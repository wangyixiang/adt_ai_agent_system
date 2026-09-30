import {
  ACTIVE_STEP_STATES,
  TERMINAL_STEP_STATES,
  TERMINAL_WORKFLOW_STATES,
  type ActiveStepState,
  type StepState,
  type TerminalStepState,
  type TerminalWorkflowState,
  type WorkflowState,
} from "./types";

export function isTerminalWorkflow(s: WorkflowState): s is TerminalWorkflowState {
  return TERMINAL_WORKFLOW_STATES.has(s);
}

export function isTerminalStep(s: StepState): s is TerminalStepState {
  return TERMINAL_STEP_STATES.has(s);
}

export function isActiveStep(s: StepState): s is ActiveStepState {
  return ACTIVE_STEP_STATES.has(s);
}

type NonTerminalStepState = Exclude<StepState, TerminalStepState>;

/** Allowed edges between non-terminal states (WORKFLOW_SPEC.md §4). */
const NON_TERMINAL_EDGES: Record<NonTerminalStepState, readonly StepState[]> = {
  // UNKNOWN from PENDING: a side-effect step whose client never managed to
  // report back is still "result unknown" (§4.3).
  PENDING: ["RUNNING", "WAITING", "REJECTED", "UNKNOWN"],
  RUNNING: ["WAITING", "COMPLETED", "FAILED", "UNKNOWN"],
  // REJECTED from WAITING: the engineer declines a confirmation, or the client
  // discovers it cannot run the step, while the step is waiting (§4.2).
  WAITING: ["RUNNING", "COMPLETED", "FAILED", "REJECTED", "UNKNOWN"],
};

/**
 * Terminal states are immutable; the only exception is reconciliation out of
 * `UNKNOWN` (WORKFLOW_SPEC.md §4).
 */
export function canTransitionStep(from: StepState, to: StepState): boolean {
  if (from === to) return false;

  if (isTerminalStep(from)) {
    return from === "UNKNOWN" && (to === "COMPLETED" || to === "FAILED");
  }

  return NON_TERMINAL_EDGES[from as NonTerminalStepState].includes(to);
}
