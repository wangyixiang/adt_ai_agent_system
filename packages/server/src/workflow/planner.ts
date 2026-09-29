import type { NewStep } from "./engine";
import type { StepSnapshot, WorkflowEvent, WorkflowSnapshot } from "./store";

export interface PlannerInput {
  workflow: WorkflowSnapshot;
  steps: StepSnapshot[];
  events: WorkflowEvent[];
}

export type PlannerDecision =
  | { kind: "step"; step: NewStep }
  | { kind: "completion_candidate"; summary: string; evidenceRefs: string[] };

/**
 * The seam between the engine and "how the next step is decided".
 * P2b ships a scripted implementation; P3 swaps in the LLM planner without
 * touching the protocol layer.
 */
export interface Planner {
  proposeNext(input: PlannerInput): Promise<PlannerDecision>;
}

/**
 * Placeholder used until the LLM planner lands (P3): it proposes no step and
 * immediately offers a completion candidate, so a workflow terminates cleanly
 * rather than hanging.
 */
export const NOOP_PLANNER: Planner = {
  proposeNext: async () => ({
    kind: "completion_candidate",
    summary: "未配置规划器（P3 接入 LLM）",
    evidenceRefs: [],
  }),
};
