import type { BlobRepository } from "./repository";
import type { BlobStore } from "./store";

export interface BlobLifecycleDeps {
  repository: BlobRepository;
  store: BlobStore;
  /** Wall clock, default `Date.now`. */
  now?: () => number;
}

export interface BlobLifecycleOptions {
  intervalMs: number;
}

/** Default sweep cadence: expiry is a housekeeping concern, not a live one. */
export const DEFAULT_BLOB_LIFECYCLE_MS = 10 * 60 * 1000;

/**
 * Collects expired blobs. The one rule that matters: **a blob a Record still
 * cites is never removed**. Records are immutable and their evidence has to
 * stay fetchable, so expiry only decides when an *unreferenced* blob becomes
 * eligible — and the check is done per row, at sweep time, so a Record written
 * late still wins.
 */
export class BlobLifecycle {
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow sweep being overtaken by the next tick. */
  private sweeping = false;

  constructor(
    private readonly deps: BlobLifecycleDeps,
    private readonly options: BlobLifecycleOptions,
  ) {
    this.clock = deps.now ?? (() => Date.now());
  }

  /** Removes every eligible blob; returns the refs it collected. */
  async sweep(): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      return await this.runSweep();
    } finally {
      this.sweeping = false;
    }
  }

  private async runSweep(): Promise<string[]> {
    const removed: string[] = [];

    for (const row of await this.deps.repository.listExpired(this.clock())) {
      try {
        if (await this.deps.repository.isReferenced(row.contentRef)) {
          console.warn(
            `[blob] ${row.contentRef} expired but is still cited by a Record; keeping it`,
          );
          continue;
        }

        await this.deps.repository.remove(row.contentRef);
        // The same bytes may back another ref; only the last one out deletes
        // the file.
        if (!(await this.deps.repository.sharesBytes(row.sha256, row.contentRef))) {
          await this.deps.store.delete(row.sha256);
        }
        removed.push(row.contentRef);
      } catch (error) {
        // One stuck row must not stop the sweep; the next one retries.
        console.error(`[blob] failed to collect ${row.contentRef}:`, error);
      }
    }

    return removed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => {
        console.error("[blob] sweep failed:", error);
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
