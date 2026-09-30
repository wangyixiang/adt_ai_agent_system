import { describe, it, expect } from "vitest";
import { toStepStatusUpdate } from "@adt/server";

describe("toStepStatusUpdate fail_reason", () => {
  it("carries a structured client fail_reason", () => {
    expect(toStepStatusUpdate({ status: "FAILED", fail_reason: { code: "timeout" } })).toEqual({
      state: "FAILED",
      failReason: { code: "timeout" },
    });
    expect(
      toStepStatusUpdate({ status: "FAILED", fail_reason: { code: "capability_error", message: "boom" } }),
    ).toEqual({ state: "FAILED", failReason: { code: "capability_error", message: "boom" } });
  });

  it("tolerates a bare code string and a missing reason", () => {
    expect(toStepStatusUpdate({ status: "FAILED", fail_reason: "timeout" })).toEqual({
      state: "FAILED",
      failReason: { code: "timeout" },
    });
    expect(toStepStatusUpdate({ status: "FAILED" })).toEqual({ state: "FAILED" });
  });

  it("carries a structured client reject_reason", () => {
    expect(
      toStepStatusUpdate({ status: "REJECTED", reject_reason: { code: "capability_unavailable" } }),
    ).toEqual({ state: "REJECTED", rejectReason: { code: "capability_unavailable" } });
    expect(toStepStatusUpdate({ status: "REJECTED" })).toEqual({ state: "REJECTED" });
  });
});
