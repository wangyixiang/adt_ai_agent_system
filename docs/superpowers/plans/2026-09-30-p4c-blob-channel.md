# P4c blob 通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"大体积/二进制证据"（日志、截图）不挤进正文类消息，而是走一条**申请制**的独立通道：申请拿 URL → 上传/下载 → 正文里只留 `content_ref`，且这个引用**永远取不回来**的风险被排除。

**Architecture:** 四层，各归其位。**字节层**（`LocalBlobStore`）按内容寻址（文件名 = sha256）落本地文件系统，流式写入并**边写边校验** size/sha256——这样 512 MiB 也不进内存。**元数据层**（`blobs` 表 + `PostgresBlobRepository`）记录 content_ref → sha256/尺寸/媒体类型/属主/过期，并提供"这个 content_ref 是否被任何 Record 引用"的查询（`records.document` 是 jsonb，可直接 `position()` 判定）。**协议层**是一个 WS 申请消息对（`blob.allocate_request/response`）加两条 HTTP 路由（`PUT`/`GET /blob/:contentRef`），传输在 WS 之外、URL 带 **HMAC 签名令牌**（无服务端会话状态，重启后旧 URL 仍有效）。**回收层**（`BlobLifecycle`）按过期扫描，**只删没有被任何 Record 引用的 blob**——保住 Record 的可回溯性。

**Tech Stack:** TypeScript（strict）· Node.js LTS（`node:crypto`、`node:fs`、全局 `fetch`）· Fastify（已装 `@fastify/websocket`，本轮加两条原生路由）· PostgreSQL（`pg`，jsonb 查询）· Vitest · pnpm workspace（沿用 P1–P4b 结构）

**Spec:** `docs/specs/PROTOCOL_SPEC.md`（§7.5 blob 通道、§10 Record 查询、§12 错误码 `blob_rejected`）、`docs/specs/WORKFLOW_SPEC.md`（§5 Evidence envelope）、`docs/specs/RECORD_SPEC.md`（§3 Record 保留 `content_ref`）、`docs/adr/ADR-004-tech-stack.md`（§2 blob 用本地文件系统 + `BlobStore` 抽象）、`docs/REQUIREMENTS.md`（FR-1 可附带文件、FR-12 记录完整、NFR-1 来源可追溯）

## Global Constraints

- **两条方向都要**（本阶段决定）：`upload`（客户端 → Server 的大体积证据）与 `download`（Server → 客户端取回，否则 Record 里的 `content_ref` 是**死引用**）。下载只做"服务端存取 + HTTP 端点"，不做 UI。
- **URL 用 HMAC 签名令牌**（本阶段决定）：签名内容 `contentRef | direction | userId | expiresAt`，服务端**不保存**任何会话态，重启后已发出的 URL 仍可用。密钥来自 `BLOB_SECRET`；**未配置时每次启动随机生成并告警**（安全默认：宁可令牌不跨重启，也不要一个硬编码的生产密钥）。
- **过期只删未被引用的 blob**（本阶段决定）：`BlobLifecycle` 删除某行前，必须先问 `records` 里有没有任何 Record 引用它。**被引用的一律不自动删**——Record 是不可变的，它引用过的证据必须能取回来。
- **内联阈值 64 KiB 只登记、不强制**（本阶段决定）：不在本阶段新增"超阈值内联就判 `invalid_output`"这条硬校验。阈值进配置，作为文档与后续强制的依据。
- **默认值（可配置，写进配置对象与文档）**：单 blob 上限 512 MiB、令牌有效期 15 分钟、blob 保留期 30 天、内联阈值 64 KiB。
- **媒体类型白名单**：`text/plain`、`text/csv`、`text/markdown`、`application/json`、`application/zip`、`application/gzip`、`application/octet-stream`、`image/png`、`image/jpeg`；不合规 → `protocol.error(code="blob_rejected")`（该码已在 `@adt/shared` 的错误码表里，disposition = 请求级，**不需要**改错误矩阵）。
- **传输在 WS 之外**：二进制不进 WS 连接；`blob.allocate_response` 里的 `url` 由可配置的 `baseUrl` 拼接（生产默认 `http://127.0.0.1:${PORT}`，反向代理部署时用 `BLOB_BASE_URL` 覆盖）。
- **上传完成的凭据就是 HTTP 响应**：不新增"上传完成"协议消息；客户端等 `PUT` 返回 2xx 之后，才可以把这个 `content_ref` 写进 `evidence.result`。
- **不碰能力层**：本阶段**不**给 `terminal.execute_command` 之类的适配器加"自动把大输出转 blob"的行为——那属于能力语义（哪个输出该外置），留给后续。
- **文档纪律**：`PROTOCOL_SPEC.md` v0.8 → **v0.9**（§7.5 写实：字段、令牌、两个方向的申请内容、上传完成语义、默认值）、`ADR-004` 补"BlobStore 已落地为 `LocalBlobStore`（内容寻址 + 流式校验）"、`docs/REQUIREMENTS.md` §7 行与 `README.md` 当前状态同步。

## Review Focus

以下失败模式规格隐含、但默认的测试不会覆盖，**每条都必须在对应任务里有测试**：

1. **坏字节不许落库**：sha256 或 size 与申请不符时，上传必须失败、且**不提交**该 blob 行（否则 Record 会引用一份与声明不符的证据）。见 Task 5。
2. **引用必须能取回**：过期回收**绝不能**删掉被 Record 引用的 blob——这是本阶段最重要的一条。见 Task 7。
3. **令牌不能越权/越界**：令牌换方向（拿 upload 的令牌去 GET）、换 blob、过期之后，都必须被拒；下载还必须校验属主（别人的 blob 取不走）。见 Task 6。
4. **大文件不许进内存**：上传/下载都必须是流式的（边写边哈希、边读边发），512 MiB 上限在**超限时中止**而不是先收完再判断。见 Task 2 + Task 5。
5. **引用在 Record 里原样保留**：`evidence.result` 里的 `content_ref` 结构要能被 Record 原样存下并查回（不需要新增 Record 字段，但必须有测试钉住）。见 Task 8。

---

### Task 1: `@adt/shared` 的 blob 协议类型与 id

**Files:**
- Create: `packages/shared/src/protocol/blob.ts`
- Modify: `packages/shared/src/protocol/ids.ts`、`packages/shared/src/index.ts`
- Test: `packages/shared/test/protocol/blob.test.ts`（新建）

**Interfaces:**
- Produces:
  - `type BlobDirection = "upload" | "download"`
  - `interface BlobRef { content_ref: string; media_type: string; size: number; sha256: string; name?: string }`
  - `interface BlobAllocatePayload { direction: BlobDirection; content_ref?: string; name?: string; media_type?: string; size?: number; sha256?: string }`
  - `interface BlobAllocateResponse { content_ref: string; url: string; expires_at: string }`
  - `newContentRefId(): string`（`blob_<uuid>`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/test/protocol/blob.test.ts
import { describe, it, expect } from "vitest";
import { newContentRefId } from "../../src/protocol/ids";

describe("blob protocol", () => {
  it("mints content refs with a recognisable prefix and no collisions", () => {
    const a = newContentRefId();
    const b = newContentRefId();
    expect(a).toMatch(/^blob_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/shared exec vitest run test/protocol/blob.test.ts`
Expected: FAIL（`newContentRefId` 未导出）

- [ ] **Step 3: 实现**

在 `ids.ts` 加 `newContentRefId()`（沿用 `newMessageId` 的写法，前缀 `blob_`）；新建 `protocol/blob.ts` 放上列的四个类型（只放类型与常量，`BlobRef` 就是 §7.5 那个引用对象）；`index.ts` 里 `export * from "./protocol/blob";`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/shared exec vitest run test/protocol/ && pnpm -C packages/shared exec tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/shared
git commit -m "feat(shared): blob channel protocol types"
```

---

### Task 2: `LocalBlobStore`——字节层（内容寻址 + 流式校验）

**Files:**
- Create: `packages/server/src/blob/store.ts`
- Test: `packages/server/test/blob/store.test.ts`（新建）

**Interfaces:**
- Produces:
  - `class BlobIntegrityError extends Error`（message 里带实际/期望的 `sha256` 或 `size`）
  - `interface BlobStore { write(source, expect): Promise<{sha256, size}>; read(sha256): Promise<Readable | null>; has(sha256): Promise<boolean>; delete(sha256): Promise<void> }`
  - `createLocalBlobStore(root: string): BlobStore`
  - `write` 的 `expect: { sha256: string; size: number; maxBytes: number }`；存储路径 `<root>/<sha256[0:2]>/<sha256>`；写入走 `<root>/tmp/<random>` 再原子改名为最终路径

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/blob/store.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createLocalBlobStore, BlobIntegrityError } from "../../src/blob/store";

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const root = (): Promise<string> => mkdtemp(join(tmpdir(), "adt-blob-"));

const streamOf = (data: Buffer): Readable => Readable.from([data]);

describe("LocalBlobStore", () => {
  it("stores by content address and reads the same bytes back", async () => {
    const store = createLocalBlobStore(await root());
    const data = Buffer.from("can trace line 1\n");
    const digest = sha(data);

    const written = await store.write(streamOf(data), {
      sha256: digest,
      size: data.length,
      maxBytes: 1024,
    });

    expect(written).toEqual({ sha256: digest, size: data.length });
    const read = (await store.read(digest))!;
    const chunks: Buffer[] = [];
    for await (const chunk of read) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    expect(await store.has(digest)).toBe(true);
  });

  it("rejects a stream whose sha256 does not match the declaration", async () => {
    const store = createLocalBlobStore(await root());
    await expect(
      store.write(streamOf(Buffer.from("real")), {
        sha256: sha(Buffer.from("declared")),
        size: 4,
        maxBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("aborts as soon as the stream exceeds maxBytes", async () => {
    const store = createLocalBlobStore(await root());
    const big = Buffer.alloc(4096, 1);
    await expect(
      store.write(streamOf(big), { sha256: sha(big), size: big.length, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("deletes stored bytes", async () => {
    const store = createLocalBlobStore(await root());
    const data = Buffer.from("x");
    const digest = sha(data);
    await store.write(streamOf(data), { sha256: digest, size: 1, maxBytes: 16 });
    await store.delete(digest);
    expect(await store.has(digest)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/blob/store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`createLocalBlobStore(root)`：启动时确保 `root` 与 `root/tmp` 存在（`mkdir` recursive）。`write` 用 `createWriteStream` 到临时路径，`for await` 消费 `source`，**每块都**更新 `createHash("sha256")`、累加 size 并在超 `maxBytes` 时立刻 `destroy()` 临时写流 + 抛 `BlobIntegrityError`；收尾后比对 sha256/size，不符则删临时文件并抛 `BlobIntegrityError`，相符则 `mkdir` 目标分片目录并 `rename` 到位。`read` 返回 `createReadStream`（不存在则 `null`），`has` 用 `access`，`delete` 用 `rm(..., { force: true })`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/blob/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/blob/store.ts packages/server/test/blob/store.test.ts
git commit -m "feat(blob): content-addressed local store with streaming integrity checks"
```

---

### Task 3: `blobs` 表 + `PostgresBlobRepository`

**Files:**
- Create: `packages/server/migrations/009_blobs.sql`、`packages/server/src/blob/repository.ts`
- Test: `packages/server/test/blob/repository.test.ts`（新建）

**Interfaces:**
- Produces:
  - `interface BlobRecord { contentRef; ownerUserId; direction: BlobDirection; name: string | null; mediaType: string; size: number; sha256: string; createdAt: number; expiresAt: number; committedAt: number | null }`
  - `interface BlobRepository { create(record): Promise<void>; get(contentRef): Promise<BlobRecord | null>; commit(contentRef, at): Promise<void>; listExpired(now): Promise<BlobRecord[]>; remove(contentRef): Promise<void>; isReferenced(contentRef): Promise<boolean>; sharesBytes(sha256, exceptContentRef): Promise<boolean> }`
  - `class PostgresBlobRepository implements BlobRepository`（构造参数 `Pool`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/blob/repository.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresBlobRepository } from "../../src/blob/repository";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let repo: PostgresBlobRepository;

beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE blobs, records"); repo = new PostgresBlobRepository(pool); });
afterAll(async () => { await pool.end(); });

const record = (over = {}) => ({
  contentRef: "blob_a", ownerUserId: "usr_1", direction: "upload" as const,
  name: "can.log", mediaType: "text/plain", size: 10,
  sha256: "a".repeat(64), createdAt: 1000, expiresAt: 2000, committedAt: null, ...over,
});

describe("PostgresBlobRepository", () => {
  it("round-trips a blob row and commits it", async () => {
    await repo.create(record());
    expect((await repo.get("blob_a"))!.committedAt).toBeNull();
    await repo.commit("blob_a", 1500);
    expect((await repo.get("blob_a"))!.committedAt).toBe(1500);
  });

  it("lists only expired rows", async () => {
    await repo.create(record({ contentRef: "blob_old", expiresAt: 2000 }));
    await repo.create(record({ contentRef: "blob_new", expiresAt: 9000 }));
    expect((await repo.listExpired(5000)).map((r) => r.contentRef)).toEqual(["blob_old"]);
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
  });

  it("reports whether another row still points at the same bytes", async () => {
    await repo.create(record({ contentRef: "blob_a" }));
    await repo.create(record({ contentRef: "blob_b" }));
    expect(await repo.sharesBytes("a".repeat(64), "blob_a")).toBe(true);
    await repo.remove("blob_b");
    expect(await repo.sharesBytes("a".repeat(64), "blob_a")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/blob/repository.test.ts`
Expected: FAIL（表与模块不存在）

- [ ] **Step 3: 实现**

`009_blobs.sql`：`CREATE TABLE IF NOT EXISTS blobs (content_ref text PRIMARY KEY, owner_user_id text NOT NULL, direction text NOT NULL, name text, media_type text NOT NULL, size bigint NOT NULL, sha256 text NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL, committed_at bigint)`，外加 `blobs_expiry_idx ON blobs (expires_at)` 与 `blobs_sha_idx ON blobs (sha256)`。`PostgresBlobRepository` 逐方法映射；`isReferenced` 用 `SELECT 1 FROM records WHERE position($1 in document::text) > 0 LIMIT 1`（不要用 `LIKE`：content_ref 里的 `_` 会被当通配符）；`sharesBytes` 用 `SELECT 1 FROM blobs WHERE sha256 = $1 AND content_ref <> $2 LIMIT 1`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/blob/repository.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/migrations/009_blobs.sql packages/server/src/blob/repository.ts packages/server/test/blob/repository.test.ts
git commit -m "feat(blob): blob metadata table and repository"
```

---

### Task 4: 签名令牌 + 配置 + `blob.allocate_request/response`

**Files:**
- Create: `packages/server/src/blob/token.ts`、`packages/server/src/blob/config.ts`、`packages/server/src/blob/protocol.ts`
- Modify: `packages/server/src/server.ts`（`CreateServerOptions.blobs` → 注册申请消息）
- Test: `packages/server/test/blob/token.test.ts`、`packages/server/test/blob/allocate.test.ts`（新建）

**Interfaces:**
- Produces:
  - `interface BlobTokenSigner { sign(input): string; verify(token): BlobTokenClaims | null }`，`createBlobTokenSigner(secret: string)`
  - `interface BlobTokenClaims { contentRef: string; direction: BlobDirection; userId: string; expiresAt: number }`
  - `interface BlobConfig { baseUrl: () => string; dataDir: string; secret: string; tokenTtlMs: number; retentionMs: number; maxBlobBytes: number; inlineThresholdBytes: number; allowedMediaTypes: ReadonlySet<string> }`、`DEFAULT_BLOB_CONFIG`、`blobConfigFromEnv(env): BlobConfig`（`BLOB_SECRET` 未设 → `randomBytes(32)` 并 `console.warn`）
  - `registerBlobProtocol(deps: { router; repository; signer; config; now?: () => number }): void`
  - `server.ts` 的 `CreateServerOptions.blobs?: { repository; store; signer; config }`（**这四件一起传**：申请只用得到前三个与 config，但 HTTP 路由在 Task 5 需要 `store`，统一成一个对象避免两处结构漂移）
  - 申请校验失败 → `blob_rejected`；成功 → `{ content_ref, url: \`${config.baseUrl()}/blob/${contentRef}?token=${token}\`, expires_at }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/blob/token.test.ts
import { describe, it, expect } from "vitest";
import { createBlobTokenSigner } from "../../src/blob/token";

describe("blob token signer", () => {
  const signer = createBlobTokenSigner("test-secret");
  const claims = { contentRef: "blob_a", direction: "upload" as const, userId: "usr_1", expiresAt: 5000 };

  it("verifies its own token", () => {
    expect(signer.verify(signer.sign(claims))).toEqual(claims);
  });

  it("rejects a tampered payload and a foreign secret", () => {
    const token = signer.sign(claims);
    const [payload, mac] = token.split(".") as [string, string];
    expect(signer.verify(`${payload}x.${mac}`)).toBeNull();
    expect(createBlobTokenSigner("other-secret").verify(token)).toBeNull();
  });
});
```

```ts
// packages/server/test/blob/allocate.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { encodeEnvelope, PROTOCOL_VERSION } from "@adt/shared";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { MessageRouter } from "../../src/ws/messageRouter";
import { Connection } from "../../src/ws/connection";
import { PostgresBlobRepository } from "../../src/blob/repository";
import { createBlobTokenSigner } from "../../src/blob/token";
import { registerBlobProtocol } from "../../src/blob/protocol";
import { DEFAULT_BLOB_CONFIG } from "../../src/blob/config";
import { TEST_DATABASE_URL } from "@adt/test-support";

// 沿既有 test/router.test.ts 的假 Connection 写法，不真开端口。
let pool: ReturnType<typeof createPool>;
let repo: PostgresBlobRepository;

beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE blobs, records"); repo = new PostgresBlobRepository(pool); });
afterAll(async () => { await pool.end(); });

const userId = "usr_1";
const session = { id: "sess_1", userId } as never;

function harness() {
  const sent: string[] = [];
  const conn = new Connection({ send: (data) => sent.push(data), close: () => undefined }, "c1");
  const router = new MessageRouter({ byConnection: () => session });
  registerBlobProtocol({
    router,
    repository: repo,
    signer: createBlobTokenSigner("test-secret"),
    config: { ...DEFAULT_BLOB_CONFIG, baseUrl: () => "http://blob.test", secret: "test-secret" },
    now: () => 1000,
  });
  const ask = async (payload: Record<string, unknown>) => {
    await router.handle(
      conn,
      encodeEnvelope({
        protocol_version: PROTOCOL_VERSION, message_id: "msg_1", session_id: "sess_1",
        workflow_id: null, user_id: userId, type: "blob.allocate_request",
        ts: "2026-09-30T10:00:00.000Z", in_reply_to: null, payload,
      }),
    );
    return JSON.parse(sent.at(-1)!) as { type: string; payload: Record<string, unknown> };
  };
  return { ask };
}

const upload = {
  direction: "upload", name: "can.log", media_type: "text/plain",
  size: 10, sha256: "a".repeat(64),
};

describe("blob.allocate_request", () => {
  it("hands out a signed url and records an uncommitted row", async () => {
    const { ask } = harness();
    const reply = await ask(upload);

    expect(reply.type).toBe("blob.allocate_response");
    const contentRef = reply.payload.content_ref as string;
    expect(contentRef).toMatch(/^blob_/);
    const url = new URL(reply.payload.url as string);
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
    expect(await repo.listExpired(0)).toEqual([]);
  });

  it("rejects an oversize request, an unknown download ref and someone else's ref", async () => {
    const { ask } = harness();
    const tooBig = await ask({ ...upload, size: DEFAULT_BLOB_CONFIG.maxBlobBytes + 1 });
    expect((tooBig.payload as { code: string }).code).toBe("blob_rejected");

    const missing = await ask({ direction: "download", content_ref: "blob_missing" });
    expect((missing.payload as { code: string }).code).toBe("blob_rejected");

    await repo.create({
      contentRef: "blob_other", ownerUserId: "usr_2", direction: "upload", name: null,
      mediaType: "text/plain", size: 1, sha256: "b".repeat(64),
      createdAt: 0, expiresAt: 9_999_999, committedAt: 1,
    });
    const foreign = await ask({ direction: "download", content_ref: "blob_other" });
    expect((foreign.payload as { code: string }).code).toBe("blob_rejected");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/blob/token.test.ts test/blob/allocate.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`token.ts`：`token = base64url(JSON.stringify(claims)) + "." + base64url(hmacSha256(secret, payload))`；`verify` 重算 MAC（**用 `timingSafeEqual` 且长度不等时先返回 null**）、`JSON.parse` 失败返回 `null`，**不做过期判断**（过期由调用方按 `expiresAt` 判，令牌本身只是签名，路由层再比当前时间）。
`config.ts`：按 Global Constraints 的默认值给 `DEFAULT_BLOB_CONFIG`；`blobConfigFromEnv` 读 `BLOB_BASE_URL`/`BLOB_SECRET`/`BLOB_DATA_DIR` 并允许覆盖上限与 TTL。
`protocol.ts`：`router.register("blob.allocate_request", ...)`——`session` 为空直接返回；按 `direction` 分支校验（upload 必填 `name`/`media_type`/`size`/`sha256`，download 必填 `content_ref` 且行存在 + `ownerUserId === session.userId` + `committedAt !== null`）；任一项不合规 → `sendError(conn, session, "blob_rejected", <原因>, env.message_id)`；合规 → 生成 `content_ref`（upload 才建行，`expiresAt = now + retentionMs`）→ 签名 → 回 `blob.allocate_response`（`inReplyTo: env.message_id`）。
`server.ts`：`CreateServerOptions` 增 `blobs?: { repository; signer; config }`，在 `registerCapabilitySync` 之后调用 `registerBlobProtocol`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/blob/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/blob packages/server/src/server.ts packages/server/test/blob
git commit -m "feat(blob): signed-URL allocation over the protocol"
```

---

### Task 5: 上传端点（流式 + 校验后才提交）

**Files:**
- Create: `packages/server/src/blob/http.ts`
- Modify: `packages/server/src/http/app.ts`（`ServerDeps.blobs?` → 注册路由）、`packages/server/src/server.ts`（透传）
- Test: `packages/server/test/blob/upload.test.ts`（新建）

**Interfaces:**
- Produces: `registerBlobRoutes(app: FastifyInstance, deps: { repository; store; signer; config; now?: () => number }): void`
  - `PUT /blob/:contentRef?token=…` → 校验令牌（`direction === "upload"`、`contentRef` 一致、未过期、`userId` 一致）→ 行存在且未提交 → `store.write(request.raw, { sha256, size, maxBytes })` → `repository.commit(contentRef, now)` → `201 { content_ref, size, sha256 }`
  - 失败：令牌无效/过期 → `401`；`BlobIntegrityError` → `400`（**不 commit**）；行不存在/已提交 → `409`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/blob/upload.test.ts
// 用 buildServer + app.inject（Fastify 内置，无需真开端口）：
// 1) 先经 repository.create(...) 造一行，再 signer.sign({direction:"upload",...}) 造令牌
// 2) PUT 正确字节 → 201；repository.get(...)!.committedAt 非空；store.has(sha256) 为 true
// 3) PUT 与声明 sha256 不符的字节 → 400；committedAt 仍为 null；store.has(真 sha) 为 false
// 4) 用 download 方向的令牌 PUT → 401
// 5) 令牌过期（now 注入为 expiresAt 之后）→ 401
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/blob/upload.test.ts`
Expected: FAIL（路由不存在 → 404）

- [ ] **Step 3: 实现**

在 `registerBlobRoutes` 里注册 `PUT`。**必须先解决 Fastify 的 415**：默认情况下 Fastify 只解析 `application/json` 与 `text/plain`，`application/octet-stream` 之类会直接被拒（415）。所以在注册路由时同时注册一个**catch-all content-type parser**，把原始流原样交给处理函数：

```ts
app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
```

处理函数里用 `request.raw`（`IncomingMessage`）交给 `store.write` 流式消费——**不要**先把 body 收进内存（这也是 Review Focus 4 的落点）。校验顺序：令牌 → 行状态 → 写入并校验 → 提交。所有错误路径都**不**提交行（未提交的行会随过期回收被清掉，见 Task 7）。`http/app.ts` 的 `ServerDeps` 加可选 `blobs`（结构即 Task 4 定义的 `{ repository, store, signer, config }`），`server.ts` 原样透传，并在有 `blobs` 时调用 `registerBlobRoutes`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/blob/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/blob/http.ts packages/server/src/http/app.ts packages/server/src/server.ts packages/server/test/blob/upload.test.ts
git commit -m "feat(blob): streaming upload endpoint that commits only valid bytes"
```

---

### Task 6: 下载端点（令牌 + 属主 + 流式返回）

**Files:**
- Modify: `packages/server/src/blob/http.ts`
- Test: `packages/server/test/blob/download.test.ts`（新建）

**Interfaces:**
- Produces: `GET /blob/:contentRef?token=…` → 校验令牌（`direction === "download"`、未过期、`userId` 一致）→ 行存在、**已提交**、`ownerUserId === userId` → `200`，`Content-Type: media_type`、`Content-Length: size`、`ETag`/`X-Blob-Sha256: sha256`，body 为 `store.read(sha256)` 流
  - 失败：令牌无效/过期/方向不符 → `401`；行不存在/未提交/属主不符 → `404`（**不**用 403 泄露存在性）

- [ ] **Step 1: 写失败测试**

断言：
- 上传完再申请 `download` 令牌 → `GET` 200，字节与原始一致，`content-type` 为 `text/plain`，`x-blob-sha256` 等于 `sha256`。
- 用 `upload` 令牌 `GET` → 401。
- 另一个用户的下载令牌（`userId: "usr_2"`）→ 404。
- 未提交的行（只 `create` 没 `commit`）→ 404。
- 令牌过期 → 401。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/blob/download.test.ts`
Expected: FAIL（404，路由不存在）

- [ ] **Step 3: 实现**

在同一个 `registerBlobRoutes` 里注册 `GET`；先把 `Content-Type`/`Content-Length`/`ETag` 头写好，再 `return reply.send(stream)`。**注意**：`GET` 必须校验 `row.ownerUserId === claims.userId`（令牌里的 `userId` 来自签发时的会话），且属主不符时统一回 `404`（不要回 403，避免"这个 ref 存在"被探测）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/blob/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/blob/http.ts packages/server/test/blob/download.test.ts
git commit -m "feat(blob): download endpoint with token, owner and streamed body"
```

---

### Task 7: `BlobLifecycle`——过期回收，且绝不删被引用者

**Files:**
- Create: `packages/server/src/blob/lifecycle.ts`
- Modify: `packages/server/src/server.ts`（`CreateServerOptions.blobs` 增 `lifecycleIntervalMs?` 并 `start()`）、`packages/test-support/src/server.ts`（同样接线 + 暴露 `blobLifecycle`）
- Test: `packages/server/test/blob/lifecycle.test.ts`（新建）

**Interfaces:**
- Produces:
  - `class BlobLifecycle { constructor(deps: { repository; store; now?: () => number }, options: { intervalMs: number }); sweep(): Promise<string[]>; start(): void; stop(): void }`
  - `sweep()`：取 `listExpired(now)`；对每行——**先** `isReferenced(contentRef)`，为真则跳过（并记 `console.warn` 一次）；否则 `remove(contentRef)`，再 `sharesBytes(sha256, contentRef)` 为假才 `store.delete(sha256)`；返回被删的 content_ref 列表

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/blob/lifecycle.test.ts
// 1) 造两个 blob：blob_keep（被一条 Record 引用）、blob_drop（没被引用），两者都已过期且都已提交
// 2) sweep(now) 只返回 ["blob_drop"]；repository.get("blob_keep") 仍存在、store.has(keepSha) 仍为 true
// 3) 同一个 sha256 被两行共用时：删掉一行后文件仍在（sharesBytes 为真），删掉第二行才真删文件
// 4) 未提交的行过期后也被清掉（放弃的上传不留垃圾）
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/blob/lifecycle.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

按 Interfaces 写 `sweep()`；`start/stop` 沿用 `StepTimeoutMonitor` 的写法（`setInterval` + `unref()` + 在途保护），并在 `server.ts` 与 `test-support` 里创建、`start()`，关闭时 `stop()`。`test-support` 的 `TestServerOptions` 增 `blobDataDir?` / `blobRetentionMs?` / `blobLifecycleIntervalMs?`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/blob/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/blob/lifecycle.ts packages/server/src/server.ts packages/test-support/src/server.ts packages/server/test/blob/lifecycle.test.ts
git commit -m "feat(blob): expire unreferenced blobs, never touch a referenced one"
```

---

### Task 8: 客户端 helper（申请 + 上传 + 下载）与端到端

**Files:**
- Create: `packages/client-daemon/src/blob.ts`
- Modify: `packages/client-daemon/src/connection.ts`（加 `request()`）、`packages/client-daemon/src/index.ts`（导出）、`packages/client-daemon/test/blob.e2e.test.ts`（新建）
- Test: `packages/client-daemon/test/blob.e2e.test.ts`

**Interfaces:**
- Produces:
  - `DaemonConnection.request(type: string, payload: unknown, replyType: string, timeoutMs?: number): Promise<Record<string, unknown>>`——发出后按 `replyType` 收**一次**响应并解开 `payload`；超时或收到 `protocol.error` 时抛错
  - `interface BlobClientDeps { connection: Pick<DaemonConnection, "request">; fetchImpl?: typeof fetch }`
  - `uploadBlob(deps, input: { name: string; mediaType: string; bytes: Uint8Array }): Promise<BlobRef>`——算 sha256 → `blob.allocate_request{upload}` → `PUT url` → 2xx 后返回 `BlobRef`
  - `downloadBlob(deps, contentRef: string): Promise<Buffer>`——`blob.allocate_request{download, content_ref}` → `GET url` → `Buffer.from(await res.arrayBuffer())`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/blob.e2e.test.ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";
import { uploadBlob, downloadBlob } from "../src/blob";

describe("blob channel end to end", () => {
  it("uploads bytes as a content_ref and downloads the very same bytes", async () => {
    const srv = await startTestServer({});
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "blob-e2e", platform: "test" },
      workspaceRoot: process.cwd(),
    });

    const bytes = Buffer.from("can trace line 1\nline 2\n");
    const ref = await uploadBlob({ connection: daemon.connection }, {
      name: "can_trace.log",
      mediaType: "text/plain",
      bytes,
    });

    expect(ref.content_ref).toMatch(/^blob_/);
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(ref.size).toBe(bytes.length);

    const back = await downloadBlob({ connection: daemon.connection }, ref.content_ref);
    expect(back.equals(bytes)).toBe(true);

    await daemon.close();
    await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/blob.e2e.test.ts`
Expected: FAIL（模块/方法不存在）

- [ ] **Step 3: 实现**

`connection.ts` 的 `request()`：生成 `message_id`，注册一次性 `on(replyType)` 处理器（比对 `in_reply_to === messageId`，不符则忽略继续等），`send` 之后带超时等待；收到 `protocol.error` 且 `in_reply_to` 匹配则 reject。`blob.ts`：`uploadBlob` 用 `createHash("sha256")` 算摘要、走 `request("blob.allocate_request", …, "blob.allocate_response")`、再 `fetch(url, { method: "PUT", body: bytes })`（`fetchImpl` 可注入以便测试替身），非 2xx 抛错；`downloadBlob` 同理走 `GET`。**注意**：`startTestServer` 必须把 `baseUrl` 指向自己实际监听的端口（Task 7 已要求接线，这里补一个 `blobBaseUrl` 的实现）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/blob.e2e.test.ts && pnpm -C packages/client-daemon test`
Expected: PASS（既有 21 个测试文件不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon
git commit -m "feat(daemon): upload and download blobs over the channel"
```

---

### Task 9: 规格与文档同步

**Files:**
- Modify: `docs/specs/PROTOCOL_SPEC.md`（v0.8 → **v0.9**：§7.5 写实——两个方向的申请字段、令牌形式与有效期、`url` 的来源、上传完成以 HTTP 响应为准、默认值；§12 的 `blob_rejected` 说明补"申请内容不合规/超尺寸/无权限"）
- Modify: `docs/adr/ADR-004-tech-stack.md`（§2 blob 行补"已落地：`LocalBlobStore`，内容寻址 + 流式校验；元数据在 `blobs` 表"）
- Modify: `docs/REQUIREMENTS.md`（§7 引用行版本；FR-1 的落实说明）
- Modify: `README.md`（当前状态补 P4c）

**Interfaces:**
- Consumes: Task 1–8
- Produces: 文档与实现一致

- [ ] **Step 1: 改 PROTOCOL_SPEC §7.5**

把原来那段"示例"补成可实现的契约：`BlobAllocatePayload` 的两个方向字段表、`content_ref` 形如 `blob_<uuid>`、`url = <baseUrl>/blob/<content_ref>?token=<HMAC>`、令牌签名内容与有效期（默认 15 分钟）、**上传完成的凭据是 `PUT` 的 2xx 响应**（不新增消息）、默认值表（内联阈值 64 KiB「只登记不强制」/ 单 blob 512 MiB / 保留期 30 天）、**过期只删未被 Record 引用的 blob**。

- [ ] **Step 2: 同步 ADR-004、REQUIREMENTS、README**

- [ ] **Step 3: 验证**

Run: `grep -n "Version" docs/specs/PROTOCOL_SPEC.md | head -2`
Expected: `v0.9`

- [ ] **Step 4: 提交**

```bash
git add docs/ README.md
git commit -m "docs: blob channel contract, defaults and retention rule"
```

---

## Self-Review

**1. Spec coverage：** §7.5 的四条——小体积内联（阈值登记，Task 4/9）、大体积只传引用（`BlobRef`，Task 1）、申请制流程（Task 4 + 5 + 6）、`blob_rejected` 与白名单/上限（Task 4）、Record 保留 `content_ref`（Task 3 的 `isReferenced` + Task 8 的端到端）；ADR-004 的 `BlobStore` 抽象（Task 2）。四项决策逐条落到任务：双向（5/6/8）、签名令牌（4）、只删未引用（7）、阈值不强制（Global Constraints + 9）。**刻意不做**：内联阈值强制、能力层自动外置大输出、blob 的 workflow 级归属、UI 取回。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支。

**3. Type consistency：** `BlobRef`/`BlobDirection`/`BlobAllocateResponse`（T1）、`BlobStore.write` 的 `expect`（T2）、`BlobRecord`/`BlobRepository`（T3）、`BlobConfig`/`BlobTokenClaims`/`registerBlobProtocol`（T4）、`registerBlobRoutes`（T5/T6）、`BlobLifecycle.sweep`（T7）、`uploadBlob`/`downloadBlob`/`DaemonConnection.request`（T8）在各任务间同名复用。

**4. Review Focus：** 五条风险落到测试——坏字节不落库（T5）、引用不被删（T7）、令牌越权/越界（T4/T6）、大文件不入内存（T2 的 maxBytes 中止 + T5 流式）、引用原样保留（T3 + T8）。

**5. Proportion：** 计划只描述决策、接口与断言；实现体只写"签名 + 关键分支"。Task 2/3/4 给了完整测试代码（它们是本阶段的契约面）；Task 5/6/7 的测试只写断言清单——因为夹具要复用既有假 Connection / `app.inject` 写法，逐行抄夹具会变成转写而不是定契约。

**6. 执行顺序上的依赖：** Task 8 的端到端依赖 Task 7 在 `test-support` 里接好 `baseUrl`（否则 `blob.allocate_response` 的 `url` 指向一个没监听的地址）。Task 5 依赖 Task 4 定的 `blobs` 依赖对象形状。计划已按此排序，执行时不要跳序。

## 移交后续计划的待办

1. **P4d（KB 导出）**：ADR-005 出站。
2. **内联阈值强制**：本阶段只登记；要强制时加一条 `invalid_output` 类校验（超阈值内联 → 拒绝并要求走 blob）。
3. **能力层外置**：`terminal.execute_command` 的大 stdout 何时转 blob，属于能力语义，留给后续（可能由 `output_schema` 的 `x-max-inline` 之类声明驱动）。
4. **反向代理部署**：`url` 目前由 `BLOB_BASE_URL`（默认 `http://127.0.0.1:${PORT}`）拼接；真部署时需配置公网可达的 base，或接受 `Host` 头推导（本阶段不做）。

## 后续

P4c 验收通过后写 **P4d（KB 导出）**。
