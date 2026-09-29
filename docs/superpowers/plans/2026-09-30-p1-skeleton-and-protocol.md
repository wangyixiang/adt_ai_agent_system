# P1 骨架与协议层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 pnpm monorepo，并实现一条**已认证的 Client↔Server 长连接**：认证握手、能力同步、心跳与协议错误处置。

**Architecture:** TypeScript 同栈。`shared` 包持有协议类型与编解码（唯一事实源）；`server` 用 Fastify + `ws` 自持信封，账号存 PostgreSQL；`client-daemon` 用同一份 `shared` 建立连接。本阶段只做会话层，不含 Workflow。

**Tech Stack:** Node.js LTS · TypeScript（strict）· pnpm workspaces · Fastify · ws · PostgreSQL（`pg`）· argon2 · Vitest

**Spec:** `docs/adr/ADR-004-tech-stack.md`、`docs/specs/PROTOCOL_SPEC.md`（v0.5 §2/§4/§5/§6/§9/§12）、`docs/adr/ADR-003-deployment-and-trust-model.md`、`docs/superpowers/specs/2026-09-29-mvp-scope.md`

## Global Constraints

- 协议版本常量 `PROTOCOL_VERSION = "0.3"`（`PROTOCOL_SPEC.md` §13）。
- 序列化用 JSON；信封字段固定为 `protocol_version / message_id / session_id / workflow_id / user_id / type / ts / in_reply_to / payload`（§2）。
- 所有 `ts` 一律 **UTC ISO 8601 带 `Z`**；排序与超时以 Server 单调时钟为准（§2、§9）。
- `message_id` 去重窗口 = **会话生命周期**；重复消息忽略并告警（§2、§E3）。
- **收到无法识别的消息类型不得断开连接**，忽略并告警（§12）。
- 保守默认：`side_effect` 缺失视为 `true`；`interruptible` 缺失视为 `false`；`idempotent` 缺失视为 `false`（§6）。
- 未登记 Capability 名称：忽略该项并告警，**不拒绝整条消息**（§6）。
- v0.1 **不要求 TLS**（`ADR-003` §4）。
- 认证：本地账号；`user_id` 握手后**必填并由 Server 校验**（`ADR-003` §3、`PROTOCOL_SPEC.md` §5.1）。
- 密码用 argon2 哈希存储；明文不落库、不写日志。

## Review Focus

以下输入/失败模式是 Spec 隐含但容易被漏测的，**每条都必须在对应任务里有测试**：

1. **`capability.sync` 携带更旧的 `revision`** → 必须被忽略（不覆盖新状态）并告警。
2. **`side_effect` / `interruptible` 缺失** → 必须按保守默认（`true` / `false`）处理，而不是报错拒绝。
3. **未登记的 Capability 名称** → 忽略该项并告警，整条消息仍生效。
4. **未知消息类型** → 回 `unknown_message_type`，连接**保持**。
5. **认证失败** → 回 `auth_failed` 并**断开**，不下发 `session.welcome`。

---

### Task 1: Monorepo 骨架 + `shared` 信封编解码

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`.gitignore`
- Create: `packages/shared/package.json`、`packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/protocol/envelope.ts`
- Create: `packages/shared/src/protocol/ids.ts`
- Test: `packages/shared/test/envelope.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `const PROTOCOL_VERSION: "0.3"`
  - `interface Envelope { protocol_version: string; message_id: string; session_id: string | null; workflow_id: string | null; user_id: string | null; type: string; ts: string; in_reply_to: string | null; payload: unknown }`
  - `class EnvelopeError extends Error { readonly code: "malformed_payload" }`
  - `function encodeEnvelope(e: Envelope): string`
  - `function decodeEnvelope(raw: string | Buffer): Envelope`（失败抛 `EnvelopeError`）
  - `function newMessageId(): string`（形如 `msg_<uuid>`）
  - `function nowUtcIso(): string`（形如 `2026-09-30T10:00:00.000Z`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/test/envelope.test.ts
import { describe, it, expect } from "vitest";
import { encodeEnvelope, decodeEnvelope, EnvelopeError, PROTOCOL_VERSION } from "../src";

const base = {
  protocol_version: PROTOCOL_VERSION, message_id: "msg_1",
  session_id: null, workflow_id: null, user_id: null,
  type: "session.hello", ts: "2026-09-30T10:00:00.000Z",
  in_reply_to: null, payload: { a: 1 },
};

describe("envelope", () => {
  it("round-trips a valid envelope", () => {
    expect(decodeEnvelope(encodeEnvelope(base))).toEqual(base);
  });
  it("rejects invalid JSON", () => {
    expect(() => decodeEnvelope("{")).toThrow(EnvelopeError);
  });
  it("rejects non-UTC ts", () => {
    expect(() => decodeEnvelope(JSON.stringify({ ...base, ts: "2026-09-30T10:00:00+08:00" })))
      .toThrow(EnvelopeError);
  });
  it("rejects missing type", () => {
    const { type, ...rest } = base;
    expect(() => decodeEnvelope(JSON.stringify(rest))).toThrow(EnvelopeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @adt/shared test`
Expected: FAIL（`Cannot find module '../src'`）

- [ ] **Step 3: 建 monorepo 骨架并实现编解码**

根 `package.json` 设 `"private": true`、`workspaces` 由 `pnpm-workspace.yaml`（`packages: ["packages/*"]`）声明；`tsconfig.base.json` 开 `strict`、`module: NodeNext`、`target: ES2022`。`packages/shared/package.json` 名 `@adt/shared`，脚本 `"test": "vitest run"`。

`envelope.ts`：`decodeEnvelope` 依次校验 JSON 可解析、是对象、`type` 为非空 string、`ts` 匹配 `/Z$/` 且可被 `Date.parse`、`message_id` 为非空 string；任一不满足抛 `EnvelopeError("malformed_payload")`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/shared test`
Expected: PASS（4 passed）

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore packages/shared
git commit -m "feat(shared): monorepo skeleton and protocol envelope codec"
```

---

### Task 2: 错误码与处置矩阵 + 会话级去重窗口

**Files:**
- Create: `packages/shared/src/protocol/errors.ts`
- Create: `packages/shared/src/protocol/dedup.ts`
- Modify: `packages/shared/src/index.ts`（re-export）
- Test: `packages/shared/test/errors.test.ts`、`packages/shared/test/dedup.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Envelope`、`newMessageId`、`nowUtcIso`
- Produces:
  - `type ErrorCode = "unsupported_version" | "session_expired" | "auth_failed" | "unknown_message_type" | "malformed_payload" | "unknown_workflow" | "unknown_step" | "unknown_record" | "blob_rejected"`
  - `type Disposition = "fatal" | "request" | "ignore"`
  - `const ERROR_DISPOSITION: Record<ErrorCode, Disposition>`
  - `function makeError(code: ErrorCode, message: string, inReplyTo: string | null): Envelope`
  - `class DedupWindow { has(id: string): boolean; add(id: string): void; clear(): void }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/test/errors.test.ts
import { describe, it, expect } from "vitest";
import { ERROR_DISPOSITION, makeError } from "../src";

describe("error disposition", () => {
  it("marks version/session/auth as fatal", () => {
    expect(ERROR_DISPOSITION.unsupported_version).toBe("fatal");
    expect(ERROR_DISPOSITION.session_expired).toBe("fatal");
    expect(ERROR_DISPOSITION.auth_failed).toBe("fatal");
  });
  it("marks unknown_message_type as ignore", () => {
    expect(ERROR_DISPOSITION.unknown_message_type).toBe("ignore");
  });
  it("builds a protocol.error envelope", () => {
    const e = makeError("unknown_step", "no such step", "msg_9");
    expect(e.type).toBe("protocol.error");
    expect(e.in_reply_to).toBe("msg_9");
    expect(e.payload).toEqual({ code: "unknown_step", message: "no such step" });
  });
});
```

```ts
// packages/shared/test/dedup.test.ts
import { describe, it, expect } from "vitest";
import { DedupWindow } from "../src";

describe("DedupWindow", () => {
  it("reports first-seen vs duplicate", () => {
    const w = new DedupWindow();
    expect(w.has("msg_1")).toBe(false);
    w.add("msg_1");
    expect(w.has("msg_1")).toBe(true);
  });
  it("clears with the session", () => {
    const w = new DedupWindow();
    w.add("msg_1");
    w.clear();
    expect(w.has("msg_1")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @adt/shared test`
Expected: FAIL（找不到 `ERROR_DISPOSITION` / `DedupWindow`）

- [ ] **Step 3: 实现**

`ERROR_DISPOSITION` 严格按 `PROTOCOL_SPEC.md` §12 的处置矩阵填全 9 个 code。`makeError` 生成 `type: "protocol.error"`、`payload: { code, message }`、`ts: nowUtcIso()`、其余字段为 `null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/shared test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/shared
git commit -m "feat(shared): error disposition matrix and session dedup window"
```

---

### Task 3: PostgreSQL + 账号存储 + 密码哈希

**Files:**
- Create: `docker-compose.yml`（Postgres 服务）
- Create: `packages/server/package.json`、`packages/server/tsconfig.json`
- Create: `packages/server/src/db/pool.ts`
- Create: `packages/server/src/auth/password.ts`
- Create: `packages/server/src/auth/userRepository.ts`
- Create: `packages/server/migrations/001_accounts.sql`
- Create: `packages/server/src/db/migrate.ts`
- Test: `packages/server/test/auth.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `function createPool(connectionString: string): Pool`
  - `async function hashPassword(secret: string): Promise<string>`
  - `async function verifyPassword(hash: string, secret: string): Promise<boolean>`
  - `interface User { id: string; username: string; passwordHash: string; disabled: boolean }`
  - `class UserRepository { constructor(pool: Pool); findByUsername(u: string): Promise<User | null>; create(u: string, secret: string): Promise<User>; verifyCredentials(u: string, secret: string): Promise<User | null> }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/db/pool";
import { UserRepository } from "../src/auth/userRepository";
import { hashPassword, verifyPassword } from "../src/auth/password";

const url = process.env.TEST_DATABASE_URL!;
let pool: ReturnType<typeof createPool>;
let repo: UserRepository;

beforeAll(async () => { pool = createPool(url); repo = new UserRepository(pool); });
afterAll(async () => { await pool.end(); });

describe("password hashing", () => {
  it("verifies the correct secret and rejects a wrong one", async () => {
    const h = await hashPassword("s3cret");
    expect(h).not.toContain("s3cret");
    expect(await verifyPassword(h, "s3cret")).toBe(true);
    expect(await verifyPassword(h, "nope")).toBe(false);
  });
});

describe("UserRepository", () => {
  it("returns the user for correct credentials, null otherwise", async () => {
    await repo.create("alice", "pw-alice");
    expect((await repo.verifyCredentials("alice", "pw-alice"))?.username).toBe("alice");
    expect(await repo.verifyCredentials("alice", "wrong")).toBeNull();
    expect(await repo.verifyCredentials("ghost", "x")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `docker compose up -d db && pnpm --filter @adt/server test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`001_accounts.sql` 建表：`users(id uuid pk default gen_random_uuid(), username text unique not null, password_hash text not null, disabled boolean not null default false, created_at timestamptz not null default now())`。`migrate.ts` 按文件名顺序执行 `migrations/*.sql`，用 `schema_migrations` 表记录已执行。`password.ts` 用 `argon2`。`verifyCredentials` 对不存在用户也要走一次 `verifyPassword` 以避免时序差异（返回 `null`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/server test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add docker-compose.yml packages/server
git commit -m "feat(server): postgres, accounts and password hashing"
```

---

### Task 4: Server 启动 + 连接注册 + 消息路由（含未知/畸形处理）

**Files:**
- Create: `packages/server/src/ws/connection.ts`
- Create: `packages/server/src/ws/messageRouter.ts`
- Create: `packages/server/src/http/app.ts`
- Create: `packages/server/src/index.ts`
- Test: `packages/server/test/router.test.ts`

**Interfaces:**
- Consumes: Task 1 `decodeEnvelope`/`encodeEnvelope`/`Envelope`；Task 2 `makeError`/`ERROR_DISPOSITION`
- Produces:
  - `class Connection { readonly id: string; send(e: Envelope): void; close(): void }`
  - `type MessageHandler = (session: Session | null, env: Envelope) => Promise<void> | void`
  - `class MessageRouter { register(type: string, h: MessageHandler): void; handle(conn: Connection, session: Session | null, raw: string | Buffer): Promise<void> }`
  - `function buildServer(deps: ServerDeps): FastifyInstance`（`ServerDeps` 含 `router`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/router.test.ts
import { describe, it, expect } from "vitest";
import { MessageRouter } from "../src/ws/messageRouter";
import { Connection } from "../src/ws/connection";
import { encodeEnvelope, PROTOCOL_VERSION } from "@adt/shared";

function fakeConn() {
  const sent: any[] = [];
  const conn = { id: "c1", send: (e: any) => sent.push(e), close: () => { conn.closed = true; } } as any;
  conn.sent = sent;
  return conn;
}
const env = (type: string, extra: any = {}) => ({
  protocol_version: PROTOCOL_VERSION, message_id: "msg_1", session_id: null,
  workflow_id: null, user_id: null, type, ts: "2026-09-30T10:00:00.000Z",
  in_reply_to: null, payload: {}, ...extra,
});

describe("MessageRouter", () => {
  it("replies unknown_message_type and keeps the connection", async () => {
    const r = new MessageRouter(); const c = fakeConn();
    await r.handle(c, null, JSON.stringify(env("nope.unknown")));
    expect(c.sent[0].payload.code).toBe("unknown_message_type");
    expect(c.closed).toBeUndefined();
  });
  it("replies malformed_payload on bad JSON", async () => {
    const r = new MessageRouter(); const c = fakeConn();
    await r.handle(c, null, "{");
    expect(c.sent[0].payload.code).toBe("malformed_payload");
  });
  it("ignores a duplicate message_id", async () => {
    const r = new MessageRouter(); const c = fakeConn();
    let calls = 0;
    r.register("session.hello", () => { calls++; });
    const raw = JSON.stringify(env("session.hello"));
    await r.handle(c, null, raw); await r.handle(c, null, raw);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @adt/server test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`handle` 流程：`decodeEnvelope`（失败 → `makeError("malformed_payload", ...)` 后返回）；若 `session` 存在且 `session.dedup.has(message_id)` → 忽略 + 告警；否则 `add` 并派发；无注册处理器 → `makeError("unknown_message_type", ...)`。`app.ts` 用 Fastify 注册 `/ws`（`ws` 库），把每条消息交给 `router.handle`；`index.ts` 组装依赖并监听 `PORT`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/server test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): ws connection registry and message router"
```

---

### Task 5: 认证握手（`session.hello` / `session.welcome` / `auth_failed` / `unsupported_version`）

**Files:**
- Create: `packages/server/src/session/sessionManager.ts`
- Create: `packages/server/src/session/handshake.ts`
- Modify: `packages/server/src/index.ts`（注册握手处理器）
- Test: `packages/server/test/handshake.int.test.ts`

**Interfaces:**
- Consumes: Task 3 `UserRepository`；Task 4 `MessageRouter`/`Connection`；Task 2 `ERROR_DISPOSITION`
- Produces:
  - `interface Session { id: string; userId: string; connection: Connection; dedup: DedupWindow; lastSeenAt: number }`
  - `class SessionManager { create(userId: string, conn: Connection): Session; get(id: string): Session | null; expire(id: string): void; touch(id: string): void }`
  - `function registerHandshake(router: MessageRouter, deps: { users: UserRepository; sessions: SessionManager; heartbeatIntervalMs: number }): void`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/handshake.int.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers/server";
import { TestClient } from "./helpers/client";

describe("handshake", () => {
  it("welcomes an authenticated client with session_id and user_id", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const w = await c.hello({ username: "alice", secret: "pw-alice" });
    expect(w.type).toBe("session.welcome");
    expect(w.payload.session_id).toMatch(/^sess_/);
    expect(w.payload.user_id).toMatch(/^usr_/);
    await c.close(); await srv.close();
  });

  it("rejects bad credentials with fatal auth_failed and closes", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const e = await c.hello({ username: "alice", secret: "wrong" });
    expect(e.payload.code).toBe("auth_failed");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("rejects an unsupported protocol version without welcome", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    const e = await c.hello({ username: "alice", secret: "pw-alice", versions: ["9.9"] });
    expect(e.payload.code).toBe("unsupported_version");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("requires user_id on messages after the handshake", async () => {
    const srv = await startTestServer();
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const e = await c.sendRaw({ ...c.base("capability.sync"), user_id: null, payload: { mode: "full", revision: 0, added: [], removed: [] } });
    expect(e.payload.code).toBe("malformed_payload");
    await c.close(); await srv.close();
  });
});
```

> 测试辅助 `test/helpers/server.ts`（`startTestServer`：建库连接、跑迁移、种子账号 `alice`、监听随机端口）与 `test/helpers/client.ts`（`TestClient`：ws 客户端、`hello`、`sendRaw`、`waitClose`）在本步一并创建。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @adt/server test`
Expected: FAIL（`startTestServer` 不存在）

- [ ] **Step 3: 实现**

`registerHandshake` 处理 `session.hello`：若 `supported_protocol_versions` 不含 `PROTOCOL_VERSION` → `unsupported_version` + `close()`；`users.verifyCredentials` 失败 → `auth_failed` + `close()`；成功 → `sessions.create`，回 `session.welcome { protocol_version, session_id, user_id, heartbeat_interval_ms }`。**握手后**任何消息若 `user_id` 为空或与 session 不符 → `malformed_payload`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/server test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): authenticated session handshake"
```

---

### Task 6: `capability.sync`（revision 排序、保守默认、未登记名称）

**Files:**
- Create: `packages/server/src/capability/capabilityRegistry.ts`
- Create: `packages/server/src/capability/handler.ts`
- Create: `packages/server/src/capability/registry.ts`（已登记名称清单，先放 `PROTOCOL_SPEC`/`CAPABILITY_SPEC` 中的标准名 + `sim_rig.trigger_reset`）
- Test: `packages/server/test/capabilitySync.int.test.ts`

**Interfaces:**
- Consumes: Task 5 `Session`
- Produces:
  - `interface CapabilityDescriptor { name: string; side_effect?: boolean; interruptible?: boolean; idempotent?: boolean; timeout_hint?: number; input_schema?: object; output_schema?: object }`
  - `interface NormalizedCapability { name: string; side_effect: boolean; interruptible: boolean; idempotent: boolean; timeout_hint?: number; input_schema?: object; output_schema?: object }`
  - `class CapabilityRegistry { readonly revision: number; apply(p: CapabilitySyncPayload): { applied: boolean; warnings: string[] }; has(name: string): boolean; get(name: string): NormalizedCapability | undefined }`
  - `function registerCapabilitySync(router: MessageRouter, deps: { known: Set<string> }): void`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/capabilitySync.int.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers/server";
import { TestClient } from "./helpers/client";

async function authed() {
  const srv = await startTestServer();
  const c = await TestClient.connect(srv.url);
  await c.hello({ username: "alice", secret: "pw-alice" });
  return { srv, c };
}

describe("capability.sync", () => {
  it("applies conservative defaults when side_effect/interruptible are missing", async () => {
    const { srv, c } = await authed();
    await c.sync({ mode: "full", revision: 0, added: [{ name: "git.collect_diagnostics" }], removed: [] });
    const cap = srv.capabilities(c.sessionId).get("git.collect_diagnostics")!;
    expect(cap.side_effect).toBe(true);
    expect(cap.interruptible).toBe(false);
    expect(cap.idempotent).toBe(false);
    await c.close(); await srv.close();
  });

  it("ignores a stale revision and warns", async () => {
    const { srv, c } = await authed();
    await c.sync({ mode: "full", revision: 5, added: [{ name: "filesystem.read_file", side_effect: false, interruptible: true }], removed: [] });
    await c.sync({ mode: "incremental", revision: 3, added: [{ name: "docker.inspect_container" }], removed: [] });
    expect(srv.warnings(c.sessionId).join(" ")).toMatch(/stale revision/i);
    expect(srv.capabilities(c.sessionId).has("docker.inspect_container")).toBe(false);
    await c.close(); await srv.close();
  });

  it("ignores an unregistered capability name but keeps the rest", async () => {
    const { srv, c } = await authed();
    await c.sync({ mode: "full", revision: 0, added: [
      { name: "not.registered_thing" },
      { name: "filesystem.read_file", side_effect: false, interruptible: true },
    ], removed: [] });
    expect(srv.capabilities(c.sessionId).has("not.registered_thing")).toBe(false);
    expect(srv.capabilities(c.sessionId).has("filesystem.read_file")).toBe(true);
    await c.close(); await srv.close();
  });
});
```

> `capability.sync` **没有**协议层 ack（`PROTOCOL_SPEC.md` §6 未定义），因此测试**不发明新消息**：`startTestServer` 在测试进程内运行 Server，测试通过 `srv.capabilities(sessionId)` / `srv.warnings(sessionId)` 直接检查会话状态。`TestClient` 只需 `sync(payload)` 与 `sessionId`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @adt/server test`
Expected: FAIL

- [ ] **Step 3: 实现**

`apply`：`revision <= current` → `{ applied: false, warnings: ["stale revision"] }`；否则逐项：名称不在 `known` → 记 warning 跳过；否则归一化默认值后写入；`mode:"full"` 时先清空再写入。`handler` 校验 `mode`/`revision`/`added`/`removed` 形状后调用 `apply`；本阶段**不回任何消息**（`PROTOCOL_SPEC.md` §6 未定义 ack）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/server test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): capability.sync with revision ordering and conservative defaults"
```

---

### Task 7: 应用层心跳与连接失活

**Files:**
- Create: `packages/server/src/ws/heartbeat.ts`
- Modify: `packages/server/src/index.ts`（注册 `session.heartbeat`）
- Test: `packages/server/test/heartbeat.int.test.ts`

**Interfaces:**
- Consumes: Task 5 `SessionManager`
- Produces:
  - `class HeartbeatMonitor { constructor(sessions: SessionManager, opts: { intervalMs: number; maxMissed: number; onDead: (sessionId: string) => void }); start(): void; stop(): void }`
  - `function registerHeartbeat(router: MessageRouter, sessions: SessionManager): void`（更新 `lastSeenAt`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/heartbeat.int.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers/server";
import { TestClient } from "./helpers/client";

describe("heartbeat", () => {
  it("keeps the session alive while heartbeats arrive", async () => {
    const srv = await startTestServer({ heartbeatIntervalMs: 50, maxMissed: 2 });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    for (let i = 0; i < 5; i++) { await c.heartbeat(); await new Promise(r => setTimeout(r, 30)); }
    expect(srv.deadSessions).toEqual([]);
    await c.close(); await srv.close();
  });

  it("reports the session as dead after missing heartbeats", async () => {
    const srv = await startTestServer({ heartbeatIntervalMs: 30, maxMissed: 2 });
    const c = await TestClient.connect(srv.url);
    const w = await c.hello({ username: "alice", secret: "pw-alice" });
    await new Promise(r => setTimeout(r, 150));
    expect(srv.deadSessions).toContain(w.payload.session_id);
    await c.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @adt/server test`
Expected: FAIL

- [ ] **Step 3: 实现**

`HeartbeatMonitor` 每 `intervalMs` 扫描一次，`now - lastSeenAt > intervalMs * maxMissed` → `onDead(sessionId)`（P1 只记录，P2 接孤儿回收）。`registerHeartbeat` 收到 `session.heartbeat` → `sessions.touch(session.id)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/server test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): application-level heartbeat and liveness monitor"
```

---

### Task 8: `client-daemon` 连接、握手、能力声明与心跳

**Files:**
- Create: `packages/client-daemon/package.json`、`packages/client-daemon/tsconfig.json`
- Create: `packages/client-daemon/src/connection.ts`
- Create: `packages/client-daemon/src/handshake.ts`
- Create: `packages/client-daemon/src/capabilities.ts`
- Create: `packages/client-daemon/src/heartbeat.ts`
- Create: `packages/client-daemon/src/index.ts`
- Test: `packages/client-daemon/test/connect.test.ts`

**Interfaces:**
- Consumes: `@adt/shared`（Task 1/2）；真实 Server（Task 5/6/7）
- Produces:
  - `interface ClientConfig { url: string; credentials: { username: string; secret: string }; capabilities: CapabilityDescriptor[]; clientInfo: { name: string; platform: string } }`
  - `class DaemonConnection { static connect(cfg: ClientConfig): Promise<DaemonConnection>; readonly sessionId: string; readonly userId: string; readonly heartbeatIntervalMs: number; on(type: string, h: (env: Envelope) => void): void; send(type: string, payload: unknown): void; close(): Promise<void> }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/connect.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer } from "../../server/test/helpers/server";
import { DaemonConnection } from "../src/connection";

describe("client-daemon connection", () => {
  it("authenticates, syncs capabilities and heartbeats", async () => {
    const srv = await startTestServer({ heartbeatIntervalMs: 50, maxMissed: 3 });
    const d = await DaemonConnection.connect({
      url: srv.url, credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "daemon-test", platform: "win32" },
      capabilities: [
        { name: "git.collect_diagnostics", side_effect: false, interruptible: true },
        { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false, idempotent: false },
      ],
    });
    expect(d.userId).toMatch(/^usr_/);
    await new Promise(r => setTimeout(r, 200));
    expect(srv.deadSessions).toEqual([]);
    await d.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @adt/client-daemon test`
Expected: FAIL

- [ ] **Step 3: 实现**

`connect`：建 ws → 发 `session.hello { supported_protocol_versions: [PROTOCOL_VERSION], client_info, auth: credentials, capabilities }` → 等 `session.welcome`（`auth_failed`/`unsupported_version` → 抛错）→ 发 `capability.sync { mode:"full", revision:0, added: capabilities, removed: [] }` → 启动定时器按 `heartbeat_interval_ms` 发 `session.heartbeat`。`send` 自动填信封（`session_id`/`user_id`/`message_id`/`ts`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @adt/client-daemon test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon
git commit -m "feat(client-daemon): authenticated connection, capability sync and heartbeat"
```

---

### Task 9: 协议层端到端验收测试

**Files:**
- Create: `packages/server/test/protocol.e2e.test.ts`
- Create: `README.md`（根：如何跑 `docker compose up -d db`、`pnpm -r test`）
- Modify: `package.json`（根脚本 `test` = `pnpm -r test`）

**Interfaces:**
- Consumes: Task 1–8 全部
- Produces: 无新增接口（验收）

- [ ] **Step 1: 写验收测试**

```ts
// packages/server/test/protocol.e2e.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers/server";
import { TestClient } from "./helpers/client";

describe("protocol e2e (P1 acceptance)", () => {
  it("A. authenticated session + capability sync + heartbeat stays alive", async () => { /* 见 Task 5/6/7 断言组合 */ });
  it("B. wrong password -> auth_failed and close", async () => { /* Task 5 */ });
  it("C. unsupported version -> close without welcome", async () => { /* Task 5 */ });
  it("D. unknown message type -> error, connection stays", async () => { /* Task 4 */ });
  it("E. stale revision ignored; unregistered name ignored; defaults conservative", async () => { /* Task 6 */ });
  it("F. missing user_id after handshake -> malformed_payload", async () => { /* Task 5 */ });
  it("G. duplicate message_id processed once", async () => { /* Task 4 */ });
});
```

- [ ] **Step 2: 运行确认全部通过**

Run: `docker compose up -d db && pnpm -r test`
Expected: 全部 PASS；`shared` 4+、`server` 全部集成测试、`client-daemon` 1 通过

- [ ] **Step 3: 提交**

```bash
git add packages/server/test/protocol.e2e.test.ts README.md package.json
git commit -m "test(protocol): P1 end-to-end acceptance suite"
```

---

## Self-Review

**1. Spec coverage（P1 范围）：** 信封/编解码 → T1；错误处置矩阵 → T2；去重窗口 → T2/T4；认证与 `user_id` → T5；`capability.sync` + revision + 保守默认 + 未登记名称 → T6；心跳 → T7；Client 侧连接 → T8；验收 → T9。覆盖 `PROTOCOL_SPEC.md` §2/§4/§5/§6/§9/§12 与 `ADR-003` §3 中属于会话层的部分。

**2. Step scan：** 每个 Step 只下一个动作（写测试 / 跑失败 / 实现 / 跑通过 / 提交）；实现步骤给签名与约束，不给完整函数体。

**3. Type consistency：** `Envelope`、`ErrorCode`、`DedupWindow`、`Session`、`CapabilityDescriptor`、`NormalizedCapability`、`DaemonConnection` 在 Task 1/2/5/6/8 定义，后续任务引用同一名称。

**4. Review Focus：** 五条风险均落到测试——(1) 陈旧 revision → T6；(2) 缺失 `side_effect`/`interruptible` → T6；(3) 未登记名称 → T6；(4) 未知消息类型不断连 → T4；(5) 认证失败断开 → T5。

**5. Proportion：** 本计划只描述决策与接口，代码以签名/断言形式出现；不含完整实现体。

## 后续

P1 验收通过后，再写 **P2（Server 引擎与持久化）**：Workflow/Step 状态机、`UNKNOWN`/终态不可变、护栏、`completion_criteria`、Record 生成与保存、孤儿回收、Record/Report 查询。
