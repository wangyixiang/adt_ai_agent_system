import { execFile } from "node:child_process";
import type { CommandResult, CommandRunner } from "./result";

const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * A bounded local command runner. Failures (non-zero exit, timeout, spawn
 * error) are encoded in `code` — it never rejects, so adapters can turn them
 * into a deterministic `FAILED`.
 */
export function nodeCommandRunner(): CommandRunner {
  return (command, args, { cwd, timeoutMs, maxBytes }) =>
    new Promise<CommandResult>((resolve) => {
      execFile(
        command,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: maxBytes ?? DEFAULT_MAX_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : -1;
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        },
      );
    });
}
