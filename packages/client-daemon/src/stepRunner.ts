import { validateJsonSchema, type JsonSchema } from "@adt/shared";
import { nodeCommandRunner } from "./capability/exec";
import type { CapabilityRegistry } from "./capability/registry";
import type { CommandRunner, ExecutionResult } from "./capability/result";

/** The connection surface the runner needs (structural, so it is easy to fake). */
export interface StepDispatcher {
  on(type: string, handler: (env: { payload: unknown }) => void): void;
  send(type: string, payload: unknown): void;
}

/**
 * The reserved advisory capability (CAPABILITY_SPEC.md §6). It is never in the
 * Manifest — the Server may dispatch it as a suggestion, and the daemon asks
 * the engineer to perform the action and report back.
 */
export const HUMAN_MANUAL_ACTION = "human.manual_action";

export interface ConfirmationRequest {
  workflowId: string;
  stepId: string;
  capability: string;
  objective: string;
  input: Record<string, unknown>;
}

/** What the engineer reports after performing a suggested action. */
export interface ManualActionFeedback {
  outcome: "succeeded" | "failed" | "unknown";
  observation: string;
  details?: unknown;
}

export interface UserInputRequest {
  workflowId: string;
  stepId: string;
  capability: string;
  objective: string;
  input: Record<string, unknown>;
}

export interface StepRunnerDeps {
  connection: StepDispatcher;
  registry: CapabilityRegistry;
  workspaceRoot: string;
  run?: CommandRunner;
  /**
   * Asks the engineer to approve a side-effect step. Anything but `true`
   * declines — an unconfirmed side effect is never executed
   * (WORKFLOW_SPEC.md §4.2).
   */
  onConfirmationRequired?: (request: ConfirmationRequest) => Promise<boolean>;
  /**
   * The advisory path (WORKFLOW_SPEC.md §6.1): asks the engineer to carry the
   * action out and report what happened. No handler, or no feedback, means the
   * step was declined.
   */
  onUserInput?: (request: UserInputRequest) => Promise<ManualActionFeedback | undefined>;
}

interface StepDispatchPayload {
  workflow_id: string;
  step_id: string;
  capability: string;
  objective?: string;
  input?: Record<string, unknown>;
  requires_confirmation?: boolean;
}

/**
 * Turns `step.dispatch` into `step.status` (PROTOCOL_SPEC.md §8).
 *
 * * an unknown capability is `REJECTED(capability_unavailable)`;
 * * input that violates the declared schema is `REJECTED(invalid_input)` — do
 *   not retry the same thing;
 * * a side-effect step is NEVER executed without an explicit confirmation, and
 *   a `human.manual_action` step is answered by the engineer;
 * * adapter failures become `FAILED` — evidence is never fabricated.
 */
export function attachStepRunner(deps: StepRunnerDeps): void {
  const run = deps.run ?? nodeCommandRunner();
  deps.connection.on("step.dispatch", (env) => {
    void handleStep(deps, run, env.payload as StepDispatchPayload);
  });
}

async function handleStep(
  deps: StepRunnerDeps,
  run: CommandRunner,
  dispatch: StepDispatchPayload,
): Promise<void> {
  const send = (status: string, extra: Record<string, unknown> = {}): void => {
    deps.connection.send("step.status", {
      workflow_id: dispatch.workflow_id,
      step_id: dispatch.step_id,
      status,
      ...extra,
    });
  };

  const input = dispatch.input ?? {};

  // The advisory path (WORKFLOW_SPEC.md §6.1) has no adapter: the action is
  // performed by a person, and their report is the evidence.
  if (dispatch.capability === HUMAN_MANUAL_ACTION) {
    send("WAITING", { wait_reason: { code: "user_input" } });
    const feedback = await ask(() =>
      deps.onUserInput?.({
        workflowId: dispatch.workflow_id,
        stepId: dispatch.step_id,
        capability: dispatch.capability,
        objective: dispatch.objective ?? "",
        input,
      }),
    );
    if (!feedback) {
      send("REJECTED", { reject_reason: { code: "user_declined" } });
      return;
    }
    send("COMPLETED", {
      evidence: {
        source: "user_input",
        type: "manual_action_result",
        result: {
          outcome: feedback.outcome,
          observation: feedback.observation,
          ...(feedback.details === undefined ? {} : { details: feedback.details }),
        },
      },
    });
    return;
  }

  const adapter = deps.registry.get(dispatch.capability);
  if (!adapter) {
    send("REJECTED", { reject_reason: { code: "capability_unavailable" } });
    return;
  }

  // CAPABILITY_SPEC.md §5.2: input that violates the declared input schema is
  // REJECTED (do not try the same thing again), not a failure.
  const schema = adapter.spec.input_schema as JsonSchema | undefined;
  if (schema) {
    const validation = validateJsonSchema(schema, input);
    if (!validation.valid) {
      send("REJECTED", {
        reject_reason: { code: "invalid_input", message: validation.errors.join("; ") },
      });
      return;
    }
  }

  // Defense in depth: a side effect the Server did not mark as needing
  // confirmation is still never auto-run (WORKFLOW_SPEC.md §4.2).
  if (adapter.spec.side_effect && dispatch.requires_confirmation !== true) {
    send("REJECTED", { reject_reason: { code: "user_declined" } });
    return;
  }

  if (dispatch.requires_confirmation === true) {
    send("WAITING", { wait_reason: { code: "user_confirmation" } });
    const approved = await ask(() =>
      deps.onConfirmationRequired?.({
        workflowId: dispatch.workflow_id,
        stepId: dispatch.step_id,
        capability: dispatch.capability,
        objective: dispatch.objective ?? "",
        input,
      }),
    );
    if (approved !== true) {
      send("REJECTED", { reject_reason: { code: "user_declined" } });
      return;
    }
  }

  send("RUNNING");

  let result: ExecutionResult;
  try {
    result = await adapter.execute(input, { workspaceRoot: deps.workspaceRoot, run });
  } catch (error) {
    send("FAILED", {
      fail_reason: { code: "capability_error", message: (error as Error).message },
    });
    return;
  }

  if (result.status === "completed") {
    send("COMPLETED", {
      evidence: { source: "capability", type: result.type, result: result.result },
    });
  } else if (result.status === "failed") {
    send("FAILED", {
      fail_reason: {
        code: result.code,
        ...(result.message === undefined ? {} : { message: result.message }),
      },
    });
  } else {
    send("REJECTED", {
      reject_reason: {
        code: result.code,
        ...(result.message === undefined ? {} : { message: result.message }),
      },
    });
  }
}

/**
 * Fails closed: a host hook that throws (a crashed confirmation dialog, an
 * unreadable notification channel) must not turn into an execution. The
 * rejection is honest — the engineer never said yes.
 */
async function ask<T>(call: () => Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    console.warn(`[step-runner] interaction failed: ${(error as Error).message}`);
    return undefined;
  }
}
