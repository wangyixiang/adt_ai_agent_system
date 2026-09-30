import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { encodeEnvelope, PROTOCOL_VERSION } from "@adt/shared";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { Connection } from "../../src/ws/connection";
import { MessageRouter } from "../../src/ws/messageRouter";
import { SessionManager } from "../../src/session/sessionManager";
import { PostgresBlobRepository } from "../../src/blob/repository";
import { createBlobTokenSigner } from "../../src/blob/token";
import { registerBlobProtocol } from "../../src/blob/protocol";
import { DEFAULT_BLOB_CONFIG } from "../../src/blob/config";
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

const blobCount = async (): Promise<number> =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs")).rows[0]!.n;

function harness() {
  const sent: string[] = [];
  let closed = false;
  const conn = new Connection(
    { send: (data) => sent.push(data), close: () => { closed = true; } },
    "c1",
  );
  // A real SessionManager: the router validates session_id/user_id and dedups
  // on `message_id`, so a hand-built session object would not behave.
  const sessions = new SessionManager({ now: () => 1000 });
  const session = sessions.create("usr_1", conn);
  const router = new MessageRouter(sessions);

  registerBlobProtocol({
    router,
    repository: repo,
    signer: createBlobTokenSigner("test-secret"),
    config: { ...DEFAULT_BLOB_CONFIG, baseUrl: () => "http://blob.test", secret: "test-secret" },
    now: () => 1000,
  });

  let seq = 0;
  const ask = async (payload: Record<string, unknown>) => {
    await router.handle(
      conn,
      encodeEnvelope({
        protocol_version: PROTOCOL_VERSION,
        message_id: `msg_${++seq}`,
        session_id: session.id,
        workflow_id: null,
        user_id: session.userId,
        type: "blob.allocate_request",
        ts: "2026-09-30T10:00:00.000Z",
        in_reply_to: null,
        payload,
      }),
    );
    return JSON.parse(sent.at(-1)!) as { type: string; payload: Record<string, unknown> };
  };

  return { ask, isClosed: () => closed };
}

const upload = {
  direction: "upload",
  name: "can.log",
  media_type: "text/plain",
  size: 10,
  sha256: "a".repeat(64),
};

describe("blob.allocate_request", () => {
  it("hands out a signed url and records an uncommitted row", async () => {
    const { ask } = harness();
    const reply = await ask(upload);

    expect(reply.type).toBe("blob.allocate_response");
    const contentRef = reply.payload.content_ref as string;
    expect(contentRef).toMatch(/^blob_/);

    const url = new URL(reply.payload.url as string);
    expect(url.origin).toBe("http://blob.test");
    expect(url.pathname).toBe(`/blob/${contentRef}`);
    expect((url.searchParams.get("token") ?? "").length).toBeGreaterThan(10);
    expect(typeof reply.payload.expires_at).toBe("string");

    expect((await repo.get(contentRef))!.committedAt).toBeNull();
  });

  it("rejects a media type outside the whitelist without creating a row", async () => {
    const { ask } = harness();
    const reply = await ask({ ...upload, media_type: "application/x-evil" });

    expect(reply.type).toBe("protocol.error");
    expect((reply.payload as { code: string }).code).toBe("blob_rejected");
    expect(await blobCount()).toBe(0);
  });

  it("rejects a size beyond the configured maximum", async () => {
    const { ask } = harness();
    const reply = await ask({ ...upload, size: DEFAULT_BLOB_CONFIG.maxBlobBytes + 1 });

    expect((reply.payload as { code: string }).code).toBe("blob_rejected");
    expect(await blobCount()).toBe(0);
  });

  it("rejects an unknown download ref and someone else's ref", async () => {
    const { ask } = harness();

    const missing = await ask({ direction: "download", content_ref: "blob_missing" });
    expect((missing.payload as { code: string }).code).toBe("blob_rejected");

    await repo.create({
      contentRef: "blob_other",
      ownerUserId: "usr_2",
      direction: "upload",
      name: null,
      mediaType: "text/plain",
      size: 1,
      sha256: "b".repeat(64),
      createdAt: 0,
      expiresAt: 9_999_999,
      committedAt: 1,
    });
    const foreign = await ask({ direction: "download", content_ref: "blob_other" });
    expect((foreign.payload as { code: string }).code).toBe("blob_rejected");
  });

  it("rejects a download of a row that was never committed", async () => {
    const { ask } = harness();
    await repo.create({
      contentRef: "blob_pending",
      ownerUserId: "usr_1",
      direction: "upload",
      name: null,
      mediaType: "text/plain",
      size: 1,
      sha256: "c".repeat(64),
      createdAt: 0,
      expiresAt: 9_999_999,
      committedAt: null,
    });

    const reply = await ask({ direction: "download", content_ref: "blob_pending" });
    expect((reply.payload as { code: string }).code).toBe("blob_rejected");
  });

  it("hands out a download url for a committed ref of one's own", async () => {
    const { ask } = harness();
    await repo.create({
      contentRef: "blob_mine",
      ownerUserId: "usr_1",
      direction: "upload",
      name: "can.log",
      mediaType: "text/plain",
      size: 4,
      sha256: "d".repeat(64),
      createdAt: 0,
      expiresAt: 9_999_999,
      committedAt: 1,
    });

    const reply = await ask({ direction: "download", content_ref: "blob_mine" });

    expect(reply.type).toBe("blob.allocate_response");
    expect(reply.payload.content_ref).toBe("blob_mine");
    expect(String(reply.payload.url)).toContain("/blob/blob_mine?token=");
  });

  it("keeps the connection open when it refuses (blob_rejected is a request-level error)", async () => {
    const { ask, isClosed } = harness();
    await ask({ ...upload, media_type: "application/x-evil" });
    expect(isClosed()).toBe(false);
  });
});
