import type { SessionManager } from "../session/sessionManager";
import type { WorkflowEngine } from "./engine";
import type { WorkflowStore } from "./store";

export interface ReclamationDeps {
  engine: WorkflowEngine;
  store: WorkflowStore;
  sessions: SessionManager;
  /** Grace window before a disconnected session's workflows are reclaimed. */
  graceMs: number;
  now?: () => number;
}

/**
 * Reclaims workflows whose owning session went away (WORKFLOW_SPEC.md §2.2).
 * A workflow whose cancel was already requested ends CANCELLED — the
 * engineer's intent wins over `client_unreachable`.
 */
export class OrphanReclaimer {
  private readonly pending = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ReclamationDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  onSessionDead(sessionId: string): void {
    if (!this.pending.has(sessionId)) this.pending.set(sessionId, this.now());
  }

  async reclaim(): Promise<string[]> {
    const now = this.now();
    const reclaimed: string[] = [];

    for (const [sessionId, deadAt] of [...this.pending.entries()]) {
      if (now - deadAt < this.deps.graceMs) continue;

      const active = await this.deps.store.findActiveWorkflows();
      for (const workflow of active) {
        if (workflow.sessionId !== sessionId) continue;
        await this.deps.engine.reclaimOrphan(workflow.id);
        reclaimed.push(workflow.id);
      }
      this.pending.delete(sessionId);
    }

    return reclaimed;
  }
}
