import { nodeCommandRunner } from "./capability/exec";
import type { CapabilityRegistry } from "./capability/registry";
import type { CommandRunner, ExecutionResult } from "./capability/result";

/** The connection surface the runner needs (structural, so it is easy to fake). */
export interface StepDispatcher {
  on(type: string, handler: (env: { payload: unknown }) => void): void;
  send(type: string, payload: unknown): void;
}

export interface StepRunnerDeps {
  connection: StepDispatcher;
  registry: CapabilityRegistry;
  workspaceRoot: string;
  run?: CommandRunner;
}

interface StepDispatchPayload {
  workflow_id: string;
  step_id: string;
  capability: string;
  input?: Record<string, unknown>;
  requires_confirmation?: boolean;
}

/**
 * Turns `step.dispatch` into `step.status` (PROTOCOL_SPEC.md §8). A step that
 * references an unknown capability is `REJECTED(capability_unavailable)`; a
 * step asking for confirmation is never executed (the confirmation flow is
 * P4). Adapter failures become `FAILED` — evidence is never fabricated.
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

  const adapter = deps.registry.get(dispatch.capability);
  if (!adapter) {
    send("REJECTED", { reject_reason: { code: "capability_unavailable" } });
    return;
  }

  if (dispatch.requires_confirmation === true) {
    send("REJECTED", { reject_reason: { code: "user_declined" } });
    return;
  }

  send("RUNNING");

  let result: ExecutionResult;
  try {
    result = await adapter.execute(dispatch.input ?? {}, { workspaceRoot: deps.workspaceRoot, run });
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
    send("REJECTED", { reject_reason: { code: result.code } });
  }
}
