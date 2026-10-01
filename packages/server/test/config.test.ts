import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { loadEnvFile } from "../src/config";

const touched: string[] = [];
afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
});

describe("loadEnvFile", () => {
  it("lets the real environment win over the file", () => {
    process.env.ADT_PROBE_A = "from-real-env";
    touched.push("ADT_PROBE_A", "ADT_PROBE_B");
    const dir = mkdtempSync(join(tmpdir(), "adt-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "ADT_PROBE_A=from-dotenv\nADT_PROBE_B=only-dotenv\n");
      loadEnvFile(file);
      expect(process.env.ADT_PROBE_A).toBe("from-real-env");
      expect(process.env.ADT_PROBE_B).toBe("only-dotenv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a silent no-op when the file is missing", () => {
    expect(() => loadEnvFile(join(tmpdir(), "adt-nope", ".env"))).not.toThrow();
  });
});
