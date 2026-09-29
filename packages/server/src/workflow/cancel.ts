import { isTerminalStep } from "./stateMachine";
import type { ActiveStepState, StepState } from "./types";

export type WaitClass = "human" | "execution" | null;

export interface CancelContext {
  activeStep: {
    state: ActiveStepState;
    interruptible: boolean;
    waitClass: WaitClass;
  } | null;
}

export type CancelDecision = "IMMEDIATE" | "CANCELLING";

/**
 * WORKFLOW_SPEC.md §2.1: no active step, a PENDING-only step, or a human wait
 * cancels immediately; a non-interruptible execution queues as CANCELLING.
 */
export function decideCancel(ctx: CancelContext): CancelDecision {
  const step = ctx.activeStep;
  if (!step) return "IMMEDIATE";
  if (step.state === "PENDING") return "IMMEDIATE";
  if (step.waitClass === "human") return "IMMEDIATE";
  return step.interruptible ? "IMMEDIATE" : "CANCELLING";
}

/** Any terminal step outcome — including UNKNOWN — ends CANCELLING (§2.1). */
export function convergesCancelling(stepReached: StepState): boolean {
  return isTerminalStep(stepReached);
}
