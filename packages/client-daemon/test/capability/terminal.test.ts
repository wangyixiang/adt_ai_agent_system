import { describe, it, expect } from "vitest";
import { terminalExecuteCommand } from "../../src/capability/adapters/terminal";
import { mvpSpec } from "../../src/capability/descriptors";
import type { CommandRunner } from "../../src/capability/result";

const ctxWith = (run: CommandRunner) => ({ workspaceRoot: "/ws", run });

describe("terminal.execute_command", () => {
  it("runs the command and reports exit_code/stdout", async () => {
    let seen: string[] = [];
    let cwd = "";
    const run: CommandRunner = async (command, args, options) => {
      seen = [command, ...args];
      cwd = options.cwd;
      return { code: 0, stdout: "ok", stderr: "" };
    };

    const result = await terminalExecuteCommand(mvpSpec("terminal.execute_command")).execute(
      { command: "echo", args: ["hi"] },
      ctxWith(run),
    );

    expect(seen).toEqual(["echo", "hi"]);
    expect(cwd).toBe("/ws");
    expect(result).toEqual({
      status: "completed",
      type: "command_result",
      result: { exit_code: 0, stdout: "ok" },
    });
  });

  it("reports a non-zero exit code as an observation, not a failure", async () => {
    const run: CommandRunner = async () => ({ code: 3, stdout: "", stderr: "boom" });
    const result = await terminalExecuteCommand(mvpSpec("terminal.execute_command")).execute(
      { command: "false" },
      ctxWith(run),
    );

    expect(result).toEqual({
      status: "completed",
      type: "command_result",
      result: { exit_code: 3, stdout: "" },
    });
  });

  it("rejects a missing command without running anything", async () => {
    let called = false;
    const run: CommandRunner = async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await terminalExecuteCommand(mvpSpec("terminal.execute_command")).execute(
      {},
      ctxWith(run),
    );

    expect(result.status).toBe("rejected");
    expect(called).toBe(false);
  });

  it("fails when the command could not run, instead of reporting exit_code -1", async () => {
    const spawnFailure: CommandRunner = async () => ({
      code: -1,
      stdout: "",
      stderr: "not found",
      failure: "spawn",
    });
    expect(
      await terminalExecuteCommand(mvpSpec("terminal.execute_command")).execute(
        { command: "nope" },
        ctxWith(spawnFailure),
      ),
    ).toEqual({ status: "failed", code: "capability_error", message: "not found" });

    const timedOut: CommandRunner = async () => ({
      code: -1,
      stdout: "",
      stderr: "",
      failure: "timeout",
    });
    expect(
      await terminalExecuteCommand(mvpSpec("terminal.execute_command")).execute(
        { command: "sleep", args: ["600"] },
        ctxWith(timedOut),
      ),
    ).toEqual({ status: "failed", code: "timeout", message: "command exceeded its timeout" });
  });
});
