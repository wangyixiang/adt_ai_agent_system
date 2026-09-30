import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../../src/capability/registry";
import type { CapabilityAdapter } from "../../src/capability/result";

const adapter = (name: string, side_effect: boolean): CapabilityAdapter => ({
  spec: {
    name,
    side_effect,
    interruptible: true,
    output_type: "git_status",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
  },
  execute: async () => ({ status: "completed", type: "x", result: {} }),
});

describe("CapabilityRegistry", () => {
  it("registers adapters and exposes descriptors for the manifest", () => {
    const registry = new CapabilityRegistry();
    registry.register(adapter("git.collect_diagnostics", false));
    registry.register(adapter("sim_rig.trigger_reset", true));

    expect(registry.get("git.collect_diagnostics")!.spec.side_effect).toBe(false);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.descriptors()).toEqual([
      {
        name: "git.collect_diagnostics",
        side_effect: false,
        interruptible: true,
        idempotent: undefined,
        timeout_hint: undefined,
        output_type: "git_status",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
      },
      {
        name: "sim_rig.trigger_reset",
        side_effect: true,
        interruptible: true,
        idempotent: undefined,
        timeout_hint: undefined,
        output_type: "git_status",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
      },
    ]);
  });
});
