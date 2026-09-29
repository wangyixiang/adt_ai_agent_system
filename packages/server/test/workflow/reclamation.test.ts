import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { OrphanReclaimer } from "../../src/workflow/reclamation";
import { SessionManager } from "../../src/session/sessionManager";
import { Connection } from "../../src/ws/connection";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;
let sessions: SessionManager;
const clock = { t: 0 };

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => clock.t });
  sessions = new SessionManager({ now: () => clock.t });
  clock.t = 1000;
});
afterAll(async () => {
  await pool.end();
});

const open = { mode: "open" as const, revision: 0 };
const conn = () => new Connection({ send: () => {}, close: () => {} }, "c1");

describe("OrphanReclaimer", () => {
  it("does not reclaim within the grace period", async () => {
    const session = sessions.create("usr_1", conn());
    const wf = await engine.create("usr_1", session.id, { text: "x" }, open);

    const reclaimer = new OrphanReclaimer({ engine, store, graceMs: 5000, now: () => clock.t });
    reclaimer.onSessionDead(session.id);
    clock.t = 3000;

    expect(await reclaimer.reclaim()).toEqual([]);
    expect((await engine.get(wf.id))!.state).toBe("CREATED");
  });

  it("reclaims as FAILED(client_unreachable) after the grace period", async () => {
    const session = sessions.create("usr_1", conn());
    const wf = await engine.create("usr_1", session.id, { text: "x" }, open);

    const reclaimer = new OrphanReclaimer({ engine, store, graceMs: 5000, now: () => clock.t });
    reclaimer.onSessionDead(session.id);
    clock.t = 9000;

    expect(await reclaimer.reclaim()).toEqual([wf.id]);
    const after = await engine.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("client_unreachable");
  });

  it("reclaims as CANCELLED when cancel was already requested", async () => {
    const session = sessions.create("usr_1", conn());
    const wf = await engine.create("usr_1", session.id, { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.cancel(wf.id, "abandoned");
    expect((await engine.get(wf.id))!.state).toBe("CANCELLING");

    const reclaimer = new OrphanReclaimer({ engine, store, graceMs: 5000, now: () => clock.t });
    reclaimer.onSessionDead(session.id);
    clock.t = 9000;

    expect(await reclaimer.reclaim()).toEqual([wf.id]);
    const after = await engine.get(wf.id);
    expect(after!.state).toBe("CANCELLED");
    expect(after!.terminalReason).toBe("abandoned");
  });

  it("does not reclaim a session that comes back within the grace period", async () => {
    const session = sessions.create("usr_1", conn());
    const wf = await engine.create("usr_1", session.id, { text: "x" }, open);

    const reclaimer = new OrphanReclaimer({ engine, store, graceMs: 5000, now: () => clock.t });
    reclaimer.onSessionDead(session.id);
    reclaimer.onSessionAlive(session.id);
    clock.t = 9000;

    expect(await reclaimer.reclaim()).toEqual([]);
    expect((await engine.get(wf.id))!.state).toBe("CREATED");
  });
});
