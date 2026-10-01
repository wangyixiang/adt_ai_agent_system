# 单体 Electron 应用（第一个可用的 exe）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个**单体 Electron exe**：双击打开 → 登录 → 提交一次请求 → 看着它一步步跑 → **在卡片上回答四个决策** → 看到 `Record: rec_…`；**关窗最小化到托盘、运行继续**。

**Architecture:** 新增 `packages/client-electron`（**electron-vite**：`main` / `preload` / `renderer`）。**main 进程内直接使用 `@adt/client-daemon`**（`ClientDaemon.connect(...)`，与 `client-cli` 相同）；main 维护一份**投影**（把 daemon 的消息变成"快照 + 事件"）、实现**四个决策的宿主**（三个 `on*` 回调 + `workflow.completion_candidate` 监听），并通过 **preload 的 `contextBridge`** 把一小簇 IPC 能力给 renderer。renderer 是 React UI；daemon 只存在于 main。

**Tech Stack:** Electron + **electron-vite** · React + TypeScript（strict）· Vitest（main/core 用 Node；renderer 用 jsdom + Testing Library）· **electron-builder**（打包冒烟）· pnpm workspace

**Spec / 决策来源:** `docs/adr/ADR-006-client-form-monolith-electron.md`（**ACCEPTED**，本计划依据它）；四决策与安全默认见 `docs/specs/WORKFLOW_SPEC.md` §4.2/§4.3/§4.4/§6.1/§7.2；`manual_action_result` 的 schema 见 `docs/specs/CAPABILITY_SPEC.md` §6；协议侧 `docs/specs/PROTOCOL_SPEC.md` §7.2（完成确认）/§8.1（确认流程）/§8.3（资源冲突）。**本计划属于 `master`（单体产品线），开发在 `master` 的特性分支上做，做完 `ff-merge` 回 `master`。**

## Global Constraints

- **UI 的词汇是 daemon 的词汇**：只用 `CAPABILITY_SPEC` / `WORKFLOW_SPEC` / `RECORD_SPEC` 的词。renderer **不认识 Server 协议**，也**不直接连 Server**——只有 main 里的 daemon 与 Server 通信。
- **四决策的安全语义只写一份**（`SAFE_DEFAULTS` + `validateAnswer`，放 `@adt/shared`）；**没有任何默认是"同意"**：确认→拒绝、资源冲突→`stop`、手工动作→无反馈、完成→`not_solved`。
- **畸形回答 ≠ 用默认**：形状不对 → 拒绝并把**问题保持打开**（等人再答）。
- **凭据只在 main → daemon**：renderer 只在登录表单里短暂持有，经 IPC 交给 main 后不再保存、不写前端存储、不进日志。
- **renderer 不碰 Node**：`contextIsolation: true`、`nodeIntegration: false`；renderer 只能用 preload 暴露的那一小簇方法。
- **`node:sqlite` 是唯一台账实现**（ADR-006）：不引入 `better-sqlite3`；打包器必须把 `node:sqlite` 当 builtin（`createRequire` 或 external）。
- **托盘**：关窗 = 最小化到托盘、运行继续；**显式退出**另行处理（见 Task 6）。
- **不 push**；编辑文件用 `edit` 工具（LF）。
- **验证口径**：`pnpm -r --if-present test` + `pnpm -r --if-present typecheck` + `pnpm -C packages/client-electron build`；本线的**出口** = **打包冒烟**（Task 7，能出 exe 并启动）。

## Review Focus

以下失败模式是规格隐含、但默认测试不会覆盖的，**每条都必须在对应任务里有测试**：

1. **答了却不推进**：回答任何一个决策，必须通过 daemon 的 `on*` 回调 / `workflow.completion_response` **真正让 Workflow 继续或终结**——不是只改 UI 状态。见 Task 4。
2. **畸形/超长回答被当成默认**：坏 `outcome`、缺 `observation`、超 4096 的文本 → 拒绝，**问题保持打开**，随后合法回答仍成功。见 Task 3 / Task 4。
3. **安全默认被绕过**：没人回答 / 退出时，落的是"拒绝 / `stop` / 无反馈 / `not_solved`"，**没有一项默认是"同意"**。见 Task 4。
4. **一个 `askId` 被答两次**：双击 / 重放不得改写人的决定。见 Task 3 / Task 4。
5. **关窗 = 结束**：关掉窗口**不等于**退出——daemon 与正在跑的 Workflow 继续；只有显式退出才收尾。见 Task 6。

---

### Task 1: `packages/client-electron` 骨架（electron-vite）+ `node:sqlite` 探针

**Files:**
- Create: `packages/client-electron/package.json`、`electron.vite.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`.gitignore`
- Create: `src/main/index.ts`（窗口 + `--smoke` 分支）、`src/preload/index.ts`（占位）、`src/renderer/index.html`、`src/renderer/src/main.tsx`（占位）
- Modify: `pnpm-workspace.yaml`（`onlyBuiltDependencies`/`allowBuilds` 放行 `electron`）

**Interfaces:**
- Produces: `pnpm -C packages/client-electron build`（electron-vite 产出 `out/`）；`pnpm -C packages/client-electron smoke` = `electron . --smoke`，打印 `process.versions.electron` / `process.versions.node`，用 `openLedger(<os.tmpdir()>/…db)` 跑一遍 `markInFlight/markDone/get`，然后 `app.exit(0)`。

- [ ] **Step 1: 写探针（先让它红）**

`src/main/index.ts` 的 `--smoke` 分支按 Interfaces 实现；此时包还不存在 → 运行 `pnpm -C packages/client-electron smoke` 失败（无 package / 无 electron）。

- [ ] **Step 2: 建包骨架**

`package.json`：`"type":"module"`、`main: "out/main/index.js"`、scripts `dev`/`build`/`smoke`/`test`/`typecheck`；deps `@adt/client-daemon`、`@adt/shared`、`react`、`react-dom`；devDeps `electron`、`electron-vite`、`electron-builder`、`vite`、`@vitejs/plugin-react`、`typescript`、`vitest`、`jsdom`、`@testing-library/react`、`@testing-library/user-event`、`@types/*`。
`electron.vite.config.ts`：三段（main/preload/renderer），renderer 用 `@vitejs/plugin-react`；**main 里把 `node:sqlite` 标为 external / 保留 `createRequire` 写法**（见 `ledger.ts` 现有注释）。
`pnpm-workspace.yaml`：允许 `electron` 的构建脚本。

- [ ] **Step 3: 安装并跑探针**

Run: `pnpm install && pnpm -C packages/client-electron build && pnpm -C packages/client-electron smoke`
Expected: 打印 **Electron 版本 + Node 版本**，台账 `markInFlight/markDone/get` 全通过，进程 `app.exit(0)`。
**把这两个版本号记进计划下方（作为"Electron 最低版本"依据）**：Electron ≥ 44 / Node ≥ 24（`node:sqlite` 免开关）。

- [ ] **Step 4: 提交**

```bash
git add packages/client-electron pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(electron): a package, and proof that node:sqlite runs inside Electron"
```

---

### Task 2: IPC 契约 + preload `contextBridge` + main 桥（最小回显）

**Files:**
- Create: `src/shared/contract.ts`
- Modify: `src/preload/index.ts`、`src/main/index.ts`
- Test: `src/main/core/bridge.test.ts`

**Interfaces:**
- Produces:
  - `contract.ts`：IPC 频道常量 + `RendererRequest`（renderer → main 的 `invoke` 请求联合）与 `MainEvent`（main → renderer 的推送联合）；`window.adt` 的类型 `AdtBridge`（`login`/`submit`/`answer`/`snapshot`/`onEvent`）。
  - `createBridge(deps): Bridge`——**纯逻辑、不 import `electron`**：`{ handle(request): Promise<unknown>; emit(event): void }`，由 main 把它接到 `ipcMain.handle` / `webContents.send`。
- 说明：Task 4 会把真正的 daemon 接进来；本任务只钉"通道与类型"。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/core/bridge.test.ts —— 用一个假 deps，不碰 electron
// dispatch({kind:"snapshot"}) → emit 出 {type:"state", snapshot};已知请求不抛未知
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/bridge.test.ts`
- [ ] **Step 3: 实现** `contract.ts` + `createBridge` + preload（`contextBridge.exposeInMainWorld("adt", …)`，只暴露契约里的方法）。
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`。
- [ ] **Step 5: 提交** — `feat(electron): the IPC contract and the preload bridge`

---

### Task 3: `@adt/shared` 的四决策词汇 + 校验

**Files:**
- Create: `packages/shared/src/decisions.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/decisions.test.ts`

**Interfaces:**
- Produces（browser-safe，renderer 也能 import）：
  - `type ManualOutcome = "succeeded"|"failed"|"partially"|"unknown"`、`MANUAL_OUTCOMES`
  - `type StepState` / `type TerminalState`
  - `type Ask`（四种：confirmation / manual_action / resource_conflict / completion）与 `type Answer`（四种合法回答）
  - `const SAFE_DEFAULTS = { confirmation:false, manualFeedback:undefined, resourceConflict:"stop", completion:"not_solved" } as const`
  - `const MAX_OBSERVATION_CHARS = 4096` / `MAX_FEEDBACK_CHARS = 4096`
  - `validateAnswer(kind: AskKind, body: unknown): { ok: true; value: Answer } | { ok: false; code: "malformed_payload"; message: string }`
  - `manual_action` 分支**复用** `HUMAN_MANUAL_ACTION_CAPABILITY.output_schema` + `validateJsonSchema`（`CAPABILITY_SPEC` §6），**不另写一份结构校验**。

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/test/decisions.test.ts
// - SAFE_DEFAULTS 四项都不是"同意"
// - validateAnswer("manual_action", {outcome:"done",…}) → ok:false（枚举只有四值）
// - validateAnswer("manual_action", {outcome:"succeeded", observation:"x".repeat(4097)}) → ok:false（长度上限）
// - validateAnswer("confirmation", {kind:"confirmation", decision:"confirmed"}) → ok:true
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/shared exec vitest run test/decisions.test.ts`
- [ ] **Step 3: 实现**（只类型 + 常量 + 校验）
- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/shared typecheck`
- [ ] **Step 5: 提交** — `feat(shared): the four decisions, their safe defaults, and answer validation`

---

### Task 4: main 内嵌 daemon —— 投影 + 命令 + 四个决策宿主

**Files:**
- Create: `src/main/core/projection.ts`、`src/main/core/host.ts`、`src/main/core/session.ts`
- Modify: `src/main/core/bridge.ts`
- Test: `src/main/core/session.int.test.ts`（**真** test Server + **真** `ClientDaemon`，不经 Electron）

**Interfaces:**
- Consumes: Task 3 的 `Ask`/`Answer`/`SAFE_DEFAULTS`/`validateAnswer`；`ClientDaemon.connect`（`@adt/client-daemon`）；`@adt/test-support` 的 `startTestServer`（测试用）
- Produces:
  - `createProjection(): { noteRequest(workflowId, text): void; observe(type, env): UiEventInput | null; observeAsk(ask, workflowId): UiEventInput; noteAnswered(askId, answer): UiEventInput | null; snapshot(): UiSnapshot }`
  - `createDecisionHost(publish: (ask: Ask, workflowId: string) => void): { port: Pick<ClientDaemonOptions,"onConfirmationRequired"|"onUserInput"|"onResourceConflict">; completion(req): Promise<"solved"|"not_solved">; answer(askId, body): AnswerOutcome; abandon(): void }`——`answer` 用 `validateAnswer`；一个 `askId` 只答一次；未答 = 挂起。
  - `createSession(deps: { daemon; projection; host; emit }): { login(c); submit(text): Promise<string>; answer(askId, body): void; snapshot(): UiSnapshot }`——`submit` 发 `workflow.request`（`client_request_id` 用 `randomUUID()`）、记录文本、发布 `workflow.created`；把 daemon 的 `step.dispatch` / `workflow.terminated` / `protocol.error` 折进投影并 `emit`；完成候选接 `host.completion` 后回 `workflow.completion_response`。

- [ ] **Step 1: 写失败测试（真 Server + 真 daemon）**

```ts
// src/main/core/session.int.test.ts（fixture：startTestServer 脚本化 planner + ClientDaemon.connect，emit 收集事件）
// 1) 提交 → 收到 workflow.created（带文本）→ step.dispatched → 等 ask(confirmation) → answer(confirmed) → step COMPLETED → 完成候选 → answer(solved) → workflow.terminated
// 2) 拒绝：answer(declined) → step REJECTED（**绝不执行**）
// 3) 畸形：answer(manual_action outcome:"done") → 抛出/返回 malformed_payload，问题仍在（随后合法回答成功）
// 4) 单次：同一 askId 第二答被拒
// 5) 安全默认：不答直接 abandon()/关闭 → 不产生"同意"
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/session.int.test.ts`
- [ ] **Step 3: 实现** `projection.ts` / `host.ts` / `session.ts`，并把 `bridge.ts` 接上 session。
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `feat(electron): the daemon runs in-process, with a projection and the four decisions`

---

### Task 5: renderer —— 登录 / 对话流 / 四张决策卡

**Files:**
- Create: `src/renderer/src/{app.tsx, api.ts(薄封装 window.adt), transcript.ts}`
- Create: `src/renderer/src/components/{Login,Transcript,ToolCard,AskCard,Notice,Summary,ProgressHeader,Composer}.tsx`
- Test: `src/renderer/src/app.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `window.adt`（类型来自 `contract.ts`）；Task 3 的 `Ask`/`Answer`/`ManualOutcome`
- Produces: 与浏览器线 UI-1/UI-2 同形的界面（对话流 + 四张卡），但**走 IPC**（`api.ts` 是 `window.adt` 的薄封装，**不出现 fetch/EventSource**）：
  - 登录错误态；工具卡（能力 / 输入 / 状态 / 证据）；`AskCard` 四态控件（确认 是/否；手工 四值 + **必填观察**；资源 等/停；完成 已解决/没解决 + 反馈）；进度头；运行中输入框禁用。
  - `deriveTranscript(snapshot, events)` 仍是**纯函数**（可单独测）。

- [ ] **Step 1: 写失败测试**

```tsx
// app.test.tsx（jsdom + RTL；注入假的 window.adt）
// 1) 登录失败 → 显示错误、不进对话流
// 2) 快照 + 推事件 → 工具卡出现、状态对、总结里有 Record
// 3) 四种 ask 各发对 body（确认 {kind,decision}；手工 {kind,outcome,observation}；资源 {kind,answer}；完成 {kind,resolution[,feedback]}）
// 4) 手工卡观察为空 → 不提交
// 5) 纯函数：乱序/重复事件下转录仍然正确；两个 unknown 文案不同
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/renderer`
- [ ] **Step 3: 实现**（组件只画；判断在 `transcript.ts`）
- [ ] **Step 4: 运行确认通过** — 同上 + `build`
- [ ] **Step 5: 提交** — `feat(electron): the chat shell and the four decision cards`

---

### Task 6: 托盘与生命周期（关窗继续 / 显式退出）

**Files:**
- Create: `src/main/tray.ts`、`src/main/lifecycle.ts`
- Modify: `src/main/index.ts`
- Test: `src/main/lifecycle.test.ts`

**Interfaces:**
- Produces: `createLifecycle({ window, daemon, tray }): { onWindowClose(): void; onTrayQuit(): Promise<void> }`——**纯逻辑，不 import `electron`**：
  - `onWindowClose`：**隐藏窗口、不退出**（运行继续）。
  - `onTrayQuit`：若有进行中的 Workflow，先确认；确认后 `daemon.close()` 再退出（**语义：本地收尾；Server 侧由既有超时/护栏收掉**）。

- [ ] **Step 1: 写失败测试** — 关窗只隐藏、不 dispose daemon；托盘退出会 dispose。
- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/lifecycle.test.ts`
- [ ] **Step 3: 实现** + 接进 `main/index.ts`
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `feat(electron): closing the window keeps the daemon running; the tray can quit`

---

### Task 7: 打包冒烟（本线出口）

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`（`pack` 脚本）、`.gitignore`

**Interfaces:**
- Produces: `pnpm -C packages/client-electron pack` → Windows **portable exe**（单体）；冒烟：启动该 exe，断言能起来（`--smoke` 模式启动后立即 `app.exit(0)`）。

- [ ] **Step 1: 配置 `electron-builder.yml`**（Windows、`portable`、`asar`；`node:sqlite` 是内置模块，无需 unpack）
- [ ] **Step 2: 跑打包 + 冒烟**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron pack`
Expected: 产出 exe；用 `--smoke` 启动它 → 退出码 0。

- [ ] **Step 3: 提交** — `build(electron): one command to a runnable Windows exe`

---

## Self-Review

**1. Spec coverage：** ADR-006（单体 / main 内嵌 / IPC / 托盘 / 安全基线）→ T1–T7；设计 §6.2 的四决策 → T3/T4；`WORKFLOW_SPEC` §4.2/§4.3/§4.4/§6.1/§7.2 → T4；`CAPABILITY_SPEC` §6（schema 复用）→ T3；`PROTOCOL_SPEC` §7.2/§8.1/§8.3 → T4。**刻意不做（下一个计划）**：Record 历史/详情、Report、导出、blob 预览、工作台视图；多 Workflow / 旁观者；**签名 / 自动更新**（先要"能跑起来的 exe"）；浏览器/HTTP 那条线（在 `electron-wrapper`，不在本线）。

**2. Step scan：** 每步一个动作；实现步给签名与语义，测试步给断言。T1 的"探针"是一条**运行命令 + 期望输出**，不是单测。

**3. Type consistency：** `Ask`/`Answer`/`SAFE_DEFAULTS`/`validateAnswer`（T3）在 T4/T5 同名复用；`contract.ts` 的 `RendererRequest`/`MainEvent`/`AdtBridge`（T2）在 T4/T5 复用；`createProjection`/`createDecisionHost`/`createSession`（T4）在 T5 的 fake 中被消费。

**4. Review Focus：** 五条都落到测试——回答推进（T4 第 1/2 例）、畸形保持打开（T3 + T4 第 3 例）、安全默认（T3 + T4 第 5 例）、单次（T3 + T4 第 4 例）、关窗≠退出（T6）。

**5. Proportion：** 计划只给签名、断言与关键分支；界面长相与字段以 spec 为准。**一个诚实的范围提示**：本切片不小（7 个任务，含 renderer UI）；若一次上下文过长，可在 **T3 之后**合并一次（main 半边完整且被真 Server 测试钉住），把 T5–T7 当第二批做。
