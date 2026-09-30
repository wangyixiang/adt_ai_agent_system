import { describe, it, expect } from "vitest";
import { defaultRegistry } from "../../src/capability/defaultRegistry";
import { mvpDescriptors } from "../../src/capability/descriptors";

describe("defaultRegistry", () => {
  it("registers every declared MVP capability as an adapter", () => {
    const registry = defaultRegistry();
    const names = registry.specs().map((spec) => spec.name).sort();
    expect(names).toEqual([
      "browser.open_page",
      "docker.inspect_container",
      "filesystem.read_file",
      "git.collect_diagnostics",
      "local-agent.diagnose_project",
    ]);
    expect(names).toEqual(mvpDescriptors().map((spec) => spec.name).sort());
    expect(registry.descriptors().every((descriptor) => descriptor.side_effect === false)).toBe(true);
  });
});
