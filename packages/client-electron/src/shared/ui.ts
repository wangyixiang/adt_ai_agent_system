/**
 * The renderer's view of a run: a snapshot + an event stream, derived in main
 * from what the daemon reports. It is the monolith's own state model (ADR-006),
 * not a Server protocol.
 */
import type { Ask, Answer, StepState, TerminalState } from "@adt/shared";

export interface UiEvidenceBlob {
  content_ref: string;
  media_type: string;
  size: number;
  name?: string;
}

export interface UiStep {
  stepId: string;
  capability: string;
  objective: string;
  input: Record<string, unknown>;
  state: StepState;
  requiresConfirmation: boolean;
  evidenceSummary: string | null;
  /** The step's evidence blob, when the evidence was offloaded (not inline). */
  evidenceBlob: UiEvidenceBlob | null;
}

export interface UiWorkflow {
  workflowId: string;
  userRequest: { text: string };
  terminalState: TerminalState | null;
  terminalReason: string | null;
  recordId: string | null;
  /** The human asked to cancel and the Server acknowledged it; still converging. */
  cancelling: boolean;
  /** Non-null means "a question is waiting for you". */
  pendingAskId: string | null;
  pendingAsk: Ask | null;
  steps: UiStep[];
}

export interface UiSnapshot {
  connection: "connected" | "disconnected";
  userId: string | null;
  capabilities: string[];
  workflows: UiWorkflow[];
}

interface UiEventBase {
  /** Monotonic within a process. */
  id: number;
}

/** `Omit` does not distribute over a union, so this keeps each variant intact. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type UiEvent =
  | (UiEventBase & { type: "workflow.created"; workflowId: string; userRequest: { text: string } })
  | (UiEventBase & {
      type: "step.dispatched";
      workflowId: string;
      stepId: string;
      capability: string;
      objective: string;
      input: Record<string, unknown>;
      requiresConfirmation: boolean;
    })
  | (UiEventBase & {
      type: "step.status";
      workflowId: string;
      stepId: string;
      state: StepState;
      evidenceSummary?: string;
      evidenceBlob?: UiEvidenceBlob;
      failReason?: string;
    })
  | (UiEventBase & { type: "ask"; workflowId: string; ask: Ask })
  | (UiEventBase & { type: "ask.answered"; workflowId: string; askId: string; answer: Answer })
  | (UiEventBase & {
      type: "workflow.terminated";
      workflowId: string;
      terminalState: TerminalState;
      terminalReason: string | null;
      recordId: string | null;
    })
  | (UiEventBase & { type: "notice"; level: "info" | "warn"; message: string });

/** A UI event before the bridge assigns its `id`. */
export type UiEventInput = DistributiveOmit<UiEvent, "id">;
