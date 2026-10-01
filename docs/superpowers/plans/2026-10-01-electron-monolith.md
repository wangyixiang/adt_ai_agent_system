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

> **探针结果（2026-10-01）**：`electron=44.5.0 node=24.21.0 ledger=ok` —— `node:sqlite` 在 Electron 的 Node 里可用且免开关；台账 `markInFlight/markDone/get` 全过。**最低基线定死：Electron ≥ 44（Node ≥ 24）**。

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

## Review 修复轮

整体评审：`opencode-go/deepseek-v4.1-flash`，范围 `74c6300..9971b8d`。**0 Critical + 4 Important + 8 Minor**；Important 一轮修复（提交 `a98d299`），Minor 延后。修复后全绿（`test` / `typecheck` / `client-electron build` / 打包冒烟）。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **I1（重要）** 完成候选的 **`feedback` 被收集、校验后又被丢掉**：`host.completion` 只回 `"solved"|"not_solved"`，`session` 只发 `{workflow_id, resolution}`——但 `PROTOCOL_SPEC` §7.2 规定 `{resolution, feedback}`，`not_solved` 时 Server 用 `feedback` 触发重规划。后果：答"没解决 + 原因"却被无视，重规划看不到原因 | **已修** | `host.completion` 改为回 `CompletionDecision = {resolution, feedback?}`（**计划的签名是 `Promise<"solved"|"not_solved">`，这是一处计划偏离**）；`session` 把 `feedback` 一并发进 `workflow.completion_response`；`host.test.ts` 断言 feedback 被带出 |
| **I2（重要）** `SAFE_DEFAULTS` 是**摆设**（生产代码不用它），且计划要求的"不答 → 不产生同意"测试**缺失** | **已修** | `host.ts` 的四个映射**引用 `SAFE_DEFAULTS`**；新增 `host.test.ts`：`abandon()` 后 answer → `unknown_ask`、且挂起的 promise **不被 resolve**（无意外同意）；畸形回答保持打开；单次；完成反馈 |
| **I3（重要）** `onStepStatus` 钩子**能抛进 daemon 的发送路径**（窗口销毁 / 证据不可序列化），未捕获会在 main 里变成 unhandled rejection | **已修** | `daemon.ts` 的钩子调用包 `try/catch` + `console.warn`（在 `stepRunner` 的 send 路径里失败要"关得住"）；`session.int.test.ts` 新增用例：`emit` 对 `step.status` 抛错，Workflow **仍然跑完**（COMPLETED） |
| **I4（重要）** T6 说"有进行中的 Workflow **先确认**"，实现却**直接关**（无确认、无记录） | **已修** | `lifecycle.ts` 加 `hasRunningWorkflow()` + `confirmQuit()`：有活的 Workflow 先问，取消则不退；`main` 接 Electron `dialog`；`lifecycle.test.ts` 覆盖"无运行→不弹窗""取消→不退""确认→收尾退出" |
| **（基础设施）** 根 `test` 脚本 `pnpm -r --if-present test` **默认并发 4**，与 `WORKFLOW` §7"共享 `adt_test` 的包不能并行跑"冲突；新增的 client-electron 让 `client-cli` 的 e2e 在整包下超时 | **已修** | 根 `package.json` 的 `test` 改为 `pnpm -r --workspace-concurrency=1 --if-present test`；`WORKFLOW` §7 补一句；整包 `pnpm test` 复跑全绿 |
| **M1** 恢复（resume）时在跑的 step 渲染成光卡（投影没见过它） | **延后** | 与 `session.resume` 的可视化一起；首个 exe 不依赖 resume |
| **M2** `bridge.emit` 是死参数、`handle` 非穷尽 | **延后** | 无害；下个计划清 |
| **M3** `tsconfig.web.json` 仍带 `"types": ["node"]`（renderer 能引用 Node 类型） | **延后** | 收紧"renderer 不碰 Node"需要把测试用的 Node 类型挪走；下个计划 |
| **M4** 台账/会话句柄不关（重复登录会多开一份） | **延后** | 进程退出即释放；做登出/重登时一并收 |
| **M5** 拒绝/等待的 step 不显示原因（只读 `fail_reason`） | **延后** | 计划里工具卡只要求状态；原因是打磨 |
| **M6** `StepState`/`TerminalState` 在 shared 与 server 各有一份 | **延后** | 潜在漂移；让 server 复用 shared 是独立重构 |
| **M7** `resource_conflict` 无端到端用例（只有 daemon 级） | **延后** | 与确认同一条 `ask()` 路径；端到端需给 session 注入自定义 registry |
| **M8** README 没写 Electron 安装注意（二进制可能没下、需 `pnpm rebuild electron`） | **延后** | 记在这里；做文档轮时补 |

**评审"Declined to judge"各行**：**维持**——自动重连/登出/多窗口（不在本计划）、CSP/`setWindowOpenHandler`/sender 校验（计划没要求）、图标/签名/自动更新（明确延后）、mac/linux（本线只做 Windows portable）、Record/Report/导出/blob/工作台（下个计划）、退出时 Server 侧孤儿回收语义（`ADR-006` 开放项）、`signAndEditExecutable:false` 连带关签名（同上"延后"）。

**RED 证据（如实）**：I1（`host.test.ts` 完成反馈）、I2（`host.test.ts` abandon）、I4（`lifecycle.test.ts`）为**回归护栏**（先随修复写出）；I3 的 `session.int` emit-抛错用例同样是护栏——这四条的红是**评审的复现**。基础设施那条的"红"是整包 `pnpm test` 的真实失败（`client-cli` e2e 超时）。

---

## Self-Review

**1. Spec coverage：** ADR-006（单体 / main 内嵌 / IPC / 托盘 / 安全基线）→ T1–T7；设计 §6.2 的四决策 → T3/T4；`WORKFLOW_SPEC` §4.2/§4.3/§4.4/§6.1/§7.2 → T4；`CAPABILITY_SPEC` §6（schema 复用）→ T3；`PROTOCOL_SPEC` §7.2/§8.1/§8.3 → T4。**刻意不做（下一个计划）**：Record 历史/详情、Report、导出、blob 预览、工作台视图；多 Workflow / 旁观者；**签名 / 自动更新**（先要"能跑起来的 exe"）；浏览器/HTTP 那条线（在 `electron-wrapper`，不在本线）。

**2. Step scan：** 每步一个动作；实现步给签名与语义，测试步给断言。T1 的"探针"是一条**运行命令 + 期望输出**，不是单测。

**3. Type consistency：** `Ask`/`Answer`/`SAFE_DEFAULTS`/`validateAnswer`（T3）在 T4/T5 同名复用；`contract.ts` 的 `RendererRequest`/`MainEvent`/`AdtBridge`（T2）在 T4/T5 复用；`createProjection`/`createDecisionHost`/`createSession`（T4）在 T5 的 fake 中被消费。

**4. Review Focus：** 五条都落到测试——回答推进（T4 第 1/2 例）、畸形保持打开（T3 + T4 第 3 例）、安全默认（T3 + T4 第 5 例）、单次（T3 + T4 第 4 例）、关窗≠退出（T6）。

**5. Proportion：** 计划只给签名、断言与关键分支；界面长相与字段以 spec 为准。**一个诚实的范围提示**：本切片不小（7 个任务，含 renderer UI）；若一次上下文过长，可在 **T3 之后**合并一次（main 半边完整且被真 Server 测试钉住），把 T5–T7 当第二批做。
