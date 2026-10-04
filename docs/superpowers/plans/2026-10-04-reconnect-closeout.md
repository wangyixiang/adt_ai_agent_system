# 断线收口（login 竞态 + 终态对账）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收掉 UI-4 评审留下的两条：① `login` 在握手成功到 `subscribe` 之间漏观察断线的窄竞态；② 重连时**断线期间已终止**的 workflow 没有被对账，导致"会话已过期"提示对**已完成**的工作误报。

**Architecture:** 不动协议（`known_workflows` 与 `state_sync.record_id` 协议本就支持）。`client-daemon`：连接暴露 `isClosed()`；`ClientConfig`/`ClientDaemonOptions` 支持 `knownWorkflows`（函数，随投影增长）；`state_sync` 的**终态** workflow 经新的 `onReconciled` 回调交给宿主。`client-electron`：投影加 `noteTerminal`；session 把已知 workflow id 传上去、把回传终态收敛进投影，并用**收敛后**的活跃数决定是否提示"过期"。

**Tech Stack:** TypeScript（strict）· ws · Vitest（node/jsdom）

**Spec:** `docs/superpowers/specs/2026-10-03-client-ui-design.md` §9.3（只同一逻辑会话内、只对服务端重发的 pending step 恢复）、`PROTOCOL_SPEC.md` §5.2（`known_workflows`、`state_sync` 带 `record_id`）。

## Global Constraints

- **不动协议**：只用既有的 `known_workflows` 与 `state_sync.record_id`。
- **不改 Record 格式**；`shared/ui.ts` 可扩展（单体自有模型）。
- 无新依赖；编辑文件用 `edit`（**LF**）；**不 push**。
- 验证：`pnpm -r --if-present test`（串行）+ `typecheck`。
- **刻意不做**：`requiresConfirmation` 进 Record（计划 B）、时序 flake（计划 C）。

## Review Focus

1. **终态被对账**：断线期间终止的运行，重连后投影里是终态（带 `recordId`），不再是"活跃"。见 Task 2。
2. **提示不误报**：只有**收敛后仍有活跃** workflow 且未 resume 时才提示"过期"。见 Task 2。
3. **不重复执行**：终态对账只改投影，不触发任何 step 执行。见 Task 2。
4. **login 竞态**：握手成功后若 socket 已关闭，仍会进入重连。见 Task 1。

---

### Task 1: login 竞态守卫

**Files:**
- Modify: `packages/client-daemon/src/connection.ts`
- Modify: `packages/client-electron/src/main/core/session.ts`
- Test: `packages/client-electron/src/main/core/session.int.test.ts`

**Interfaces:**
- Produces：`DaemonConnection.isClosed(): boolean`（`readyState === WebSocket.CLOSED`）。
- Consumes：session 的 `subscribe` 之后，若 `connected.connection.isClosed()` 则 `scheduleReconnect()`。

- [ ] **Step 1: 写失败测试**

`session.int.test.ts` 加一条：登录后立刻把 daemon 的连接**主动**关掉（模拟握手后即断），断言 session 进入 `reconnecting`（而不是停在 `connected`）。用 `session` 无法直接拿连接，改为：登录 → 让 server 关闭 socket → 断言 `reconnecting`（这条已由 UI-4 的测试覆盖）。**改为单元级**：直接测 `DaemonConnection.isClosed()`——连接后为 `false`，`close()` 后为 `true`（放 `packages/client-daemon/test/connection.close.test.ts`）。

```ts
it("reports isClosed after a deliberate close", async () => {
  const srv = await startTestServer({});
  const c = await DaemonConnection.connect({ url: srv.url, credentials, clientInfo, capabilities: [] });
  expect(c.isClosed()).toBe(false);
  await c.close();
  expect(c.isClosed()).toBe(true);
  await srv.close();
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-daemon test -- connection.close`
Expected: FAIL——`isClosed` 不存在。

- [ ] **Step 3: 实现**

`connection.ts` 加 `isClosed(): boolean { return this.ws.readyState === WebSocket.CLOSED; }`。`session.ts`：`login` 与 `attemptReconnect` 在 `subscribe(connected)` 之后加 `if (connected.connection.isClosed()) scheduleReconnect();`。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-daemon test -- connection.close` 与 `pnpm -C packages/client-electron test -- session.int.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/connection.ts \
        packages/client-electron/src/main/core/session.ts \
        packages/client-daemon/test/connection.close.test.ts
git commit -m "fix(client-electron): observe a socket that closed right after the handshake"
```

---

### Task 2: 重连终态对账

**Files:**
- Modify: `packages/client-daemon/src/connection.ts`
- Modify: `packages/client-daemon/src/daemon.ts`
- Modify: `packages/client-daemon/src/index.ts`
- Modify: `packages/client-electron/src/main/core/projection.ts`
- Modify: `packages/client-electron/src/main/core/session.ts`
- Test: `packages/client-daemon/test/reconnect.e2e.test.ts`
- Test: `packages/client-electron/src/main/core/projection.test.ts`
- Test: `packages/client-electron/src/main/core/session.int.test.ts`

**Interfaces:**
- Produces:
  - `ClientConfig.knownWorkflows?: () => string[]`；`sendResume` 用 `cfg.knownWorkflows?.() ?? []` 填 `known_workflows`。
  - `StateSyncSnapshot.workflows[]` 加 `record_id: string | null`（协议已有）。
  - `ClientDaemonOptions.knownWorkflows?: () => string[]`；`ClientDaemonOptions.onReconciled?: (workflows: ReconciledWorkflow[]) => void`，`ReconciledWorkflow = { workflowId: string; terminalState: TerminalState; recordId: string | null }`；`onReady` 的 `stateSync` 分支里，把 `workflow_status` 属终态的项回调。
  - `Projection.noteTerminal(workflowId, terminalState, recordId): void`——把该 workflow 标为终态（若无则 `ensure` 后标记），不发事件。
  - `session.ts`：`connectDaemon` 传 `knownWorkflows: () => projection.workflows().map((w) => w.workflowId)` 与 `onReconciled`（逐条 `projection.noteTerminal`，并 `emitState()`）；"过期"提示的判定改为**收敛后**再算 `stillLive`。

- [ ] **Step 1: 写失败测试**

`projection.test.ts` 加：

```ts
it("reconciles a workflow that terminated during the outage", () => {
  const p = createProjection();
  p.noteRequest("wf_1", "x", []);
  p.noteTerminal("wf_1", "COMPLETED", "rec_1");
  const w = p.workflows().find((x) => x.workflowId === "wf_1")!;
  expect(w.terminalState).toBe("COMPLETED");
  expect(w.recordId).toBe("rec_1");
});
```

`reconnect.e2e.test.ts` 加：resume 时 `onReconciled` 收到断线期间终止的 workflow（构造：第一条连接跑完并终止 → 断开 → 第二条连接带 `knownWorkflows: () => [workflowId]` → 收到该 workflow 的终态）。

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- projection.test` 与 `pnpm -C packages/client-daemon test -- reconnect.e2e`
Expected: FAIL——`noteTerminal`/`onReconciled`/`knownWorkflows` 不存在。

- [ ] **Step 3: 实现**

按 Interfaces 改 `connection.ts`（`knownWorkflows` + `record_id` 字段）、`daemon.ts`（选项 + `onReconciled` + 终态判定，`TerminalState` 从 `@adt/shared` 取）、`index.ts`（导出 `ReconciledWorkflow`）、`projection.ts`（`noteTerminal`）、`session.ts`（接线 + 收敛后判定）。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-daemon test -- reconnect.e2e` 与 `pnpm -C packages/client-electron test -- projection.test session.int.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/connection.ts packages/client-daemon/src/daemon.ts packages/client-daemon/src/index.ts \
        packages/client-electron/src/main/core/projection.ts packages/client-electron/src/main/core/session.ts \
        packages/client-daemon/test/reconnect.e2e.test.ts \
        packages/client-electron/src/main/core/projection.test.ts packages/client-electron/src/main/core/session.int.test.ts
git commit -m "feat(client-electron): reconcile workflows that ended during the outage"
```

---

### Task 3: 整基验证（本切片出口）

- [ ] **Step 1: 全量验证**

Run: `pnpm -r --if-present test` 与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0（若 server/daemon 时序 flake，隔离复跑确认——那是计划 C 的范畴）。

---

## 移交后续计划的待办

- **计划 B**：`step_dispatched` 带 `requiresConfirmation`。
- **计划 C**：时序 flake 稳化。

## Self-Review

**1. Spec coverage：** §9.3 的"只对 pending_step 恢复"→ 不变；本计划补的是"断线期间终态的对账"，使 §9 的"过期如实"不误报。协议依据 `PROTOCOL_SPEC.md` §5.2 的 `known_workflows`/`record_id`。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给接口。

**3. Type consistency：** `ReconciledWorkflow`（T2）→ `onReconciled`（T2）→ `Projection.noteTerminal`（T2）→ session 接线（T2）；`knownWorkflows: () => string[]` 在 `ClientConfig` 与 `ClientDaemonOptions` 同名同形。

**4. Review Focus：** 四条分别由 T2（终态对账、提示不误报、不重复执行）与 T1（login 竞态）钉住。

**5. Proportion：** 计划只钉出口、回调与断言。
