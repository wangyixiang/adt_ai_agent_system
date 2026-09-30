import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";
import { openLedger } from "../src/ledger";
import { openSessionStore } from "../src/sessionStore";

const credentials = { username: "alice", secret: "pw-alice" };
const clientInfo = { name: "resume-test", platform: "test" };

/** A resumable client needs both stores on disk; that is the point of the gate. */
const durable = () => {
  const dir = mkdtempSync(join(tmpdir(), "adt-resume-"));
  return {
    sessionStore: openSessionStore(join(dir, "session.db")),
    ledger: openLedger(join(dir, "ledger.db")),
  };
};

describe("client session resume", () => {
  it("keeps the logical session across a reconnect", async () => {
    const srv = await startTestServer({});
    const first = durable();
    const sessionStore = first.sessionStore;

    const before = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
      ledger: first.ledger,
    });
    const sessionId = before.connection.sessionId;
    await before.close();

    const second = durable();
    // Same session store, a fresh (but still file-backed) ledger handle — as a
    // restarted process would have.
    const after = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
      ledger: second.ledger,
    });

    // Resumed, not re-handshaken: the logical session is what carries the
    // workflows and the capability manifest.
    expect(after.connection.sessionId).toBe(sessionId);
    expect(sessionStore.load()).toEqual({ sessionId, userId: after.connection.userId });

    // The manifest survived the reconnect: resume deliberately does not re-send
    // `capability.sync` (a `revision: 0` resend would be dropped as stale), so
    // the session must still hold what it declared.
    expect(srv.capabilities(sessionId).size).toBeGreaterThan(0);
    expect(srv.warnings(sessionId).join("\n")).not.toContain("stale revision");

    await after.close();
    await srv.close();
  });

  it("falls back to a fresh handshake when the remembered session is gone", async () => {
    const srv = await startTestServer({ sessionTtlMs: 1 });
    const first = durable();
    const sessionStore = first.sessionStore;

    const before = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
      ledger: first.ledger,
    });
    const stale = before.connection.sessionId;
    await before.close();
    // Let the session expire so the resume is refused.
    await srv.waitFor(() => false, 30).catch(() => undefined);

    const second = durable();
    const after = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
      ledger: second.ledger,
    });

    expect(after.connection.sessionId).not.toBe(stale);
    // The remembered session is replaced by the one we actually got.
    expect(sessionStore.load()!.sessionId).toBe(after.connection.sessionId);

    await after.close();
    await srv.close();
  });

  it("does not resume when the ledger cannot outlive the process", async () => {
    const srv = await startTestServer({});
    const sessionStore = openSessionStore(":memory:");

    const first = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      // A persistent session store but only an in-memory ledger: resuming could
      // hand back a mid-flight side effect that the (empty) ledger reads as
      // "never ran" — so the daemon must start a fresh session instead.
      sessionStore,
      ledger: openLedger(":memory:"),
    });
    const sessionId = first.connection.sessionId;
    await first.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const second = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      sessionStore,
      ledger: openLedger(":memory:"),
    });
    const warned = warn.mock.calls.map((call) => String(call[0])).join("\n");
    warn.mockRestore();

    expect(second.connection.sessionId).not.toBe(sessionId);
    expect(warned).toContain("not resuming");

    await second.close();
    await srv.close();
  });
});
