import type { WorkflowEngine } from "./engine";
import type { StepSnapshot, WorkflowStore } from "./store";

/** The slices the monitor needs; narrow so tests can inject fakes. */
export interface StepTimeoutDeps {
  engine: Pick<WorkflowEngine, "timeoutStep">;
  store: Pick<WorkflowStore, "findActiveWorkflows" | "listSteps">;
  /** Monotonic clock (PROTOCOL_SPEC.md §2/§9); defaults to `performance.now`. */
  now?: () => number;
}

export interface StepTimeoutOptions {
  intervalMs: number;
}

/**
 * Enforces `step_timeout` (PROTOCOL_SPEC.md §9). Each Step carries the deadline
 * snapshotted at dispatch, so an engine restart resumes the same budget and a
 * `capability.sync` cannot move the goalposts for an in-flight step.
 *
 * Only an *executing* step is eligible: `PENDING` means the client has not
 * acknowledged (orphan reclamation covers that case), and a human wait has no
 * deadline.
 */
export class StepTimeoutMonitor {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: StepTimeoutDeps,
    private readonly options: StepTimeoutOptions,
  ) {
    this.now = deps.now ?? (() => Math.floor(performance.now()));
  }

  /** Times out every overdue step; returns the ids it ended. */
  async sweep(): Promise<string[]> {
    const now = this.now();
    const timedOut: string[] = [];

    for (const workflow of await this.deps.store.findActiveWorkflows()) {
      const steps = await this.deps.store.listSteps(workflow.id);
      for (const step of steps) {
        if (!this.isOverdue(step, now)) continue;
        try {
          await this.deps.engine.timeoutStep(workflow.id, step.id);
          timedOut.push(step.id);
        } catch (error) {
          // One stuck step must not stop the sweep (or the timer keeps firing
          // on it forever); the next sweep retries.
          console.error(`[step-timeout] failed to time out ${step.id}:`, error);
        }
      }
    }

    return timedOut;
  }

  private isOverdue(step: Pick<StepSnapshot, "state" | "waitClass" | "updatedAt" | "timeoutMs">, now: number): boolean {
    const executing =
      step.state === "RUNNING" || (step.state === "WAITING" && step.waitClass !== "human");
    if (!executing || step.timeoutMs <= 0) return false;
    return now - step.updatedAt > step.timeoutMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => {
        console.error("[step-timeout] sweep failed:", error);
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
