import { describe, it, expect } from "vitest";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";
import { openSessionStore } from "../src/sessionStore";

const credentials = { username: "alice", secret: "pw-alice" };
const clientInfo = { name: "resume-test", platform: "test" };

describe("client session resume", () => {
  it("keeps the logical session across a reconnect", async () => {
    const srv = await startTestServer({});
    const sessionStore = openSessionStore(":memory:");

    const first = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
    });
    const sessionId = first.connection.sessionId;
    await first.close();

    const second = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
    });

    // Resumed, not re-handshaken: the logical session is what carries the
    // workflows and the capability manifest.
    expect(second.connection.sessionId).toBe(sessionId);
    expect(sessionStore.load()).toEqual({ sessionId, userId: second.connection.userId });

    await second.close();
    await srv.close();
  });

  it("falls back to a fresh handshake when the remembered session is gone", async () => {
    const srv = await startTestServer({ sessionTtlMs: 1 });
    const sessionStore = openSessionStore(":memory:");

    const first = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
    });
    const stale = first.connection.sessionId;
    await first.close();
    // Let the session expire so the resume is refused.
    await srv.waitFor(() => false, 30).catch(() => undefined);

    const second = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
    });

    expect(second.connection.sessionId).not.toBe(stale);
    // The remembered session is replaced by the one we actually got.
    expect(sessionStore.load()!.sessionId).toBe(second.connection.sessionId);

    await second.close();
    await srv.close();
  });
});
