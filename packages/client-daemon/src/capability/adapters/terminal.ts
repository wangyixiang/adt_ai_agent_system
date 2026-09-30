import type { CapabilityAdapter, ExecutionResult } from "../result";
import type { CapabilitySpec } from "../spec";

/**
 * `terminal.execute_command` (CAPABILITY_SPEC.md §2/§5.3). Its content cannot
 * be predicted, so it is declared with a side effect and only ever runs after
 * an explicit confirmation (WORKFLOW_SPEC.md §4.2).
 *
 * A non-zero exit code is an observation, not a failure: the command ran, and
 * `exit_code` is exactly what the Schema promises to report. Only a rejected
 * input or a spawn error the runner itself reports is a failure.
 */
export function terminalExecuteCommand(spec: CapabilitySpec): CapabilityAdapter {
  return {
    spec,
    async execute(input, ctx): Promise<ExecutionResult> {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (command === "") {
        return { status: "rejected", code: "invalid_input", message: "command is required" };
      }

      const args = Array.isArray(input.args)
        ? input.args.filter((arg): arg is string => typeof arg === "string")
        : [];

      const result = await ctx.run(command, args, {
        cwd: ctx.workspaceRoot,
        timeoutMs: spec.timeout_hint ?? 30_000,
      });

      // "Did not run" is not an observation (CAPABILITY_SPEC.md §5.3), so it
      // must not be dressed up as `exit_code: -1`.
      if (result.failure === "timeout") {
        return { status: "failed", code: "timeout", message: "command exceeded its timeout" };
      }
      if (result.failure !== undefined) {
        return {
          status: "failed",
          code: "capability_error",
          message: result.stderr.trim() || "command could not be started",
        };
      }

      return {
        status: "completed",
        type: spec.output_type ?? "command_result",
        result: { exit_code: result.code, stdout: result.stdout },
      };
    },
  };
}
