import type { StepState } from "@adt/shared";

import type { TranscriptItem } from "../transcript";
import { Icon, type IconName } from "./Icon";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const STATE_ICON: Record<StepState, IconName> = {
  PENDING: "hourglass",
  RUNNING: "hourglass",
  WAITING: "hourglass",
  COMPLETED: "check",
  FAILED: "error",
  REJECTED: "block",
  UNKNOWN: "error",
};

/**
 * The thread's compact pointer at a step: a status icon, the capability and a
 * state chip, with the objective below. The full record (input, evidence, blob
 * actions, decisions) belongs to the workbench — clicking this row locates it.
 */
export function ToolCard({ item, onLocate }: { item: ToolItem; onLocate(stepId: string): void }) {
  return (
    <button
      type="button"
      className="tool-row"
      data-state={item.state}
      onClick={() => onLocate(item.stepId)}
    >
      <span className="tool-row-head">
        <Icon name={STATE_ICON[item.state]} />
        <span className="capability">{item.capability}</span>
        <span className="badge">{item.resuming ? "恢复中" : item.text}</span>
      </span>
      {item.objective !== "" && <span className="objective">{item.objective}</span>}
    </button>
  );
}
