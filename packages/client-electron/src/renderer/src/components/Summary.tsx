import type { TranscriptItem } from "../transcript";

type SummaryItem = Extract<TranscriptItem, { kind: "summary" }>;

export function Summary({ item }: { item: SummaryItem }) {
  return (
    <div className="summary" data-terminal-state={item.terminalState}>
      <p>{item.text}</p>
      {item.recordId !== null && <p className="record">Record: {item.recordId}</p>}
    </div>
  );
}
