import { describe, it, expect } from "vitest";
import { Connection } from "../../src/ws/connection";
import { sendError } from "../../src/ws/errors";

function makeConn() {
  const sent: Array<{ payload: { code: string; message: string } }> = [];
  const conn = new Connection(
    { send: (data: string) => sent.push(JSON.parse(data)), close: () => {} },
    "conn_1",
  );
  return { conn, sent };
}

describe("sendError disposition", () => {
  it("closes the connection after emitting a fatal error", () => {
    const { conn, sent } = makeConn();
    sendError(conn, null, "auth_failed", "invalid credentials", "msg_1");
    expect(sent[0]!.payload).toEqual({ code: "auth_failed", message: "invalid credentials" });
    expect(conn.isClosed).toBe(true);
  });

  it("keeps the connection for request-level and ignorable errors", () => {
    const { conn } = makeConn();
    sendError(conn, null, "malformed_payload", "bad", "msg_1");
    sendError(conn, null, "unknown_message_type", "bad", "msg_2");
    sendError(conn, null, "unknown_workflow", "bad", "msg_3");
    expect(conn.isClosed).toBe(false);
  });
});
