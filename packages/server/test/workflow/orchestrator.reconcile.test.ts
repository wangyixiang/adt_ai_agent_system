import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowOrchestrator, type PlannerDecision } from "../../src/workflow/orchestrator";
import type { Planner } from "../../src/workflow/planner";
import { buildRecord } from "../../src/record/builder";
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

describe("reconciliation", () => {
  it("resolves an UNKNOWN step through a reconcile decision, with evidence refs in the Record", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.timeoutStep(wf.id, step.id);
    expect((await store.getStep(step.id))!.state).toBe("UNKNOWN");

    const planner: Planner = {
      initialCriteria: async () => ({ mode: "open", revision: 0 }),
      proposeNext: async (): Promise<PlannerDecision> => ({
        kind: "reconcile",
        stepId: step.id,
        outcome: "COMPLETED",
        evidenceRefs: ["step_evidence_1"],
      }),
    };
    const orchestrator = new WorkflowOrchestrator({
      engine,
      store,
      planner,
      capabilitiesOf: () => [],
    });
    await orchestrator.advance(wf.id);

    expect((await store.getStep(step.id))!.state).toBe("COMPLETED");

    const record = buildRecord({
      workflow: (await store.getWorkflow(wf.id))!,
      steps: await store.listSteps(wf.id),
      events: await store.listEvents(wf.id),
      userRequest: { text: "x" },
      recordId: "rec_r",
    });
    const resolved = record.entries.find((entry) => entry.kind === "reconciliation_resolved")!;
    expect(resolved.ref.resolved_to).toBe("COMPLETED");
    expect(resolved.ref.evidence_refs).toEqual(["step_evidence_1"]);
  });

  it("rejects a reconcile decision for a step that is not UNKNOWN", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });

    await expect(engine.reconcileUnknown(wf.id, step.id, "COMPLETED")).rejects.toThrow(
      "step is not UNKNOWN",
    );
  });
});
