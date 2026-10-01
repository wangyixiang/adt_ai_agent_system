import { describe, it, expect } from "vitest";

import { SAFE_DEFAULTS, MANUAL_OUTCOMES, MAX_OBSERVATION_CHARS, validateAnswer } from "../src/decisions";

describe("the four decisions", () => {
  it("has a safe default for every decision — none of them is 'yes'", () => {
    expect(SAFE_DEFAULTS.confirmation).toBe(false);
    expect(SAFE_DEFAULTS.resourceConflict).toBe("stop");
    expect(SAFE_DEFAULTS.completion).toBe("not_solved");
    expect(SAFE_DEFAULTS.manualFeedback).toBeUndefined();
  });

  it("keeps the fixed four manual outcomes (CAPABILITY_SPEC §6)", () => {
    expect(MANUAL_OUTCOMES).toEqual(["succeeded", "failed", "partially", "unknown"]);
  });

  it("accepts a well-formed confirmation", () => {
    expect(
      validateAnswer("confirmation", { kind: "confirmation", decision: "confirmed" }),
    ).toMatchObject({ ok: true, value: { kind: "confirmation", decision: "confirmed" } });
  });

  it("refuses a manual outcome outside the fixed four", () => {
    expect(
      validateAnswer("manual_action", { kind: "manual_action", outcome: "done", observation: "x" }),
    ).toMatchObject({ ok: false, code: "malformed_payload" });
  });

  it("refuses an over-long observation", () => {
    expect(
      validateAnswer("manual_action", {
        kind: "manual_action",
        outcome: "succeeded",
        observation: "x".repeat(MAX_OBSERVATION_CHARS + 1),
      }),
    ).toMatchObject({ ok: false, code: "malformed_payload" });
  });

  it("refuses a body of the wrong kind", () => {
    expect(
      validateAnswer("completion", { kind: "manual_action", outcome: "succeeded", observation: "x" }),
    ).toMatchObject({ ok: false, code: "malformed_payload" });
  });

  it("accepts optional details on a manual action", () => {
    const result = validateAnswer("manual_action", {
      kind: "manual_action",
      outcome: "succeeded",
      observation: "好了",
      details: { note: "换了线" },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "manual_action") {
      expect(result.value.details).toEqual({ note: "换了线" });
    }
  });
});
