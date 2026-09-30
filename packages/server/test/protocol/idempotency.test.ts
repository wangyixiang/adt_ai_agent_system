import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

describe("workflow.request idempotency", () => {
  it("returns the same workflow for a replayed client_request_id", async () => {
    const srv = await startTestServer({ planner: [] });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const payload = {
      client_request_id: "req_1",
      user_request: { text: "x", attachments: [], context: {} },
    };

    const first = await c.sendRaw({ ...c.base("workflow.request"), payload });
    const firstId = (first.payload as { workflow_id: string }).workflow_id;
    await c.next(); // completion candidate

    const second = await c.sendRaw({ ...c.base("workflow.request"), payload });
    expect((second.payload as { workflow_id: string }).workflow_id).toBe(firstId);

    await c.close();
    await srv.close();
  });

  it("scopes idempotency to the session", async () => {
    const srv = await startTestServer({ planner: [] });
    const a = await TestClient.connect(srv.url);
    await a.hello({ username: "alice", secret: "pw-alice" });
    const payload = {
      client_request_id: "req_1",
      user_request: { text: "x", attachments: [], context: {} },
    };
    const first = await a.sendRaw({ ...a.base("workflow.request"), payload });
    await a.next();
    await a.close();

    const b = await TestClient.connect(srv.url);
    await b.hello({ username: "bob", secret: "pw-bob" });
    const other = await b.sendRaw({ ...b.base("workflow.request"), payload });
    expect((other.payload as { workflow_id: string }).workflow_id).not.toBe(
      (first.payload as { workflow_id: string }).workflow_id,
    );
    await b.next(); // drain the completion candidate before closing the pool
    await b.close();
    await srv.close();
  });
});
