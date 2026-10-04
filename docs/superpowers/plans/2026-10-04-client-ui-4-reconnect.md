# UI-4 断线恢复 / resume 可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面客户端在**物理连接断开后自动重连并 resume**，把**真实连接状态**暴露到界面（`已连接 / 正在重连… / 已断开`），并让 resume 时被重发的 step 不再渲染成空卡（山 M1"光卡"）——它先显示"恢复中"，权威状态到达后收敛。

**Architecture:** 三段，**都不动协议**。`client-daemon` 增加两个小出口：连接关闭通知（`DaemonConnection.onClose`）与 resume 事件（`ClientDaemonOptions.onResumed`）。`client-electron` 的 main 拥有 daemon 生命周期：收到关闭 → 置 `reconnecting` → 指数退避重连（`ClientDaemon.connect` 内含 resume）→ 用 `onResumed` 播种投影（`capability/objective/input`）→ 重新订阅 → 置 `connected`。renderer 消费三态与"恢复中"。

**Tech Stack:** TypeScript（strict）· ws · Electron + electron-vite · React 18 · Vitest（node/jsdom）· Playwright Electron

**Spec:** `docs/superpowers/specs/2026-10-03-client-ui-design.md` §9（现实/缺口/设计/边界）、§7（应用栏连接态）。计划是 spec 的论证，冲突以 spec 为准。

## Global Constraints

- **不动协议**：`session.resume` / `workflow.state_sync` / `pending_step` 已存在（`PROTOCOL_SPEC.md` §5.2）。只加 daemon/main/renderer 的内部出口。
- **不改数据/record**；`shared/ui.ts` 的 `UiSnapshot.connection` 扩为三态（单体自有模型，非协议）。
- **一个数据一个家**：连接状态只归应用栏（spec §6.3）。
- 无新依赖；`theme.css` 变量 + 纯 `className`。
- 编辑文件用 `edit`（**LF**）；**不 push**。
- 验证：`pnpm -r --if-present test`（串行）+ `typecheck` + `pnpm -C packages/client-electron build` + **桌面冒烟**；daemon 侧另有 `reconnect.e2e.test.ts`。
- 边界（NFR-3）：只保证**同一逻辑会话内**；会话过期 / Server 重启 → 不恢复，如实提示。
- **刻意不做**：组件样式遍与无障碍（UI-5）、`requiresConfirmation` 进 Record（单独切片）、时序 flake 稳化（单独任务）。

## Review Focus

1. **真实状态**：中途断线时应用栏必须从"已连接"变为"正在重连…"（不再假报连接）。见 Task 2/3。
2. **自动恢复**：断线后无需人工操作即可重连并 resume；重连成功状态回到"已连接"。见 Task 1/2。
3. **不再空卡**：resume 重发的 step 显示其真实 `capability`/`objective` 与"恢复中"，不得是空卡。见 Task 1/2/3。
4. **不重复执行副作用**：重连后对 in-flight 副作用只报 `UNKNOWN`（既有台账保证），UI 用"未对账"呈现，不新增执行。见 Task 1。
5. **过期如实**：`session_expired` 时不假装恢复，提示"需要重新提交"。见 Task 2/3。

---

### Task 1: daemon 暴露连接关闭与 resume

**Files:**
- Modify: `packages/client-daemon/src/connection.ts`
- Modify: `packages/client-daemon/src/daemon.ts`
- Test: `packages/client-daemon/test/connection.close.test.ts`（新建）
- Test: `packages/client-daemon/test/reconnect.e2e.test.ts`（扩展）

**Interfaces:**
- Produces:
  - `DaemonConnection.onClose(handler: () => void): void`——物理 socket 关闭（非主动 `close()`）时回调。
  - `export interface ResumedStep { workflowId: string; stepId: string; capability: string; objective: string; input: Record<string, unknown>; }`
  - `ClientDaemonOptions.onResumed?: (steps: ResumedStep[]) => void`——`state_sync` 到达时、**重跑之前**，用 `stateSync.workflows[].pending_step` 构造并回调。

- [ ] **Step 1: 写失败测试**

`connection.close.test.ts`（node 环境）：

```ts
import { describe, it, expect } from "vitest";
// Start a `@adt/test-support` server, connect a DaemonConnection, then have the
// server close the socket and assert onClose fires; call `connection.close()`
// deliberately and assert it does NOT.
```

`reconnect.e2e.test.ts` 追加：断言 resume 时 `onResumed` 被调用一次，且收到的 step 带 `capability`/`objective`。

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-daemon test -- connection.close reconnect.e2e`
Expected: FAIL——`onClose`/`onResumed` 不存在。

- [ ] **Step 3: 实现**

`connection.ts`：加 `private closing = false;`、`private readonly closeHandlers: Array<() => void> = [];`、`onClose(handler)`；构造里 `ws.on("close", () => { if (!this.closing) for (const h of this.closeHandlers) h(); })`；`close()` 里先 `this.closing = true`。`daemon.ts`：`onReady` 的 `if (stateSync)` 分支里，用 `stateSync.workflows` 过滤 `pending_step !== null` 构造 `ResumedStep[]` 并 `opts.onResumed?.(steps)`，再 `void (async () => {...})()` 重跑。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-daemon test -- connection.close reconnect.e2e`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/connection.ts packages/client-daemon/src/daemon.ts \
        packages/client-daemon/test/connection.close.test.ts packages/client-daemon/test/reconnect.e2e.test.ts
git commit -m "feat(client-daemon): surface transport close and the resumed steps"
```

---

### Task 2: main 真实连接三态 + 自动重连 + 播种投影

**Files:**
- Modify: `packages/client-electron/src/shared/ui.ts`
- Modify: `packages/client-electron/src/main/core/projection.ts`
- Modify: `packages/client-electron/src/main/core/session.ts`
- Test: `packages/client-electron/src/main/core/projection.test.ts`
- Test: `packages/client-electron/src/main/core/session.int.test.ts`

**Interfaces:**
- Produces:
  - `UiSnapshot.connection: "connected" | "reconnecting" | "disconnected"`。
  - `UiStep.resuming?: boolean`；`UiEvent` 的 `step.dispatched` 变体加 `resuming?: boolean`。
  - `Projection.noteResumed(step: ResumedStep): UiEventInput`——`ensure(workflowId)` 后 upsert 该 step（`capability`/`objective`/`input`，`state:"PENDING"`，`resuming:true`），返回 `{type:"step.dispatched", …, resuming:true}`；`observeStepStatus` 收到该 step 的任意状态时清 `resuming`。
  - `Projection.snapshot()` 只返回 `workflows`（连接/用户/能力由 session 组装）。
  - `Session`：跟踪 `transport: "connected"|"reconnecting"|"disconnected"`；`daemon.connection.onClose` → 置 `reconnecting`、发 `state` 快照、指数退避（0.5s→1→2→4→8→上限 30s）重连；重连用同一 `ClientDaemon.connect`（含 resume）；`onResumed` → `emitUi(projection.noteResumed(step))`；重连成功 → `connected`、重新订阅、发快照；resume 被回落（未收到 `onResumed` 且有活跃 workflow）→ 发一条 `notice`："会话已过期，未能恢复；未完成的工作需要重新提交"。

- [ ] **Step 1: 写失败测试**

`projection.test.ts` 追加：`noteResumed` seeds a step (capability/objective/resuming true) and a later `observeStepStatus` clears `resuming`。

`session.int.test.ts` 追加：连接后让 server 关闭 socket → 状态变 `reconnecting`、随后自动重连回 `connected`（用既有的 in-process server 夹具）。

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- projection.test session.int.test`
Expected: FAIL——三态/`noteResumed`/重连不存在。

- [ ] **Step 3: 实现**

按 Interfaces 改 `ui.ts`、`projection.ts`、`session.ts`（`snapshot` 签名变更要同步 `bridge.ts`/`index.ts` 的调用点与 `bridge.test.ts` 的 fake）。退避与重连订阅是 session 的私有逻辑；登出/退出时停止重连。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- projection.test session.int.test bridge.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/shared/ui.ts \
        packages/client-electron/src/main/core/projection.ts \
        packages/client-electron/src/main/core/session.ts \
        packages/client-electron/src/main/core/projection.test.ts \
        packages/client-electron/src/main/core/session.int.test.ts \
        packages/client-electron/src/main/core/bridge.test.ts
git commit -m "feat(client-electron): reconnect on transport loss and seed resumed steps"
```

---

### Task 3: renderer 三态应用栏 + 恢复中

**Files:**
- Modify: `packages/client-electron/src/renderer/src/components/AppBar.tsx`
- Modify: `packages/client-electron/src/renderer/src/transcript.ts`
- Modify: `packages/client-electron/src/renderer/src/components/ToolCard.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/Transcript.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Test: `packages/client-electron/src/renderer/src/components/AppBar.test.tsx`
- Test: `packages/client-electron/src/renderer/src/transcript.test.ts`
- Test: `packages/client-electron/src/renderer/src/components/ToolCard.test.tsx`
- Test: `packages/client-electron/src/renderer/src/app.test.tsx`

**Interfaces:**
- Produces:
  - `AppBar` 的 `CONNECTION_TEXT: Record<UiSnapshot["connection"], string>`＝`{ connected:"已连接", reconnecting:"正在重连…", disconnected:"已断开" }`。
  - `TranscriptItem{kind:"tool"}` += `resuming: boolean`；`deriveTranscript` 的 `step.dispatched` 分支读 `event.resuming ?? false`，`step.status` 分支把 `resuming` 置 `false`。
  - `ToolCard`：`item.resuming` 时状态文案显示"恢复中"。
  - `App`：`ui.snapshot.connection === "reconnecting"` 时在中栏顶部渲染一行 `.reconnect-note`＝"正在恢复会话，同步权威状态…"。

- [ ] **Step 1: 写失败测试**

`AppBar.test.tsx`：加 `reconnecting → "正在重连…"`。`transcript.test.ts`：`step.dispatched(resuming:true)` → tool 的 `resuming` 为 true，随后 `step.status` → false。`ToolCard.test.tsx`：`resuming` 时显示"恢复中"。`app.test.tsx`：`connection:"reconnecting"` 的 snapshot → 中栏出现"正在恢复会话"。

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- AppBar.test transcript.test ToolCard.test app.test`
Expected: FAIL。

- [ ] **Step 3: 实现**

按 Interfaces 改组件与 `transcript.ts`；`app.test.tsx` 的 `fakeClient` 若用 `connection:"connected"` 不变。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- AppBar.test transcript.test ToolCard.test app.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/components/AppBar.tsx \
        packages/client-electron/src/renderer/src/transcript.ts \
        packages/client-electron/src/renderer/src/components/ToolCard.tsx \
        packages/client-electron/src/renderer/src/components/Transcript.tsx \
        packages/client-electron/src/renderer/src/app.tsx \
        packages/client-electron/src/renderer/src/components/AppBar.test.tsx \
        packages/client-electron/src/renderer/src/transcript.test.ts \
        packages/client-electron/src/renderer/src/components/ToolCard.test.tsx \
        packages/client-electron/src/renderer/src/app.test.tsx
git commit -m "feat(client-electron): show the connection tri-state and a resuming step"
```

---

### Task 4: 整基验证（本切片出口）

**Files:** 无新增（只跑）。

- [ ] **Step 1: daemon 侧 resume 行为**

Run: `pnpm -C packages/client-daemon test -- reconnect.e2e`
Expected: PASS（既有断线→resume→UNKNOWN 的行为不回归）。

- [ ] **Step 2: 构建与冒烟**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron test:e2e`
Expected: build exit 0；冒烟 **3 passed**。

- [ ] **Step 3: 全量验证**

Run: `pnpm -r --if-present test` 与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0。

---

## 移交后续计划的待办

- **UI-5**：组件样式遍（`.tool-row`/`.bubble*`/`.step-input`/`.completion-*`/`.workbench-*`/`.reconnect-note` 等）与无障碍（最小字号、对比度、颜色+图标+文字、模态焦点/ Esc）。
- **record 切片**：`step_dispatched` 带 `requiresConfirmation`（live/往期同形缺口）。
- **单独 bounded**：server `recordProtocol`/`stepTimeout.int` 与 daemon `controlledExecution` 的时序 flake（隔离必绿、计时敏感）。

## Self-Review

**1. Spec coverage：** §9.2 的六条（可感知状态、自动重连退避、`state_sync` 播种、恢复中、对账呈现、过期如实）→ Task 1/2/3；§9.3 边界（只同一逻辑会话）→ Global Constraints。**刻意不做**见 Global Constraints/移交。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给接口/DOM 契约。

**3. Type consistency：** `ResumedStep`（T1）→ `Projection.noteResumed`（T2）→ `UiStep.resuming`（T2）→ `TranscriptItem.resuming`（T3）；`UiSnapshot.connection` 三态（T2）→ `AppBar` 映射（T3）；`UiEvent.step.dispatched.resuming`（T2）→ `deriveTranscript`（T3）。

**4. Review Focus：** 五条分别由 T2/T3（真实状态）、T1/T2（自动恢复）、T1/T2/T3（不空卡）、T1（不重复副作用，既有台账）、T2/T3（过期如实）钉住。

**5. Proportion：** 计划只钉出口、事件与断言；实现细节留给执行。
