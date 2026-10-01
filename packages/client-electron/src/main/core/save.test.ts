import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { writeTextFile } from "./save";

describe("writeTextFile", () => {
  it("writes the exact bytes, in UTF-8, and creates the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adt-save-"));
    try {
      const path = join(dir, "report.md");
      await writeTextFile(path, "# 结论\n好了");
      expect(readFileSync(path, "utf8")).toBe("# 结论\n好了");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
