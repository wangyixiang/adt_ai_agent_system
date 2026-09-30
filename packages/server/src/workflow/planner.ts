import type { NormalizedCapability } from "@adt/shared";
import type { CompletionCriteria } from "./criteria";
import type { NewStep } from "./engine";
import type { StepSnapshot, WorkflowEvent, WorkflowSnapshot } from "./store";

export interface PlannerInput {
  workflow: WorkflowSnapshot;
  steps: StepSnapshot[];
  events: WorkflowEvent[];
  /** The owning session's declared Capabilities (CAPABILITY_SPEC.md §3). */
  capabilities: NormalizedCapability[];
}

export type PlannerDecision =
  | { kind: "step"; step: NewStep; criteria?: Omit<CompletionCriteria, "revision"> }
  | {
      kind: "completion_candidate";
      summary: string;
      evidenceRefs: string[];
      criteria?: Omit<CompletionCriteria, "revision">;
    };

/**
 * The seam between the engine and "how the next step is decided".
 * P2b ships a scripted implementation; P3 swaps in the LLM planner without
 * touching the protocol layer.
 */
export interface Planner {
  /**
   * The Request-level completion criteria for a new workflow
   * (WORKFLOW_SPEC.md §8.1); recorded at creation with `revision: 0`.
   */
  initialCriteria(
    request: unknown,
    capabilities: NormalizedCapability[],
  ): Promise<CompletionCriteria>;

  proposeNext(input: PlannerInput): Promise<PlannerDecision>;
}

/**
 * Placeholder used until the LLM planner lands (P3): it proposes no step and
 * immediately offers a completion candidate, so a workflow terminates cleanly
 * rather than hanging.
 */
export const NOOP_PLANNER: Planner = {
  initialCriteria: async () => ({ mode: "open", revision: 0 }),
  proposeNext: async () => ({
    kind: "completion_candidate",
    summary: "未配置规划器（P3 接入 LLM）",
    evidenceRefs: [],
  }),
};
