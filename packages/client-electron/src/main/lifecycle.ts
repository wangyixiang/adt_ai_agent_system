/**
 * Window/tray lifetime, as pure logic (ADR-006 §Decision 4). Closing the window
 * must **not** end the app: the daemon keeps running in the tray. Only the tray's
 * explicit quit ends things — and if a diagnostic is still running, it asks
 * first, because quitting abandons it locally (the Server reclaims it later).
 */
export interface LifecycleDeps {
  hideWindow(): void;
  hasRunningWorkflow(): boolean;
  /** Ask the human whether to quit despite a live run; `true` means "yes, quit". */
  confirmQuit(): Promise<boolean>;
  closeDaemon(): Promise<void>;
  quit(): void;
}

export interface Lifecycle {
  /** The window's close button: hide, keep running. */
  onWindowClose(): void;
  /** The tray's Quit: confirm if a run is live, then close the daemon and quit. */
  onTrayQuit(): Promise<void>;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  return {
    onWindowClose() {
      deps.hideWindow();
    },

    async onTrayQuit() {
      if (deps.hasRunningWorkflow() && !(await deps.confirmQuit())) return;
      await deps.closeDaemon();
      deps.quit();
    },
  };
}
