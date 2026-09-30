import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemReadFile } from "../../src/capability/adapters/filesystem";
import { mvpSpec } from "../../src/capability/descriptors";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "adt-ws-"));
  await writeFile(join(root, "hello.txt"), "hello", "utf8");
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(tmpdir(), "outside.txt"), "secret", "utf8");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const adapter = () => filesystemReadFile(mvpSpec("filesystem.read_file"));
const ctx = () => ({
  workspaceRoot: root,
  run: async () => ({ stdout: "", stderr: "", code: 0 }),
});

describe("filesystem.read_file", () => {
  it("reads a file inside the workspace with a faithful result", async () => {
    const result = await adapter().execute({ path: "hello.txt" }, ctx());
    expect(result).toEqual({
      status: "completed",
      type: "file_content",
      result: { content: "hello", encoding: "utf8", path: "hello.txt" },
    });
  });

  it("refuses to escape the workspace", async () => {
    const escape = await adapter().execute({ path: "../outside.txt" }, ctx());
    expect(escape.status).toBe("failed");
    expect((escape as { code: string }).code).toBe("invalid_input");
    expect(JSON.stringify(escape)).not.toContain("secret");
  });

  it("fails cleanly for a missing file", async () => {
    const missing = await adapter().execute({ path: "nope.txt" }, ctx());
    expect(missing.status).toBe("failed");
  });
});
