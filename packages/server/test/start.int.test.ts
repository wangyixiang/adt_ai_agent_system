import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPool,
  DEFAULT_BLOB_CONFIG,
  migrate,
  start,
  UserRepository,
  type PlannerDecision,
} from "@adt/server";
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

  it("serves the blob channel from the production entry point", async () => {
    const pool = createPool(TEST_DATABASE_URL);
    await migrate(pool);
    await pool.query("TRUNCATE users");
    await new UserRepository(pool).create("alice", "pw-alice");
    await pool.end();

    const dataDir = await mkdtemp(join(tmpdir(), "adt-blob-start-"));
    const server = await start({
      port: 0,
      databaseUrl: TEST_DATABASE_URL,
      // Keep the bytes out of the repository checkout.
      blobConfig: { ...DEFAULT_BLOB_CONFIG, secret: "start-test-secret", dataDir },
    });

    // The transfer route exists: a bad token is refused with 401, not 404.
    const base = server.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/blob/blob_x?token=bad`, { method: "PUT" })).status).toBe(401);

    // And the allocation message is registered on the protocol.
    const c = await TestClient.connect(server.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const allocation = await c.sendRaw({
      ...c.base("blob.allocate_request"),
      payload: {
        direction: "upload",
        name: "can.log",
        media_type: "text/plain",
        size: 4,
        sha256: "a".repeat(64),
      },
    });
    expect(allocation.type).toBe("blob.allocate_response");
    expect((allocation.payload as { url: string }).url).toContain(`${base}/blob/`);

    await c.close();
    await server.close();
  });
});
