import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveWithinWorkspace, resolveRealWithinWorkspace } from "../../src/capability/workspace";

const root = resolve("/tmp/ws");

describe("resolveWithinWorkspace", () => {
  it("resolves relative paths inside the root", () => {
    expect(resolveWithinWorkspace(root, "logs/app.log")).toBe(resolve(root, "logs/app.log"));
    expect(resolveWithinWorkspace(root, ".")).toBe(root);
  });

  it("rejects escapes", () => {
    expect(resolveWithinWorkspace(root, "../secret")).toBeNull();
    expect(resolveWithinWorkspace(root, "logs/../../secret")).toBeNull();
    expect(resolveWithinWorkspace(root, `/tmp/other${sep}x`)).toBeNull();
  });
});

describe("resolveRealWithinWorkspace", () => {
  it("rejects a symlinked directory that points outside the root", async () => {
    const base = await mkdtemp(join(tmpdir(), "adt-confinement-"));
    const outside = join(base, "outside");
    const ws = join(base, "ws");
    await mkdir(outside, { recursive: true });
    await mkdir(ws, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "TOPSECRET", "utf8");
    await symlink(outside, join(ws, "linkdir"), process.platform === "win32" ? "junction" : "dir");

    expect(resolveWithinWorkspace(ws, "linkdir/secret.txt")).not.toBeNull();
    expect(await resolveRealWithinWorkspace(ws, "linkdir/secret.txt")).toBeNull();

    await rm(base, { recursive: true, force: true });
  });
});

