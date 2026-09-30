import { readFile, stat } from "node:fs/promises";
import type { CapabilityAdapter, ExecutionResult } from "../result";
import type { CapabilitySpec } from "../spec";
import { resolveRealWithinWorkspace } from "../workspace";

const MAX_BYTES = 256 * 1024;

/**
 * `filesystem.read_file` (CAPABILITY_SPEC.md §5.3). Reads a UTF-8 file that
 * lives inside the configured workspace; anything outside is refused before
 * the filesystem is touched.
 */
export function filesystemReadFile(spec: CapabilitySpec): CapabilityAdapter {
  return {
    spec,
    async execute(input, ctx): Promise<ExecutionResult> {
      const target = typeof input.path === "string" ? input.path : "";
      if (target === "") {
        return { status: "rejected", code: "invalid_input", message: "path is required" };
      }

      const abs = await resolveRealWithinWorkspace(ctx.workspaceRoot, target);
      if (!abs) {
        return { status: "rejected", code: "invalid_input", message: "path escapes the workspace" };
      }

      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        return { status: "failed", code: "capability_error", message: "no such file" };
      }
      if (size > MAX_BYTES) {
        return { status: "failed", code: "capability_error", message: "file too large" };
      }

      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        return { status: "failed", code: "capability_error", message: "read failed" };
      }

      return {
        status: "completed",
        type: spec.output_type ?? "file_content",
        result: { content, encoding: "utf8", path: target },
      };
    },
  };
}
