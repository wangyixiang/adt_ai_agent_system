import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresRecordStore } from "../../src/record/postgresRecordStore";
import type { RecordDocument } from "../../src/record/types";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store!: PostgresRecordStore;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE records");
  store = new PostgresRecordStore(pool);
});
afterAll(async () => {
  await pool.end();
});

const rec = (
  id: string,
  owner: string,
  endedAt: number,
  over: Partial<RecordDocument> = {},
): RecordDocument => ({
  record_id: id,
  workflow_id: `wf_${id}`,
  owner_user_id: owner,
  spec_versions: { workflow_spec: "0.5", capability_spec: "0.8" },
  created_at: 100,
  ended_at: endedAt,
  terminal_state: "COMPLETED",
  terminal_reason: null,
  completion_criteria: { mode: "open", revision: 0 },
  criteria_revisions: [],
  user_request: { text: "svc down" },
  summary: {
    problem_short: "svc down",
    terminal_state: "COMPLETED",
    result_short: "fixed",
    duration_ms: endedAt - 100,
  },
  entries: [
    {
      entry_id: "e1",
      ts: 100,
      kind: "evidence_received",
      ref: {
        step_id: "step_1",
        evidence: { source: "capability", type: "git_status", result: {} },
      },
      narrative: "获得了 git_status 证据。",
    },
  ],
  final_result: { resolution: "advisory" },
  ...over,
});

describe("PostgresRecordStore", () => {
  it("round-trips a record and enforces one record per workflow", async () => {
    await store.save(rec("rec_1", "usr_1", 200));
    expect((await store.get("rec_1", "usr_1"))!.summary.problem_short).toBe("svc down");

    // Same workflow_id again: the unique constraint must reject a second record.
    await expect(
      store.save(rec("rec_9", "usr_1", 300, { workflow_id: "wf_rec_1" })),
    ).rejects.toThrow();
  });

  it("filters by owner so another user cannot see the record", async () => {
    await store.save(rec("rec_1", "usr_1", 200));
    expect(await store.get("rec_1", "usr_2")).toBeNull();
    expect((await store.listByOwner("usr_2", {}, null, 20)).records).toEqual([]);
  });

  it("filters by time range and keyword, newest first", async () => {
    await store.save(rec("rec_1", "usr_1", 200));
    await store.save(
      rec("rec_2", "usr_1", 300, {
        user_request: { text: "can bus" },
        summary: {
          problem_short: "can bus",
          terminal_state: "COMPLETED",
          result_short: "ok",
          duration_ms: 200,
        },
      }),
    );

    const all = await store.listByOwner("usr_1", {}, null, 20);
    expect(all.records.map((r) => r.record_id)).toEqual(["rec_2", "rec_1"]);

    const ranged = await store.listByOwner("usr_1", { timeRange: { from: 250, to: 400 } }, null, 20);
    expect(ranged.records.map((r) => r.record_id)).toEqual(["rec_2"]);

    const keyword = await store.listByOwner("usr_1", { keyword: "CAN" }, null, 20);
    expect(keyword.records.map((r) => r.record_id)).toEqual(["rec_2"]);
  });

  it("paginates with an opaque cursor and caps the page size", async () => {
    for (let i = 0; i < 3; i++) await store.save(rec(`rec_${i}`, "usr_1", 200 + i));

    const first = await store.listByOwner("usr_1", {}, null, 2);
    expect(first.records).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = await store.listByOwner("usr_1", {}, first.next_cursor, 2);
    expect(second.records).toHaveLength(1);
    expect(second.next_cursor).toBeNull();

    const capped = await store.listByOwner("usr_1", {}, null, 9999);
    expect(capped.records).toHaveLength(3);
  });
});
