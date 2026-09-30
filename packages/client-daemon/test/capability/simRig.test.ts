import { describe, it, expect } from "vitest";
import { simRigTriggerReset, simRigQueryState } from "../../src/capability/adapters/simRig";
import { mvpSpec } from "../../src/capability/descriptors";

const ctx = {
  workspaceRoot: "/ws",
  run: async () => ({ stdout: "", stderr: "", code: 0 }),
};

describe("sim_rig", () => {
  it("acknowledges a reset and reports a reconciliation state", async () => {
    expect(await simRigTriggerReset(mvpSpec("sim_rig.trigger_reset")).execute({}, ctx)).toEqual({
      status: "completed",
      type: "reset_ack",
      result: { reset_ack: true },
    });
    expect(await simRigQueryState(mvpSpec("sim_rig.query_state")).execute({}, ctx)).toEqual({
      status: "completed",
      type: "reset_state",
      result: { reset_applied: true },
    });
  });

  it("declares the simulated reset conservatively", () => {
    const reset = mvpSpec("sim_rig.trigger_reset");
    expect(reset.side_effect).toBe(true);
    expect(reset.interruptible).toBe(false);
    expect(reset.idempotent).toBe(false);
    expect(mvpSpec("sim_rig.query_state").side_effect).toBe(false);
  });
});
