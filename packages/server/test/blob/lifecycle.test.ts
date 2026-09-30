import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { createLocalBlobStore, type BlobStore } from "../../src/blob/store";
import { PostgresBlobRepository } from "../../src/blob/repository";
import { BlobLifecycle } from "../../src/blob/lifecycle";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let repo: PostgresBlobRepository;
let store: BlobStore;

const NOW = 100_000;
const PAST = 50_000; // expires_at, long gone
const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE blobs, records");
  repo = new PostgresBlobRepository(pool);
  store = createLocalBlobStore(await mkdtemp(join(tmpdir(), "adt-blob-gc-")));
});
afterAll(async () => {
  await pool.end();
});

const lifecycle = (): BlobLifecycle =>
  new BlobLifecycle({ repository: repo, store, now: () => NOW }, { intervalMs: 1000 });

/** A committed blob whose bytes really are on disk. */
const committed = async (contentRef: string, bytes: Buffer): Promise<string> => {
  const digest = sha(bytes);
  await repo.create({
    contentRef,
    ownerUserId: "usr_1",
    direction: "upload",
    name: null,
    mediaType: "text/plain",
    size: bytes.length,
    sha256: digest,
    createdAt: 0,
    expiresAt: PAST,
    committedAt: 1,
  });
  await store.write(Readable.from([bytes]), {
    sha256: digest,
    size: bytes.length,
    maxBytes: 1024,
  });
  return digest;
};

describe("BlobLifecycle", () => {
  it("collects an expired blob, but never one a Record still cites", async () => {
    const keepSha = await committed("blob_keep", Buffer.from("keep me"));
    const dropSha = await committed("blob_drop", Buffer.from("drop me"));

    await pool.query(
      `INSERT INTO records (record_id, workflow_id, owner_user_id, terminal_state, ended_at, document)
       VALUES ('rec_1','wf_1','usr_1','COMPLETED',1,$1)`,
      [JSON.stringify({ entries: [{ ref: { evidence: { result: { content_ref: "blob_keep" } } } }] })],
    );

    expect(await lifecycle().sweep()).toEqual(["blob_drop"]);

    // The Record stays retraceable: row and bytes survive.
    expect(await repo.get("blob_keep")).not.toBeNull();
    expect(await store.has(keepSha)).toBe(true);
    // The unreferenced one is gone from both layers.
    expect(await repo.get("blob_drop")).toBeNull();
    expect(await store.has(dropSha)).toBe(false);
  });

  it("keeps the file while another row still points at the same bytes", async () => {
    const bytes = Buffer.from("shared");
    const digest = await committed("blob_first", bytes);
    await repo.create({
      contentRef: "blob_second",
      ownerUserId: "usr_1",
      direction: "upload",
      name: null,
      mediaType: "text/plain",
      size: bytes.length,
      sha256: digest,
      createdAt: 0,
      expiresAt: NOW + 1000, // not expired for this sweep
      committedAt: 1,
    });

    expect(await lifecycle().sweep()).toEqual(["blob_first"]);
    expect(await store.has(digest)).toBe(true);

    // Now the second one expires too: the last row out turns off the lights.
    await pool.query("UPDATE blobs SET expires_at = $1 WHERE content_ref = 'blob_second'", [PAST]);
    expect(await lifecycle().sweep()).toEqual(["blob_second"]);
    expect(await store.has(digest)).toBe(false);
  });

  it("cleans up an abandoned upload too", async () => {
    await repo.create({
      contentRef: "blob_abandoned",
      ownerUserId: "usr_1",
      direction: "upload",
      name: null,
      mediaType: "text/plain",
      size: 4,
      sha256: "d".repeat(64),
      createdAt: 0,
      expiresAt: PAST,
      committedAt: null,
    });

    expect(await lifecycle().sweep()).toEqual(["blob_abandoned"]);
    expect(await repo.get("blob_abandoned")).toBeNull();
  });

  it("leaves unexpired blobs alone", async () => {
    await repo.create({
      contentRef: "blob_fresh",
      ownerUserId: "usr_1",
      direction: "upload",
      name: null,
      mediaType: "text/plain",
      size: 4,
      sha256: "e".repeat(64),
      createdAt: NOW,
      expiresAt: NOW + 1000,
      committedAt: 1,
    });

    expect(await lifecycle().sweep()).toEqual([]);
    expect(await repo.get("blob_fresh")).not.toBeNull();
  });
});
