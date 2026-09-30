import type { CapabilityAdapter, ExecutionResult } from "../result";
import type { CapabilitySpec } from "../spec";

interface InspectEntry {
  State?: { Running?: unknown };
  Config?: { Image?: unknown };
}

/**
 * `docker.inspect_container` (CAPABILITY_SPEC.md §5.3). Read-only; runs
 * `docker inspect` with a fixed cwd and a timeout.
 */
export function dockerInspectContainer(spec: CapabilitySpec): CapabilityAdapter {
  return {
    spec,
    async execute(input, ctx): Promise<ExecutionResult> {
      const container = typeof input.container === "string" ? input.container : "";
      if (container === "" || container.startsWith("-")) {
        return { status: "rejected", code: "invalid_input", message: "invalid container name" };
      }

      const result = await ctx.run("docker", ["inspect", container], {
        cwd: ctx.workspaceRoot,
        timeoutMs: spec.timeout_hint ?? 5000,
      });
      if (result.code !== 0) {
        return {
          status: "failed",
          code: "capability_error",
          message: result.stderr.trim() || "docker failed",
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { status: "failed", code: "capability_error", message: "docker inspect returned invalid JSON" };
      }

      const first = Array.isArray(parsed) ? (parsed[0] as InspectEntry | undefined) : undefined;
      const running = first?.State?.Running;
      if (typeof running !== "boolean") {
        return { status: "failed", code: "capability_error", message: "docker inspect returned no state" };
      }

      const image = typeof first?.Config?.Image === "string" ? first.Config.Image : undefined;
      return {
        status: "completed",
        type: spec.output_type ?? "container_info",
        result: image === undefined ? { running } : { running, image },
      };
    },
  };
}
