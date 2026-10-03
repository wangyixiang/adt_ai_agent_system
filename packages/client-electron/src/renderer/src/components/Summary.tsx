import type { TranscriptItem } from "../transcript";

type SummaryItem = Extract<TranscriptItem, { kind: "summary" }>;

/**
 * The thread's single terminal line: the run is over. The structured
 * conclusion — the Record id and the terminal fingerprint — lives in the
 * workbench; the id is deliberately not repeated here (spec §6.3).
 */
export function Summary({ item }: { item: SummaryItem }) {
  return (
    <div className="summary" data-terminal-state={item.terminalState}>
      <p>{item.text}</p>
    </div>
  );
}
