# 会话历史（左栏会话列表 + 往期对话重建）设计

- **日期:** 2026-10-01
- **状态:** 待评审（批准后据此写实施计划）
- **层级:** Design — 单体 Electron 客户端（`packages/client-electron`）的产品形态扩展
- **关联:** `ADR-006`（Client 形态：单体 Electron）、`ADR-004`、`RECORD_SPEC.md` §3/§4/§5、`REPORT_SPEC.md`、`PROTOCOL_SPEC.md` §10（Record 查询）/§7.2（完成确认）、`WORKFLOW_SPEC.md` §6.1、`docs/superpowers/plans/2026-10-01-electron-monolith.md`（已交付的第一个 exe）

---

## 1. 目标与判断标准

在已交付的单体 Electron 应用上，加一个**像聊天应用那样的会话历史**：左栏列出"对话"，点开可**回翻往期工作记录**；当前正在跑的那条也在列表里。

判断标准：**打开应用，能看到自己过去跑过的每一条诊断（不限于本次启动），点开任意一条，能看懂"当时发生了什么、结论是什么"**；且当前正在跑的那条始终在列表里、可以随时切回去看。

不追求"逐字还原当时界面"——往期是**基于 Record 的重建**（见 §4、§7）。

## 2. 已锁定的决定（本轮讨论得出）

1. **每条对话 = 一个 Workflow**（保持 `design §7.1` 的模型，不反转）。
2. **往期用 Record 重建，不新增存储**（不持久化 live 转录/事件流）。
3. **先做"一次一条 + 列表切换"**：输入框在运行中仍禁用；将来可扩成多条并行（见 §8）。
4. **本切片范围**：会话列表（live + 往期）+ 往期对话重建。Report 生成/渲染、导出到 KB、blob 预览、工作台视图**不在本切片**。
5. **保真度**：给 Record 新增 `step_status` entry kind，**只记终态**（`COMPLETED`/`FAILED`/`REJECTED`/`UNKNOWN`），使重建的步骤状态是**读出来的**而非推断的（见 §5）。

## 3. 数据与 IPC

### 3.1 新增两条 IPC 命令（`packages/client-electron`）

| 请求 | 响应 |
|---|---|
| `{ kind: "records"; cursor?: string \| null; pageSize?: number }` | `UiRecordList` |
| `{ kind: "record"; id: string }` | `UiRecord` |

- main 侧 `session.records(...)` / `session.record(id)` 转 daemon 的
  `connection.request("record.list_request", { filters: {}, cursor, page_size }, "record.list_response")` 与
  `connection.request("record.get_request", { record_id }, "record.get_response")`。
- **owner 过滤在 Server 侧**；他人/不存在的 `record_id` → `unknown_record`，**原样透出**为 IPC 错误（UI 如实显示，不显示空白）。
- 未登录 → `not_logged_in`（沿用既有）。

### 3.2 契约类型（`packages/client-electron/src/shared/contract.ts`）

- `UiRecordSummary`：镜像 `RECORD_SPEC` §5 —— `{ problem_short, terminal_state, result_short, duration_ms }`。
- `UiRecordListEntry`：`{ recordId, workflowId, summary: UiRecordSummary }`。
- `UiRecordList`：`{ records: UiRecordListEntry[]; nextCursor: string | null }`。
- `UiRecord`：镜像 `RECORD_SPEC` §3 的成品文档（`record_id, workflow_id, created_at, ended_at, terminal_state, terminal_reason, user_request{text,...}, summary, entries[], final_result, …`，**snake_case 原样**）。
- 说明：这些是**浏览器安全的形状**，在 `client-electron` 内镜像 `@adt/server` 的 `RecordDocument`（**renderer 不 import `@adt/server`**；不动 server 的既有类型）。

### 3.3 合并、去重、排序（renderer 内纯函数）

`conversations(snapshot, events, records)` → `UiConversation[]`：
- `live`：**本次启动的投影里出现过的** Workflow（`snapshot.workflows`，**不论是否已终止**）——这样一条刚跑完、Record 还没拉回来时，它不会从列表里"消失"；
- `history`：`records()` 的列表项；
- **按 `workflowId` 去重，`live` 优先**（同一会话在本次启动里投影仍持有它时，用它的**真转录**；重启后投影为空，就只剩 history）；
- 排序：**未终止的在前**，其余按 Server 给到的顺序（`ended_at` 倒序）；
- `UiConversation = { workflowId, recordId: string | null, title, state, live }`（`title` 取 live 的 `userRequest.text` 或 history 的 `summary.problem_short`；`state` = live 的 `terminalState ?? "running"`，history 的 `terminal_state`；即 `running` | `COMPLETED` | `FAILED` | `CANCELLED`）。

**刷新时机**：登录后拉一次；每次收到 `workflow.terminated` 后再拉一次（新 Record 出现在列表）。

## 4. `transcriptFromRecord`（纯函数，复用现有 `Transcript` 组件）

把 `UiRecord` 映射成与实时转录**同形**的 `TranscriptItem[]`（见 `client-electron/src/renderer/src/transcript.ts`）：

| Record 内容 | 转录条目 |
|---|---|
| `user_request.text` | `user` 气泡 |
| `step_dispatched`（`ref.step_id/capability/objective/input`） | `assistant`（objective）+ `tool`（capability/objective/input，状态 `PENDING`） |
| `step_status`（`ref.step_id/state`）**新增** | 更新该 `tool` 的 `state`（终态） |
| `evidence_received`（`ref.step_id/evidence/fail_reason?`） | 更新 `tool` 的证据摘要（用与 daemon 相同的 `summarize` 规则） |
| `step_rejected`（`ref.step_id/capability/reject_reason`） | `tool` → `REJECTED` |
| `step_outcome_unknown`（`ref.step_id/capability`） | `tool` → `UNKNOWN`（另可加一条 warn `notice`） |
| `reconciliation_resolved`（`ref.step_id/resolved_to`） | `tool` → `resolved_to` |
| `user_confirmation`（`ref.step_id/decision`） | **已回答**的确认 `ask`（`text`：已确认 / 已拒绝） |
| `user_input`（`ref.step_id/content`） | **已回答**的手工动作 `ask`（`text` 用 `MANUAL_OUTCOME_TEXT`，`unknown` 仍是"人说自己不确定"） |
| `completion_candidate`（`ref.summary/evidence_refs`） | 完成候选 `ask`（未答） |
| `completion_response`（`ref.resolution/feedback`） | 该完成候选 `ask` **已回答** |
| `cancellation_requested` / `guardrail_triggered` | `notice`（后者 `warn`） |
| `final_result` + `terminal_state` + `record_id` | `summary`（含 `Record: rec_…`） |

- **顺序**：`user` 在最前，其后按 `entries` 的**条目顺序**，`summary` 在最后（不按 `ts` 排，见 `RECORD_SPEC` §6.1）。
- **两个 `unknown` 不混**：`user_input` 的 `outcome:"unknown"` → "人说自己不确定"；`step_status` 的 `UNKNOWN` → "系统判定结果不确定"。

## 5. Record 的增强：`step_status` entry（Server 侧，前置）

- **`RECORD_SPEC.md` §4**：新增 entry kind **`step_status`**，`ref = { step_id, state }`；**只记终态**（`COMPLETED`/`FAILED`/`REJECTED`/`UNKNOWN`）；升 **v0.9**，同步 `REQUIREMENTS.md` §7。
- **`packages/server/src/record/builder.ts`**：`case "step_status"` 在状态为终态时落一条 entry（`narrative` 加对应模板）；非终态（`PENDING`/`RUNNING`/`WAITING`、进度保活）**不落 entry**。engine 早已把这些记成事件（`engine.ts` 的 `this.event(…, "step_status", …)`），无需改 engine。
- **副作用（已接受）**：`REPORT_SPEC` §5.2 的 `full` 档按序列出所有 entries → 报告会多出"步骤状态"行。
- **为什么需要它**：Record 原本没有 `step_status` 条目，重建只能从 `evidence_received`/`step_rejected`/… 推断步骤状态；补上终态后，重建**读**状态而不是**猜**状态。

## 6. 布局与组件

- 外壳变**两栏**：左 `ConversationList`，右沿用 `ProgressHeader + Transcript`，底部 `Composer`**常驻**（它只负责开一条新对话，与当前选中的会话无关；有进行中的会话时禁用）。
- `ConversationList`：每行 = 标题（问题一句话）+ 状态徽章（`进行中` / `COMPLETED` / `FAILED` / `CANCELLED`）+ 耗时；**选中高亮**。
- 选中 **live**：现有行为（该 Workflow 的转录 + 进度头 + 输入框按"是否有进行中"禁用）。
- 选中 **history**：渲染重建结果，顶部标"往期记录"。（`Composer` 仍常驻——它只开新对话，不属于选中的那条。）
- 空态："还没有对话，提交一次请求开始。"；`records()` 失败 → `role="alert"` 错误条（不是空列表）。

## 7. 确定性与性能（明确定义）

- **确定性**：`transcriptFromRecord` 是纯函数；输入是**冻结的** Record（`RECORD_SPEC` §0），推导里没有时钟/随机/LLM/网络；顺序按条目顺序；Server 列表排序稳定（`ended_at DESC, record_id DESC`）。**同一 Record 永远渲染出同一结果。**
- **性能**：Client 侧推导是 **O(entries)** 的一次遍历（一次诊断几十~几百条），**可忽略**；真正的延迟是 **Server 往返**（列表一次查询、详情一次查询，本机 ms 级）。live 侧无 Server 往返（投影在内存）。
- **记忆化**：因为 Record **不可变**，按 `recordId` 记忆化**永不失效**（每条只推一次，切换/重渲染直接取）。**不做增量推导**（Record 小而不可变，全量一次 + memo 更简单）。

### 7.1 保真度边界（明说）

- 往期是**重建**，不是"当时的可交互界面"：不会复现当时的卡片控件本身，人的决定以 `entries` 呈现。
- 只记**终态**：看不到 `RUNNING`/`WAITING` 的中间过程。
- **终止时仍 `WAITING` 的步**（取消/护栏）没有终态 entry → 该 `tool` 停在 `PENDING`。
- 首切片**只拉一页**（`page_size` ≤ 100）；更早的记录暂不可达（分页 UI 归后续）。

## 8. 与"多条并行"的关系（为将来留形）

- 会话索引**按 `workflow_id` 建 map**（`design §7.1` 本来就要求）；每条 entry 要么 `live` 要么 `history`。
- **"一次一条"只活在输入框的一个谓词里**（"有进行中的 → 新对话输入禁用"），**不写进组件、不假设全局只有一条**。
- 将来做多条并行（原 UI-4 体量）时：放这个谓词 + 允许列表出现多条 `live` + 每条线程各自渲染即可，**不动数据模型与 IPC 形状**。

## 9. 测试策略

- **Server（Record 增强）**：builder 单测——COMPLETED 的步产生 `step_status` entry；进度保活**不**产生 entry；`renderNarrative("step_status", …)` 有输出。
- **client-electron 纯逻辑**：`transcriptFromRecord`（各类条目映射、顺序、两个 `unknown`、summary）；`conversations` 的合并/去重/排序（live 优先）。
- **组件测（jsdom）**：列表渲染 live+history；点开 history 显示重建；空态与错误态。
- **集成测（真 Server + 真 daemon）**：`records()` / `record(id)` 返回；`unknown_record` 透出。
- **桌面冒烟扩展（Playwright Electron）**：跑完一条 → 打开历史 → 看到那条 → 打开它 → 断言重建里有该 step 与 `Record:` 总结。
- **验证口径**：`pnpm test`（串行）+ `pnpm -r typecheck` + `pnpm -C packages/client-electron build` + 桌面冒烟。

## 10. 明确不做（本切片）

- Report 生成与渲染、导出到 KB、blob 预览/下载（各自后续切片）。
- 工作台视图（步骤/证据时间线面板）。
- 多条 Workflow 并行、取消、只读旁观者。
- 逐字还原当时的界面（不做转录/事件持久化）。
- 跨会话检索、分页 UI（首切片只第一页）。

## 11. 依赖与风险

- **前置依赖**：`step_status` entry 是 Server/规格改动（`RECORD_SPEC` v0.9）——它是本切片重建保真度的前提，**须先于 UI 落地**（可同计划内先做，或独立小计划先行）。
- **风险**：Report `full` 输出因新增 entry 而变长（已接受）；`user_confirmation`/`user_input` 的 `ref` 仍不含"卡片原文"（objective/instruction）——往期里人工决策显示为**决定 + narrative**，不是当时的卡片（若将来想更贴近，可定向补 `ref` 字段，属后续）。
- **不碰**：`PROTOCOL_SPEC`（协议面不变）、`ADR-006` 的决定。
