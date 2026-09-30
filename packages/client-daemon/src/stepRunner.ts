import { HUMAN_MANUAL_ACTION, validateJsonSchema, type JsonSchema } from "@adt/shared";
import { nodeCommandRunner } from "./capability/exec";
import type { CapabilityRegistry } from "./capability/registry";
import type { CommandRunner, ExecutionResult } from "./capability/result";
import type { Ledger } from "./ledger";

/** The connection surface the runner needs (structural, so it is easy to fake). */
export interface StepDispatcher {
  on(type: string, handler: (env: { payload: unknown }) => void): void;
  send(type: string, payload: unknown): void;
}

/**
 * The reserved advisory capability (CAPABILITY_SPEC.md §6). It is never in the
 * Manifest — the Server may dispatch it as a suggestion, and the daemon asks
 * the engineer to perform the action and report back. Re-exported for callers
 * that used to import it from here.
 */
export { HUMAN_MANUAL_ACTION };

/**
 * A provider that cannot get the resource reports this code instead of
 * executing (WORKFLOW_SPEC.md §4.4). The runner asks the engineer, and an
 * unresolved conflict ends the workflow server-side.
 */
export const RESOURCE_CONFLICT = "resource_conflict";

export interface ConfirmationRequest {
  workflowId: string;
  stepId: string;
  capability: string;
  objective: string;
  input: Record<string, unknown>;
}

/** What the engineer reports after performing a suggested action. */
export interface ManualActionFeedback {
  outcome: "succeeded" | "failed" | "partially" | "unknown";
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

export interface ResourceConflictRequest {
  workflowId: string;
  stepId: string;
  capability: string;
  objective: string;
  message?: string;
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
  /**
   * The provider found the resource busy. `"wait"` makes the runner retry once
   * the engineer has freed it; anything else — or no handler at all — reports
   * the conflict, which ends the workflow server-side.
   */
  onResourceConflict?: (request: ResourceConflictRequest) => Promise<"wait" | "stop">;
  /**
   * The persistent `idempotency_key → result` ledger (WORKFLOW_SPEC.md §4.3).
   * Without it a re-dispatched side effect runs again.
   */
  ledger?: Ledger;
}

export interface StepDispatchPayload {
  workflow_id: string;
  step_id: string;
  capability: string;
  objective?: string;
  input?: Record<string, unknown>;
  requires_confirmation?: boolean;
  idempotency_key?: string | null;
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
export function attachStepRunner(
  deps: StepRunnerDeps,
): (dispatch: StepDispatchPayload) => Promise<void> {
  const run = deps.run ?? nodeCommandRunner();
  const runner = (dispatch: StepDispatchPayload): Promise<void> => runStep(deps, run, dispatch);
  deps.connection.on("step.dispatch", (env) => {
    void runner(env.payload as StepDispatchPayload);
  });
  return runner;
}

/**
 * Keys this process is executing right now. The ledger only knows what past
 * attempts did; this covers the window between "check the ledger" and "mark it
 * in flight", where a racing re-dispatch of the same step would otherwise slip
 * through and run a second time.
 */
const inProcess = new Set<string>();

/**
 * Runs one dispatched step. A key already being processed here is answered
 * `UNKNOWN` rather than executed: like an unreadable ledger entry, the outcome
 * cannot be confirmed (WORKFLOW_SPEC.md §4.3).
 */
async function runStep(
  deps: StepRunnerDeps,
  run: CommandRunner,
  dispatch: StepDispatchPayload,
): Promise<void> {
  const key = dispatch.idempotency_key ?? null;
  if (key !== null) {
    if (inProcess.has(key)) {
      deps.connection.send("step.status", {
        workflow_id: dispatch.workflow_id,
        step_id: dispatch.step_id,
        status: "UNKNOWN",
      });
      return;
    }
    inProcess.add(key);
  }

  try {
    await executeStep(deps, run, dispatch);
  } finally {
    if (key !== null) inProcess.delete(key);
  }
}

async function executeStep(
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

  // Idempotency (WORKFLOW_SPEC.md §4.3): this exact action was already carried
  // out, so replay the recorded result. Checked before confirmation — there is
  // nothing left to approve.
  const key = dispatch.idempotency_key ?? null;
  if (key !== null) {
    const recorded = deps.ledger?.get(key);
    if (recorded?.state === "done") {
      send("COMPLETED", {
        evidence: { source: "capability", type: recorded.type, result: recorded.result },
      });
      return;
    }
    if (recorded?.state === "in_flight") {
      // WORKFLOW_SPEC.md §4.3: we began this action and never learned how it
      // ended (the ack was lost, or the process died mid-way). Running it again
      // would duplicate a physical action, so the honest answer is "unknown" —
      // the Server reconciles it. Never ask for confirmation either: there is
      // nothing to confirm.
      send("UNKNOWN");
      return;
    }
    // The same key already being processed right here (a re-dispatch racing the
    // original) must not become a second execution either — see `runStep`.
  } else if (adapter.spec.side_effect) {
    // A side effect with no key cannot be made safe to retry, and silently
    // running it once more after a reconnect is exactly what §4.3 forbids.
    send("REJECTED", {
      reject_reason: {
        code: "unsafe_operation",
        message: "a side-effecting step must carry an idempotency_key",
      },
    });
    return;
  }

  /** The action did not happen, so it is not "unknown" — forget the marker. */
  const forget = (): void => {
    if (key !== null) deps.ledger?.clear(key);
  };

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

  // Committed to running it: say so in the ledger BEFORE the action starts, so
  // a reconnect (or a crash) leaves a trace we can honestly report as unknown.
  if (key !== null) deps.ledger?.markInFlight(key);

  send("RUNNING");

  // Executing, and asking the engineer when the resource is busy. A provider
  // that cannot get the resource reports `rejected(resource_conflict)` rather
  // than pretending the action ran (WORKFLOW_SPEC.md §4.4): we park the step
  // (a human wait has no deadline), ask, and either retry once the engineer has
  // freed it, or report the conflict — which ends the workflow server-side.
  for (;;) {
    let result: ExecutionResult;
    try {
      result = await adapter.execute(input, { workspaceRoot: deps.workspaceRoot, run });
    } catch (error) {
      forget();
      send("FAILED", {
        fail_reason: { code: "capability_error", message: (error as Error).message },
      });
      return;
    }

    if (result.status === "rejected" && result.code === RESOURCE_CONFLICT) {
      send("WAITING", { wait_reason: { code: RESOURCE_CONFLICT } });
      const decision = await ask(() =>
        deps.onResourceConflict?.({
          workflowId: dispatch.workflow_id,
          stepId: dispatch.step_id,
          capability: dispatch.capability,
          objective: dispatch.objective ?? "",
          ...(result.message === undefined ? {} : { message: result.message }),
        }),
      );
      if (decision === "wait") {
        send("RUNNING");
        continue;
      }
      forget();
      send("REJECTED", {
        reject_reason: {
          code: RESOURCE_CONFLICT,
          ...(result.message === undefined ? {} : { message: result.message }),
        },
      });
      return;
    }

    if (result.status === "completed") {
      // The only outcome worth remembering: it is what a later re-dispatch (a
      // resume) replays instead of repeating the action.
      if (key !== null) deps.ledger?.markDone(key, result.type, result.result);
      send("COMPLETED", {
        evidence: { source: "capability", type: result.type, result: result.result },
      });
      return;
    }

    if (result.status === "failed") {
      // A side effect we killed at its own local limit is not a known failure:
      // it may have taken (partial) effect, so the honest state is UNKNOWN
      // (WORKFLOW_SPEC.md §4.3) — and the ledger must keep saying "in flight",
      // so a re-dispatch still cannot run it a second time.
      if (adapter.spec.side_effect && result.code === "timeout") {
        send("UNKNOWN");
        return;
      }
      forget();
      send("FAILED", {
        fail_reason: {
          code: result.code,
          ...(result.message === undefined ? {} : { message: result.message }),
        },
      });
      return;
    }

    forget();
    send("REJECTED", {
      reject_reason: {
        code: result.code,
        ...(result.message === undefined ? {} : { message: result.message }),
      },
    });
    return;
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
