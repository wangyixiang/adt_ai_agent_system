import { describe, it, expect } from "vitest";

import type { IncomingAttachment } from "../../shared/contract";
import {
  checkAttachments,
  INLINE_THRESHOLD_BYTES,
  MAX_ATTACHMENTS,
  normalizeMediaType,
  planAttachment,
} from "./attachments";

const incoming = (bytes: number): IncomingAttachment => ({
  name: "a.log",
  mediaType: "text/plain",
  dataBase64: Buffer.alloc(bytes, 65).toString("base64"),
});

describe("attachment planning", () => {
  it("normalizes a media type against the whitelist", () => {
    expect(normalizeMediaType("text/plain")).toBe("text/plain");
    expect(normalizeMediaType("application/x-evil")).toBe("application/octet-stream");
  });

  it("inlines exactly at the threshold and offloads above it", () => {
    expect(planAttachment(new Uint8Array(INLINE_THRESHOLD_BYTES)).mode).toBe("inline");
    expect(planAttachment(new Uint8Array(INLINE_THRESHOLD_BYTES + 1)).mode).toBe("blob");
  });

  it("rejects too many attachments", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => incoming(1));
    expect(checkAttachments(many)).toMatchObject({ ok: false, code: "too_many" });
  });

  it("rejects a total over the byte cap", () => {
    // Two 20 MiB payloads exceed the 32 MiB cap but stay under the count cap.
    expect(checkAttachments([incoming(20 * 1024 * 1024), incoming(20 * 1024 * 1024)])).toMatchObject({
      ok: false,
      code: "too_large",
    });
  });

  it("accepts a normal set", () => {
    expect(checkAttachments([incoming(10), incoming(200)])).toEqual({ ok: true });
  });
});
