import { describe, it, expect } from "vitest";
import { encodeEnvelope, decodeEnvelope, EnvelopeError, PROTOCOL_VERSION } from "../src";

const base = {
  protocol_version: PROTOCOL_VERSION,
  message_id: "msg_1",
  session_id: null,
  workflow_id: null,
  user_id: null,
  type: "session.hello",
  ts: "2026-09-30T10:00:00.000Z",
  in_reply_to: null,
  payload: { a: 1 },
};

describe("envelope", () => {
  it("round-trips a valid envelope", () => {
    expect(decodeEnvelope(encodeEnvelope(base))).toEqual(base);
  });

  it("rejects invalid JSON", () => {
    expect(() => decodeEnvelope("{")).toThrow(EnvelopeError);
  });

  it("rejects non-UTC ts", () => {
    expect(() =>
      decodeEnvelope(JSON.stringify({ ...base, ts: "2026-09-30T10:00:00+08:00" })),
    ).toThrow(EnvelopeError);
  });

  it("rejects missing type", () => {
    const { type, ...rest } = base;
    expect(() => decodeEnvelope(JSON.stringify(rest))).toThrow(EnvelopeError);
  });
});
