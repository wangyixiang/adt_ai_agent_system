import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;
let t = 1000;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  t = 1000;
  engine = new WorkflowEngine({ store, now: () => t, wallClock: () => t });
});
afterAll(async () => {
  await pool.end();
});

const create = () =>
  engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });

describe("step timing and idempotency", () => {
  it("snapshots timeoutMs and mints a stable idempotency key for side-effect steps", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
      timeoutMs: 30000,
    });
    expect(step.timeoutMs).toBe(30000);
    expect(step.idempotencyKey).toMatch(/^idem_/);
    // Re-reading the persisted step keeps the same key, so a resume re-dispatch
    // of the same step is idempotent on the client (WORKFLOW_SPEC.md §4.3).
    expect((await store.getStep(step.id))!.idempotencyKey).toBe(step.idempotencyKey);
  });

  it("leaves the key null for read-only steps and refreshes updatedAt on state change", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
      timeoutMs: 5000,
    });
    expect(step.idempotencyKey).toBeNull();
    expect(step.updatedAt).toBe(1000);

    t = 2000;
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    expect((await store.getStep(step.id))!.updatedAt).toBe(2000);
  });

  it("stamps deadlines with the wall clock, not the ordering clock", async () => {
    // The deadline is persisted and read back after a restart, so it must come
    // from a clock that survives the process. If this regressed to `this.now()`
    // (production: performance.now), the timeout monitor would compare against
    // a meaningless base.
    const ordered = new WorkflowEngine({ store, now: () => 1000, wallClock: () => 5000 });
    const wf = await ordered.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await ordered.dispatchStep(wf.id, {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    });
    expect(step.updatedAt).toBe(5000);
  });
});
