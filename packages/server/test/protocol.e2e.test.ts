import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";
import { newMessageId } from "@adt/shared";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("protocol e2e (P1 acceptance)", () => {
  it("A. authenticated session + capability sync + heartbeat stays alive", async () => {
    const srv = await startTestServer({ heartbeatIntervalMs: 80, maxMissed: 3 });
    const c = await TestClient.connect(srv.url);

    const welcome = await c.hello({ username: "alice", secret: "pw-alice" });
    expect(welcome.type).toBe("session.welcome");
    expect(c.sessionId).toMatch(/^sess_/);
    expect(c.userId).toMatch(/^usr_/);

    c.sync({
      mode: "full",
      revision: 0,
      added: [
        { name: "git.collect_diagnostics", side_effect: false, interruptible: true },
        { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
      ],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("sim_rig.trigger_reset"));

    for (let i = 0; i < 5; i++) {
      c.heartbeat();
      await sleep(40);
    }
    expect(srv.deadSessions).toEqual([]);

    await c.close();
    await srv.close();
  });

  it("B. wrong password -> auth_failed and close", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const err = await c.hello({ username: "alice", secret: "wrong" });
    expect((err.payload as { code: string }).code).toBe("auth_failed");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("C. unsupported version -> close without welcome", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const err = await c.hello({
      username: "alice",
      secret: "pw-alice",
      versions: ["9.9"],
    });
    expect((err.payload as { code: string }).code).toBe("unsupported_version");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("D. unknown message type -> error, connection stays", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const first = await c.sendRaw(c.base("nope.unknown"));
    expect((first.payload as { code: string }).code).toBe("unknown_message_type");

    const second = await c.sendRaw(c.base("still.unknown"));
    expect((second.payload as { code: string }).code).toBe("unknown_message_type");

    await c.close();
    await srv.close();
  });

  it("E. stale revision ignored; unregistered name ignored; defaults conservative", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    c.sync({
      mode: "full",
      revision: 7,
      added: [
        { name: "filesystem.read_file", side_effect: false, interruptible: true },
        { name: "git.collect_diagnostics" },
        { name: "not.registered_thing" },
      ],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));

    const caps = srv.capabilities(c.sessionId);
    expect(caps.get("git.collect_diagnostics")!.side_effect).toBe(true);
    expect(caps.get("git.collect_diagnostics")!.interruptible).toBe(false);
    expect(caps.get("git.collect_diagnostics")!.idempotent).toBe(false);
    expect(caps.has("not.registered_thing")).toBe(false);

    c.sync({ mode: "incremental", revision: 2, added: [{ name: "docker.inspect_container" }], removed: [] });
    await srv.waitFor(() =>
      srv.warnings(c.sessionId).some((w) => /stale revision/i.test(w)),
    );
    expect(srv.capabilities(c.sessionId).has("docker.inspect_container")).toBe(false);

    await c.close();
    await srv.close();
  });

  it("F. missing user_id after handshake -> malformed_payload", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const err = await c.sendRaw({
      ...c.base("capability.sync"),
      user_id: null,
      payload: { mode: "full", revision: 0, added: [], removed: [] },
    });
    expect((err.payload as { code: string }).code).toBe("malformed_payload");

    await c.close();
    await srv.close();
  });

  it("G. duplicate message_id processed once", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const envelope = {
      ...c.base("capability.sync"),
      message_id: newMessageId(),
      payload: {
        mode: "full" as const,
        revision: 0,
        added: [{ name: "filesystem.read_file", side_effect: false, interruptible: true }],
        removed: [],
      },
    };

    c.send(envelope);
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("filesystem.read_file"));

    // Same message_id again: the dedup window must ignore it.
    c.send(envelope);
    await srv.waitFor(() =>
      srv.warnings(c.sessionId).some((w) => /duplicate message_id/i.test(w)),
    );

    expect(srv.capabilities(c.sessionId).has("filesystem.read_file")).toBe(true);

    await c.close();
    await srv.close();
  });
});
