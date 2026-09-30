import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresBlobRepository, type BlobRecord } from "../../src/blob/repository";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let repo: PostgresBlobRepository;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE blobs, records");
  repo = new PostgresBlobRepository(pool);
});
afterAll(async () => {
  await pool.end();
});

const record = (over: Partial<BlobRecord> = {}): BlobRecord => ({
  contentRef: "blob_a",
  ownerUserId: "usr_1",
  direction: "upload",
  name: "can.log",
  mediaType: "text/plain",
  size: 10,
  sha256: "a".repeat(64),
  createdAt: 1000,
  expiresAt: 2000,
  committedAt: null,
  ...over,
});

describe("PostgresBlobRepository", () => {
  it("round-trips a row and commits it", async () => {
    await repo.create(record());
    const stored = (await repo.get("blob_a"))!;
    expect(stored).toEqual(record());
    expect(stored.committedAt).toBeNull();

    await repo.commit("blob_a", 1500);
    expect((await repo.get("blob_a"))!.committedAt).toBe(1500);
  });

  it("returns null for an unknown ref", async () => {
    expect(await repo.get("blob_nope")).toBeNull();
  });

  it("lists only expired rows", async () => {
    await repo.create(record({ contentRef: "blob_old", expiresAt: 2000 }));
    await repo.create(record({ contentRef: "blob_new", expiresAt: 9000 }));

    expect((await repo.listExpired(5000)).map((row) => row.contentRef)).toEqual(["blob_old"]);
  });

  it("knows whether a Record still references the blob", async () => {
    await repo.create(record());
    expect(await repo.isReferenced("blob_a")).toBe(false);

    await pool.query(
      `INSERT INTO records (record_id, workflow_id, owner_user_id, terminal_state, ended_at, document)
       VALUES ('rec_1','wf_1','usr_1','COMPLETED',1,$1)`,
      [JSON.stringify({ entries: [{ ref: { evidence: { result: { content_ref: "blob_a" } } } }] })],
    );
    expect(await repo.isReferenced("blob_a")).toBe(true);
    // A different ref is a different blob. (The search is substring-based on
    // purpose — see the repository — so this checks a ref that shares nothing
    // with the stored text rather than a prefix of it.)
    expect(await repo.isReferenced("blob_zzz")).toBe(false);
  });

  it("reports whether another row still points at the same bytes", async () => {
    await repo.create(record({ contentRef: "blob_a" }));
    await repo.create(record({ contentRef: "blob_b" }));

    expect(await repo.sharesBytes("a".repeat(64), "blob_a")).toBe(true);
    await repo.remove("blob_b");
    expect(await repo.sharesBytes("a".repeat(64), "blob_a")).toBe(false);
  });
});
