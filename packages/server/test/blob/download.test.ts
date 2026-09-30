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
const DATA = Buffer.from("can trace line 1\nline 2\n");
const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const REF = "blob_a";

const token = (
  direction: "upload" | "download",
  options: { contentRef?: string; userId?: string; expiresAt?: number } = {},
): string =>
  signer.sign({
    contentRef: options.contentRef ?? REF,
    direction,
    userId: options.userId ?? "usr_1",
    expiresAt: options.expiresAt ?? NOW + 60_000,
  });

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE blobs, records");
  repo = new PostgresBlobRepository(pool);
  store = createLocalBlobStore(await mkdtemp(join(tmpdir(), "adt-blob-dl-")));
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

const allocateAndUpload = async (options: { commit?: boolean } = {}): Promise<void> => {
  await repo.create({
    contentRef: REF,
    ownerUserId: "usr_1",
    direction: "upload",
    name: "can_trace.log",
    mediaType: "text/plain",
    size: DATA.length,
    sha256: sha(DATA),
    createdAt: NOW,
    expiresAt: NOW + 600_000,
    committedAt: null,
  });
  if (options.commit === false) return;

  const response = await app.inject({
    method: "PUT",
    url: `/blob/${REF}?token=${token("upload")}`,
    payload: DATA,
    headers: { "content-type": "application/octet-stream" },
  });
  expect(response.statusCode).toBe(201);
};

const get = (queryToken: string, contentRef = REF) =>
  app.inject({ method: "GET", url: `/blob/${contentRef}?token=${queryToken}` });

describe("GET /blob/:contentRef", () => {
  it("hands back the very same bytes with their declared type", async () => {
    await allocateAndUpload();

    const response = await get(token("download"));

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["x-blob-sha256"]).toBe(sha(DATA));
    expect(response.headers["etag"]).toBe(`"${sha(DATA)}"`);
    expect(Buffer.from(response.rawPayload).equals(DATA)).toBe(true);
  });

  it("refuses an upload token, an expired token, a foreign ref and a foreign user", async () => {
    await allocateAndUpload();

    expect((await get(token("upload"))).statusCode).toBe(401);
    expect((await get(token("download", { expiresAt: NOW - 1 }))).statusCode).toBe(401);
    expect((await get(token("download", { contentRef: "blob_other" }))).statusCode).toBe(401);
    // Someone else's ref: answered like a missing one, so existence is not
    // leaked by the status code.
    expect((await get(token("download", { userId: "usr_2" }))).statusCode).toBe(404);
  });

  it("refuses a ref that was never uploaded", async () => {
    await allocateAndUpload({ commit: false });
    expect((await get(token("download"))).statusCode).toBe(404);
  });

  it("refuses an unknown ref", async () => {
    const response = await get(token("download", { contentRef: "blob_missing" }), "blob_missing");
    expect(response.statusCode).toBe(404);
  });
});
