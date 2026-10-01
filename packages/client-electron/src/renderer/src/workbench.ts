/**
 * The workbench's model: the selected conversation, seen as a structured view
 * (steps + evidence + conclusion) rather than a chat stream. It is a **pure
 * function over the same `TranscriptItem[]` the thread renders**, so a live run
 * and a past Record reconstructed from `transcriptFromRecord` share one shape.
 */
import type { StepState, TerminalState } from "@adt/shared";

import type { TranscriptItem } from "./transcript";

/** `CANCELLING` is the convergence window, not a terminal state. */
export type WorkbenchState = "running" | "CANCELLING" | TerminalState;

export interface WorkbenchStep {
  key: string;
  stepId: string;
  capability: string;
  objective: string;
  state: StepState;
  evidenceSummary: string | null;
  text: string;
}

export interface WorkbenchConclusion {
  terminalState: TerminalState;
  terminalReason: string | null;
  recordId: string | null;
  text: string;
}

export interface WorkbenchModel {
  workflowId: string | null;
  state: WorkbenchState;
  steps: WorkbenchStep[];
  conclusion: WorkbenchConclusion | null;
}

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type SummaryItem = Extract<TranscriptItem, { kind: "summary" }>;

export function deriveWorkbench(items: TranscriptItem[], cancelling: boolean): WorkbenchModel {
  const steps: WorkbenchStep[] = items
    .filter((item): item is ToolItem => item.kind === "tool")
    .map((item) => ({
      key: item.key,
      stepId: item.stepId,
      capability: item.capability,
      objective: item.objective,
      state: item.state,
      evidenceSummary: item.evidenceSummary,
      text: item.text,
    }));

  const summary = items.find((item): item is SummaryItem => item.kind === "summary");
  const conclusion: WorkbenchConclusion | null =
    summary === undefined
      ? null
      : {
          terminalState: summary.terminalState,
          terminalReason: summary.terminalReason,
          recordId: summary.recordId,
          text: summary.text,
        };

  const first = items.find((item) => item.kind !== "notice");
  const workflowId = first === undefined ? null : first.workflowId;
  // A terminal state wins: "cancelling" only tells the running case apart.
  const state: WorkbenchState = conclusion?.terminalState ?? (cancelling ? "CANCELLING" : "running");

  return { workflowId, state, steps, conclusion };
}
