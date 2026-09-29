import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { DEFAULT_GUARDRAILS } from "../../src/workflow/guardrails";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;
const clock = { t: 1000 };

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  clock.t = 1000;
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
    await limited.dispatchStep(wf.id, readOnly);

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow(/step_limit/);

    const after = await limited.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("step_limit");

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow();
  });

  it("fails with time_budget when the workflow runs too long", async () => {
    const limited = new WorkflowEngine({
      store,
      now: () => clock.t,
      guardrails: { ...DEFAULT_GUARDRAILS, timeBudgetMs: 500 },
    });
    const wf = await limited.create("usr_1", "sess_1", { text: "x" }, open);
    clock.t = 2000;

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow(/time_budget/);

    const after = await limited.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("time_budget");
  });
});
