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
          if (error === null) {
            resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
            return;
          }

          // A numeric `code` is a real exit status (the command ran). Anything
          // else means the process never reported one: either we killed it
          // (`killed`), or it could not be started at all.
          const raw = (error as { code?: unknown; killed?: boolean }).code;
          if (typeof raw === "number") {
            resolve({ stdout: String(stdout), stderr: String(stderr), code: raw });
            return;
          }

          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            code: -1,
            failure: (error as { killed?: boolean }).killed === true ? "timeout" : "spawn",
          });
        },
      );
    });
}
