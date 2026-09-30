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
      "sim_rig.query_state",
      "sim_rig.trigger_reset",
      "terminal.execute_command",
    ]);
    expect(names).toEqual(mvpDescriptors().map((spec) => spec.name).sort());
  });

  it("declares every side effect conservatively", () => {
    const registry = defaultRegistry();
    const sideEffects = registry
      .specs()
      .filter((spec) => spec.side_effect)
      .map((spec) => spec.name)
      .sort();
    expect(sideEffects).toEqual(["sim_rig.trigger_reset", "terminal.execute_command"]);
    // A side effect that cannot be interrupted is the conservative declaration
    // (CAPABILITY_SPEC.md §2): claiming interruptibility means promising to stop
    // a half-done action on a cancel.
    expect(
      registry
        .specs()
        .filter((spec) => spec.side_effect)
        .every((spec) => spec.interruptible === false),
    ).toBe(true);
  });
});
