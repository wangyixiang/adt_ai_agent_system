import { describe, it, expect } from "vitest";
import { mvpDescriptors } from "../../src/capability/descriptors";

describe("mvpDescriptors", () => {
  it("declares the MVP capabilities with their schemas", () => {
    const byName = new Map(mvpDescriptors().map((spec) => [spec.name, spec]));
    expect(byName.get("git.collect_diagnostics")!.output_type).toBe("git_status");
    expect(byName.get("git.collect_diagnostics")!.side_effect).toBe(false);
    expect(byName.get("filesystem.read_file")!.output_type).toBe("file_content");
    expect(byName.get("filesystem.read_file")!.input_schema).toEqual({
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    });
    expect(byName.get("docker.inspect_container")!.side_effect).toBe(false);
    // Placeholders are declared but carry no schema (CAPABILITY_SPEC.md §5.4).
    expect(
      mvpDescriptors()
        .filter((spec) => spec.input_schema === undefined)
        .map((spec) => spec.name)
        .sort(),
    ).toEqual(["browser.open_page", "local-agent.diagnose_project"]);
    // Everything that can change local state must say so (CAPABILITY_SPEC.md §2).
    expect(
      mvpDescriptors()
        .filter((spec) => spec.side_effect)
        .map((spec) => spec.name)
        .sort(),
    ).toEqual(["sim_rig.trigger_reset", "terminal.execute_command"]);
  });
});
