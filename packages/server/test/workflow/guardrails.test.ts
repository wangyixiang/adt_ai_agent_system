import { describe, it, expect } from "vitest";
import { DEFAULT_GUARDRAILS, breachedGuardrail } from "../../src/workflow/guardrails";
import { reviseCriteria } from "../../src/workflow/criteria";

const base = { stepCount: 0, consecutiveRetries: 0, notSolvedRounds: 0, elapsedMs: 0 };

describe("guardrails", () => {
  it("defaults match WORKFLOW_SPEC.md §13", () => {
    expect(DEFAULT_GUARDRAILS).toEqual({
      maxStepsPerWorkflow: 50,
      maxConsecutiveRetriesPerCapability: 2,
      maxNotSolvedRounds: 5,
      timeBudgetMs: null,
    });
  });

  it("breaches on step count", () => {
    expect(breachedGuardrail({ ...base, stepCount: 51 }, DEFAULT_GUARDRAILS)).toBe("step_limit");
    expect(breachedGuardrail({ ...base, stepCount: 50 }, DEFAULT_GUARDRAILS)).toBeNull();
  });

  it("breaches on consecutive retries", () => {
    expect(breachedGuardrail({ ...base, consecutiveRetries: 3 }, DEFAULT_GUARDRAILS)).toBe("retry_limit");
    expect(breachedGuardrail({ ...base, consecutiveRetries: 2 }, DEFAULT_GUARDRAILS)).toBeNull();
  });

  it("breaches on not_solved rounds", () => {
    expect(breachedGuardrail({ ...base, notSolvedRounds: 6 }, DEFAULT_GUARDRAILS)).toBe("user_round_limit");
    expect(breachedGuardrail({ ...base, notSolvedRounds: 5 }, DEFAULT_GUARDRAILS)).toBeNull();
  });

  it("only breaches on time when a budget is configured", () => {
    expect(breachedGuardrail({ ...base, elapsedMs: 10_000 }, DEFAULT_GUARDRAILS)).toBeNull();
    expect(
      breachedGuardrail({ ...base, elapsedMs: 10_000 }, { ...DEFAULT_GUARDRAILS, timeBudgetMs: 5_000 }),
    ).toBe("time_budget");
  });
});

describe("completion criteria", () => {
  it("bumps revision on every change", () => {
    const first = reviseCriteria({ mode: "open", revision: 0 }, { mode: "formal", assertions: ["svc == up"] });
    expect(first).toEqual({ mode: "formal", assertions: ["svc == up"], revision: 1 });
    const second = reviseCriteria(first, { mode: "open" });
    expect(second.revision).toBe(2);
    expect(second.mode).toBe("open");
  });
});
