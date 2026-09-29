import { describe, it, expect } from "vitest";
import { decideCancel, convergesCancelling } from "../../src/workflow/cancel";

const active = (
  state: "PENDING" | "RUNNING" | "WAITING",
  interruptible: boolean,
  waitClass: "human" | "execution" | null,
) => ({ activeStep: { state, interruptible, waitClass } });

describe("cancel decision", () => {
  it("is immediate when nothing is active", () => {
    expect(decideCancel({ activeStep: null })).toBe("IMMEDIATE");
  });

  it("is immediate when the only active step is PENDING", () => {
    expect(decideCancel(active("PENDING", false, null))).toBe("IMMEDIATE");
  });

  it("is immediate for human waits", () => {
    expect(decideCancel(active("WAITING", false, "human"))).toBe("IMMEDIATE");
  });

  it("is immediate when the executing step is interruptible", () => {
    expect(decideCancel(active("RUNNING", true, "execution"))).toBe("IMMEDIATE");
  });

  it("queues when a non-interruptible execution is in flight", () => {
    expect(decideCancel(active("RUNNING", false, "execution"))).toBe("CANCELLING");
    expect(decideCancel(active("WAITING", false, "execution"))).toBe("CANCELLING");
  });

  it("does not treat a stale human waitClass as a human wait", () => {
    // A side-effect step resumes WAITING(user_confirmation) -> RUNNING; the
    // old waitClass must not bypass CANCELLING.
    expect(decideCancel(active("RUNNING", false, "human"))).toBe("CANCELLING");
  });
});

describe("CANCELLING convergence", () => {
  it("converges on any terminal step outcome, including UNKNOWN", () => {
    expect(convergesCancelling("COMPLETED")).toBe(true);
    expect(convergesCancelling("FAILED")).toBe(true);
    expect(convergesCancelling("UNKNOWN")).toBe(true);
    expect(convergesCancelling("RUNNING")).toBe(false);
  });
});
