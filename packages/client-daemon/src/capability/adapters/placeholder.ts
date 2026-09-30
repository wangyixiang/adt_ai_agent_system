import type { CapabilityAdapter, ExecutionResult } from "../result";
import type { CapabilitySpec } from "../spec";

/**
 * A declared-but-unimplemented capability. It is advertised in the Manifest
 * (without a schema, CAPABILITY_SPEC.md §5.4) and reports honestly that it
 * cannot run — it never fabricates evidence.
 */
export function placeholderAdapter(spec: CapabilitySpec): CapabilityAdapter {
  return {
    spec,
    async execute(): Promise<ExecutionResult> {
      return {
        status: "failed",
        code: "capability_error",
        message: `${spec.name} is not implemented in this MVP`,
      };
    },
  };
}
