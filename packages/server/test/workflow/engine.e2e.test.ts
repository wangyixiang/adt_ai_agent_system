import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
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

describe("workflow lifecycle e2e", () => {
  it("persists a full lifecycle and survives an engine restart", async () => {
    const terminated: string[] = [];
    const engine = new WorkflowEngine({
      store: new PostgresWorkflowStore(pool),
      now: () => 1000,
      onTerminated: (workflow) => {
        terminated.push(workflow.id);
      },
    });

    const wf = await engine.create(
      "usr_1",
      "sess_1",
      { text: "svc down" },
      { mode: "formal", assertions: ["svc == up"], revision: 1 },
    );
    const step = await engine.dispatchStep(wf.id, {
      objective: "read logs",
      capability: "test_rig.read_signal_log",
      sideEffect: false,
      interruptible: true,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "COMPLETED" });
    await engine.confirmCompletion(wf.id, "solved");

    // A brand-new engine over the same database sees the same state.
    const reloaded = new WorkflowEngine({
      store: new PostgresWorkflowStore(pool),
      now: () => 2000,
    });
    const after = await reloaded.get(wf.id);
    expect(after!.state).toBe("COMPLETED");
    expect(after!.criteria).toEqual({ mode: "formal", assertions: ["svc == up"], revision: 1 });
    expect(terminated).toEqual([wf.id]);

    // Terminal immutability survives a restart: a fresh engine must refuse
    // to dispatch another step on a COMPLETED workflow.
    await expect(
      reloaded.dispatchStep(wf.id, {
        objective: "again",
        capability: "git.collect_diagnostics",
        sideEffect: false,
        interruptible: true,
      }),
    ).rejects.toThrow();

    const events = await new PostgresWorkflowStore(pool).listEvents(wf.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("workflow_created");
    expect(kinds).toContain("step_dispatched");
    expect(kinds).toContain("step_status");
    expect(kinds).toContain("completion_response");
    expect(kinds).toContain("workflow_terminated");
  });
});
