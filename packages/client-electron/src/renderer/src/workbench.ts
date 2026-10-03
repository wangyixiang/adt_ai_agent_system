/**
 * The workbench's model: the selected conversation, seen as a structured view
 * (steps + evidence + the human's decisions + the conclusion) rather than a chat
 * stream. It is a **pure function over the same `TranscriptItem[]` the thread
 * renders**, so a live run and a past Record reconstructed from
 * `transcriptFromRecord` share one shape.
 */
import type { Ask, StepState, TerminalState } from "@adt/shared";

import type { UiEvidenceBlob } from "../../shared/contract";
import type { TranscriptItem } from "./transcript";

/** `CANCELLING` is the convergence window, not a terminal state. */
export type WorkbenchState = "running" | "CANCELLING" | TerminalState;

export interface WorkbenchStep {
  key: string;
  stepId: string;
  capability: string;
  objective: string;
  state: StepState;
  input: Record<string, unknown>;
  requiresConfirmation: boolean;
  evidenceSummary: string | null;
  evidenceBlob: UiEvidenceBlob | null;
  /** This step's human decisions, as short labels (answered) or "待你回答". */
  decisions: string[];
}

export interface WorkbenchConclusion {
  terminalState: TerminalState;
  terminalReason: string | null;
  recordId: string | null;
}

export interface WorkbenchCompletion {
  summary: string;
  evidenceRefs: string[];
}

export interface WorkbenchModel {
  workflowId: string | null;
  state: WorkbenchState;
  steps: WorkbenchStep[];
  conclusion: WorkbenchConclusion | null;
  /** The Server's "solved?" proposal, when one is on the table/answered. */
  completion: WorkbenchCompletion | null;
}

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type AskItem = Extract<TranscriptItem, { kind: "ask" }>;
type SummaryItem = Extract<TranscriptItem, { kind: "summary" }>;
type CompletionAsk = Extract<Ask, { kind: "completion" }>;

export function deriveWorkbench(items: TranscriptItem[], cancelling: boolean): WorkbenchModel {
  const asks = items.filter((item): item is AskItem => item.kind === "ask");

  const steps: WorkbenchStep[] = items
    .filter((item): item is ToolItem => item.kind === "tool")
    .map((item) => ({
      key: item.key,
      stepId: item.stepId,
      capability: item.capability,
      objective: item.objective,
      state: item.state,
      input: item.input,
      requiresConfirmation: item.requiresConfirmation,
      evidenceSummary: item.evidenceSummary,
      evidenceBlob: item.evidenceBlob,
      decisions: asks
        .filter((ask) => ask.stepId !== null && ask.stepId === item.stepId && ask.askKind !== "completion")
        .map((ask) => (ask.answered ? ask.text : "待你回答")),
    }));

  const summary = items.find((item): item is SummaryItem => item.kind === "summary");
  const conclusion: WorkbenchConclusion | null =
    summary === undefined
      ? null
      : {
          terminalState: summary.terminalState,
          terminalReason: summary.terminalReason,
          recordId: summary.recordId,
        };

  const candidate = asks
    .map((ask) => ask.ask)
    .find((ask): ask is CompletionAsk => ask !== null && ask.kind === "completion");
  const completion: WorkbenchCompletion | null =
    candidate === undefined ? null : { summary: candidate.summary, evidenceRefs: candidate.evidenceRefs };

  const first = items.find((item) => item.kind !== "notice");
  const workflowId = first === undefined ? null : first.workflowId;
  // A terminal state wins: "cancelling" only tells the running case apart.
  const state: WorkbenchState = conclusion?.terminalState ?? (cancelling ? "CANCELLING" : "running");

  return { workflowId, state, steps, conclusion, completion };
}
