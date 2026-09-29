import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("heartbeat", () => {
  it("keeps the session alive while heartbeats arrive", async () => {
    const srv = await startTestServer({ heartbeatIntervalMs: 100, maxMissed: 3 });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    for (let i = 0; i < 5; i++) {
      c.heartbeat();
      await sleep(40);
    }
    expect(srv.deadSessions).toEqual([]);
    await c.close();
    await srv.close();
  });

  it("reports the session as dead after missing heartbeats", async () => {
    const srv = await startTestServer({ heartbeatIntervalMs: 50, maxMissed: 2 });
    const c = await TestClient.connect(srv.url);
    const w = await c.hello({ username: "alice", secret: "pw-alice" });
    const sessionId = (w.payload as { session_id: string }).session_id;
    await srv.waitFor(() => srv.deadSessions.includes(sessionId), 3000);
    expect(srv.deadSessions).toContain(sessionId);
    await c.close();
    await srv.close();
  });
});
