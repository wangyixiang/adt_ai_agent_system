import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowOrchestrator, type PlannerDecision } from "../../src/workflow/orchestrator";
import type { Planner } from "../../src/workflow/planner";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
});
afterAll(async () => {
  await pool.end();
});

const open = { mode: "open" as const, revision: 0 };
const sideEffect = {
  objective: "复位测试台",
  capability: "sim_rig.trigger_reset",
  sideEffect: true,
  interruptible: false,
};

/**
 * The real sequence for a provider that discovers a busy resource while
 * executing: RUNNING → WAITING(human) → REJECTED. (A rejection is never legal
 * straight out of RUNNING, and the engine ignores illegal transitions — which
 * is exactly why a test that skipped the wait would silently prove nothing.)
 */
async function conflictRejectedWorkflow(engine: WorkflowEngine): Promise<string> {
  const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
  const step = await engine.dispatchStep(wf.id, sideEffect);
  await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
  await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "human" });
  await engine.applyStepStatus(wf.id, step.id, {
    state: "REJECTED",
    rejectReason: { code: "resource_conflict", message: "测试台正被占用" },
  });
  return wf.id;
}

/** Any other rejection (e.g. an undeclared capability) happens before RUNNING. */
async function otherRejectedWorkflow(engine: WorkflowEngine): Promise<string> {
  const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
  const step = await engine.dispatchStep(wf.id, sideEffect);
  await engine.applyStepStatus(wf.id, step.id, {
    state: "REJECTED",
    rejectReason: { code: "capability_unavailable" },
  });
  return wf.id;
}

function orchestratorWith(
  engine: WorkflowEngine,
  store: PostgresWorkflowStore,
  onPlanned: () => void,
): WorkflowOrchestrator {
  const planner: Planner = {
    initialCriteria: async () => open,
    proposeNext: async (): Promise<PlannerDecision> => {
      onPlanned();
      return { kind: "completion_candidate", summary: "还在跑", evidenceRefs: [] };
    },
  };
  return new WorkflowOrchestrator({ engine, store, planner, capabilitiesOf: () => [] });
}

describe("resource conflict ends the workflow", () => {
  it("fails the workflow with terminal_reason=resource_conflict and never re-plans", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const workflowId = await conflictRejectedWorkflow(engine);

    let planned = 0;
    const orch = orchestratorWith(engine, store, () => {
      planned++;
    });
    expect(await orch.advance(workflowId)).toEqual({});

    const after = (await engine.get(workflowId))!;
    expect(after.state).toBe("FAILED");
    expect(after.terminalReason).toBe("resource_conflict");
    expect(planned).toBe(0);
  });

  it("keeps re-planning for any other reject reason", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const workflowId = await otherRejectedWorkflow(engine);

    let planned = 0;
    const orch = orchestratorWith(engine, store, () => {
      planned++;
    });
    await orch.advance(workflowId);

    expect(planned).toBe(1);
    expect((await engine.get(workflowId))!.state).toBe("RUNNING");
  });

  it("still converges a cancelled workflow to CANCELLED, not FAILED", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, sideEffect);
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    // A non-interruptible side effect defers the cancel (WORKFLOW_SPEC.md §2.1).
    await engine.cancel(wf.id);
    expect((await engine.get(wf.id))!.state).toBe("CANCELLING");

    await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "human" });
    await engine.applyStepStatus(wf.id, step.id, {
      state: "REJECTED",
      rejectReason: { code: "resource_conflict", message: "测试台正被占用" },
    });

    // The cancel intent still wins when the conflict arrives.
    const orch = orchestratorWith(engine, store, () => undefined);
    await orch.advance(wf.id);

    const after = (await engine.get(wf.id))!;
    expect(after.state).toBe("CANCELLED");
    expect(after.terminalReason).toBe("user_cancelled");
  });
});
