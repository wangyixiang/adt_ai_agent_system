export type WorkflowState =
  | "CREATED"
  | "RUNNING"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type StepState =
  | "PENDING"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "REJECTED"
  | "UNKNOWN";

export type TerminalWorkflowState = "COMPLETED" | "FAILED" | "CANCELLED";
export type TerminalStepState = "COMPLETED" | "FAILED" | "REJECTED" | "UNKNOWN";
export type ActiveStepState = "PENDING" | "RUNNING" | "WAITING";

export const TERMINAL_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const TERMINAL_STEP_STATES: ReadonlySet<StepState> = new Set([
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "UNKNOWN",
]);

export const ACTIVE_STEP_STATES: ReadonlySet<StepState> = new Set([
  "PENDING",
  "RUNNING",
  "WAITING",
]);
