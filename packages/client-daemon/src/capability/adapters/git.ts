import type { CapabilityAdapter, ExecutionResult } from "../result";
import type { CapabilitySpec } from "../spec";
import { resolveWithinWorkspace } from "../workspace";

interface GitStatus {
  branch: string;
  modified_files: number;
  untracked_files: number;
}

/**
 * Parses `git status --porcelain=v1 --branch`:
 * the first `## ` line carries the branch; `?? ` lines are untracked; every
 * other entry (staged, modified, renamed, …) counts as changed.
 */
function parsePorcelain(stdout: string): GitStatus {
  let branch = "";
  let modified = 0;
  let untracked = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (line === "") continue;
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0]!.split(" ")[0] ?? "";
      continue;
    }
    if (line.startsWith("?? ")) {
      untracked++;
      continue;
    }
    modified++;
  }

  return { branch, modified_files: modified, untracked_files: untracked };
}

/**
 * `git.collect_diagnostics` (CAPABILITY_SPEC.md §5.3). Read-only; runs `git`
 * with a fixed cwd, confined to the workspace.
 */
export function gitCollectDiagnostics(spec: CapabilitySpec): CapabilityAdapter {
  return {
    spec,
    async execute(input, ctx): Promise<ExecutionResult> {
      const projectPath = typeof input.project_path === "string" ? input.project_path : ".";
      const abs = resolveWithinWorkspace(ctx.workspaceRoot, projectPath);
      if (!abs) {
        return { status: "failed", code: "invalid_input", message: "project_path escapes the workspace" };
      }

      const result = await ctx.run(
        "git",
        ["-C", abs, "status", "--porcelain=v1", "--branch"],
        { cwd: abs, timeoutMs: spec.timeout_hint ?? 5000 },
      );
      if (result.code !== 0) {
        return {
          status: "failed",
          code: "capability_error",
          message: result.stderr.trim() || "git failed",
        };
      }

      return {
        status: "completed",
        type: spec.output_type ?? "git_status",
        result: parsePorcelain(result.stdout),
      };
    },
  };
}
