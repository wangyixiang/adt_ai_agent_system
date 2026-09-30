# P4 收口阶段（重连恢复 + 清单 output_type + 墙钟）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **编号说明：** 本阶段由一次全仓对齐审计得出，**先于 P4d（KB 导出）落地**。为避免改写历史计划里的 `P4d` 引用，本阶段不占用 P4d/P4e 编号，称「**P4 收口**」。执行顺序：P4c → **收口** → P4d。

**Goal:** 把审计发现的"实现与契约不符"清掉：① **客户端断线重连**（`NFR-3` 是 P0 需求，服务端做完了、客户端半边缺失）；② **Manifest 带 `output_type`**，让 `evidence.type` 这一条校验真正落地；③ 护栏与 Record 的时间改为**墙钟**。

**Architecture:** 三块互不相干。**重连**：daemon 记住逻辑会话（一个新模块 + 小表），连接时先试 `session.resume`、失败回落 `session.hello`；`state_sync` 带回的 `pending_step` 交给既有的 Step Runner 重跑——而"重跑"要安全，就必须先把**幂等台账改成三态**（未见过 / 执行中 / 已完成），否则重发一个当时正在执行的副作用 Step 会**静默再执行一次物理动作**（违反 `WORKFLOW_SPEC.md` §4.3）。**清单**：`output_type` 进 Manifest，并在**派发时快照到 Step**（沿用"校验依据必须冻结在 Step 上"的既有教训），`evidence.type` 与快照不符 → `FAILED(invalid_output)`，`step.dispatch.expected_output` 从此有实义。**时间**：Workflow 的 `createdAt`/`endedAt` 改墙钟（护栏的 `elapsedMs`、Record 的 `duration_ms`、`record.list` 的时间过滤都挂在它们上面），事件的 `ts` 按 `PROTOCOL_SPEC.md` §2 保持单调并写明理由。

**Tech Stack:** TypeScript（strict）· Node.js LTS · PostgreSQL（`pg`）· `node:sqlite`（台账/会话存储）· Vitest · pnpm workspace（沿用 P1–P4c 结构）

**Spec:** `docs/specs/PROTOCOL_SPEC.md`（§2 `ts` 语义、§5.2 `session.resume`/`workflow.state_sync`、§6 Manifest 字段、§8 `step.dispatch.expected_output`）、`docs/specs/WORKFLOW_SPEC.md`（§4.3 台账与"不得静默重执行"、§13 护栏时间预算）、`docs/specs/CAPABILITY_SPEC.md`（§5.2 校验职责、§7-5 `evidence.type` 待补项）、`docs/specs/RECORD_SPEC.md`（§6 `spec_versions`、§5 摘要里的 `duration_ms`）、`docs/REQUIREMENTS.md`（NFR-3 断线恢复）

## Global Constraints

- **`NFR-3` 的范围照旧**：只保证"同一逻辑会话内"的断线恢复；会话过期或服务端重启不保证（那时走新会话 + 新 Workflow）。本阶段不扩大这个范围。
- **台账三态语义（本阶段确立）**：`未见过`（可执行）／`执行中`（**不得执行**，报 `UNKNOWN` 待对账）／`已完成`（回放结果）。失败/拒绝**清除**标记（不是"执行中"）。
- **只读 Step 不碰台账**（没有 `idempotency_key`）：重发即重跑，读操作幂等。
- **`output_type` 是声明的一部分**，不是自由文本：它必须与 `evidence.type` 一致；缺失声明时不阻断（`CAPABILITY_SPEC.md` §5.4 的兼容口子照旧，只是告警）。
- **校验依据冻结在 Step 上**：`output_type` 与 `output_schema` 一样在派发时快照（`CAPABILITY_SPEC.md` §4.1），不读实时清单。
- **时间基准（本阶段确立）**：**持久化到库里、且会被人读的**时间一律墙钟（Workflow 的 `created_at`/`ended_at`、Step 的 `updated_at`）；**事件的 `ts` 保持单调**（`PROTOCOL_SPEC.md` §2 明确如此，且排序靠 `seq` 不靠 `ts`）。这条写进文档，避免下次又猜。
- **不 push**；合并用本地 `ff-merge`（见 `docs/superpowers/WORKFLOW.md`）。
- **文档纪律**：`PROTOCOL_SPEC.md` v0.9 → **v0.10**（§5.2 补客户端 resume 行为、§6 Manifest 增 `output_type`、§8 说明 `expected_output` 的来源与校验）、`CAPABILITY_SPEC.md` v0.9 → **v0.10**（§7-5 关闭）、`RECORD_SPEC.md` v0.7 → **v0.8**（时间基准说明）、`docs/REQUIREMENTS.md` §7 行同步、README 当前状态。

## Review Focus

以下失败模式规格隐含、但默认的测试不会覆盖，**每条都必须在对应任务里有测试**：

1. **重连不得重复执行物理动作**：重发一个"当时正在执行"的副作用 Step 必须报 `UNKNOWN`，**执行器一次都不能再被调用**（`WORKFLOW_SPEC.md` §4.3）。见 Task 4。
2. **已完成但回执丢失**：台账有结果时重发必须**回放**该结果、不执行。见 Task 2 + Task 4。
3. **回落不能丢会话**：resume 失败（会话过期/未知）必须能干净地退回 `session.hello`，并把本地记住的会话换掉。见 Task 3。
4. **`evidence.type` 与声明不符必须被拦**：不能只看 schema；不符 → `FAILED(invalid_output)` 且证据保留。见 Task 6。
5. **时间跨重启仍成立**：护栏的 `elapsedMs` 与 `record.list` 的时间过滤在"上一个进程留下的 Workflow"上也要正确（这就是墙钟要解决的问题）。见 Task 7。

---

### Task 1: 会话存储 + 台账三态

**Files:**
- Create: `packages/client-daemon/src/sessionStore.ts`
- Modify: `packages/client-daemon/src/ledger.ts`
- Test: `packages/client-daemon/test/sessionStore.test.ts`、`test/ledger.test.ts`（追加）

**Interfaces:**
- Produces:
  - `interface SessionStore { save(session: { sessionId: string; userId: string }): void; load(): { sessionId: string; userId: string } | null; clear(): void; close(): void }`
  - `openSessionStore(location: string): SessionStore`（与台账同样的 `node:sqlite` 用法与 `createRequire` 加载方式）
  - `type LedgerState = { state: "in_flight" } | { state: "done"; type: string; result: unknown }`
  - `interface Ledger { get(key): LedgerState | undefined; markInFlight(key): void; markDone(key, type, result): void; clear(key): void; close(): void }`
  - 兼容：`LedgerEntry`（`{type, result}`）保留为"已完成"的负载类型

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/sessionStore.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../src/sessionStore";

describe("openSessionStore", () => {
  it("remembers one logical session across a reopen and forgets it on clear", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adt-session-")), "session.db");
    const first = openSessionStore(path);
    expect(first.load()).toBeNull();
    first.save({ sessionId: "sess_1", userId: "usr_1" });
    first.close();

    const second = openSessionStore(path);
    expect(second.load()).toEqual({ sessionId: "sess_1", userId: "usr_1" });
    // Saving again replaces it: the daemon only ever has one live session.
    second.save({ sessionId: "sess_2", userId: "usr_1" });
    expect(second.load()!.sessionId).toBe("sess_2");
    second.clear();
    expect(second.load()).toBeNull();
    second.close();
  });
});
```

```ts
// packages/client-daemon/test/ledger.test.ts（追加）
it("distinguishes 'never seen', 'in flight' and 'done'", () => {
  const ledger = openLedger(":memory:");
  const key = "idem_1";

  expect(ledger.get(key)).toBeUndefined();

  // Before executing a side effect the runner says so; that is what makes a
  // re-dispatch after a reconnect report UNKNOWN instead of re-running it.
  ledger.markInFlight(key);
  expect(ledger.get(key)).toEqual({ state: "in_flight" });

  ledger.markDone(key, "reset_ack", { reset_ack: true });
  expect(ledger.get(key)).toEqual({
    state: "done",
    type: "reset_ack",
    result: { reset_ack: true },
  });

  // A failure clears the marker: the action is not "unknown", it did not happen.
  ledger.clear(key);
  expect(ledger.get(key)).toBeUndefined();
  ledger.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/sessionStore.test.ts test/ledger.test.ts`
Expected: FAIL（模块不存在 / `markInFlight` 等未定义）

- [ ] **Step 3: 实现**

`sessionStore.ts` 复制 `ledger.ts` 的 `createRequire("node:sqlite")` 加载方式（Vite 解析不了 `node:sqlite`，见 Task 2 的注释）；表 `session(id text primary key, session_id text not null, user_id text not null, updated_at bigint not null)`，只保留一行（固定 `id='current'`）。
`ledger.ts` 把表改成 `ledger(key text primary key, state text not null, type text, result text)`：`markInFlight` 写 `state='in_flight'`；`markDone` 写 `state='done'` + type/result（覆盖）；`clear` 删除该行；`get` 按 `state` 还原三态，坏 JSON 仍按"无记录"处理并告警。**迁移**：老库里的行没有 `state` 列，`openLedger` 时 `ALTER TABLE ... ADD COLUMN` 不存在才加，并把 `result` 非空的老行补成 `state='done'`（老版本只在完成时写行）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/ledger.test.ts test/sessionStore.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src packages/client-daemon/test
git commit -m "feat(daemon): persist the logical session and make the ledger three-state"
```

---

### Task 2: Runner 按三态处理副作用 Step

**Files:**
- Modify: `packages/client-daemon/src/stepRunner.ts`
- Test: `packages/client-daemon/test/stepRunner.idempotency.test.ts`（改/追加）

**Interfaces:**
- Consumes: Task 1 的 `Ledger`
- Produces: 副作用 Step（有 `idempotency_key`）的执行分支按台账分三路：
  - `done` → `COMPLETED(evidence={source:"capability", type, result})`（**不执行**）
  - `in_flight` → `UNKNOWN`（**不执行**；`WORKFLOW_SPEC.md` §4.3"无法确认台账时不得静默重执行"）
  - 未见过 → `markInFlight(key)` → 确认 → 执行 → `completed` 时 `markDone`；`failed`/`rejected` 时 `clear(key)`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/stepRunner.idempotency.test.ts（追加）
it("reports UNKNOWN for a step it had already begun, instead of running it twice", async () => {
  const ledger = openLedger(":memory:");
  ledger.markInFlight("idem_1");
  let runs = 0;

  const h = harness({ ledger, run: async () => { runs++; return { status: "completed", type: "reset_ack", result: {} }; } });
  h.dispatch({ ...payload, idempotency_key: "idem_1" });
  await h.settle();

  expect(runs).toBe(0);
  expect(h.sent.at(-1)!.payload).toMatchObject({ status: "UNKNOWN" });
});

it("clears the marker when the action did not happen", async () => {
  const ledger = openLedger(":memory:");
  const h = harness({
    ledger,
    run: async () => ({ status: "failed", code: "capability_error", message: "no ack" }),
  });
  h.dispatch(payload);
  await h.settle();

  expect(ledger.get("idem_1")).toBeUndefined();
});

it("replays a finished result without executing", async () => {
  const ledger = openLedger(":memory:");
  ledger.markDone("idem_1", "reset_ack", { reset_ack: true });
  let runs = 0;

  const h = harness({ ledger, run: async () => { runs++; return { status: "completed", type: "x", result: {} }; } });
  h.dispatch(payload);
  await h.settle();

  expect(runs).toBe(0);
  expect(h.sent.at(-1)!.payload).toMatchObject({
    status: "COMPLETED",
    evidence: { type: "reset_ack", result: { reset_ack: true } },
  });
});
```

> 说明：该文件既有的 `harness(ledger)` 需要**小幅扩写**为可注入执行体的形式：`harness({ ledger, execute }: { ledger?: Ledger; execute?: () => Promise<ExecutionResult> } = {})`，默认 `execute` 保持现有行为（计数 + 返回 `reset_ack`），既有四个用例改用默认值即可，不改变它们的断言。下面的 `h.dispatch(payload)` 仍走既有签名。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.idempotency.test.ts`
Expected: FAIL（`in_flight` 被当作"未命中"而执行；失败路径不清除标记）

- [ ] **Step 3: 实现**

把现有的"命中台账就回放"改成三态分支（见 Interfaces）。注意**顺序**：台账判定早于确认（`in_flight`/`done` 都不需要工程师再点头），见 P4a 的既有实现；`markInFlight` 在**执行前**写，`markDone` 在 `completed` 后写，`clear` 在 `failed`/`rejected`（含资源冲突那一路的终态拒绝）时写。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.idempotency.test.ts test/stepRunner.resourceConflict.test.ts test/stepRunner.confirm.test.ts`
Expected: PASS（既有确认/冲突测试不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/stepRunner.ts packages/client-daemon/test/stepRunner.idempotency.test.ts
git commit -m "feat(daemon): never silently re-run a side effect the ledger cannot confirm"
```

---

### Task 3: 连接层 resume（含回落）与 `state_sync` 重派发

**Files:**
- Modify: `packages/client-daemon/src/connection.ts`、`packages/client-daemon/src/daemon.ts`、`packages/client-daemon/src/stepRunner.ts`（把 `handleStep` 抽成可复用入口）
- Test: `packages/client-daemon/test/connect.test.ts`（改/追加）、`test/resume.test.ts`（新建）

**Interfaces:**
- Produces:
  - `ClientDaemonOptions.sessionStore?: SessionStore`（默认内存实现；文件版由宿主传入，与 `ledger` 同样口径）
  - `DaemonConnection.connect(cfg, onReady)`：先按 `cfg.session`（`{sessionId} | null`）尝试 `session.resume`，成功则用 `workflow.state_sync` 的 `session_id`；**失败/超时/`session_expired`/`auth_failed` → 改用 `session.hello`**（并把 `session` 置空由调用方持久化）
  - `ClientConfig` 增 `session?: { sessionId: string } | null` 与 `knownWorkflows?: string[]`
  - **就绪信号**：`hello` 的自然是 `session.welcome`；`resume` 的是它回的 `workflow.state_sync`（信封上的 `session_id`/`user_id` 即新会话身份）。因此 `onReady` 的签名扩为 `onReady(connection, stateSync?: WorkflowStateSyncPayload)`——daemon 用它拿到 `pending_step`；同时仍 `connection.on("workflow.state_sync", …)` 兜住"连接建立之后又来的"那一次
  - `ClientDaemon.connect`：连接成功后 `sessionStore.save({sessionId, userId})`；断线/失败时不清（下次还要试 resume）；回落成功则 `save` 新会话
  - `attachStepRunner` 暴露 `runStep(deps, run, dispatch): Promise<void>`（由 `handleStep` 改名导出），事件处理器只负责调用它
- 语义落点：`known_workflows` 不需要持久化——服务端只把它用来筛选**已终态**的 workflow，未终态的（也就是带 `pending_step` 的）**一律同步**（`packages/server/src/session/resume.ts`）。因此 daemon 固定传 `[]` 即可。

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/resume.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";

describe("client session resume", () => {
  it("keeps the logical session across a reconnect", async () => {
    const srv = await startTestServer({});
    const store = /* 内存 SessionStore：save/load/clear/close */;

    const first = await ClientDaemon.connect({ url: srv.url, credentials, clientInfo, workspaceRoot: root, sessionStore: store });
    const sessionId = first.connection.sessionId;
    await first.close();

    const second = await ClientDaemon.connect({ url: srv.url, credentials, clientInfo, workspaceRoot: root, sessionStore: store });
    expect(second.connection.sessionId).toBe(sessionId); // 不是新会话
    await second.close();
    await srv.close();
  });

  it("falls back to a fresh handshake when the remembered session is gone", async () => {
    const srv = await startTestServer({ sessionTtlMs: 1 });
    const store = /* … */;
    const first = await ClientDaemon.connect({ … });
    const stale = first.connection.sessionId;
    await first.close();
    await new Promise((r) => setTimeout(r, 20)); // 让会话过期

    const second = await ClientDaemon.connect({ … });
    expect(second.connection.sessionId).not.toBe(stale);
    await second.close();
    await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/resume.test.ts`
Expected: FAIL（`sessionStore` 未接线；重连必然新会话）

- [ ] **Step 3: 实现**

`connection.ts`：把握手过程抽成"发 `session.hello` 或 `session.resume`"两种起点，二者共用"收到 `session.welcome` 或 `workflow.state_sync` 即视为就绪"的收尾（resume 的就绪信号是 `workflow.state_sync`，其 `session_id` 与 `user_id` 已在信封上）。resume 失败一律**回落** `hello`（并在 `hello` 成功后由调用方覆盖持久化的会话）。`daemon.ts`：接线 `sessionStore`、把 `state_sync` 的 `pending_step` 逐个交给 `runStep`（**顺序执行**，避免两步并发动同一套硬件）。
`stepRunner.ts`：`handleStep` 改名导出为 `runStep`，事件处理器只负责调用它。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/resume.test.ts test/connect.test.ts test/daemon.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon
git commit -m "feat(daemon): resume the logical session and re-run pending steps"
```

---

### Task 4: 端到端——重连不重复执行副作用

**Files:**
- Test: `packages/client-daemon/test/reconnect.e2e.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1–3；`startTestServer` 的 `plannerImpl` / `defaultRegistry` 覆盖（P4a 已有"挂住不返回"的适配器写法）
- Produces: 验收——真实 daemon + server：
  1. 副作用 Step 正在执行（适配器挂住）时断线 → 重连（resume）→ 服务端重发同一个 `pending_step` → daemon 报 **`UNKNOWN`**，且**适配器只被调用过一次**；
  2. 台账已有结果时重发 → **回放** `COMPLETED`，不执行。

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/reconnect.e2e.test.ts
// 1) 服务端：plannerImpl 先给一个副作用 Step（sim_rig.trigger_reset），对账那一步用 reconcile 决策
// 2) 客户端：registry 用"挂住不返回"的适配器（计数 runs），onConfirmationRequired 恒 true
// 3) 流程：发起 workflow → 等到 RUNNING（适配器已进入）→ daemon.close() 断开
// 4) 用同一个 sessionStore 重连 → 断言 runs === 1（没有被第二次执行）
// 5) 并断言服务端该 Step 的最终态是 UNKNOWN 或经对账后的终态（取决于 planner 脚本）
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/reconnect.e2e.test.ts`
Expected: FAIL（当前实现会第二次执行：`runs === 2`）

- [ ] **Step 3: 实现（补齐缺口）**

修正暴露的缺口直到闭环成立；**不得**为过测试放宽 Server 侧校验，也不得让 daemon 在"台账无法确认"时选择执行。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/reconnect.e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/test/reconnect.e2e.test.ts packages/client-daemon/src
git commit -m "test(daemon): a reconnect never repeats a side effect it cannot confirm"
```

---

### Task 5: Manifest 带 `output_type`

**Files:**
- Modify: `packages/shared/src/protocol/capability.ts`、`packages/client-daemon/src/capability/registry.ts`、`packages/server/src/capability/capabilityRegistry.ts`
- Test: `packages/server/test/capabilitySync.int.test.ts`（追加）、`packages/client-daemon/test/capability/registry.test.ts`（追加）

**Interfaces:**
- Produces:
  - `CapabilityDescriptor.output_type?: string`、`NormalizedCapability.output_type?: string`
  - 客户端 `registry.descriptors()` 把 `spec.output_type` 一并发上去（`CapabilitySpec.output_type` **已存在**，只是没进 Manifest）
  - 服务端 `normalize()` 透传 `output_type`
  - **`HUMAN_MANUAL_ACTION_CAPABILITY` 补 `output_type: "manual_action_result"`**（`@adt/shared`）：建议路径的证据同样是"声明过的输出"，补上它 T6 的类型校验才覆盖这条路径

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/capabilitySync.int.test.ts（追加）
it("keeps the declared output_type so evidence.type can be checked later", async () => {
  // hello with { name: "git.collect_diagnostics", output_type: "git_status", … }
  // → sessions.capabilitiesOf(sessionId).get("git.collect_diagnostics").output_type === "git_status"
});
```

```ts
// packages/client-daemon/test/capability/registry.test.ts（追加）
it("sends the declared output_type in the Manifest", () => {
  const registry = defaultRegistry();
  const descriptor = registry
    .descriptors()
    .find((candidate) => candidate.name === "git.collect_diagnostics")!;
  expect(descriptor.output_type).toBe("git_status");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/capabilitySync.int.test.ts && pnpm -C packages/client-daemon exec vitest run test/capability/registry.test.ts`
Expected: FAIL（`output_type` 被丢弃）

- [ ] **Step 3: 实现**

三处各一行：shared 的两个接口加可选字段；客户端 `descriptors()` 带上；服务端 `normalize()` 透传。

- [ ] **Step 4: 运行测试确认通过**

Run: 同上两条命令
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/shared packages/client-daemon packages/server
git commit -m "feat: carry the declared output_type in the capability manifest"
```

---

### Task 6: `expected_output` 快照与 `evidence.type` 校验

**Files:**
- Create: `packages/server/migrations/010_step_output_type.sql`
- Modify: `packages/server/src/workflow/store.ts`、`postgresStore.ts`、`engine.ts`、`orchestrator.ts`、`protocol/workflowProtocol.ts`
- Test: `packages/server/test/protocol/evidenceValidation.test.ts`（追加）、`packages/server/test/workflow/engine.outputType.test.ts`（新建）

**Interfaces:**
- Produces:
  - `StepSnapshot.expectedOutput: string | null`；`NewStep.expectedOutput?: string | null`
  - `orchestrator` 派发时把 `capability.output_type ?? null` 写入 `expectedOutput`（与 `outputSchema` 同样"派发时冻结"）
  - `stepDispatchPayload` 的 `expected_output` 改为 `step.expectedOutput`（现在是硬编码 `null`）
  - `withOutputValidation`：若 `step.expectedOutput` 非空且 `evidence.type !== step.expectedOutput` → `FAILED(invalid_output)`（与 schema 校验**同一个**拒绝通道）；两者都缺失时才告警放行（§5.4）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/evidenceValidation.test.ts（追加）
it("records FAILED(invalid_output) when evidence.type does not match the declared output_type", async () => {
  // hello 声明 { name: "git.collect_diagnostics", output_type: "git_status", output_schema: {branch} }
  // planner 派发该能力 → 客户端 COMPLETED, evidence = { source:"capability", type:"something_else", result:{branch:"main"} }
  // 断言：Step 变 FAILED 且 fail_reason.code === "invalid_output"，证据被保留
});
```

```ts
// packages/server/test/workflow/engine.outputType.test.ts（新建）
it("freezes expected_output on the step at dispatch", async () => {
  // dispatchStep({ …, expectedOutput: "git_status" }) → 持久化后 getStep(...).expectedOutput === "git_status"
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/evidenceValidation.test.ts test/workflow/engine.outputType.test.ts`
Expected: FAIL（字段不存在；类型不符的 `evidence.type` 现在会被 schema 放行）

- [ ] **Step 3: 实现**

`010_step_output_type.sql`：`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS expected_output text;`。`toStep`/`insertStep` 映射新列；`dispatchStep` 写 `expectedOutput: step.expectedOutput ?? null`；`orchestrator` 从能力清单取值（**读清单只发生在派发时**）；`stepDispatchPayload` 用真实值；`withOutputValidation` 在 schema 校验**之前**先比 `type`（type 不符就没必要再看 result），保留既有 `invalid_output` 的语义与证据。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/ test/workflow/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(protocol): bind expected_output to the step and check evidence.type against it"
```

---

### Task 7: Workflow 时间改墙钟

**Files:**
- Modify: `packages/server/src/workflow/engine.ts`、`packages/server/src/index.ts`（`start()` 的时钟注入）
- Test: `packages/server/test/workflow/engine.clock.test.ts`（新建）、`packages/server/test/record/builder.test.ts`（追加 duration 断言）

**Interfaces:**
- Produces: `create()` 与 `terminate()` 用 `this.wallClock()` 写 `createdAt`/`endedAt`；`EngineDeps.now` **只**用于事件 `ts`（并在注释里写明理由：`PROTOCOL_SPEC.md` §2 要求 `ts` 单调，排序不靠它）
- 影响：护栏的 `elapsedMs = wallClock() - createdAt`、Record 的 `duration_ms`、`record.list` 的 `time_range` 过滤、`records.owner_ended_idx` 的排序都恢复为"真实时间"

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.clock.test.ts
it("stamps workflow timestamps with the wall clock, not the ordering clock", async () => {
  const store = new PostgresWorkflowStore(pool);
  const engine = new WorkflowEngine({ store, now: () => 1000, wallClock: () => 1_700_000_000_000 });
  const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
  expect(wf.createdAt).toBe(1_700_000_000_000);

  const ended = await engine.fail(wf.id, "planner_error");
  expect(ended.endedAt).toBe(1_700_000_000_000);
  // 事件仍用单调时钟（排序靠 seq）
  expect((await store.listEvents(wf.id)).every((event) => event.ts === 1000)).toBe(true);
});

it("keeps a time budget meaningful across a restart", async () => {
  // 用 wallClock 造一个"创建于很久以前"的 Workflow（把 createdAt 直接写成 now - 10 分钟），
  // guardrails.timeBudgetMs = 60_000 → 下一次派发必须因 time_budget 终止。
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.clock.test.ts`
Expected: FAIL（`createdAt` 现在是单调钟读数 1000）

- [ ] **Step 3: 实现**

`create()`：`createdAt: this.wallClock()`；`terminate()`：`endedAt: this.wallClock()`；护栏与 `duration_ms` 不动（它们读的是这两个字段）。`start()` 的 `now` 保持 `performance.now()`（事件 ts 用），`wallClock` 保持 `Date.now()`（已在 P4a 接好）。
**预期影响很小**：既有测试里的 `createdAt`/`endedAt` 几乎都是**夹具字面量**（`builder.test.ts`、`criteria.test.ts`、`llmPlanner.test.ts`、`blob/*`），不是对引擎产出的断言；若跑测试出现相关失败，按"夹具在造历史时间"调整（例如给 `wallClock` 注入与 `now` 相同的值）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/`
Expected: PASS（含既有回归）

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "fix(workflow): stamp workflow timestamps with the wall clock"
```

---

### Task 8: 规格与文档同步

**Files:**
- Modify: `docs/specs/PROTOCOL_SPEC.md`（v0.9 → **v0.10**：§5.2 补客户端 resume 的期望行为与回落、§6 Manifest 增 `output_type`、§8 说明 `expected_output` 来自派发快照并被用于校验 `evidence.type`）
- Modify: `docs/specs/CAPABILITY_SPEC.md`（v0.9 → **v0.10**：§7-5 关闭；§4.1 的"派发时冻结"补上 `output_type`）
- Modify: `docs/specs/RECORD_SPEC.md`（v0.7 → **v0.8**：§6 旁补一句时间基准——`created_at`/`ended_at`/`duration_ms` 是墙钟；entry 的 `ts` 是单调读数，排序以条目顺序为准）
- Modify: `docs/REQUIREMENTS.md`（§7 三行版本号；NFR-3 的落实说明补"客户端 resume 已实现"）
- Modify: `README.md`（当前状态补本阶段；`后续` 仍是 P4d）
- Modify: `docs/superpowers/plans/2026-09-30-p4c-blob-channel.md`（**只在最末的延后项表里**追加一行：D1/D2/D3 已由「P4 收口」关闭——不重写其正文，保持它作为当时记录）

**Interfaces:**
- Consumes: Task 1–7
- Produces: 文档与实现一致

- [ ] **Step 1: 改四份规范/需求文档**

- [ ] **Step 2: 同步 README 与 P4c 计划的关闭记录**

- [ ] **Step 3: 验证**

Run: `for f in WORKFLOW_SPEC CAPABILITY_SPEC PROTOCOL_SPEC RECORD_SPEC; do …比较自身版本与 REQUIREMENTS §7 引用…; done`
Expected: 四行全部 `OK`

- [ ] **Step 4: 提交**

```bash
git add docs/ README.md
git commit -m "docs: client resume, manifest output_type and the wall-clock convention"
```

---

## Self-Review

**1. Spec coverage：** NFR-3 的客户端半边 → T1/T3/T4；`WORKFLOW_SPEC` §4.3 的"不得静默重执行" → T1/T2/T4；`CAPABILITY_SPEC` §5.2 的 `evidence.type` 校验 + §7-5 → T5/T6；`PROTOCOL_SPEC` §8 的 `expected_output` 实义化 → T6；护栏/`duration_ms`/`record.list` 的时间基准 → T7；文档 → T8。**刻意不做**：P4d（KB 导出）、真实 Windows 适配器、UI、§4.4 之外的资源模型、内联阈值强制。

**2. Step scan：** 每步一个动作；实现步给签名与关键分支，不给完整函数体。

**3. Type consistency：** `SessionStore`/`openSessionStore`（T1）、`LedgerState`/`markInFlight`/`markDone`/`clear`（T1/T2）、`runStep`（T3/T4）、`CapabilityDescriptor.output_type`（T5）、`StepSnapshot.expectedOutput`/`NewStep.expectedOutput`（T6）在各任务间同名复用。

**4. Review Focus：** 五条风险落到测试——重连不重复执行（T4，且断言"适配器只被调用一次"）、回放（T2/T4）、回落不丢会话（T3）、type 不符被拦（T6）、时间跨重启（T7）。补充一条：**台账三态**是 T4 成立的前提，所以 T1/T2 必须先在 T3/T4 之前完成（顺序依赖见下）。

**5. Proportion：** 计划只描述决策、接口与断言；Task 3/4 的测试给断言意图（夹具要复用既有 `TestClient`/`ClientDaemon` 写法，逐行抄会变成转写）。

**6. 执行顺序依赖：** T1 → T2 → T3 → T4（台账三态先于 resume，否则重连会重复执行）；T5 → T6（先有清单字段才能校验）；T7 独立；T8 最后。

## 移交后续计划的待办

1. **P4d（KB 导出）**：ADR-005 出站。
2. 审计列出的其余开放项（D4–D8：超时对齐、LLM 重试、Windows 适配器调研、client-ui、P4c 的 N8/N9 等）——**按人指定顺序处理**，本阶段不动。
