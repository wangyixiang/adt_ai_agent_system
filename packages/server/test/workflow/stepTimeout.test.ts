import { describe, it, expect } from "vitest";
import { StepTimeoutMonitor } from "../../src/workflow/stepTimeout";

describe("StepTimeoutMonitor", () => {
  it("times out an overdue executing step and skips non-executing ones", async () => {
    let t = 0;
    const timed: string[] = [];
    const advanced: string[] = [];
    const monitor = new StepTimeoutMonitor(
      {
        clock: () => t,
        onStepEnded: (workflowId) => {
          advanced.push(workflowId);
        },
        store: {
          findActiveWorkflows: async () => [{ id: "wf_1" }] as never,
          listSteps: async () =>
            [
              { id: "step_running", state: "RUNNING", updatedAt: 0, timeoutMs: 100, waitClass: null },
              { id: "step_human", state: "WAITING", updatedAt: 0, timeoutMs: 100, waitClass: "human" },
              { id: "step_no_deadline", state: "RUNNING", updatedAt: 0, timeoutMs: 0, waitClass: null },
              { id: "step_pending", state: "PENDING", updatedAt: 0, timeoutMs: 100, waitClass: null },
            ] as never,
        },
        engine: {
          timeoutStep: async (_workflowId: string, stepId: string) => {
            timed.push(stepId);
            return {} as never;
          },
        },
      },
      { intervalMs: 10 },
    );

    expect(await monitor.sweep()).toEqual([]);
    t = 150;
    expect(await monitor.sweep()).toEqual(["step_running"]);
    expect(timed).toEqual(["step_running"]);
    // The workflow is advanced exactly once, so a timed-out step does not stall.
    expect(advanced).toEqual(["wf_1"]);
  });

  it("keeps sweeping when one step fails", async () => {    const monitor = new StepTimeoutMonitor(
      {
        clock: () => 1000,
        store: {
          findActiveWorkflows: async () => [{ id: "wf_1" }] as never,
          listSteps: async () =>
            [
              { id: "step_a", state: "RUNNING", updatedAt: 0, timeoutMs: 1, waitClass: null },
              { id: "step_b", state: "RUNNING", updatedAt: 0, timeoutMs: 1, waitClass: null },
            ] as never,
        },
        engine: {
          timeoutStep: async (_workflowId: string, stepId: string) => {
            if (stepId === "step_a") throw new Error("boom");
            return {} as never;
          },
        },
      },
      { intervalMs: 10 },
    );

    expect(await monitor.sweep()).toEqual(["step_b"]);
  });

  it("does not start a second sweep while one is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timed: string[] = [];

    const monitor = new StepTimeoutMonitor(
      {
        clock: () => 1000,
        store: {
          findActiveWorkflows: async () => [{ id: "wf_1" }] as never,
          listSteps: async () =>
            [
              { id: "step_a", state: "RUNNING", updatedAt: 0, timeoutMs: 1, waitClass: null },
            ] as never,
        },
        engine: {
          timeoutStep: async (_workflowId: string, stepId: string) => {
            timed.push(stepId);
            await gate;
            return {} as never;
          },
        },
      },
      { intervalMs: 10 },
    );

    const first = monitor.sweep();
    // Let the first sweep get past the guard and block on the engine.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The next tick must not double-drive the same step.
    expect(await monitor.sweep()).toEqual([]);

    release();
    expect(await first).toEqual(["step_a"]);
    expect(timed).toEqual(["step_a"]);
  });
});
