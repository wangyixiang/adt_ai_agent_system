import { describe, it, expect } from "vitest";

import { evidenceRefOf } from "../src/daemon";

describe("evidenceRefOf", () => {
  it("returns the blob reference when the evidence result is a BlobRef", () => {
    const ref = evidenceRefOf({
      type: "terminal.output",
      result: { content_ref: "blob_x", media_type: "text/plain", size: 12, name: "trace.log" },
    });
    expect(ref).toEqual({ content_ref: "blob_x", media_type: "text/plain", size: 12, name: "trace.log" });
  });

  it("returns undefined for inline evidence (no content_ref)", () => {
    expect(evidenceRefOf({ type: "git_status", result: { branch: "main" } })).toBeUndefined();
    expect(evidenceRefOf({ type: "note", result: "just text" })).toBeUndefined();
  });

  it("defaults media_type and size when the ref is incomplete", () => {
    expect(evidenceRefOf({ result: { content_ref: "blob_y" } })).toEqual({
      content_ref: "blob_y",
      media_type: "application/octet-stream",
      size: 0,
    });
  });
});
