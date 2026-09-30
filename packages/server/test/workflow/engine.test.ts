import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine, GuardrailError, WorkflowTerminalError, WorkflowBusyError } from "../../src/workflow/engine";
import { DEFAULT_GUARDRAILS } from "../../src/workflow/guardrails";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;
const clock = { t: 1000, wall: 1_700_000_000_000 };

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  clock.t = 1000;
  clock.wall = 1_700_000_000_000;
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => clock.t });
});
afterAll(async () => {
  await pool.end();
});

const open = { mode: "open" as const, revision: 0 };
const readOnly = {
  objective: "check",
  capability: "git.collect_diagnostics",
  sideEffect: false,
  interruptible: true,
};

describe("WorkflowEngine basics", () => {
  it("creates a workflow in CREATED then RUNNING once a step is dispatched", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "it broke" }, open);
    expect(wf.state).toBe("CREATED");
    expect(wf.sessionId).toBe("sess_1");
    const step = await engine.dispatchStep(wf.id, readOnly);
    expect(step.state).toBe("PENDING");
    expect((await engine.get(wf.id))!.state).toBe("RUNNING");
  });

  it("ignores a status update on a terminal step", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, readOnly);
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "COMPLETED" });
    const after = await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    expect((await engine.getStep(step.id))!.state).toBe("COMPLETED");
    expect(after.state).toBe("RUNNING");
  });

  it("completes only after the user says solved", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");
    const after = await engine.get(wf.id);
    expect(after!.state).toBe("COMPLETED");
    expect(after!.terminalReason).toBeNull();
  });

  it("counts not_solved rounds and re-plans", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const after = await engine.confirmCompletion(wf.id, "not_solved", "still broken");
    expect(after.state).toBe("RUNNING");
    expect(after.notSolvedRounds).toBe(1);
  });

  it("fails with step_limit and refuses further steps", async () => {
    const limited = new WorkflowEngine({
      store,
      now: () => 1000,
      guardrails: { ...DEFAULT_GUARDRAILS, maxStepsPerWorkflow: 1 },
    });
    const wf = await limited.create("usr_1", "sess_1", { text: "x" }, open);
    const first = await limited.dispatchStep(wf.id, readOnly);
    await limited.applyStepStatus(wf.id, first.id, { state: "RUNNING" });
    await limited.applyStepStatus(wf.id, first.id, { state: "COMPLETED" });

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow(/step_limit/);

    const after = await limited.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("step_limit");

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow();
  });

  it("fails with time_budget when the workflow runs too long", async () => {
    // The budget is measured on the wall clock, because `createdAt` outlives
    // this process (see the clock test): stepping the ordering clock forward is
    // not what "it ran too long" means.
    const limited = new WorkflowEngine({
      store,
      now: () => clock.t,
      wallClock: () => clock.wall,
      guardrails: { ...DEFAULT_GUARDRAILS, timeBudgetMs: 500 },
    });
    const wf = await limited.create("usr_1", "sess_1", { text: "x" }, open);
    clock.wall += 2000;

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow(/time_budget/);

    const after = await limited.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("time_budget");
  });

  it("ignores illegal transitions and keep-alives a duplicate RUNNING", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, readOnly);

    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    const afterRun = (await store.getStep(step.id))!.updatedAt;
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" }); // keep-alive
    await engine.applyStepStatus(wf.id, step.id, { state: "REJECTED" }); // RUNNING->REJECTED is illegal

    const events = (await store.listEvents(wf.id)).filter((e) => e.kind === "step_status");
    // The duplicate RUNNING only moves the deadline (PROTOCOL_SPEC.md §9: any
    // step.status resets the timer); the illegal transition adds nothing.
    expect(events).toHaveLength(2);
    expect(events.every((event) => (event.payload as { state: string }).state === "RUNNING")).toBe(true);
    expect((await store.getStep(step.id))!.state).toBe("RUNNING");
    expect((await store.getStep(step.id))!.updatedAt).toBeGreaterThanOrEqual(afterRun);
  });

  it("emits no event for an update on a terminal step", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, readOnly);
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "COMPLETED" });
    const before = (await store.listEvents(wf.id)).length;

    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });

    expect((await store.listEvents(wf.id)).length).toBe(before);
  });

  it("rejects dispatch on a terminal workflow with a distinct error", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");

    const error = await engine.dispatchStep(wf.id, readOnly).catch((e) => e);

    expect(error).toBeInstanceOf(WorkflowTerminalError);
    expect(error).not.toBeInstanceOf(GuardrailError);
    expect((error as WorkflowTerminalError).state).toBe("COMPLETED");
  });

  it("refuses to dispatch while a step is still active", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.dispatchStep(wf.id, readOnly);

    const error = await engine.dispatchStep(wf.id, readOnly).catch((e) => e);

    expect(error).toBeInstanceOf(WorkflowBusyError);
    expect(await store.listSteps(wf.id)).toHaveLength(1);
  });

  it("serializes concurrent dispatches so the guardrail cannot be bypassed", async () => {
    const limited = new WorkflowEngine({
      store,
      now: () => 1000,
      guardrails: { ...DEFAULT_GUARDRAILS, maxStepsPerWorkflow: 1 },
    });
    const wf = await limited.create("usr_1", "sess_1", { text: "x" }, open);

    const results = await Promise.allSettled([
      limited.dispatchStep(wf.id, readOnly),
      limited.dispatchStep(wf.id, readOnly),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.listSteps(wf.id)).toHaveLength(1);
  });
});

describe("engine cancel after a resumed confirmation", () => {
  it("queues CANCELLING instead of cancelling a running non-interruptible step", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "human" });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });

    const after = await engine.cancel(wf.id, "abandoned");

    expect(after.state).toBe("CANCELLING");
  });
});
