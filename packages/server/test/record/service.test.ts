import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { PostgresRecordStore } from "../../src/record/postgresRecordStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RecordService } from "../../src/record/service";
import type { RecordDocument } from "../../src/record/types";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let workflowStore!: PostgresWorkflowStore;
let recordStore!: PostgresRecordStore;
let engine!: WorkflowEngine;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events, records");
  workflowStore = new PostgresWorkflowStore(pool);
  recordStore = new PostgresRecordStore(pool);
  engine = new WorkflowEngine({ store: workflowStore, now: () => 1000 });
});
afterAll(async () => {
  await pool.end();
});

const open = { mode: "open" as const, revision: 0 };

describe("RecordService.finalize", () => {
  it("builds and persists a record for a terminated workflow", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "svc down" }, open);
    await engine.confirmCompletion(wf.id, "solved");

    const service = new RecordService({ store: recordStore, workflowStore });
    const result = await service.finalize(wf.id);

    expect(result.recordId).toMatch(/^rec_/);
    expect(result.persistenceFailed).toBe(false);
    const stored = await recordStore.get(result.recordId!, "usr_1");
    expect(stored!.terminal_state).toBe("COMPLETED");
  });

  it("is idempotent: a second finalize returns the same record", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");
    const service = new RecordService({ store: recordStore, workflowStore });

    const first = await service.finalize(wf.id);
    const second = await service.finalize(wf.id);

    expect(second.recordId).toBe(first.recordId);
  });

  it("reports persistence failure after exhausting retries", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");

    const failing = {
      save: vi.fn().mockRejectedValue(new Error("disk full")),
      findByWorkflow: vi.fn().mockResolvedValue(null),
    } as unknown as PostgresRecordStore;
    const service = new RecordService({ store: failing, workflowStore, retries: 1 });

    expect(await service.finalize(wf.id)).toEqual({
      recordId: null,
      persistenceFailed: true,
    });
    expect((failing.save as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("recovers the record when a committed insert failed to acknowledge", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");

    // The row was committed but the ack was lost: `save` reports a unique
    // violation, and the re-check finds the existing record.
    const existing = { record_id: "rec_existing", workflow_id: wf.id } as RecordDocument;
    let lookups = 0;
    const store = {
      save: vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint")),
      findByWorkflow: vi.fn().mockImplementation(async () => {
        lookups += 1;
        return lookups === 1 ? null : existing;
      }),
    } as unknown as PostgresRecordStore;

    const service = new RecordService({ store, workflowStore, retries: 1 });

    expect(await service.finalize(wf.id)).toEqual({
      recordId: "rec_existing",
      persistenceFailed: false,
    });
  });

  it("keeps the original user request across a fresh service", async () => {
    const request = {
      text: "can bus down",
      attachments: [{ name: "trace.log" }],
      context: { rig: "A" },
    };
    const wf = await engine.create("usr_1", "sess_1", request, open);
    await engine.confirmCompletion(wf.id, "solved");

    // A brand-new service with no in-memory state (as after a restart).
    const service = new RecordService({ store: recordStore, workflowStore });
    const result = await service.finalize(wf.id);

    const stored = await recordStore.get(result.recordId!, "usr_1");
    expect(stored!.user_request).toEqual(request);
    expect(stored!.summary.problem_short).toContain("can bus");
  });
});
