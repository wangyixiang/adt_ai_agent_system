import { randomUUID } from "node:crypto";
import type { WorkflowStore } from "../workflow/store";
import { buildRecord } from "./builder";
import type { RecordStore } from "./store";

export interface FinalizeResult {
  recordId: string | null;
  persistenceFailed: boolean;
}

export interface RecordServiceDeps {
  store: RecordStore;
  workflowStore: WorkflowStore;
  /** Extra save attempts after the first (default 2). */
  retries?: number;
}

/**
 * Builds and persists the Record for a terminated workflow.
 *
 * Ordering is the caller's job: persist first, then notify
 * (PROTOCOL_SPEC.md §7.4 / decision D-D3). This service never sends anything.
 */
export class RecordService {
  constructor(private readonly deps: RecordServiceDeps) {}

  async finalize(workflowId: string, userRequest: unknown): Promise<FinalizeResult> {
    const existing = await this.deps.store.findByWorkflow(workflowId);
    if (existing) {
      return { recordId: existing.record_id, persistenceFailed: false };
    }

    const workflow = await this.deps.workflowStore.getWorkflow(workflowId);
    if (!workflow) throw new Error(`unknown workflow ${workflowId}`);

    const steps = await this.deps.workflowStore.listSteps(workflowId);
    const events = await this.deps.workflowStore.listEvents(workflowId);

    const document = buildRecord({
      workflow,
      steps,
      events,
      userRequest,
      recordId: `rec_${randomUUID()}`,
    });

    const attempts = Math.max(1, (this.deps.retries ?? 2) + 1);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.deps.store.save(document);
        return { recordId: document.record_id, persistenceFailed: false };
      } catch {
        // Retry; the last failure is reported below.
      }
    }

    return { recordId: null, persistenceFailed: true };
  }
}
