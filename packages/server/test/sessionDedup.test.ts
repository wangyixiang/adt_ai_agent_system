import { describe, it, expect } from "vitest";
import { Connection, MessageRouter, SessionManager } from "@adt/server";

const envelope = (
  type: string,
  sessionId: string | null,
  userId: string | null,
  messageId: string,
) =>
  JSON.stringify({
    protocol_version: "0.3",
    message_id: messageId,
    session_id: sessionId,
    workflow_id: null,
    user_id: userId,
    type,
    ts: "2026-09-30T10:00:00.000Z",
    in_reply_to: null,
    payload: {},
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
    const message = envelope("capability.sync", session.id, "usr_1", "msg_1");
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

  it("dedups the resume message itself across the attach boundary", async () => {
    const sessions = new SessionManager({ ttlMs: 1000, now: () => 0 });
    const router = new MessageRouter(sessions);
    let calls = 0;
    const conn = new Connection({ send: () => {}, close: () => {} }, "c1");
    const session = sessions.create("usr_1", conn);
    sessions.detach("c1");
    router.register("session.resume", () => {
      calls++;
      sessions.attach(session.id, conn);
    });

    const message = envelope("session.resume", session.id, "usr_1", "msg_r");
    await router.handle(conn, message);
    expect(calls).toBe(1);

    // The resume's id was recorded on the pre-attach connection window; a
    // retransmission after attach must still be ignored.
    await router.handle(conn, message);
    expect(calls).toBe(1);
  });
});
