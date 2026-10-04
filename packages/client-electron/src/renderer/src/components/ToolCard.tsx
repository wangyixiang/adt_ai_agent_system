import type { TranscriptItem } from "../transcript";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/**
 * The thread's compact pointer at a step: capability, state and objective.
 * The full record (input, evidence, blob actions, decisions) belongs to the
 * workbench — clicking this row locates that node (spec §6.2/§6.3).
 */
export function ToolCard({ item, onLocate }: { item: ToolItem; onLocate(stepId: string): void }) {
  return (
    <button
      type="button"
      className="tool-row"
      data-state={item.state}
      onClick={() => onLocate(item.stepId)}
    >
      <span className="capability">{item.capability}</span>
      <span className="badge">{item.resuming ? "恢复中" : item.text}</span>
      {item.objective !== "" && <span className="objective">{item.objective}</span>}
    </button>
  );
}
