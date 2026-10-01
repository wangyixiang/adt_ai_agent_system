/** The part of a running server shutdown needs: closing it. */
export interface ShutdownTarget {
  close(): Promise<void>;
  on(signal: "SIGTERM" | "SIGINT", handler: () => void): void;
}

export interface ShutdownDeps {
  target: ShutdownTarget;
  exit(code: number): void;
  error(message: string): void;
}

/**
 * Wires `SIGTERM`/`SIGINT` to `target.close()`, then exits.
 *
 * A first signal starts a graceful close and exits `0` when it settles; a
 * **second** signal exits `1` at once (a stuck close must not trap the process —
 * Docker gives a grace period, then `SIGKILL`). A rejected `close()` is reported
 * and still exits `1`, so a failing shutdown is never a silent hang.
 */
export function installGracefulShutdown(deps: ShutdownDeps): void {
  let closing = false;
  const handle = (): void => {
    if (closing) {
      deps.exit(1);
      return;
    }
    closing = true;
    void deps.target.close().then(
      () => deps.exit(0),
      (error: unknown) => {
        deps.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        deps.exit(1);
      },
    );
  };
  deps.target.on("SIGTERM", handle);
  deps.target.on("SIGINT", handle);
}
