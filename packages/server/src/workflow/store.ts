import type { WaitClass } from "./cancel";
import type { CompletionCriteria } from "./criteria";
import type { StepState, WorkflowState } from "./types";

export interface WorkflowSnapshot {
  id: string;
  userId: string;
  sessionId: string;
  state: WorkflowState;
  terminalReason: string | null;
  criteria: CompletionCriteria;
  createdAt: number;
  endedAt: number | null;
  notSolvedRounds: number;
}

export interface StepSnapshot {
  id: string;
  workflowId: string;
  state: StepState;
  objective: string;
  capability: string;
  sideEffect: boolean;
  interruptible: boolean;
  idempotencyKey: string | null;
  attempt: number;
  waitClass: WaitClass;
}

export type WorkflowEventKind =
  | "workflow_created"
  | "step_dispatched"
  | "step_status"
  | "criteria_revised"
  | "cancel_requested"
  | "completion_candidate"
  | "completion_response"
  | "guardrail_triggered"
  | "workflow_terminated";

export interface WorkflowEvent {
  id: string;
  workflowId: string;
  kind: WorkflowEventKind;
  ts: number;
  payload: unknown;
}

/**
 * Every write persists the entity change and its event in one transaction,
 * so the event log can never drift from the authoritative state (ADR-001).
 */
export interface WorkflowStore {
  createWorkflow(workflow: WorkflowSnapshot, event: WorkflowEvent): Promise<void>;
  getWorkflow(id: string): Promise<WorkflowSnapshot | null>;
  listWorkflowsByUser(userId: string): Promise<WorkflowSnapshot[]>;
  saveWorkflow(workflow: WorkflowSnapshot, event: WorkflowEvent): Promise<void>;

  createStep(step: StepSnapshot, event: WorkflowEvent): Promise<void>;
  getStep(id: string): Promise<StepSnapshot | null>;
  listSteps(workflowId: string): Promise<StepSnapshot[]>;
  saveStep(step: StepSnapshot, event: WorkflowEvent): Promise<void>;

  listEvents(workflowId: string): Promise<WorkflowEvent[]>;
  findActiveWorkflows(): Promise<WorkflowSnapshot[]>;
}
