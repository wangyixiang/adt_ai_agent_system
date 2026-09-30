import { describe, it, expect } from "vitest";
import { gitCollectDiagnostics } from "../../src/capability/adapters/git";
import { mvpSpec } from "../../src/capability/descriptors";
import type { CommandRunner } from "../../src/capability/result";

const adapter = () => gitCollectDiagnostics(mvpSpec("git.collect_diagnostics"));
const ctxWith = (run: CommandRunner) => ({ workspaceRoot: "/ws", run });

describe("git.collect_diagnostics", () => {
  it("parses porcelain output into branch/modified/untracked", async () => {
    const run: CommandRunner = async () => ({
      code: 0,
      stdout: "## main...origin/main\n M src/a.ts\n?? new.txt\n?? b.txt\n",
      stderr: "",
    });
    const result = await adapter().execute({}, ctxWith(run));
    expect(result).toEqual({
      status: "completed",
      type: "git_status",
      result: { branch: "main", modified_files: 1, untracked_files: 2 },
    });
  });

  it("reads the branch from a repository that has no commits yet", async () => {
    const run: CommandRunner = async () => ({
      code: 0,
      stdout: "## No commits yet on main\n?? first.txt\n",
      stderr: "",
    });
    const result = await adapter().execute({}, ctxWith(run));
    expect(result).toEqual({
      status: "completed",
      type: "git_status",
      result: { branch: "main", modified_files: 0, untracked_files: 1 },
    });
  });

  it("fails when git exits non-zero", async () => {
    const run: CommandRunner = async () => ({ code: 128, stdout: "", stderr: "not a repo" });
    const result = await adapter().execute({ project_path: "." }, ctxWith(run));
    expect(result.status).toBe("failed");
    expect((result as { code: string }).code).toBe("capability_error");
  });

  it("refuses a project_path outside the workspace", async () => {
    let called = false;
    const run: CommandRunner = async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await adapter().execute({ project_path: "../elsewhere" }, ctxWith(run));
    expect(result.status).toBe("rejected");
    expect(called).toBe(false);
  });
});
