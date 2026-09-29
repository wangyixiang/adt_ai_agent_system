import type { MessageRouter } from "./messageRouter";
import type { SessionManager } from "../session/sessionManager";

export interface HeartbeatOptions {
  intervalMs: number;
  maxMissed: number;
  onDead: (sessionId: string) => void;
}

/**
 * Application-level liveness (PROTOCOL_SPEC.md §9 / ADR-003 §3).
 * P1 only reports dead sessions; orphan reclamation arrives with the
 * workflow engine (P2).
 */
export class HeartbeatMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessions: SessionManager,
    private readonly opts: HeartbeatOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  sweep(): void {
    const now = Date.now();
    const threshold = this.opts.intervalMs * this.opts.maxMissed;
    for (const session of this.sessions.all()) {
      if (now - session.lastSeenAt > threshold) this.opts.onDead(session.id);
    }
  }
}

export function registerHeartbeat(
  router: MessageRouter,
  sessions: SessionManager,
): void {
  router.register("session.heartbeat", ({ session }) => {
    if (session) sessions.touch(session.id);
  });
}
