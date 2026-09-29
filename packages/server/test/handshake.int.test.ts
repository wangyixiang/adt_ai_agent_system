import { describe, it, expect } from "vitest";
import { startTestServer } from "@adt/test-support";
import { TestClient } from "@adt/test-support";

describe("handshake", () => {
  it("welcomes an authenticated client with session_id and user_id", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const w = await c.hello({ username: "alice", secret: "pw-alice" });
    expect(w.type).toBe("session.welcome");
    expect((w.payload as any).session_id).toMatch(/^sess_/);
    expect((w.payload as any).user_id).toMatch(/^usr_/);
    await c.close();
    await srv.close();
  });

  it("rejects bad credentials with fatal auth_failed and closes", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const e = await c.hello({ username: "alice", secret: "wrong" });
    expect((e.payload as any).code).toBe("auth_failed");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("rejects an unsupported protocol version without welcome", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const e = await c.hello({ username: "alice", secret: "pw-alice", versions: ["9.9"] });
    expect((e.payload as any).code).toBe("unsupported_version");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("requires user_id on messages after the handshake", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const e = await c.sendRaw({
      ...c.base("capability.sync"),
      user_id: null,
      payload: { mode: "full", revision: 0, added: [], removed: [] },
    });
    expect((e.payload as any).code).toBe("malformed_payload");
    await c.close();
    await srv.close();
  });

  it("applies capabilities declared inline in session.hello", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({
      username: "alice",
      secret: "pw-alice",
      capabilities: [
        { name: "git.collect_diagnostics", side_effect: false, interruptible: true },
      ],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));
    expect(srv.capabilities(c.sessionId).get("git.collect_diagnostics")!.side_effect).toBe(false);
    await c.close();
    await srv.close();
  });

  it("rejects a mismatched session_id after the handshake", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const e = await c.sendRaw({
      ...c.base("capability.sync"),
      session_id: "sess_wrong",
      payload: { mode: "full", revision: 0, added: [], removed: [] },
    });
    expect((e.payload as { code: string }).code).toBe("malformed_payload");
    await c.close();
    await srv.close();
  });
});
