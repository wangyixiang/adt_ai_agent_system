import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => 1000 });
});
afterAll(async () => {
  await pool.end();
});

describe("evidence on step status", () => {
  it("stores the evidence returned by the client on COMPLETED", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, {
      state: "COMPLETED",
      evidence: { source: "capability", type: "git_status", result: { branch: "main" } },
    });

    const events = await store.listEvents(wf.id);
    const completed = events.find(
      (e) => e.kind === "step_status" && (e.payload as { state: string }).state === "COMPLETED",
    )!;
    expect((completed.payload as { evidence: unknown }).evidence).toEqual({
      source: "capability",
      type: "git_status",
      result: { branch: "main" },
    });
  });

  it("stores partial evidence on FAILED", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, {
      state: "FAILED",
      evidence: { source: "system", type: "partial", result: { lines: 3 } },
    });

    const events = await store.listEvents(wf.id);
    const failed = events.find(
      (e) => e.kind === "step_status" && (e.payload as { state: string }).state === "FAILED",
    )!;
    expect((failed.payload as { evidence: unknown }).evidence).toEqual({
      source: "system",
      type: "partial",
      result: { lines: 3 },
    });
  });
});
