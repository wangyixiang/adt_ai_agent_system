import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import type { WorkflowEvent, WorkflowEventKind, WorkflowSnapshot } from "../../src/workflow/store";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
});
afterAll(async () => {
  await pool.end();
});

const wf: WorkflowSnapshot = {
  id: "wf_1",
  userId: "usr_1",
  sessionId: "sess_1",
  userRequest: { text: "svc down" },
  state: "CREATED",
  terminalReason: null,
  criteria: { mode: "open", revision: 0 },
  createdAt: 100,
  endedAt: null,
  notSolvedRounds: 0,
};

const ev = (id: string, kind: WorkflowEventKind): WorkflowEvent => ({
  id,
  workflowId: "wf_1",
  kind,
  ts: 100,
  payload: {},
});

const evFor = (workflowId: string, id: string, kind: WorkflowEventKind): WorkflowEvent => ({
  id,
  workflowId,
  kind,
  ts: 100,
  payload: {},
});

describe("PostgresWorkflowStore", () => {
  it("round-trips a workflow and its event atomically", async () => {
    await store.createWorkflow(wf, ev("ev_1", "workflow_created"));
    expect(await store.getWorkflow("wf_1")).toEqual(wf);
    expect((await store.listEvents("wf_1")).map((e) => e.kind)).toEqual(["workflow_created"]);
  });

  it("persists state changes and lists by user", async () => {
    await store.saveWorkflow({ ...wf, state: "RUNNING" }, ev("ev_2", "step_dispatched"));
    expect((await store.getWorkflow("wf_1"))!.state).toBe("RUNNING");
    expect(await store.listWorkflowsByUser("usr_1")).toHaveLength(1);
    expect(await store.listWorkflowsByUser("usr_other")).toHaveLength(0);
  });

  it("round-trips steps", async () => {
    await store.createStep(
      {
        id: "step_1",
        workflowId: "wf_1",
        state: "PENDING",
        objective: "check",
        capability: "git.collect_diagnostics",
        sideEffect: false,
        interruptible: true,
        idempotencyKey: null,
        attempt: 1,
        waitClass: null,
      },
      ev("ev_3", "step_dispatched"),
    );
    const step = (await store.getStep("step_1"))!;
    await store.saveStep({ ...step, state: "RUNNING" }, ev("ev_4", "step_status"));
    expect((await store.getStep("step_1"))!.state).toBe("RUNNING");
    expect(await store.listSteps("wf_1")).toHaveLength(1);
  });

  it("finds only non-terminal workflows", async () => {
    expect((await store.findActiveWorkflows()).map((w) => w.id)).toEqual(["wf_1"]);
    await store.saveWorkflow(
      { ...wf, state: "CANCELLED", terminalReason: "user_cancelled" },
      ev("ev_5", "workflow_terminated"),
    );
    expect(await store.findActiveWorkflows()).toEqual([]);
  });

  it("rolls back a combined step+workflow write when an event fails", async () => {
    // ev_1 already exists -> the event insert fails, so neither entity may change.
    const step = (await store.getStep("step_1"))!;
    expect(step.state).toBe("RUNNING");

    await expect(
      store.saveStepAndWorkflow(
        { ...step, state: "WAITING", waitClass: "human" },
        { ...wf, state: "RUNNING" },
        [ev("ev_1", "step_status")],
      ),
    ).rejects.toThrow();

    expect((await store.getStep("step_1"))!.state).toBe("RUNNING");
    expect((await store.getWorkflow("wf_1"))!.state).toBe("CANCELLED");
  });

  it("orders events by insertion, not by timestamp", async () => {
    const wf2: WorkflowSnapshot = { ...wf, id: "wf_2" };
    await store.createWorkflow(wf2, evFor("wf_2", "ev_b", "workflow_created"));
    await store.saveWorkflow(
      { ...wf2, state: "RUNNING" },
      evFor("wf_2", "ev_a", "step_dispatched"),
    );
    await store.saveWorkflow(
      { ...wf2, state: "COMPLETED" },
      evFor("wf_2", "ev_c", "workflow_terminated"),
    );

    // ids sort as a < b < c, so a (ts,id) order would return them out of
    // insertion order; the log must follow insertion order.
    const kinds = (await store.listEvents("wf_2")).map((e) => e.kind);
    expect(kinds).toEqual(["workflow_created", "step_dispatched", "workflow_terminated"]);
  });

  it("preserves the original error when ROLLBACK also fails", async () => {
    const failingClient = {
      query: async (sql: string) => {
        if (sql === "BEGIN") return {};
        if (sql === "ROLLBACK") throw new Error("rollback failed");
        throw new Error("original failure");
      },
      release: () => {},
    };
    const fakePool = {
      connect: async () => failingClient,
      query: async () => ({ rows: [] }),
    } as unknown as ReturnType<typeof createPool>;
    const failingStore = new PostgresWorkflowStore(fakePool);

    await expect(
      failingStore.createWorkflow(wf, ev("ev_x", "workflow_created")),
    ).rejects.toThrow("original failure");
  });

  it("lists workflows by session, oldest first", async () => {
    // A dedicated session id: earlier tests leave workflows in `sess_1`.
    await store.createWorkflow(
      { ...wf, id: "wf_s1a", sessionId: "sess_list" },
      evFor("wf_s1a", "ev_s1a", "workflow_created"),
    );
    await store.createWorkflow(
      { ...wf, id: "wf_s1b", sessionId: "sess_list" },
      evFor("wf_s1b", "ev_s1b", "workflow_created"),
    );
    await store.createWorkflow(
      { ...wf, id: "wf_s2", sessionId: "sess_other" },
      evFor("wf_s2", "ev_s2", "workflow_created"),
    );

    expect((await store.listWorkflowsBySession("sess_list")).map((w) => w.id)).toEqual([
      "wf_s1a",
      "wf_s1b",
    ]);
    expect(await store.listWorkflowsBySession("sess_missing")).toEqual([]);
  });
});
