/**
 * Window/tray lifetime, as pure logic (ADR-006 §Decision 4). Closing the window
 * must **not** end the app: the daemon keeps running in the tray. Only the tray's
 * explicit quit closes the daemon.
 */
export interface LifecycleDeps {
  hideWindow(): void;
  closeDaemon(): Promise<void>;
  quit(): void;
}

export interface Lifecycle {
  /** The window's close button: hide, keep running. */
  onWindowClose(): void;
  /** The tray's Quit: close the daemon, then quit. */
  onTrayQuit(): Promise<void>;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  return {
    onWindowClose() {
      deps.hideWindow();
    },

    async onTrayQuit() {
      await deps.closeDaemon();
      deps.quit();
    },
  };
}
