import { describe, it, expect } from "vitest";
import { resolve, sep } from "node:path";
import { resolveWithinWorkspace } from "../../src/capability/workspace";

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
