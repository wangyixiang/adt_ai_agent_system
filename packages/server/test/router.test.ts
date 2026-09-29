import { describe, it, expect } from "vitest";
import { MessageRouter } from "../src/ws/messageRouter";
import { Connection } from "../src/ws/connection";
import { encodeEnvelope, PROTOCOL_VERSION } from "@adt/shared";

function makeConn() {
  const sent: string[] = [];
  let closed = false;
  const conn = new Connection(
    { send: (data: string) => sent.push(data), close: () => { closed = true; } },
    "c1",
  );
  return {
    conn,
    sent,
    isClosed: () => closed,
    last: () => JSON.parse(sent.at(-1)!) as { payload: { code: string } },
  };
}

const resolver = { byConnection: () => null };

const env = (type: string, extra: Record<string, unknown> = {}) => ({
  protocol_version: PROTOCOL_VERSION,
  message_id: "msg_1",
  session_id: null,
  workflow_id: null,
  user_id: null,
  type,
  ts: "2026-09-30T10:00:00.000Z",
  in_reply_to: null,
  payload: {},
  ...extra,
});

describe("MessageRouter", () => {
  it("replies unknown_message_type and keeps the connection", async () => {
    const r = new MessageRouter(resolver);
    const c = makeConn();
    await r.handle(c.conn, JSON.stringify(env("nope.unknown")));
    expect(c.last().payload.code).toBe("unknown_message_type");
    expect(c.isClosed()).toBe(false);
    expect(c.conn.warnings.join(" ")).toMatch(/unknown message type/i);
  });

  it("replies malformed_payload on bad JSON", async () => {
    const r = new MessageRouter(resolver);
    const c = makeConn();
    await r.handle(c.conn, "{");
    expect(c.last().payload.code).toBe("malformed_payload");
  });

  it("ignores a duplicate message_id", async () => {
    const r = new MessageRouter(resolver);
    const c = makeConn();
    let calls = 0;
    r.register("session.hello", () => {
      calls++;
    });
    const raw = JSON.stringify(env("session.hello"));
    await r.handle(c.conn, raw);
    await r.handle(c.conn, raw);
    expect(calls).toBe(1);
    expect(c.conn.warnings.join(" ")).toMatch(/duplicate/i);
  });

  it("turns a handler exception into a warning and keeps the connection", async () => {
    const r = new MessageRouter(resolver);
    const c = makeConn();
    r.register("boom", () => {
      throw new Error("kaboom");
    });
    await r.handle(c.conn, JSON.stringify(env("boom")));
    expect(c.conn.warnings.join(" ")).toMatch(/handler/i);
    expect(c.isClosed()).toBe(false);
  });

  it("processes one connection's messages strictly in arrival order", async () => {
    const r = new MessageRouter(resolver);
    const c = makeConn();
    const order: string[] = [];
    r.register("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow");
    });
    r.register("fast", () => {
      order.push("fast");
    });

    const first = r.handle(c.conn, JSON.stringify(env("slow", { message_id: "msg_a" })));
    const second = r.handle(c.conn, JSON.stringify(env("fast", { message_id: "msg_b" })));
    await Promise.all([first, second]);

    expect(order).toEqual(["slow", "fast"]);
  });
});
