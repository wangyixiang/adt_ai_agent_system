import { describe, it, expect } from "vitest";

import { classifyBlob } from "./blobs";

describe("classifyBlob", () => {
  it("decodes text and json", () => {
    expect(classifyBlob(new TextEncoder().encode("hello"), "text/plain")).toEqual({
      kind: "text",
      mediaType: "text/plain",
      text: "hello",
    });
    expect(classifyBlob(new TextEncoder().encode("{}"), "application/json").kind).toBe("text");
  });

  it("turns images into a data URL", () => {
    const preview = classifyBlob(new Uint8Array([137, 80, 78, 71]), "image/png");
    expect(preview.kind).toBe("image");
    if (preview.kind === "image") expect(preview.dataUrl).toBe("data:image/png;base64,iVBORw==");
  });

  it("calls anything else binary", () => {
    expect(classifyBlob(new Uint8Array([1, 2, 3]), "application/zip")).toEqual({
      kind: "binary",
      mediaType: "application/zip",
      size: 3,
    });
  });
});
