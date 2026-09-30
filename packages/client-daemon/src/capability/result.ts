import type { CapabilitySpec } from "./spec";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a local command; never rejects — failures are encoded in `code`. */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxBytes?: number },
) => Promise<CommandResult>;

/**
 * What an adapter reports back. `completed` carries the real observation;
 * failure/rejection never fabricate a result (Record fidelity).
 */
export type ExecutionResult =
  | { status: "completed"; type: string; result: unknown }
  | { status: "failed"; code: string; message?: string }
  | { status: "rejected"; code: string; message?: string };

export interface ExecutionContext {
  /** Filesystem access is confined to this root. */
  workspaceRoot: string;
  run: CommandRunner;
}

export interface CapabilityAdapter {
  spec: CapabilitySpec;
  execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult>;
}
