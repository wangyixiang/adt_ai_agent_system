import { describe, it, expect } from "vitest";
import { nodeCommandRunner } from "../../src/capability/exec";

describe("nodeCommandRunner", () => {
  it("captures stdout and the exit code", async () => {
    const result = await nodeCommandRunner()(process.execPath, ["-e", "process.stdout.write('hi')"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  it("reports a non-zero exit without throwing", async () => {
    const result = await nodeCommandRunner()(process.execPath, ["-e", "process.exit(3)"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(3);
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await nodeCommandRunner()(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(result.code).not.toBe(0);
  });
});
