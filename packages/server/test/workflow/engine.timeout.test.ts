import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowBlockedError, WorkflowEngine } from "../../src/workflow/engine";
import { toStepStatusUpdate } from "../../src/protocol/workflowProtocol";
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

describe("engine.timeoutStep", () => {
  it("fails a read-only running step with timeout", async () => {    const wf = await create();
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

  it("does not let a keep-alive RUNNING be timed out by a stale deadline", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "long",
      capability: "terminal.execute_command",
      sideEffect: true,
      interruptible: false,
      timeoutMs: 1000,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });

    // Wall clock moves past the deadline; the client reports progress, which
    // resets it (PROTOCOL_SPEC.md §9: any step.status resets the timer).
    t = 5000;
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING", progress: { ratio: 0.5 } });
    expect((await store.getStep(step.id))!.updatedAt).toBe(5000);

    const event = (await store.listEvents(wf.id))
      .filter((e) => e.kind === "step_status")
      .at(-1)!;
    expect(event.payload).toMatchObject({ state: "RUNNING", progress: { ratio: 0.5 } });
  });

  it("does not time out a step parked on a resource conflict", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
      timeoutMs: 1000,
    });
    await engine.applyStepStatus(
      wf.id,
      step.id,
      toStepStatusUpdate({ status: "WAITING", wait_reason: { code: "resource_conflict" } })!,
    );

    // Long past the deadline: a human wait has no deadline, and turning this
    // into UNKNOWN would start reconciliation for an action that never ran.
    t = 99_999;
    await engine.timeoutStep(wf.id, step.id);
    expect((await store.getStep(step.id))!.state).toBe("WAITING");
  });

  it("keeps an execution-class WAITING step alive too", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, {
      objective: "wait",
      capability: "sim_rig.query_state",
      sideEffect: false,
      interruptible: true,
      timeoutMs: 1000,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "execution" });
    expect((await store.getStep(step.id))!.updatedAt).toBe(1000);

    t = 4000;
    await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "execution" });

    const after = (await store.getStep(step.id))!;
    expect(after.state).toBe("WAITING");
    expect(after.updatedAt).toBe(4000);
  });
});

describe("side-effect blocking (WORKFLOW_SPEC.md §4.3)", () => {
  it("refuses a side effect while another one is unreconciled, but allows reads", async () => {
    const wf = await create();
    const reset = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, reset.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, reset.id, { state: "UNKNOWN" });

    await expect(
      engine.dispatchStep(wf.id, {
        objective: "reset again",
        capability: "sim_rig.trigger_reset",
        sideEffect: true,
        interruptible: false,
      }),
    ).rejects.toBeInstanceOf(WorkflowBlockedError);
    // Nothing was created by the refused dispatch.
    expect(await store.listSteps(wf.id)).toHaveLength(1);

    // A read-only step (or a reconciliation) is still allowed.
    const read = await engine.dispatchStep(wf.id, {
      objective: "check",
      capability: "sim_rig.query_state",
      sideEffect: false,
      interruptible: true,
    });
    expect(read.state).toBe("PENDING");
  });

  it("allows the side effect again once the UNKNOWN is reconciled", async () => {
    const wf = await create();
    const reset = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, reset.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, reset.id, { state: "UNKNOWN" });
    await engine.reconcileUnknown(wf.id, reset.id, "FAILED", [reset.id]);

    const again = await engine.dispatchStep(wf.id, {
      objective: "reset again",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    expect(again.state).toBe("PENDING");
  });
});
