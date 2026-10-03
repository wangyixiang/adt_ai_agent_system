import type { TranscriptItem } from "../transcript";

type SummaryItem = Extract<TranscriptItem, { kind: "summary" }>;

/**
 * The thread's single terminal line: the run is over, and the structured
 * conclusion (terminal state, reason, Record) lives in the workbench. The
 * `recordId` is deliberately not repeated here (spec §6.3).
 */
export function Summary({ item }: { item: SummaryItem }) {
  return (
    <div className="summary" data-terminal-state={item.terminalState}>
      <p>{item.text}</p>
    </div>
  );
}
