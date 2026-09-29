import { describe, it, expect } from "vitest";
import {
  isTerminalWorkflow,
  isTerminalStep,
  isActiveStep,
  canTransitionStep,
} from "../../src/workflow/stateMachine";

describe("state machine", () => {
  it("knows the terminal workflow states", () => {
    expect(isTerminalWorkflow("COMPLETED")).toBe(true);
    expect(isTerminalWorkflow("FAILED")).toBe(true);
    expect(isTerminalWorkflow("CANCELLED")).toBe(true);
    expect(isTerminalWorkflow("RUNNING")).toBe(false);
    expect(isTerminalWorkflow("CANCELLING")).toBe(false);
  });

  it("knows the terminal step states", () => {
    expect(isTerminalStep("COMPLETED")).toBe(true);
    expect(isTerminalStep("FAILED")).toBe(true);
    expect(isTerminalStep("REJECTED")).toBe(true);
    expect(isTerminalStep("UNKNOWN")).toBe(true);
    expect(isTerminalStep("WAITING")).toBe(false);
  });

  it("treats PENDING/RUNNING/WAITING as active", () => {
    expect(isActiveStep("PENDING")).toBe(true);
    expect(isActiveStep("RUNNING")).toBe(true);
    expect(isActiveStep("WAITING")).toBe(true);
    expect(isActiveStep("COMPLETED")).toBe(false);
  });

  it("allows only the reconciliation edge out of a terminal state", () => {
    expect(canTransitionStep("UNKNOWN", "COMPLETED")).toBe(true);
    expect(canTransitionStep("UNKNOWN", "FAILED")).toBe(true);
    expect(canTransitionStep("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransitionStep("FAILED", "COMPLETED")).toBe(false);
    expect(canTransitionStep("REJECTED", "RUNNING")).toBe(false);
    expect(canTransitionStep("RUNNING", "COMPLETED")).toBe(true);
    expect(canTransitionStep("PENDING", "WAITING")).toBe(true);
  });
});
