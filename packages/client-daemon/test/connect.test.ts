import { describe, it, expect } from "vitest";
import { startTestServer } from "@adt/test-support";
import { DaemonConnection } from "../src/connection";

describe("client-daemon connection", () => {
  it("authenticates, syncs capabilities and heartbeats", async () => {
    const srv = await startTestServer({ heartbeatIntervalMs: 50, maxMissed: 3 });
    const d = await DaemonConnection.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "daemon-test", platform: "win32" },
      capabilities: [
        { name: "git.collect_diagnostics", side_effect: false, interruptible: true },
        {
          name: "sim_rig.trigger_reset",
          side_effect: true,
          interruptible: false,
          idempotent: false,
        },
      ],
    });

    expect(d.userId).toMatch(/^usr_/);
    expect(d.sessionId).toMatch(/^sess_/);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(srv.deadSessions).toEqual([]);
    await srv.waitFor(() => srv.capabilities(d.sessionId).has("git.collect_diagnostics"));

    await d.close();
    await srv.close();
  });
});
