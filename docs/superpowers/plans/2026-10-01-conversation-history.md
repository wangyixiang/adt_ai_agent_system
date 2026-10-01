# 会话历史（左栏会话列表 + 往期对话重建）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单体 Electron 应用里加一个**左栏会话列表**（当前正在跑的那条 + 往期 Record），点开往期可**回翻**——过程与结论用 Record 重建，与实时对话同形。

**Architecture:** 三段。**Server**：给 Record 增一个 `step_status` entry kind（**只记终态**），让往期重建**读**状态而不是**猜**；**daemon/客户端**：`client-electron` 的 main 经 daemon 转发两条 Record 查询（`record.list_request` / `record.get_request`），以 IPC 暴露给 renderer；**renderer**：新增两个**纯函数**（`transcriptFromRecord`、`conversations`）+ 两栏外壳（`ConversationList` + 复用现有 `Transcript`）。**不新增任何存储**。

**Tech Stack:** TypeScript（strict）· Fastify + Postgres（Server）· Electron + electron-vite（client-electron）· Vitest（Node/jsdom）· Playwright（Electron 桌面冒烟）

**Spec:** `docs/superpowers/specs/2026-10-01-conversation-history-design.md`（**权威**，执行前先读）。数据形状：`RECORD_SPEC.md` §3/§4/§5；查询协议：`PROTOCOL_SPEC.md` §10；报告副作用：`REPORT_SPEC.md` §5.2。

## Global Constraints

- **每条对话 = 一个 Workflow**（`design §7.1` 不改）；**"一次一条"只活在输入框的谓词里**，不写进组件、不假设全局只有一条。
- **往期用 Record 重建，不新增存储**；renderer **不 import `@adt/server`**；Record 形状在 `client-electron/src/shared` **镜像** `RECORD_SPEC` §3（**snake_case 原样**）。
- **owner 过滤在 Server 侧**；他人/不存在 → `unknown_record`，**原样透出**（UI 如实显示，不显示空白）；未登录 → `not_logged_in`。
- **`step_status` 只记终态**（`COMPLETED`/`FAILED`/`REJECTED`/`UNKNOWN`）；中间态与进度保活**不落 entry**（否则 Record 膨胀、Report 变吵）。
- **规范文档同步**：`RECORD_SPEC.md` → **v0.9**；`docs/REQUIREMENTS.md` §7 的 `RECORD_SPEC` 行同步。
- **不碰 `PROTOCOL_SPEC`**（协议面不变）、不碰 `ADR-006` 的决定。
- **不 push**；编辑文件用 `edit` 工具（LF）。
- **验证口径**：`pnpm test`（根脚本已 `--workspace-concurrency=1` 串行）+ `pnpm -r typecheck` + `pnpm -C packages/client-electron build` + 桌面冒烟 `pnpm -C packages/client-electron test:e2e`。

## Review Focus

以下失败模式规格隐含、但默认测试不会覆盖，**每条都必须在对应任务里有测试**：

1. **重建不确定 / 条目错位**：同一份 Record 每次渲染一致；顺序按 `entries` 条目顺序（不是 `ts`）；**两个 `unknown` 不混**（`user_input` 的"人说自己不确定" vs `step_status` 的"系统判定结果不确定"）。见 Task 3。
2. **会话在列表里去重 / 不消失**：同一会话同时存在于 live 与 history 时**只出现一次（live 优先）**；一条**刚终止、Record 还没拉回**时不从列表消失；重启后投影为空 → 只剩 history。见 Task 3 / Task 4。
3. **越权 / 不存在被伪装**：`record(id)` 请求他人或不存在的 → 透出 `unknown_record`；未登录 → `not_logged_in`；都不 500、不空白。见 Task 2。
4. **`step_status` 记多了**：进度保活 / `RUNNING` / `WAITING` **不得**落 entry（否则 Record 膨胀、Report 多出噪音行、重建重复）。见 Task 1。
5. **推导在每次渲染重算**：往期推导必须**按 `recordId` 记忆化**（Record 不可变，缓存永不失效）；不得每次重渲染都 O(entries) 重算。见 Task 4。

---

### Task 1: Server —— Record 增 `step_status` entry（只记终态）

**Files:**
- Modify: `packages/server/src/record/types.ts`、`packages/server/src/record/builder.ts`
- Modify: `docs/specs/RECORD_SPEC.md`（页首 `Version` → v0.9；§4 增 `step_status` 行）
- Modify: `docs/REQUIREMENTS.md`（§7 `RECORD_SPEC` 行 → v0.9）
- Test: `packages/server/test/record/`（既有 builder 测试文件；按其现有命名/风格扩展）

**Interfaces:**
- `RecordEntryKind` 增加 `"step_status"`；其 `ref` 为 `{ step_id: string; state: string }`。
- `builder.toEntry` 由"返回 `RecordEntry | null`"改为"返回 `RecordEntry[]`"；`buildRecord` 用 `flatMap` 收集（**入口不变**：仍是 `buildRecord(input)` → `RecordDocument`）。
- `case "step_status"`：**先**产出既有派生 entry（`reconciliation_resolved` / `step_outcome_unknown` / `user_confirmation` / `step_rejected` / `user_input` / `evidence_received`，可空），**再**在 `payload.state` ∈ {`COMPLETED`,`FAILED`,`REJECTED`,`UNKNOWN`} 时追加 `{ kind:"step_status", ref:{step_id, state} }`；两者都非空则顺序为**派生在前、`step_status` 在后**；非终态返回空数组。
- `renderNarrative` 增 `case "step_status"`（例：`步骤 ${ref.step_id} → ${ref.state}。`）。

- [ ] **Step 1: 写失败测试**

在既有 record builder 测试里加：
```ts
// 1) 一个 COMPLETED（带证据）的步：entries 里既有 evidence_received，也有 step_status { state:"COMPLETED" }
// 2) 一个只有 RUNNING/进度保活、未终态的步：**不**产生 step_status entry
// 3) step_status entry 的 ref 形状为 { step_id, state }，且 narrative 非空
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C packages/server exec vitest run test/record/`
Expected: FAIL（`step_status` 种类/entry 不存在）

- [ ] **Step 3: 实现**

`types.ts` 加 kind；`builder.ts` 把 `toEntry` 改为返回数组、`buildRecord` 改 `flatMap`、`case "step_status"` 按 Interfaces 追加终态 entry、`renderNarrative` 加 case。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm -C packages/server exec vitest run test/record/ && pnpm -C packages/server typecheck`
Expected: PASS

- [ ] **Step 5: 规格同步 + 提交**

`RECORD_SPEC.md` → v0.9（§4 增行、说明"只记终态、中间态不记"）；`REQUIREMENTS.md` §7 同步。

```bash
git add packages/server/src/record packages/server/test/record docs/specs/RECORD_SPEC.md docs/REQUIREMENTS.md
git commit -m "feat(record): a step_status entry for terminal step states"
```

---

### Task 2: `client-electron` —— Record 查询的契约 + IPC + session

**Files:**
- Modify: `packages/client-electron/src/shared/contract.ts`
- Modify: `packages/client-electron/src/main/core/session.ts`、`src/main/core/bridge.ts`、`src/main/index.ts`、`src/preload/index.ts`
- Test: `packages/client-electron/src/main/core/session.int.test.ts`（扩展）

**Interfaces:**
- `contract.ts` 新增类型（snake_case 原样，镜像 `RECORD_SPEC` §3/§5）：
  - `UiRecordSummary = { problem_short: string; terminal_state: string; result_short: string; duration_ms: number }`
  - `UiRecordListEntry = { recordId: string; workflowId: string; summary: UiRecordSummary }`
  - `UiRecordList = { records: UiRecordListEntry[]; nextCursor: string | null }`
  - `UiRecord`：`record_id, workflow_id, created_at, ended_at, terminal_state, terminal_reason, user_request: { text: string } & Record<string, unknown>, summary: UiRecordSummary, entries: UiRecordEntry[], final_result: Record<string, unknown>`；`UiRecordEntry = { entry_id: string; ts: number; kind: string; ref: Record<string, unknown>; narrative: string }`
- `contract.ts` 扩展 `RendererRequest`：`| { kind: "records"; cursor?: string | null; pageSize?: number } | { kind: "record"; id: string }`；扩展 `AdtBridge`：`records(cursor?: string | null, pageSize?: number): Promise<UiRecordList>`、`record(id: string): Promise<UiRecord>`。
- `session.ts`：`records(cursor?, pageSize?): Promise<UiRecordList>`（`record.list_request`，`page_size` 默认 **100**）与 `record(id): Promise<UiRecord>`（`record.get_request`）；把 Server 的 `record.list_response`（`records[].record_id/workflow_id/summary`、`next_cursor`）映射为 `UiRecordList`；`record.get_response.record` 原样作为 `UiRecord`。
- `bridge.ts` 的 `handle` 两个新分支；`preload` 两个方法；`main/index.ts` 把 bridge deps 接到 `session.records/record`。

- [ ] **Step 1: 写失败测试**

```ts
// session.int.test.ts（真 Server + 真 daemon）：跑完一条（resetStep + done，答完成候选）后
// 1) records()：含 1 条；entryWorkflowId 匹配；summary.terminal_state === "COMPLETED"
// 2) record(id)：terminal_state === "COMPLETED"；entries 非空；**含一条 step_status**（Task 1 的产物）
// 3) record("rec_nope")：抛错，消息含 unknown_record
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C packages/client-electron exec vitest run src/main/core/session.int.test.ts`
Expected: FAIL（`records`/`record` 不存在）

- [ ] **Step 3: 实现**（按 Interfaces）
- [ ] **Step 4: 运行确认通过**

Run: `pnpm -C packages/client-electron exec vitest run src/ && pnpm -C packages/client-electron typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src
git commit -m "feat(electron): record queries over IPC (list + detail)"
```

---

### Task 3: `client-electron` —— 纯函数 `transcriptFromRecord` + `conversations`

**Files:**
- Create: `packages/client-electron/src/renderer/src/recordTranscript.ts`、`conversations.ts`
- Test: `packages/client-electron/src/renderer/src/recordTranscript.test.ts`、`conversations.test.ts`

**Interfaces:**
- `transcriptFromRecord(record: UiRecord): TranscriptItem[]`——按 Spec §4 的表映射（`user_request`→user；`step_dispatched`→assistant+tool；`step_status`→tool.state；`evidence_received`→tool.evidenceSummary；`step_rejected`/`step_outcome_unknown`/`reconciliation_resolved`→tool.state；`user_confirmation`/`user_input`→**已回答**的 ask；`completion_candidate`/`completion_response`→完成候选 ask（未答/已答）；`cancellation_requested`/`guardrail_triggered`→notice；`final_result`+`terminal_state`+`record_id`→summary）。顺序：user 最前、其后按 `entries` 顺序、summary 最后。
- `UiConversation = { workflowId: string; recordId: string | null; title: string; state: "running" | "COMPLETED" | "FAILED" | "CANCELLED"; live: boolean }`
- `conversations(snapshot: UiSnapshot, events: UiEvent[], records: UiRecordListEntry[]): UiConversation[]`——`live` = 投影里出现过的 Workflow（**含已终止的**），`history` = 列表项；**按 `workflowId` 去重、live 优先**；排序：未终止在前，其余按 `records` 顺序。
- `twoUnknown` 文案复用 `transcript.ts` 里已有的 `MANUAL_OUTCOME_TEXT` / `STEP_STATE_TEXT`（导出或在 `recordTranscript.ts` 复用同表）。

- [ ] **Step 1: 写失败测试**

```ts
// recordTranscript.test.ts
// - 造一条含 step_dispatched/step_status(COMPLETED)/evidence_received/... 的 UiRecord → 断言 kinds 顺序与字段
// - user_input outcome "unknown" → ask.text 含"人"；step_status UNKNOWN → tool.text 含"系统"；两者不同
// conversations.test.ts
// - live 与 history 同 workflowId → 只出一条且 live:true
// - 一条刚终止（snapshot 里有、records 也有）→ 仍在列表
// - 只有 history（投影为空）→ 全 live:false
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C packages/client-electron exec vitest run src/renderer/src/recordTranscript.test.ts src/renderer/src/conversations.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（两个纯函数）
- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 + `pnpm -C packages/client-electron typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/recordTranscript.ts packages/client-electron/src/renderer/src/conversations.ts packages/client-electron/src/renderer/src/recordTranscript.test.ts packages/client-electron/src/renderer/src/conversations.test.ts
git commit -m "feat(electron): reconstruct a conversation from a Record"
```

---

### Task 4: `client-electron` —— 两栏外壳 + `ConversationList`

**Files:**
- Create: `src/renderer/src/components/ConversationList.tsx`
- Modify: `src/renderer/src/app.tsx`（变两栏；选中的会话决定右栏）
- Test: `src/renderer/src/app.test.tsx`（扩展）

**Interfaces:**
- `App` 状态：`snapshot`、`events`、`records: UiRecordListEntry[]`、`selectedWorkflowId: string | null`。
  - 登录后拉一次 `client.records()`；每次收到 `workflow.terminated` 后再拉一次。
  - `conversations(...)` 建列表；默认选中：**有进行中选进行中，否则选第一条**。
  - 选中的 **live**：`deriveTranscript(snapshot, events)` 里该 workflow 的条目（可先整体推导再看 `workflowId` 过滤）；选中的 **history**：`client.record(recordId)` → **按 `recordId` 记忆化** → `transcriptFromRecord`。
- `ConversationList`：每行 `{ title, 状态徽章, 耗时 }`；`onSelect(workflowId)`；空态与错误态（`role="alert"`）。
- 右栏：`ProgressHeader + Transcript`；`Composer` 仅在 **live 且没有进行中的会话** 时可用（"一次一条"谓词）；history 不显示 Composer，顶部标"往期记录"。

- [ ] **Step 1: 写失败测试**

```tsx
// app.test.tsx（jsdom；扩展假 client，加 records/record）
// 1) 注入 1 条 history（records() 返回）+ 空投影 → 列表出现该条；点开 → 显示 Record 重建（含该 step 与 Record:）
// 2) 注入 live（进行中）+ 同 workflowId 的 history → 列表只一条、徽章"进行中"、输入框禁用
// 3) records() reject → role=alert 错误可见（列表不空白）
// 4) 空：无 live 无 history → "还没有对话"
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C packages/client-electron exec vitest run src/renderer/src/app.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**（组件只画；判断在纯函数里；记忆化在 `App` 内）
- [ ] **Step 4: 运行确认通过**

Run: `pnpm -C packages/client-electron exec vitest run src/ && pnpm -C packages/client-electron typecheck && pnpm -C packages/client-electron build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer
git commit -m "feat(electron): a conversation list, and the past reconstructed from Records"
```

---

### Task 5: 桌面冒烟扩展 + README

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`、`README.md`

**Interfaces:**
- 复用现有桌面冒烟（真 Electron + 真 Server + 真 daemon）。追加：跑完一条 → 在左栏看到那条 → 点开 → 断言重建里有该 step 与 `Record: rec_…`。

- [ ] **Step 1: 扩展用例**（在既有 spec 里追加步骤/断言）
- [ ] **Step 2: 跑**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron test:e2e`
Expected: PASS（1 条用例覆盖：登录→跑完→列表→打开往期→重建）

- [ ] **Step 3: 文档 + 提交**

README 的 `client-electron` 一节补一句"左栏会话历史：往期用 Record 重建、不新增存储"。

```bash
git add packages/client-electron/smoke/electron.spec.ts README.md
git commit -m "test+docs(electron): the history path in the desktop smoke"
```

---

## Review 修复轮

整体评审：`opencode-go/deepseek-v4.1-flash`，范围 `1473cb7..a9a06fa`。**1 Critical + 3 Important + 6 Minor**；Critical/Important 一轮修复（提交 `340aa61`），Minor 延后。修复后全绿（`test` / `typecheck` / `client-electron build` / 桌面冒烟 2 例）。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **C1（阻塞）** 一条 `step_status` 事件产出两条 entry，**共用同一个 `entry_id`**（= `event.id`）→ Record 里永久重复 id，破坏可追溯性 | **已修** | `builder.ts` 给追加的 `step_status` entry 用**独立 id**（`` `${event.id}:step_status` ``）；builder 测试加"entry_id 唯一"断言 |
| **I1（重要）** 在别的会话下**发起新对话，主视图不跟随新会话**（`handleSubmit` 不更新选中） | **已修** | `app.tsx` 的 `handleSubmit` `.then((workflowId) => setSelected(workflowId))`；新增组件测"往期在视图中发起新对话 → 跟随新会话" |
| **I2（重要）** 左栏**缺"耗时"列**（design §6 要求标题 + 状态 + 耗时） | **已修** | `UiConversation` 加 `durationMs`；`conversations` 从 Record 的 `summary.duration_ms` 填；`ConversationList` 渲染；测试同步 |
| **I3（重要）** Review Focus #3/#5 要求的测试**缺失**：`not_logged_in` 与"记忆化不重取" | **已修** | `session.int.test` 加"未登录时 record 查询 → `not_logged_in`"；`app.test` 加"重渲染不重取同一 Record"（`fetched` 不变） |
| **M（重定级为目标相关）** 重建的总结**不显示结论**（`final_result` 的 `resolution_summary`/`failure_summary`），而目标是"看懂结论是什么" | **已修** | `recordTranscript` 的 summary 文本带上 `final_result` 的结论；测试断言含结论文本 |
| **M** `records()`/`record()` 失败后**不清理错误条**（成功拉取不清 `error`） | **延后** | 只是残留一条提示；等 UI 打磨轮 |
| **M** live 视图**把各 workflow 的 notice 都带上**（notice 无 workflowId） | **延后** | 当前单会话下不可见；多并行（B）时一并处理 |
| **M** 已终止的 live 会话**排在 history 之前**（未严格按 Server 顺序） | **延后** | 会话内影响很小；排序规则在多并行时再定 |
| **M** 冒烟**用例 2 依赖用例 1 先造出 Record**（单独跑用例 2 会失败） | **延后** | 同一 `beforeAll` Server 下顺序执行；把依赖写明即可 |
| **M** 错误文案**带着 Electron IPC 包装**（`Error invoking remote method …`） | **延后** | 诚实但啰嗦；显示层做一次剥离即可 |

**评审"Declined to judge"各行**：**维持**——Report `full` 不显示 `ts`（既有、不在本 diff）；history 拉取瞬间的"还没有内容"闪烁；多并行/取消/旁观者（明确不做）；分页 UI（明确延后）；`UiRecord` 只取 UI 需要的子集（renderer 不 import Server 类型）；`step_status` 的 narrative 措辞（计划写"例："）；"请求他人 Record"未测（owner 过滤在 Server，计划只要求"不存在"那条）；`session.record` 不做运行时校验（受信内部 IPC）；`user_confirmation`/`user_input` 重建缺卡片原文（design §11 已接受的边界）。

**RED 证据（如实）**：C1 的"先失败"是**评审的复现**（可重跑）；I1/I2/I3 与 M（结论）的测试随修复写出，为**回归护栏**。

---

## Self-Review

**1. Spec coverage：** Spec §3（IPC/类型）→ T2；§4（`transcriptFromRecord`）→ T3；§5（`step_status`）→ T1；§6（布局/组件）→ T4；§7（确定性/记忆化/保真度）→ T3（纯函数）+ T4（memo）；§8（多并行留形）→ T4（谓词）；§9（测试）→ 各任务 + T5；§10（不做）→ 全局约束与 T5 的范围。**刻意不做**：Report/导出/blob、工作台、多并行、取消、旁观者、逐字还原、跨会话检索、分页 UI。

**2. Step scan：** 每步一个动作；实现步给签名与映射表（Spec §4 是权威），测试步给断言。

**3. Type consistency：** `UiRecordListEntry` / `UiRecord` / `UiRecordList`（T2）在 T3/T4 复用；`UiConversation`（T3）在 T4 复用；`transcriptFromRecord` / `conversations`（T3）在 T4 消费；T3/T4 复用 `transcript.ts` 既有的 `TranscriptItem` 与两个 `unknown` 文案表。

**4. Review Focus：** 五条都落到测试——确定性/条目顺序/两个 unknown（T3）、去重与不消失（T3/T4）、`unknown_record`/`not_logged_in`（T2）、`step_status` 只记终态（T1）、按 `recordId` 记忆化（T4）。

**5. Proportion：** 计划只给端点、签名、映射表与断言；字段与报告副作用以 Spec 与 `RECORD_SPEC`/`REPORT_SPEC` 为准。**依赖顺序**：T1 → T2 → T3 → T4 → T5（T3 依赖 T2 的类型；T4 依赖 T1 的 `step_status`、T2、T3）。
