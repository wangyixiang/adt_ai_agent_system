import { describe, it, expect } from "vitest";
import { Connection, MessageRouter, SessionManager } from "@adt/server";

const raw = (sessionId: string, userId: string, messageId: string) =>
  JSON.stringify({
    protocol_version: "0.3",
    message_id: messageId,
    session_id: sessionId,
    workflow_id: null,
    user_id: userId,
    type: "capability.sync",
    ts: "2026-09-30T10:00:00.000Z",
    in_reply_to: null,
    payload: { mode: "full", revision: 0, added: [], removed: [] },
  });

describe("session dedup window", () => {
  it("dedups on the session window, carried across a reconnect", async () => {
    const sessions = new SessionManager({ ttlMs: 100, now: () => 0 });
    const router = new MessageRouter(sessions);
    let calls = 0;
    router.register("capability.sync", () => {
      calls++;
    });

    const first = new Connection({ send: () => {}, close: () => {} }, "c1");
    const session = sessions.create("usr_1", first);
    const message = raw(session.id, "usr_1", "msg_1");
    await router.handle(first, message);
    expect(calls).toBe(1);

    // The same message_id redelivered on a NEW physical connection must still
    // be recognised: the window belongs to the logical session, not the socket.
    sessions.detach("c1");
    const second = new Connection({ send: () => {}, close: () => {} }, "c2");
    sessions.attach(session.id, second);
    await router.handle(second, message);
    expect(calls).toBe(1);
  });
});
