import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { createLocalBlobStore } from "../../src/blob/store";
import { PostgresBlobRepository } from "../../src/blob/repository";
import { createBlobTokenSigner } from "../../src/blob/token";
import { DEFAULT_BLOB_CONFIG } from "../../src/blob/config";
import { registerBlobRoutes } from "../../src/blob/http";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let repo: PostgresBlobRepository;
let store: ReturnType<typeof createLocalBlobStore>;
let app: FastifyInstance;

const signer = createBlobTokenSigner("test-secret");
const NOW = 10_000;
const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const tokenFor = (
  contentRef: string,
  direction: "upload" | "download",
  expiresAt = NOW + 60_000,
): string => signer.sign({ contentRef, direction, userId: "usr_1", expiresAt });

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE blobs, records");
  repo = new PostgresBlobRepository(pool);
  store = createLocalBlobStore(await mkdtemp(join(tmpdir(), "adt-blob-http-")));
  app = Fastify({ logger: false });
  registerBlobRoutes(app, {
    repository: repo,
    store,
    signer,
    config: { ...DEFAULT_BLOB_CONFIG, secret: "test-secret", baseUrl: () => "http://blob.test" },
    now: () => NOW,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const allocate = async (data: Buffer, contentRef = "blob_a"): Promise<void> => {
  await repo.create({
    contentRef,
    ownerUserId: "usr_1",
    direction: "upload",
    name: "can.log",
    mediaType: "text/plain",
    size: data.length,
    sha256: sha(data),
    createdAt: NOW,
    expiresAt: NOW + 600_000,
    committedAt: null,
  });
};

const put = (contentRef: string, data: Buffer, token = tokenFor(contentRef, "upload")) =>
  app.inject({
    method: "PUT",
    url: `/blob/${contentRef}?token=${token}`,
    payload: data,
    headers: { "content-type": "application/octet-stream" },
  });

describe("PUT /blob/:contentRef", () => {
  it("stores the bytes and commits the row", async () => {
    const data = Buffer.from("can trace\n");
    await allocate(data);

    const response = await put("blob_a", data);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ content_ref: "blob_a", size: data.length, sha256: sha(data) });
    expect((await repo.get("blob_a"))!.committedAt).toBe(NOW);
    expect(await store.has(sha(data))).toBe(true);
  });

  it("refuses bytes that do not match the declaration, and does not commit", async () => {
    const declared = Buffer.from("declared");
    await allocate(declared);

    const response = await put("blob_a", Buffer.from("something else"));

    expect(response.statusCode).toBe(400);
    expect((await repo.get("blob_a"))!.committedAt).toBeNull();
    // Neither the declared nor the received bytes are reachable.
    expect(await store.has(sha(declared))).toBe(false);
    expect(await store.has(sha(Buffer.from("something else")))).toBe(false);
  });

  it("refuses a download token, an expired token and a foreign ref", async () => {
    const data = Buffer.from("x");
    await allocate(data);

    const wrongDirection = await put("blob_a", data, tokenFor("blob_a", "download"));
    expect(wrongDirection.statusCode).toBe(401);

    const expired = await put("blob_a", data, tokenFor("blob_a", "upload", NOW - 1));
    expect(expired.statusCode).toBe(401);

    const unknown = await put("blob_missing", data);
    expect(unknown.statusCode).toBe(404);
  });

  it("refuses to overwrite an already committed blob", async () => {
    const data = Buffer.from("x");
    await allocate(data);
    await put("blob_a", data);

    const again = await put("blob_a", data);
    expect(again.statusCode).toBe(409);
  });
});
