import { describe, it, expect } from "vitest";
import { selectPlanner } from "../../src/llm/selectPlanner";
import { LlmPlanner, NOOP_PLANNER, type Planner } from "@adt/server";

const explicit: Planner = {
  initialCriteria: async () => ({ mode: "open", revision: 0 }),
  proposeNext: async () => ({ kind: "completion_candidate", summary: "", evidenceRefs: [] }),
};

describe("selectPlanner", () => {
  it("falls back to the no-op planner without an API key", () => {
    expect(selectPlanner({})).toBe(NOOP_PLANNER);
  });

  it("uses the LLM planner when an API key is configured", () => {
    expect(selectPlanner({ LLM_API_KEY: "k" })).toBeInstanceOf(LlmPlanner);
  });

  it("honours an explicitly supplied planner over the environment", () => {
    expect(selectPlanner({ LLM_API_KEY: "k" }, explicit)).toBe(explicit);
  });
});
