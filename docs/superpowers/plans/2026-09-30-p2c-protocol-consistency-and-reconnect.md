# P2c 协议一致性与重连 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P1 遗留的三处"规范 vs 实现"两处真相收敛掉——让 `ERROR_DISPOSITION` 真正驱动错误处置、让去重窗口属于**逻辑会话**而非物理连接、让 `session.resume` + `workflow.state_sync` 在断线重连后恢复真实状态，并把孤儿回收接进 Server 生命周期。

**Architecture:** `Session` 从"绑在 `Connection` 上的临时对象"升级为**逻辑实体**：它持有去重窗口、Capability Registry，并在物理连接断开后按 TTL 保留以便 `resume`；`SessionManager` 负责 `create/attach/detach/sweep`，`SessionLifecycle` 周期性清扫过期会话并驱动 `OrphanReclaimer`。协议层新增 `registerSessionResume`，它先认证（ADR-003 §3），再把 Server 权威状态（ADR-001）一次性同步给 Client。错误处置只有一条出口（`sendError`），由 `ERROR_DISPOSITION` 决定是否断开。

**Tech Stack:** TypeScript（strict）· Node.js LTS · PostgreSQL（`pg`）· Fastify + `ws` · Vitest · pnpm workspace（沿用 P1/P2a/P2b 结构）

**Spec:** `docs/specs/PROTOCOL_SPEC.md`（v0.6 §2/§5.1/§5.2/§9/§12/§14 —— 本计划 **Task 1** 将其修订为 **v0.7**，补 `session.resume` 认证、会话 TTL 与 `workflow.state_sync` 字段）、`docs/adr/ADR-003-deployment-and-trust-model.md`（§3 认证、§4 无 TLS、§5 授权、§6 可见性、§7 会话归属）、`docs/specs/WORKFLOW_SPEC.md`（§2.1 取消意图优先、§2.2 孤儿回收）、`docs/adr/ADR-001-server-owns-workflow-state.md`、`docs/superpowers/specs/2026-09-29-mvp-scope.md`（§5.2 E3 断线重连）、`docs/superpowers/specs/2026-09-29-spec-gap-closure-design.md`（D-A3 恢复边界、D-E3 去重窗口、D-C8 处置矩阵）

## Global Constraints

- **协议文档版本**：`PROTOCOL_SPEC.md` v0.6 → **v0.7**（Task 1）。线路协议版本常量 `PROTOCOL_VERSION = "0.3"` **不变**（`PROTOCOL_SPEC.md` §13：`v0.x` 阶段允许在 minor 内做调整，且本次改动向后兼容）。
- **`session.resume` 必须携带 `auth`**（与 `session.hello.auth` 同形：`{ username, secret }`）；认证失败 → `protocol.error(code=auth_failed)`（**致命**：发送后断开）；`session_id` 未知或超过 TTL → `protocol.error(code=session_expired)`（**致命**）。顺序：**先认证、再查会话**（ADR-003 §3：Server 只接受已认证的 Client）。
- **逻辑会话 TTL**：断线后会话按可配置 `sessionTtlMs` 保留（默认 `86_400_000`，即 24 小时），TTL 内可 `resume`；超时未恢复 → 会话过期并触发孤儿回收。
- **去重窗口 = 逻辑会话生命周期**（`PROTOCOL_SPEC.md` §2）：窗口属于 `Session`，跨物理重连保留；会话结束（`expire`）时清空。握手前的消息仍用连接级窗口兜底。
- **孤儿回收宽限 = 会话 TTL**（`WORKFLOW_SPEC.md` §2.2）：未请求取消 → `FAILED(terminal_reason=client_unreachable)`；已请求取消 → `CANCELLED`；两种情况都照常保存 Record。
- **错误处置唯一出口**：`sendError` 依据 `ERROR_DISPOSITION` 决定行为——`fatal` → 发送错误后 `conn.close()`；`request` / `ignore` → 发送（或仅告警）后**保持连接**。任何处理器都不得再手写 `conn.close()` 处置错误。
- **Server 是状态权威**（ADR-001）：`workflow.state_sync` 返回 Server 的真实状态；`known_workflows` 只用来**挑选需要补发终态的对账项**，不参与状态合并。
- **授权**：resume 的认证用户必须与 `session.userId` 一致，否则 `auth_failed`（致命）；不泄露他人的会话或 Workflow（ADR-003 §3/§5/§6）。
- **时间**：会话 TTL 与回收宽限一律用可注入的**单调时钟**（默认 `performance.now`，与 P1/P2a 一致），不使用 wall clock 判超时。
- **本阶段不实现**（留给 P3/P4）：Capability I/O schema 校验、`workflow.request` 的 `client_request_id` 幂等台账、LLM 规划、受控执行确认与对账编排、幂等台账、blob、KB 导出。

## Review Focus

以下失败模式是 Spec 隐含但容易漏测的，**每条都必须在对应任务里有测试**：

1. **跨重连的重传 `message_id`**：断线前见过的 `message_id` 在 resume 后重发，必须被忽略（不产生第二条 Workflow）——去重窗口是会话级（Task 3 单测 + Task 6 端到端）。
2. **致命错误必须真的断开**：`auth_failed` / `unsupported_version` / `session_expired` 发送后连接关闭；`malformed_payload` / `unknown_message_type` / `unknown_workflow` 不断开——判定来自 `ERROR_DISPOSITION`，不是散落的分支（Task 2）。
3. **未知/过期会话 resume** → `session_expired` 且连接关闭；**凭据错误或用户不符** → `auth_failed` 且连接关闭，不返回任何 `state_sync`（Task 6）。
4. **TTL 内的 resume 必须取消待回收**：连接短暂断开又恢复 → Workflow 不得被判 `FAILED(client_unreachable)`；超过 TTL 未恢复 → 必须回收为 `FAILED(client_unreachable)` 并保存 Record（Task 4 集成测试）。
5. **断线期间已终止的 Workflow 必须被对账**：Client 已知但已终态的 Workflow 出现在 `state_sync` 中，且带可用 `record_id`（Task 6）。

---

### Task 1: 修订 `PROTOCOL_SPEC.md` v0.6 → v0.7（重连认证、会话 TTL、state_sync 字段）

**Files:**
- Modify: `docs/specs/PROTOCOL_SPEC.md`
- Modify: 其他显式引用 `PROTOCOL_SPEC.md`（v0.6）版本号的文档（用 `grep` 找出来）

**Interfaces:**
- Consumes: 无
- Produces: 后续所有任务实现的线路契约（v0.7）

- [ ] **Step 1: 改页首版本号与变更记录**

页首 `**Version:**` 改为 `v0.7`，并在 `## 变更记录（v0.4 → v0.5）` **之上**新增一节：

```markdown
## 变更记录（v0.6 → v0.7）

依据 `ADR-003`（部署与信任模型）与 `WORKFLOW_SPEC.md` §2.2：

- **`session.resume` 携带认证凭据**（§5.2）：`{ session_id, auth: { username, secret }, known_workflows }`。认证失败 → `protocol.error(code=auth_failed)`（致命）；`session_id` 未知/过期 → `protocol.error(code=session_expired)`（致命）。依据 `ADR-003` §3"Server 只接受已认证的 Client"。
- **会话 TTL**（§5.2）：断线后 `session_id` 在可配置 TTL 内仍可 `resume`；建议默认 24 小时。超过 TTL 视为 `session_expired`。
- **`workflow.state_sync.workflows[]` 扩展**（§5.2）：新增 `record_id` / `record_persistence_failed`；明确范围为"该 session 下所有非终态 Workflow，加上 `known_workflows` 中已被 Server 判定为终态的 Workflow"，使断线期间发生的终止也能被对账。
```

- [ ] **Step 2: 改 §5.2 的时序图与正文**

把 `session.resume` 的请求体补上 `auth`，并在正文写明：认证失败 `auth_failed`（致命，断开）；`session_id` 未知或超过 TTL → `session_expired`（致命，断开）；TTL 内 → 复用原 `session_id`、保留会话级去重窗口并回 `workflow.state_sync`。把 `workflow.state_sync.workflows[]` 的字段补成：

```text
{workflow_id, workflow_status,
 pending_step: <step.dispatch payload> | null,
 record_id: string | null,
 record_persistence_failed: boolean}
```

- [ ] **Step 3: 同步 §12 与 §14**

§12 处置矩阵中 `session_expired` / `auth_failed` 两行已是"致命"，补一句"`session.resume` 的认证失败同样走 `auth_failed`"。§14「断线重连」示例把 `session.resume(session_id, ...)` 改成带 `auth` 的形态。

- [ ] **Step 4: 同步交叉引用**

Run: `grep -rn "PROTOCOL_SPEC" docs/ --include=*.md` —— 把显式写成 `PROTOCOL_SPEC.md` v0.6 的版本引用更新为 v0.7（只改版本号，不改语义）。

- [ ] **Step 5: 提交**

```bash
git add docs/
git commit -m "docs(protocol): v0.7 resume auth, session TTL and state_sync fields"
```

---

### Task 2: `ERROR_DISPOSITION` 真正驱动错误处置

**Files:**
- Modify: `packages/server/src/ws/errors.ts`
- Modify: `packages/server/src/session/handshake.ts`
- Test: `packages/server/test/ws/errors.test.ts`（新建）

**Interfaces:**
- Consumes: `packages/shared/src/protocol/errors.ts` 的 `ERROR_DISPOSITION` / `makeError` / `ErrorCode`（P1 已有，不改）
- Produces:
  - `function sendError(conn: Connection, session: Session | null, code: ErrorCode, message: string, inReplyTo: string | null): void` —— 行为变化：`ERROR_DISPOSITION[code] === "fatal"` 时，发送后调用 `conn.close()`。
- 约束：`sendError` 是本进程**唯一**的错误出口；`registerHandshake` 不再直接 `conn.close()`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/ws/errors.test.ts
import { describe, it, expect } from "vitest";
import { Connection } from "../../src/ws/connection";
import { sendError } from "../../src/ws/errors";

function makeConn() {
  const sent: Array<{ payload: { code: string; message: string } }> = [];
  const conn = new Connection(
    { send: (data: string) => sent.push(JSON.parse(data)), close: () => {} },
    "conn_1",
  );
  return { conn, sent };
}

describe("sendError disposition", () => {
  it("closes the connection after emitting a fatal error", () => {
    const { conn, sent } = makeConn();
    sendError(conn, null, "auth_failed", "invalid credentials", "msg_1");
    expect(sent[0]!.payload).toEqual({ code: "auth_failed", message: "invalid credentials" });
    expect(conn.isClosed).toBe(true);
  });

  it("keeps the connection for request-level and ignorable errors", () => {
    const { conn } = makeConn();
    sendError(conn, null, "malformed_payload", "bad", "msg_1");
    sendError(conn, null, "unknown_message_type", "bad", "msg_2");
    sendError(conn, null, "unknown_workflow", "bad", "msg_3");
    expect(conn.isClosed).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/ws/errors.test.ts`
Expected: FAIL（`auth_failed` 不会关闭连接）

- [ ] **Step 3: 实现**

`errors.ts`：在 `sendError` 末尾按表处置——

```ts
if (ERROR_DISPOSITION[code] === "fatal") conn.close();
```

（`fatal` 之外的 `request` / `ignore` 都不断开；`ignore` 的告警由调用方 `conn.warn` 负责。导入 `ERROR_DISPOSITION`。）

`handshake.ts`：`unsupported_version` 与两处 `auth_failed` 改为 `sendError(conn, null, code, message, env.message_id)`，删除随后的 `conn.close()`。

- [ ] **Step 4: 运行测试确认通过，且既有握手测试不回归**

Run: `pnpm -C packages/server exec vitest run test/ws/errors.test.ts test/handshake.int.test.ts test/router.test.ts`
Expected: PASS（`auth_failed` / `unsupported_version` 仍 `waitClose`，未知消息类型仍不断连）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/ws/errors.ts packages/server/src/session/handshake.ts packages/server/test/ws/errors.test.ts
git commit -m "refactor(server): dispose protocol errors from ERROR_DISPOSITION"
```

---

### Task 3: 逻辑会话——去重窗口上移 + `attach`/`detach`/`sweep`/TTL

**Files:**
- Modify: `packages/server/src/session/sessionManager.ts`
- Modify: `packages/server/src/ws/messageRouter.ts`
- Modify: `packages/server/src/ws/heartbeat.ts`（跳过已断开的会话）
- Test: `packages/server/test/sessionManager.test.ts`（扩展）、`packages/server/test/sessionDedup.test.ts`（新建）

**Interfaces:**
- Consumes: `DedupWindow`（`@adt/shared`）、`Connection`、`SessionResolver`
- Produces:
  - `interface Session { id: string; userId: string; connection: Connection | null; lastSeenAt: number; disconnectedAt: number | null; capabilities: CapabilityRegistry; dedup: DedupWindow }`
  - `interface SessionManagerOptions { now?: () => number; knownCapabilities?: ReadonlySet<string>; ttlMs?: number }`（`ttlMs` 默认 `86_400_000`）
  - `SessionManager.create(userId, connection): Session`（新建会话，带新的 `DedupWindow`）
  - `SessionManager.detach(connectionId): Session | null`（断开物理连接：`connection = null`、`disconnectedAt = now`，会话仍在 `byId` 中）
  - `SessionManager.markDisconnected(sessionId): void`（心跳判死时调用；`disconnectedAt` 只设一次）
  - `SessionManager.attach(sessionId, connection): Session | null`（过期/不存在返回 `null`；否则重绑连接、清 `disconnectedAt`、`touch`）
  - `SessionManager.isExpired(session, now?): boolean`
  - `SessionManager.sweep(now?): string[]`（移除并返回超过 TTL 的会话 id）
  - `Connection.dedup` 保留（握手前兜底）；`MessageRouter` 改用 `session?.dedup ?? conn.dedup`

- [ ] **Step 1: 写失败测试（SessionManager 生命周期与去重）**

```ts
// packages/server/test/sessionManager.test.ts（在既有 describe 内追加）
import { Connection, SessionManager } from "@adt/server";

const makeConnection = (id: string) => new Connection({ send: () => {}, close: () => {} }, id);

it("retains a detached session until the ttl, then expires it", () => {
  let t = 1000;
  const sessions = new SessionManager({ ttlMs: 100, now: () => t });
  const s = sessions.create("usr_1", makeConnection("c1"));

  sessions.detach("c1");
  expect(sessions.get(s.id)!.connection).toBeNull();
  expect(sessions.byConnection("c1")).toBeNull();

  t += 50;
  expect(sessions.sweep()).toEqual([]);
  expect(sessions.get(s.id)).not.toBeNull();

  t += 60;
  expect(sessions.sweep()).toEqual([s.id]);
  expect(sessions.get(s.id)).toBeNull();
});

it("attaches a resumed session and carries its dedup window", () => {
  let t = 1000;
  const sessions = new SessionManager({ ttlMs: 100, now: () => t });
  const s = sessions.create("usr_1", makeConnection("c1"));
  s.dedup.add("msg_1");
  sessions.detach("c1");

  const resumed = sessions.attach(s.id, makeConnection("c2"));
  expect(resumed!.id).toBe(s.id);
  expect(resumed!.connection!.id).toBe("c2");
  expect(resumed!.disconnectedAt).toBeNull();
  expect(resumed!.dedup.has("msg_1")).toBe(true);
  expect(sessions.byConnection("c2")!.id).toBe(s.id);
  expect(sessions.byConnection("c1")).toBeNull();
});

it("refuses to attach an expired or unknown session", () => {
  let t = 1000;
  const sessions = new SessionManager({ ttlMs: 100, now: () => t });
  const s = sessions.create("usr_1", makeConnection("c1"));
  sessions.detach("c1");

  t += 200;
  expect(sessions.attach(s.id, makeConnection("c2"))).toBeNull();
  expect(sessions.attach("sess_nope", makeConnection("c3"))).toBeNull();
});
```

```ts
// packages/server/test/sessionDedup.test.ts
import { describe, it, expect } from "vitest";
import { Connection, MessageRouter, SessionManager } from "@adt/server";

const raw = (sessionId: string, userId: string, messageId: string) =>
  JSON.stringify({
    protocol_version: "0.3", message_id: messageId, session_id: sessionId,
    workflow_id: null, user_id: userId, type: "capability.sync",
    ts: "2026-09-30T10:00:00.000Z", in_reply_to: null,
    payload: { mode: "full", revision: 0, added: [], removed: [] },
  });

describe("session dedup window", () => {
  it("dedups on the session window after the handshake", async () => {
    const sessions = new SessionManager({ now: () => 0 });
    const router = new MessageRouter(sessions);
    let calls = 0;
    router.register("capability.sync", () => { calls++; });

    const conn = new Connection({ send: () => {}, close: () => {} }, "c1");
    const session = sessions.create("usr_1", conn);
    const message = raw(session.id, "usr_1", "msg_1");

    await router.handle(conn, message);
    await router.handle(conn, message);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/sessionManager.test.ts test/sessionDedup.test.ts`
Expected: FAIL（`detach`/`attach`/`sweep`/`Session.dedup` 不存在）

- [ ] **Step 3: 实现**

`sessionManager.ts`：`Session` 增加 `disconnectedAt` / `dedup`，`connection` 改为可空；`create` 里 `dedup: new DedupWindow()`；`expire` 改为清 `session.dedup`（不再依赖 `session.connection.dedup`）；新增 `ttlMs`、`isExpired`、`detach`、`markDisconnected`、`attach`、`sweep`，实现按 Interfaces 的语义。

`messageRouter.ts`：把 `conn.dedup` 的读写改为先解析会话、再选窗口：

```ts
const session = this.resolver.byConnection(conn.id);
const window = session?.dedup ?? conn.dedup;
if (window.has(env.message_id)) { conn.warn(...); return; }
window.add(env.message_id);
```

`heartbeat.ts`：`sweep()` 中 `if (!session.connection) continue;`（已断开的会话由 TTL 清扫负责，心跳不再重复判死）。

`test-support/src/server.ts` 的 `warnings` 适配可空连接：`sessions.get(sessionId)?.connection?.warnings ?? []`。

- [ ] **Step 4: 运行测试确认通过（含既有回归）**

Run: `pnpm -C packages/server exec vitest run test/sessionManager.test.ts test/sessionDedup.test.ts test/router.test.ts test/heartbeat.int.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/session/sessionManager.ts packages/server/src/ws/messageRouter.ts packages/server/src/ws/heartbeat.ts packages/server/test/sessionManager.test.ts packages/server/test/sessionDedup.test.ts packages/test-support/src/server.ts
git commit -m "feat(session): logical session lifetime with attach/detach/TTL and session dedup window"
```

---

### Task 4: 会话清扫与孤儿回收接线

**Files:**
- Create: `packages/server/src/session/lifecycle.ts`
- Modify: `packages/server/src/http/app.ts`（连接关闭回调）
- Modify: `packages/server/src/server.ts`（`sessionTtlMs`、关闭/心跳判死接线）
- Modify: `packages/server/src/index.ts`（`start` 接线 + 导出）
- Modify: `packages/test-support/src/server.ts`（`sessionTtlMs` / `reclaimIntervalMs` / reclaimer + lifecycle）
- Test: `packages/server/test/session/lifecycle.test.ts`（新建）、`packages/server/test/workflow/reclaimSession.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `SessionManager`；P2a 的 `OrphanReclaimer`（`onSessionDead` / `onSessionAlive` / `reclaim`）
- Produces:
  - `interface Reclaimable { reclaim(): Promise<string[]> }`
  - `class SessionLifecycle { constructor(deps: { sessions: SessionManager; reclaimer: Reclaimable }, options: { intervalMs: number; now?: () => number }); sweep(): Promise<{ expired: string[]; reclaimed: string[] }>; start(): void; stop(): void }`
  - `createServer` 选项新增 `sessionTtlMs?: number`；内部：连接关闭 → `sessions.detach(conn.id)` 并回调 `onSessionDead`；心跳判死 → `sessions.markDisconnected(id)` 并回调 `onSessionDead`
  - `buildServer` 依赖新增 `onConnectionClosed?: (conn: Connection) => void`
  - `start` / `startTestServer` 选项新增 `sessionTtlMs?: number` 与 `reclaimIntervalMs?: number`（默认 `60_000`）；二者用 `graceMs = sessionTtlMs` 构造 `OrphanReclaimer`，并用 `SessionLifecycle` 定时 `sweep()`

- [ ] **Step 1: 写失败测试（lifecycle 单测 + 回收集成）**

```ts
// packages/server/test/session/lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { Connection, SessionManager } from "@adt/server";
import { SessionLifecycle } from "../../src/session/lifecycle";

describe("SessionLifecycle", () => {
  it("expires sessions past the ttl and reclaims their workflows in one sweep", async () => {
    let t = 0;
    const sessions = new SessionManager({ ttlMs: 100, now: () => t });
    const s = sessions.create("usr_1", new Connection({ send: () => {}, close: () => {} }, "c1"));
    sessions.detach("c1");

    const reclaimer = { reclaim: async () => ["wf_1"] };
    const lifecycle = new SessionLifecycle(
      { sessions, reclaimer },
      { intervalMs: 10, now: () => t },
    );

    t = 50;
    expect(await lifecycle.sweep()).toEqual({ expired: [], reclaimed: ["wf_1"] });

    t = 150;
    expect(await lifecycle.sweep()).toEqual({ expired: [s.id], reclaimed: ["wf_1"] });
    expect(sessions.get(s.id)).toBeNull();
  });
});
```

```ts
// packages/server/test/workflow/reclaimSession.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

const readStep = {
  kind: "step" as const,
  step: { objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true },
};

describe("orphan reclamation wired into the session lifecycle", () => {
  it("fails a workflow as client_unreachable when the session never resumes", async () => {
    const srv = await startTestServer({ sessionTtlMs: 60, reclaimIntervalMs: 20, planner: [readStep] });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    await c.next(); // step.dispatch
    await c.close();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await srv.engine.get(workflowId))?.state !== "FAILED") {
      await new Promise((r) => setTimeout(r, 20));
    }
    const workflow = (await srv.engine.get(workflowId))!;
    expect(workflow.state).toBe("FAILED");
    expect(workflow.terminalReason).toBe("client_unreachable");
    await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/session/lifecycle.test.ts test/workflow/reclaimSession.test.ts`
Expected: FAIL（`SessionLifecycle` 不存在；server 未接回收）

- [ ] **Step 3: 实现**

`lifecycle.ts`：`sweep()` 先 `const expired = this.sessions.sweep(this.now())`，再 `const reclaimed = await this.reclaimer.reclaim()`，返回二者；`start()` / `stop()` 用 `setInterval`（`timer.unref?.()`，与 `HeartbeatMonitor` 同风格）。

`http/app.ts`：`ServerDeps` 增加 `onConnectionClosed?`；`socket.on("close")` 里 `conn.markClosed(); deps.onConnectionClosed?.(conn);`。

`server.ts`：`CreateServerOptions` 增加 `sessionTtlMs`；`new SessionManager({ ..., ttlMs: opts.sessionTtlMs })`；把 `HeartbeatMonitor.onDead` 改成 `(id) => { sessions.markDisconnected(id); (opts.onSessionDead ?? (() => {}))(id); }`；`buildServer` 传 `onConnectionClosed: (conn) => { const s = sessions.detach(conn.id); if (s) (opts.onSessionDead ?? (() => {}))(s.id); }`。

`index.ts` / `test-support/src/server.ts`：**把 workflow 依赖的构造提前到 `createServer` 之前**（它们不依赖 server），然后：

```ts
const reclaimer = new OrphanReclaimer({ engine, store: workflowStore, graceMs: sessionTtlMs });
const server = await createServer({ pool, sessionTtlMs, onSessionDead: (id) => reclaimer.onSessionDead(id) });
// ... registerWorkflowProtocol ...
const lifecycle = new SessionLifecycle({ sessions: server.sessions, reclaimer }, { intervalMs: reclaimIntervalMs });
lifecycle.start();
```

`close()` 里 `lifecycle.stop()`。`test-support` 的 `onSessionDead` 同时记录 `deadSessions` 并喂给 `reclaimer`。`TestServerOptions` 增加 `sessionTtlMs?` / `reclaimIntervalMs?`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/session/lifecycle.test.ts test/workflow/reclaimSession.test.ts test/workflow/reclamation.test.ts test/start.int.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/session/lifecycle.ts packages/server/src/http/app.ts packages/server/src/server.ts packages/server/src/index.ts packages/test-support packages/server/test/session/lifecycle.test.ts packages/server/test/workflow/reclaimSession.test.ts
git commit -m "feat(session): sweep expired sessions and reclaim orphaned workflows"
```

---

### Task 5: `WorkflowStore.listWorkflowsBySession`

**Files:**
- Modify: `packages/server/src/workflow/store.ts`
- Modify: `packages/server/src/workflow/postgresStore.ts`
- Test: `packages/server/test/workflow/postgresStore.test.ts`（追加）

**Interfaces:**
- Consumes: `WorkflowSnapshot`
- Produces: `WorkflowStore.listWorkflowsBySession(sessionId: string): Promise<WorkflowSnapshot[]>`（按 `created_at, id` 升序）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/postgresStore.test.ts（在既有 describe 内追加）
it("lists workflows by session, oldest first", async () => {
  await store.createWorkflow({ ...wf, id: "wf_s1a", sessionId: "sess_1" }, evFor("wf_s1a", "ev_s1a", "workflow_created"));
  await store.createWorkflow({ ...wf, id: "wf_s1b", sessionId: "sess_1" }, evFor("wf_s1b", "ev_s1b", "workflow_created"));
  await store.createWorkflow({ ...wf, id: "wf_s2", sessionId: "sess_2" }, evFor("wf_s2", "ev_s2", "workflow_created"));

  expect((await store.listWorkflowsBySession("sess_1")).map((w) => w.id)).toEqual(["wf_s1a", "wf_s1b"]);
  expect(await store.listWorkflowsBySession("sess_3")).toEqual([]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/postgresStore.test.ts`
Expected: FAIL（`listWorkflowsBySession` 不是函数）

- [ ] **Step 3: 实现**

`store.ts`：接口新增该方法。`postgresStore.ts`：

```sql
SELECT * FROM workflows WHERE session_id = $1 ORDER BY created_at, id
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/postgresStore.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/store.ts packages/server/src/workflow/postgresStore.ts packages/server/test/workflow/postgresStore.test.ts
git commit -m "feat(workflow): list workflows by owning session"
```

---

### Task 6: `session.resume` + `workflow.state_sync`

**Files:**
- Create: `packages/server/src/session/resume.ts`
- Modify: `packages/server/src/protocol/workflowProtocol.ts`（导出 `stepDispatchPayload`）
- Modify: `packages/server/src/index.ts`（注册 + 导出）
- Modify: `packages/test-support/src/server.ts`、`packages/test-support/src/client.ts`（`resume`、`workflows`、`onResumed` 接线）
- Test: `packages/server/test/protocol/resumeProtocol.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 `sendError`；Task 3 `SessionManager.get/isExpired/attach`；Task 4 的 `onResumed` 接线点；Task 5 `listWorkflowsBySession`；P2b `RecordService.finalize`；`UserRepository.verifyCredentials`；`isActiveStep` / `isTerminalWorkflow`
- Produces:
  - `interface SessionResumeDeps { router: MessageRouter; sessions: SessionManager; users: UserRepository; store: WorkflowStore; records: RecordService; onResumed?: (sessionId: string) => void }`
  - `function registerSessionResume(deps: SessionResumeDeps): void`
  - `function stepDispatchPayload(step: StepSnapshot): { workflow_id: string; step_id: string; objective: string; capability: string; input: {}; expected_output: null; requires_confirmation: boolean; idempotency_key: string | null }`（从 `workflowProtocol.ts` 导出，`sendStepDispatch` 复用它）
  - `workflow.state_sync` payload：`{ resumed: true, workflows: Array<{ workflow_id: string; workflow_status: WorkflowState; pending_step: ReturnType<typeof stepDispatchPayload> | null; record_id: string | null; record_persistence_failed: boolean }> }`
  - `TestClient.resume(sessionId: string, opts: { username: string; secret: string; knownWorkflows?: string[] }): Promise<Envelope>`
  - `TestServer.workflows(sessionId: string): Promise<WorkflowSnapshot[]>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/resumeProtocol.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient, type TestServer } from "@adt/test-support";

const readStep = {
  kind: "step" as const,
  step: { objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true },
};

async function runningSession(srv: TestServer) {
  const c = await TestClient.connect(srv.url);
  const welcome = await c.hello({ username: "alice", secret: "pw-alice" });
  const sessionId = (welcome.payload as { session_id: string }).session_id;
  const request = {
    ...c.base("workflow.request"),
    payload: { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } },
  };
  const created = await c.sendRaw(request);
  const workflowId = (created.payload as { workflow_id: string }).workflow_id;
  const dispatch = await c.next(); // step.dispatch
  return { c, sessionId, workflowId, request, stepId: (dispatch.payload as { step_id: string }).step_id };
}

describe("session.resume / workflow.state_sync", () => {
  it("resumes a disconnected session and syncs the pending step", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId, workflowId, stepId } = await runningSession(srv);
    await c.close();

    const resumed = await TestClient.connect(srv.url);
    const sync = await resumed.resume(sessionId, { username: "alice", secret: "pw-alice" });

    expect(sync.type).toBe("workflow.state_sync");
    expect(sync.in_reply_to).not.toBeNull();
    expect((sync.payload as { resumed: boolean }).resumed).toBe(true);
    const entry = (sync.payload as { workflows: any[] }).workflows.find((w) => w.workflow_id === workflowId);
    expect(entry.workflow_status).toBe("RUNNING");
    expect(entry.pending_step.step_id).toBe(stepId);
    expect(entry.pending_step.capability).toBe("git.collect_diagnostics");
    expect(entry.record_id).toBeNull();

    // The resumed session keeps working (PENDING must pass through RUNNING first).
    resumed.send({
      ...resumed.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    const candidate = await resumed.sendRaw({
      ...resumed.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "COMPLETED", evidence: { source: "capability", type: "git_status", result: {} } },
    });
    expect(candidate.type).toBe("workflow.completion_candidate");
    await resumed.close();
    await srv.close();
  });

  it("ignores a message_id already seen before the reconnect", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId, request } = await runningSession(srv);
    await c.close();

    const resumed = await TestClient.connect(srv.url);
    await resumed.resume(sessionId, { username: "alice", secret: "pw-alice" });
    resumed.send(request); // exact retransmission of the pre-disconnect message
    await new Promise((r) => setTimeout(r, 50));

    expect(await srv.workflows(sessionId)).toHaveLength(1);
    await resumed.close();
    await srv.close();
  });

  it("replies session_expired and closes for an unknown session", async () => {
    const srv = await startTestServer({ planner: [] });
    const c = await TestClient.connect(srv.url);
    const err = await c.resume("sess_nope", { username: "alice", secret: "pw-alice" });
    expect(err.type).toBe("protocol.error");
    expect((err.payload as { code: string }).code).toBe("session_expired");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("rejects resume with bad credentials", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId } = await runningSession(srv);
    await c.close();

    const other = await TestClient.connect(srv.url);
    const err = await other.resume(sessionId, { username: "alice", secret: "wrong" });
    expect((err.payload as { code: string }).code).toBe("auth_failed");
    expect(await other.waitClose()).toBe(true);
    await srv.close();
  });

  it("does not let another user resume someone else's session", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId } = await runningSession(srv);
    await c.close();

    const bob = await TestClient.connect(srv.url);
    const err = await bob.resume(sessionId, { username: "bob", secret: "pw-bob" });
    expect((err.payload as { code: string }).code).toBe("auth_failed");
    expect(await bob.waitClose()).toBe(true);
    await srv.close();
  });

  it("reports a workflow that terminated while the client was offline", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId, workflowId } = await runningSession(srv);
    await c.close();
    await srv.engine.reclaimOrphan(workflowId); // termination that happened while offline

    const resumed = await TestClient.connect(srv.url);
    const sync = await resumed.resume(sessionId, {
      username: "alice", secret: "pw-alice", knownWorkflows: [workflowId],
    });
    const entry = (sync.payload as { workflows: any[] }).workflows.find((w) => w.workflow_id === workflowId);
    expect(entry.workflow_status).toBe("FAILED");
    expect(entry.record_id).toMatch(/^rec_/);
    expect(entry.record_persistence_failed).toBe(false);
    await resumed.close();
    await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/resumeProtocol.test.ts`
Expected: FAIL（`session.resume` 未注册 / `TestClient.resume` 不存在）

- [ ] **Step 3: 实现**

`workflowProtocol.ts`：抽出并导出 `stepDispatchPayload(step)`；`sendStepDispatch` 改用它。

`session/resume.ts` 的 `registerSessionResume`：

1. 读 `payload = { session_id, auth, known_workflows }`；`session_id` 非字符串或 `auth.username`/`auth.secret` 非字符串 → `sendError(conn, null, "malformed_payload", ...)` 并返回。
2. `users.verifyCredentials(username, secret)` 为 `null` → `sendError(conn, null, "auth_failed", ...)`（致命，`sendError` 会断开）。
3. `const existing = sessions.get(session_id)`；`!existing || sessions.isExpired(existing)` → `sendError(conn, null, "session_expired", ...)`。
4. `existing.userId !== user.id` → `sendError(conn, null, "auth_failed", ...)`。
5. `sessions.attach(existing.id, conn)`；`deps.onResumed?.(existing.id)`。
6. `const workflows = await store.listWorkflowsBySession(existing.id)`；`const known = new Set(known_workflows.map((w) => w.workflow_id))`。对每个 workflow：若 `isTerminalWorkflow(w.state) && !known.has(w.id)` 跳过；否则取 `listSteps(w.id)` 中 `isActiveStep` 的第一个作为 `pending_step`；若已终态，`const fin = await records.finalize(w.id)`，`record_id = fin.recordId`、`record_persistence_failed = fin.persistenceFailed`，否则 `null` / `false`。
7. `conn.send({ ...session 信封, type: "workflow.state_sync", session_id: existing.id, user_id: existing.userId, in_reply_to: env.message_id, payload: { resumed: true, workflows } })`。

> `known_workflows` 只用于挑选"需要补发终态"的对账项（ADR-001：状态以 Server 为准）。`records.finalize` 幂等，顺带补齐断线期间未落盘的 Record。

`index.ts` 的 `start` 与 `test-support/src/server.ts`：在 `registerWorkflowProtocol` 之后 `registerSessionResume({ ..., users: new UserRepository(pool), store: workflowStore, records, onResumed: (id) => reclaimer.onSessionAlive(id) })`。

`test-support/src/client.ts` 增加 `resume`（发送 `session.resume`，从返回信封/`state_sync` 更新 `sessionId` / `userId`）；`test-support/src/server.ts` 增加 `workflows(sessionId)`（委托 `workflowStore.listWorkflowsBySession`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/resumeProtocol.test.ts test/protocol/workflowProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/session/resume.ts packages/server/src/protocol/workflowProtocol.ts packages/server/src/index.ts packages/test-support packages/server/test/protocol/resumeProtocol.test.ts
git commit -m "feat(protocol): session.resume with auth and workflow.state_sync"
```

---

### Task 7: 补齐 P1 遗留的 `capability.sync` 测试覆盖

**Files:**
- Modify: `packages/server/src/capability/handler.ts`（收严 `added`/`removed` 形态）
- Test: `packages/server/test/capabilitySync.int.test.ts`（追加）

**Interfaces:**
- Consumes: P1 的 `registerCapabilitySync` / `CapabilityRegistry`
- Produces: 无新接口；`registerCapabilitySync` 现在要求 `added` 与 `removed` 都是数组，否则 `malformed_payload`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/capabilitySync.int.test.ts（在既有 describe 内追加）
it("keeps explicit side_effect/interruptible values", async () => {
  const { srv, c } = await authed();
  await c.sync({
    mode: "full", revision: 0,
    added: [{ name: "git.collect_diagnostics", side_effect: false, interruptible: true, idempotent: true }],
    removed: [],
  });
  await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));
  const cap = srv.capabilities(c.sessionId).get("git.collect_diagnostics")!;
  expect(cap.side_effect).toBe(false);
  expect(cap.interruptible).toBe(true);
  expect(cap.idempotent).toBe(true);
  await c.close(); await srv.close();
});

it("applies an incremental removal", async () => {
  const { srv, c } = await authed();
  await c.sync({
    mode: "full", revision: 0,
    added: [{ name: "git.collect_diagnostics", side_effect: false, interruptible: true }],
    removed: [],
  });
  await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));

  await c.sync({ mode: "incremental", revision: 1, added: [], removed: ["git.collect_diagnostics"] });
  await srv.waitFor(() => !srv.capabilities(c.sessionId).has("git.collect_diagnostics"));
  await c.close(); await srv.close();
});

it("rejects a malformed capability.sync shape", async () => {
  const { srv, c } = await authed();
  const err = await c.sendRaw({
    ...c.base("capability.sync"),
    payload: { mode: "full", revision: 1, added: "nope", removed: [] },
  });
  expect((err.payload as { code: string }).code).toBe("malformed_payload");
  await c.close(); await srv.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/capabilitySync.int.test.ts`
Expected: 前两条 PASS（回归覆盖）；第三条 FAIL（`added` 非数组时当前被 `apply` 容忍）

- [ ] **Step 3: 实现**

`handler.ts`：在既有校验后追加

```ts
if (!Array.isArray(payload.added) || !Array.isArray(payload.removed)) {
  sendError(conn, session, "malformed_payload", "invalid capability.sync payload", env.message_id);
  return;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/capabilitySync.int.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/capability/handler.ts packages/server/test/capabilitySync.int.test.ts
git commit -m "test(server): cover explicit capability flags, incremental removal and malformed sync"
```

---

## Self-Review

**1. Spec coverage：** `ERROR_DISPOSITION` 驱动 → T2；去重窗口 = 会话生命周期 → T3（单测）+ T6（跨重连端到端）；`session.resume` 认证 + TTL + `workflow.state_sync` 字段 → T1（文档）+ T6（实现）；孤儿回收接线（宽限 = TTL、取消意图优先）→ T4；P1 遗留覆盖（显式 flag / 增量 `removed` / 畸形 shape）→ T7；`listWorkflowsBySession` 是 T6 的支撑 → T5。**刻意留给后续**：`workflow.request` 的 `client_request_id` 幂等、Capability I/O schema 校验、LLM 规划（P3）；受控执行确认、对账编排、blob、KB 导出（P4）。

**2. Step scan：** 每个 Step 一个动作；实现步只给签名、语义与关键分支，不给完整函数体。

**3. Type consistency：** `Session.dedup` / `disconnectedAt` / `connection: Connection | null`、`SessionManager.attach/detach/markDisconnected/sweep/isExpired`、`SessionLifecycle.sweep`、`Reclaimable`、`WorkflowStore.listWorkflowsBySession`、`registerSessionResume` / `SessionResumeDeps`、`stepDispatchPayload`、`TestClient.resume` / `TestServer.workflows` 在 T3–T6 定义，后续任务同名复用。

**4. Review Focus：** 五条风险均落到测试——(1) 跨重连重传 → T6；不产生第二条 Workflow；(2) 致命错误断开、请求级/可忽略不断开 → T2；(3) 未知/过期会话、错误凭据、跨用户 → T6；(4) TTL 内 resume 取消回收、超时回收为 `client_unreachable` → T4；(5) 断线期间终止的对账 → T6（`known_workflows` + `record_id`）。

**5. Proportion：** 计划只给决策、接口与断言；实现体仅出现在算法不由签名与测试决定之处（`resume` 校验顺序、`sweep` 组合）。

## 移交后续计划的待办

1. **`workflow.request` 的 `client_request_id` 幂等未实现**（D-D1；属 P1/P2b 范围但与 P2c 相邻）→ 若 P3 前需要，单独小改动补充 `(session_id, client_request_id)` 去重与台账。
2. **`record.list_request` 的 `filters` 默认值/cursor 与 `state_sync` 的字段需在 `PROTOCOL_SPEC.md` v0.7 里保持一致** → 实现期间若发现文档滞后于代码，回到 Task 1 的文档同步。
3. **`SessionLifecycle` 的 `intervalMs` 生产默认值**（当前 60s）→ 视部署调优，不阻塞 MVP。

## 后续

P2c 验收通过后写 **P3（端到端只读闭环）**：LLM 规划（替换 `NOOP_PLANNER`）、Capability I/O schema 校验、`criteria` 修订历史、`workflow.request` 幂等台账。之后 P4（受控执行确认 / 对账编排 / blob / KB 导出）。
