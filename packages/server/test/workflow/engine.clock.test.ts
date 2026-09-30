import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { GuardrailError, WorkflowEngine } from "../../src/workflow/engine";
import { DEFAULT_GUARDRAILS } from "../../src/workflow/guardrails";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
const clock = { wall: 1_700_000_000_000, mono: 1000 };

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  clock.wall = 1_700_000_000_000;
  clock.mono = 1000;
});
afterAll(async () => {
  await pool.end();
});

const engineWith = (guardrails = DEFAULT_GUARDRAILS): WorkflowEngine =>
  new WorkflowEngine({
    store,
    now: () => clock.mono,
    wallClock: () => clock.wall,
    guardrails,
  });

const readOnly = {
  objective: "check",
  capability: "git.collect_diagnostics",
  sideEffect: false,
  interruptible: true,
};

describe("workflow timestamps", () => {
  it("stamps created_at and ended_at with the wall clock, not the ordering clock", async () => {
    const engine = engineWith();
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    expect(wf.createdAt).toBe(1_700_000_000_000);

    const ended = await engine.fail(wf.id, "planner_error");
    expect(ended.endedAt).toBe(1_700_000_000_000);

    // Events keep the monotonic ordering clock (PROTOCOL_SPEC.md §2); ordering
    // comes from the insertion sequence, not from `ts`.
    const events = await store.listEvents(wf.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.ts === 1000)).toBe(true);
  });

  it("keeps the time budget meaningful across a restart", async () => {
    // The previous process created this workflow ten minutes ago.
    const before = engineWith();
    const wf = await before.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });

    // A restart: the wall clock moves on while the (process-local) monotonic
    // clock starts over near zero — the situation that used to make the budget
    // unenforceable.
    clock.wall += 10 * 60 * 1000;
    clock.mono = 5;

    const after = engineWith({ ...DEFAULT_GUARDRAILS, timeBudgetMs: 60_000 });
    await expect(after.dispatchStep(wf.id, readOnly)).rejects.toBeInstanceOf(GuardrailError);

    const ended = (await store.getWorkflow(wf.id))!;
    expect(ended.state).toBe("FAILED");
    expect(ended.terminalReason).toBe("time_budget");
  });

  it("does not trip the budget on a workflow created before the wall clock", async () => {
    // A live workflow carried over from the previous deploy: its `created_at`
    // was written on that process's monotonic clock, so measuring it against a
    // wall clock would read as decades of runtime.
    const wf = {
      id: "wf_legacy",
      userId: "usr_1",
      sessionId: "sess_1",
      userRequest: { text: "x" },
      state: "RUNNING" as const,
      terminalReason: null,
      criteria: { mode: "open" as const, revision: 0 },
      createdAt: 1000,
      endedAt: null,
      notSolvedRounds: 0,
    };
    await store.createWorkflow(wf, {
      id: "ev_legacy",
      workflowId: wf.id,
      kind: "workflow_created",
      ts: 1000,
      payload: {},
    });

    const engine = engineWith({ ...DEFAULT_GUARDRAILS, timeBudgetMs: 60_000 });
    const step = await engine.dispatchStep(wf.id, readOnly);

    expect(step.state).toBe("PENDING");
    expect((await store.getWorkflow(wf.id))!.state).toBe("RUNNING");
  });
});
