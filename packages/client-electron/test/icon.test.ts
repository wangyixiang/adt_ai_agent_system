import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

describe("the packaging icon", () => {
  it("exists and is a 256x256 PNG (electron-builder's floor)", () => {
    const path = fileURLToPath(new URL("../build/icon.png", import.meta.url));
    const png = readFileSync(path);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBe(256);
  });
});
