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

const create = () =>
  engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });

describe("engine.timeoutStep", () => {
  it("fails a read-only running step with timeout", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "r",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.timeoutStep(wf.id, step.id);

    expect((await store.getStep(step.id))!.state).toBe("FAILED");
    const event = (await store.listEvents(wf.id))
      .filter((e) => e.kind === "step_status")
      .at(-1)!;
    expect(event.payload).toMatchObject({ failReason: { code: "timeout" } });
  });

  it("marks a side-effect running step UNKNOWN", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.timeoutStep(wf.id, step.id);

    expect((await store.getStep(step.id))!.state).toBe("UNKNOWN");
  });

  it("does not time out a human-waiting step", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "e",
      capability: "human.manual_action",
      sideEffect: false,
      interruptible: true,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "human" });
    await engine.timeoutStep(wf.id, step.id);

    expect((await store.getStep(step.id))!.state).toBe("WAITING");
  });

  it("does not time out a step the client never acknowledged", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "r",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    });
    await engine.timeoutStep(wf.id, step.id);

    expect((await store.getStep(step.id))!.state).toBe("PENDING");
  });
});
