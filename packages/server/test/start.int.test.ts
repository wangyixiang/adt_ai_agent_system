import { describe, it, expect } from "vitest";
import { createPool, migrate, start, UserRepository, type PlannerDecision } from "@adt/server";
import { TestClient, TEST_DATABASE_URL } from "@adt/test-support";

describe("production entry point (start)", () => {
  it("serves an authenticated handshake and capability sync", async () => {
    const pool = createPool(TEST_DATABASE_URL);
    await migrate(pool);
    await pool.query("TRUNCATE users");
    await new UserRepository(pool).create("alice", "pw-alice");
    await pool.end();

    const server = await start({ port: 0, databaseUrl: TEST_DATABASE_URL });
    const c = await TestClient.connect(server.url);

    const welcome = await c.hello({ username: "alice", secret: "pw-alice" });
    expect(welcome.type).toBe("session.welcome");
    expect(c.sessionId).toMatch(/^sess_/);

    c.sync({
      mode: "full",
      revision: 0,
      added: [{ name: "git.collect_diagnostics", side_effect: false, interruptible: true }],
      removed: [],
    });

    await c.close();
    await server.close();
  });

  it("serves the workflow protocol from the production entry point", async () => {
    const pool = createPool(TEST_DATABASE_URL);
    await migrate(pool);
    await pool.query("TRUNCATE users");
    await new UserRepository(pool).create("alice", "pw-alice");
    await pool.end();

    const decisions: PlannerDecision[] = [
      {
        kind: "step",
        step: {
          objective: "read",
          capability: "git.collect_diagnostics",
          sideEffect: false,
          interruptible: true,
        },
      },
    ];
    const server = await start({
      port: 0,
      databaseUrl: TEST_DATABASE_URL,
      planner: {
        initialCriteria: async () => ({ mode: "open", revision: 0 }),
        proposeNext: async () =>
          decisions.shift() ?? { kind: "completion_candidate", summary: "", evidenceRefs: [] },
      },
    });

    const c = await TestClient.connect(server.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_1",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    expect(created.type).toBe("workflow.created");

    const dispatch = await c.next();
    expect(dispatch.type).toBe("step.dispatch");

    await c.close();
    await server.close();
  });
});
