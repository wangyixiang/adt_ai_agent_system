import type { CapabilityAdapter, ExecutionResult } from "../result";
import type { CapabilitySpec } from "../spec";

/**
 * `sim_rig.trigger_reset` (CAPABILITY_SPEC.md §5.3, MVP simulated). It touches
 * no real hardware: the point is to exercise confirmation, `UNKNOWN`,
 * reconciliation and the idempotency ledger before real `test_rig.*`
 * capabilities exist (MVP scope §3).
 */
export function simRigTriggerReset(spec: CapabilitySpec): CapabilityAdapter {
  return {
    spec,
    async execute(): Promise<ExecutionResult> {
      return {
        status: "completed",
        type: spec.output_type ?? "reset_ack",
        result: { reset_ack: true },
      };
    },
  };
}

/**
 * `sim_rig.query_state` (CAPABILITY_SPEC.md §5.3, MVP simulated): the read-only
 * companion used to reconcile an `UNKNOWN` reset (WORKFLOW_SPEC.md §4.3).
 */
export function simRigQueryState(spec: CapabilitySpec): CapabilityAdapter {
  return {
    spec,
    async execute(): Promise<ExecutionResult> {
      return {
        status: "completed",
        type: spec.output_type ?? "reset_state",
        result: { reset_applied: true },
      };
    },
  };
}
