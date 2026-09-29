import { describe, it, expect } from "vitest";
import { ERROR_DISPOSITION, makeError } from "../src";

describe("error disposition", () => {
  it("marks version/session/auth as fatal", () => {
    expect(ERROR_DISPOSITION.unsupported_version).toBe("fatal");
    expect(ERROR_DISPOSITION.session_expired).toBe("fatal");
    expect(ERROR_DISPOSITION.auth_failed).toBe("fatal");
  });

  it("marks unknown_message_type as ignore", () => {
    expect(ERROR_DISPOSITION.unknown_message_type).toBe("ignore");
  });

  it("builds a protocol.error envelope", () => {
    const e = makeError("unknown_step", "no such step", "msg_9");
    expect(e.type).toBe("protocol.error");
    expect(e.in_reply_to).toBe("msg_9");
    expect(e.payload).toEqual({ code: "unknown_step", message: "no such step" });
  });
});
