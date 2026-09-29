import type { SessionManager } from "./sessionManager";

/** The slice of `OrphanReclaimer` the lifecycle drives. */
export interface Reclaimable {
  reclaim(): Promise<string[]>;
}

export interface SessionLifecycleDeps {
  sessions: SessionManager;
  reclaimer: Reclaimable;
}

export interface SessionLifecycleOptions {
  intervalMs: number;
  /** Monotonic clock (PROTOCOL_SPEC.md §2/§9); defaults to `performance.now`. */
  now?: () => number;
}

export interface LifecycleSweepResult {
  expired: string[];
  reclaimed: string[];
}

/**
 * Expires sessions whose TTL elapsed and drives orphan reclamation
 * (PROTOCOL_SPEC.md §5.2 / WORKFLOW_SPEC.md §2.2). Reclamation grace equals
 * the session TTL, so a session that is gone for good is expired and its
 * workflows reclaimed in the same sweep.
 */
export class SessionLifecycle {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: SessionLifecycleDeps,
    private readonly options: SessionLifecycleOptions,
  ) {
    this.now = options.now ?? (() => Math.floor(performance.now()));
  }

  async sweep(): Promise<LifecycleSweepResult> {
    const expired = this.deps.sessions.sweep(this.now());
    const reclaimed = await this.deps.reclaimer.reclaim();
    return { expired, reclaimed };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => {
        console.error("[session-lifecycle] sweep failed:", error);
      });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
