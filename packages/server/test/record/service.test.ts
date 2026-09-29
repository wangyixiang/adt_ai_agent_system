import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { PostgresRecordStore } from "../../src/record/postgresRecordStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RecordService } from "../../src/record/service";
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
    const result = await service.finalize(wf.id, { text: "svc down" });

    expect(result.recordId).toMatch(/^rec_/);
    expect(result.persistenceFailed).toBe(false);
    const stored = await recordStore.get(result.recordId!, "usr_1");
    expect(stored!.terminal_state).toBe("COMPLETED");
  });

  it("is idempotent: a second finalize returns the same record", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");
    const service = new RecordService({ store: recordStore, workflowStore });

    const first = await service.finalize(wf.id, { text: "x" });
    const second = await service.finalize(wf.id, { text: "x" });

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

    expect(await service.finalize(wf.id, { text: "x" })).toEqual({
      recordId: null,
      persistenceFailed: true,
    });
    expect((failing.save as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});
