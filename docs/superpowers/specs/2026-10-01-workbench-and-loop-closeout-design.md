# 工作台与闭环末端（Report / 导出 / 取消 / 附件 + blob）设计

- **日期:** 2026-10-01
- **状态:** 待评审（批准后据此写实施计划）
- **层级:** Design — 单体 Electron 客户端（`packages/client-electron`）的产品形态扩展
- **关联:** `ADR-006`（Client 形态：单体 Electron）、`ADR-002`（One-Step Planning）、`ADR-005`（KB 导出契约）、`PROTOCOL_SPEC.md` §7.3（取消）/§7.5（blob 通道）/§10.3（导出）/§11（Report）、`REPORT_SPEC.md` §3/§4/§6、`RECORD_SPEC.md` §3/§4、`CAPABILITY_SPEC.md` §6（`human.manual_action`）、`docs/architecture/CLIENT_SPEC.md` §1/§3、`docs/superpowers/specs/2026-09-29-mvp-scope.md` §2/§5.1/§6、`docs/superpowers/plans/2026-10-01-electron-monolith.md`、`docs/superpowers/specs/2026-10-01-conversation-history-design.md`

---

## 1. 目标与判断标准

在已交付的单体 Electron 应用上，补齐**诊断闭环的末端**与**日常可用性**，使 `mvp-scope §5.1` 的主路径能在桌面端**从头演示到尾**。

判断标准：**打开应用，跑完一条诊断 → 在工作台看清每一步与证据 → 生成 Report 并另存/复制 → 把 Report 或 Record 导出到知识库 → 打开往期能看到当时的附件与证据 blob**；进行中的会话能**取消**，并看到 `CANCELLING` 收敛。

## 2. 已锁定的决定（本轮讨论得出）

1. **工作台 = 右栏（三栏）**：左会话列表 / 中对话流 / 右工作台；工作台随选中会话切换，**live 与往期同形**。
2. **Report = 覆盖式查看器**：渲染 Server 返回的 markdown，可**复制**与**另存为 .md**；**不在应用内持久化、不本地拼凑**。
3. **取消 = 二次确认 + `CANCELLING` 态，不填原因**（`workflow.cancel_request` 不带 `reason`，`terminal_reason` 保持 `null`）。
4. **附件 = 文件 + 粘贴文本**；**≤ 64 KiB 内联、> 64 KiB 走 blob**；**下载/预览/往期渲染一并做**。
5. **FR-3 的"原因假设"不新增实体**：工作台只呈现"步骤目标 + 支撑证据 + 完成候选"，不造"假设卡"。
6. **附件限额**：单会话单轮**数量上限 10**、**每轮总大小上限 32 MiB**（单文件走 blob 的上限沿用服务端 `BLOB_MAX_BYTES`，默认 512 MiB）。
7. **`submit` 直接扩展 `attachments`**：不引入"附件暂存"，提交时一并带上。

## 3. 范围与两处范围修订

覆盖 S0–S5 六个切片：**S0 工作台**、**S1 Report**、**S2 KB 导出**、**S3 取消**、**S4 手工动作 `details`**、**S5 附件 + blob**。

- **修订 A（范围扩大，需同步 `mvp-scope`）**：**blob 通道进 MVP**。`mvp-scope §6` 原本明确"大体积附件走 blob 通道的完整实现"不在 MVP。纳入理由：不做 blob，"附件"对大于 64 KiB 的文件就断了，且 Record 引用过的证据 blob 无法回看。**这是对 MVP 范围的修订，`mvp-scope §6` 要同步改。**
- **修订 B**：附件阈值定为 **64 KiB**（回到 `PROTOCOL_SPEC` §7.5 的建议默认值 64 KiB，不再用早前讨论的 512 KB）。

## 4. 布局与工作台（S0）

外壳变**三栏**：左 `ConversationList`，中 `Thread`（沿用 `ProgressHeader + Transcript + Composer`），右 `Workbench`。工作台随选中的会话切换，**live 与往期用同一套组件的同一形状**。

工作台分三段：

- **头部**：状态徽章（`进行中` / `CANCELLING` / `COMPLETED` / `FAILED` / `CANCELLED`）+ 动作区（**生成报告** / **导出到知识库** / **取消**），按状态可用或禁用（见 §5–§7 的可用条件）。
- **步骤/证据时间线**：每步一行——`capability`、状态、`objective`、证据摘要；证据是 blob 时给**预览 / 另存**入口（见 §9）；人工决定（确认/拒绝/手工/资源冲突）作为行内小标。
- **结论区**：终止后显示 `terminal_state` / `terminal_reason` / `recordId`；有完成候选时显示其 `summary` 与 `evidenceRefs`。
- **空态**：未选中或列表为空时的提示。

**往期**：工作台数据来自 Record 的同源映射——从 `entries` 取 steps/evidence/attachments（复用 `conversation-history-design` 的 `transcriptFromRecord` 思路，但产出工作台所需的**结构化**视图，不是聊天转录）。

**诚实边界（明说）**：FR-3 的"原因假设"在系统里**没有独立实体**（`ADR-002` One-Step Planning）。系统的"判断方向"只体现在 Step 的 `objective` 与完成候选的 `summary` 上。工作台**不新增"假设"对象**；若要真正的"假设卡"，那是新功能（要改协议/规划器），不在本切片。

## 5. Report（S1）

- **入口**：工作台"生成报告"，**仅当该会话已有 `recordId`**（已终止）时可用。
- **`detail_level`**：默认 `full`，提供 `summary` / `full` 切换（`REPORT_SPEC` §3 两档都已定义）。
- **协议**：`report.generate_request { record_id, options: { detail_level } }` → `report.generate_result { record_id, status, report: { format: "markdown", content }, error_code, message }`（`PROTOCOL_SPEC` §11）。
- **呈现**：**覆盖式查看器**（主区弹出，不占死布局）渲染 markdown；按钮 **复制**、**另存为 .md**。
- **诚实**：每次点击都重新向 Server 请求（`REPORT_SPEC` §6：Server 不持久化/缓存）；**不本地拼凑**（`CLIENT_SPEC` §3 第 12 条）。
- **失败**：`status: "failed"`（`generation_failed` / `insufficient_content` / `invalid_option` / `timeout`）或 `protocol.error`（`unknown_record`）→ 在查看器内显示错误，**不显示半成品**。

## 6. KB 导出（S2）

- **入口**：工作台"导出到知识库"，有 `recordId` 时可用。
- **先选导出对象**：`Record`（默认）/ `Report`（**本次会话已成功生成过 Report** 才可选，否则该项禁用并说明原因）。
- **协议**：`record.export_request { record_id, object, target: "knowledge_base" }` → `record.export_result { record_id, object, status, error_code, message }`（`PROTOCOL_SPEC` §10.3）。
- **反馈严格诚实**（`ADR-005` §4）：
  - `ok` →「**端点已接收**（≠ 已被收录；是否收录由 KB 审核人员决定）」；
  - `export_unavailable` →「未配置 KB 端点」；
  - `export_failed` / `invalid_object` → 对应错误信息。
- **不追踪审核状态**（`ADR-005`）；导出**不改** Record、可重复发起。

## 7. 取消（S3）

- **入口**：工作台"取消"，**仅 live 且未终止**时可用。
- **二次确认**弹窗（提示：受控执行不粗暴打断，正在执行的不可中断步骤可能需等待结束）。
- **协议**：`workflow.cancel_request { workflow_id }`（**不带 `reason`**）→ `workflow.cancel_ack { workflow_id, workflow_status }`（`PROTOCOL_SPEC` §7.3）：
  - `workflow_status: "CANCELLED"`（情况 A，立即终止）→ 紧接着收到 `workflow.terminated`；
  - `workflow_status: "CANCELLING"`（情况 B）→ UI 进入 **"正在取消（等待当前步骤结束）"**，取消按钮禁用，直到 `workflow.terminated`。
- **投影**：`UiWorkflow` 新增 `cancelling: boolean`（`cancel_ack` 置 `true`；`workflow.terminated` 清）。
- **互斥锁**：取消意图发出后，同一会话的其它互斥动作（确认等）按 `CLIENT_SPEC` §3 第 14 条锁定。

## 8. 手工动作卡 `details`（S4）

- `AskCard` 的手工动作表单加**可选**两项：①「补充说明」文本框；②**附件**（复用 S5 的机制）。
- 组装 `Answer` 的 `details`（`human.manual_action` 的 output schema 有 `details: {type: object}`，`CAPABILITY_SPEC` §6）：`{ note?: string; attachments?: UiAttachment[] }`。
- `host.ts` **已透传** `answer.details`（electron-monolith 评审 I1），本切片只补 **UI 收集**与（必要时）`validateAnswer` 的细节。

## 9. 附件与 blob（S5）

- **入口**：Composer（提交问题）；`AskCard` 手工动作（作为 `details.attachments`）。
- **选择方式**：文件选择器（renderer 用 web `<input type=file>`）+ **拖拽**；**粘贴文本**（一段文本合成一个 `text/plain` 附件）。
- **类型白名单**（本地预检，对齐服务端 `DEFAULT_ALLOWED_MEDIA_TYPES`，`server/src/blob/config.ts`）：`text/plain`、`text/csv`、`text/markdown`、`application/json`、`application/zip`、`application/gzip`、`application/octet-stream`、`image/png`、`image/jpeg`；renderer 取 `File.type`，为空或不在白名单 → **`application/octet-stream`**（不本地拒绝，交给服务端白名单兜底）。
- **分流**：`size ≤ 64 KiB` → **内联**（`data_base64`）；`size > 64 KiB` → **`uploadBlob`**（`@adt/client-daemon` 已有，含 sha256）拿 `content_ref`。
- **限额**：单会话单轮**数量 ≤ 10**、**每轮总大小 ≤ 32 MiB**；超限**明确拒绝并提示**（不静默截断）。
- **下载/预览**（经 main，renderer 不碰字节）：
  - `blob_preview`：main 调 `downloadBlob`（内含 sha256 校验）后按类型分流——文本/JSON → 返回**解码文本**；图片 → 返回 **`data:` URL**；其它 → 提示"另存/打开"。
  - `blob_save`：main 弹保存对话框并落盘（`dialog.showSaveDialog` + 写文件）。
  - **token/凭据只留在 main**。
- **往期渲染**：从 Record 的 `user_request.attachments` 与 `entries[].ref.evidence.result.content_ref` 还原附件/证据条目，提供预览/另存。
- **live 证据 blob 的前提**：`StepStatusUpdate`（`client-daemon`）当前只带 `evidenceSummary?: string`，**拿不到证据的 `content_ref`**。需**小改**：当证据 `result` 是 `BlobRef` 时，`StepStatusUpdate` 增带 `evidenceRef`（`{ content_ref, media_type, size, name? }`），投影存到 `UiStep.evidenceBlob`。**仅影响 live 证据**；往期（Record）不受影响。此改动是**加法**、影响 `client-cli` 极小。

## 10. IPC 契约与契约类型

### 10.1 `RendererRequest` 新增（`renderer → main`）

| 请求 | 响应 | 协议落点 |
|---|---|---|
| `{ kind:"report"; recordId:string; detailLevel?:"summary"\|"full" }` | `UiReportResult` | `report.generate_request/result` |
| `{ kind:"export"; recordId:string; object:"record"\|"report" }` | `UiExportResult` | `record.export_request/result` |
| `{ kind:"cancel"; workflowId:string }` | `void`（等 `cancel_ack`） | `workflow.cancel_request/ack` |
| `{ kind:"blob_preview"; contentRef:string }` | `UiBlobPreview` | `blob.allocate_request`(download) + HTTP GET |
| `{ kind:"blob_save"; contentRef:string; suggestedName?:string }` | `{ saved:boolean; path?:string }` | 同上 |
| `{ kind:"submit"; text:string; attachments:IncomingAttachment[] }` | `string`（`workflowId`） | `workflow.request`（扩展 `attachments`） |

`IncomingAttachment = { name: string; mediaType: string; dataBase64: string }` —— renderer → main 的**入站**形状；main 计算 `size`/`sha256`、判内联/走 blob。

### 10.2 契约类型（`packages/client-electron/src/shared/contract.ts`，renderer 安全镜像）

```ts
/** 附件（客户端定义；规格未定义其形状，见 §14）。 */
export type UiAttachment = { name: string; media_type: string; size: number; sha256: string } & (
  | { mode: "inline"; data_base64: string }
  | { mode: "blob"; content_ref: string }
);

/** live 步骤上的证据 blob 引用（只有引用，不含字节）。 */
export interface UiEvidenceBlob { content_ref: string; media_type: string; size: number; name?: string }

export interface UiReportResult {
  ok: boolean;
  markdown?: string;
  errorCode?: string;
  message?: string;
}

export interface UiExportResult {
  ok: boolean;
  errorCode?: "export_unavailable" | "export_failed" | "invalid_object" | null;
  message?: string | null;
}

export type UiBlobPreview =
  | { kind: "text"; mediaType: string; text: string }
  | { kind: "image"; mediaType: string; dataUrl: string }
  | { kind: "binary"; mediaType: string; size: number };
```

- `UiStep` 增 `evidenceBlob: UiEvidenceBlob | null`。
- `UiWorkflow` 增 `cancelling: boolean`。
- `UiRecord` 的 `user_request` 保持 `Record<string, unknown>`（`attachments` 在其中原样透出）。

### 10.3 `MainEvent` / `UiEvent`

- 现有 `ui` 事件流不变；取消的**收敛**通过新增的 `UiWorkflow.cancelling`（快照）与 `workflow.terminated` 表达，**不新增事件类型**（保持"终止通知只有一种"的一致性）。
- `step.status` 事件可携带 `evidenceBlob`（若存在），供工作台即时显示 blob 入口。

## 11. 错误处理与安全

- 未登录 → `not_logged_in`（沿用既有）。
- 附件超限/类型被服务端拒 → `blob_rejected`（**如实显示，不假装成功**）；本地预检 + 服务端白名单**双保险**。
- 导出：`export_unavailable` / `export_failed` / `invalid_object`，以及 `protocol.error(unknown_record)`。
- Report：`status:"failed"` 的各 `error_code`，以及 `protocol.error(unknown_record)`。
- 取消：`protocol.error`（如 `unknown_workflow`）如实显示，且**不假定已取消**。
- **安全**：renderer **不碰 Node、不拿 token/凭据**；blob 字节只在 main 流转；`contextIsolation: true` / `nodeIntegration: false` 不变（`ADR-006` §1）。

## 12. 测试策略

- **main 纯逻辑**：`bridge` 的新请求分派；`session` 的 report/export/cancel/attach；**内联 vs blob 的分流**纯函数；`UiAttachment` 组装（`size`/`sha256`/`mode`）；附件限额（数量/总量）；`UiBlobPreview` 的类型分流。
- **daemon**：`StepStatusUpdate` 带 `evidenceRef` 的单测（证据是 `BlobRef` 时携带；内联证据时不携带且不破坏既有断言）。
- **renderer（jsdom + RTL）**：三栏工作台（live + 往期）；报告查看器（成功/失败/复制/另存）；取消二次确认 + `CANCELLING`；附件选择 + 超限拒绝 + 粘贴文本；往期附件/证据 blob 条目。
- **集成（真 Server + 真 daemon）**：`report.generate`（成功/失败）；`record.export`（`ok` / `export_unavailable` / `unknown_record`）；`workflow.cancel`（情况 A 立即、情况 B 排队后收敛）；blob **上传**（> 64 KiB）与**下载**（sha256 校验）。
- **桌面冒烟（Playwright Electron）**：跑完一条 → 打开工作台 → 生成报告 → 另存 → 导出 → 打开往期看到附件。
- **验证口径**：`pnpm -r --if-present test`（**串行**）+ `pnpm -r --if-present typecheck` + `pnpm -C packages/client-electron build` + 桌面冒烟。

## 13. 明确不做（本切片）

- **D2** token 流式 / 推理文字；**A5** 多条 Workflow 并行；**B1** Electron 安全硬化（CSP / `setWindowOpenHandler` / sender 校验）；**B2** 打包分发（图标/签名/自动更新/安装包）；**C1** 断线恢复体验 + resume 可视化。
- FR-3 的"假设实体"（不新增对象，见 §4）。
- 往期"逐字还原当时的界面"（不做转录/事件持久化）。
- Report 的 HTML/PDF 输出与非 `markdown` 格式（`REPORT_SPEC` §6）。

## 14. 规格影响

| 文档 | 需要的变化 |
|---|---|
| `mvp-scope §6` | **修订**：blob 通道进 MVP（撤销"大体积附件走 blob 通道的完整实现"的排除）；阈值 64 KiB（修订 B） |
| `RECORD_SPEC.md` | **附件形状目前规格未定义**（服务端 `user_request: unknown` 只透存、不校验）——把 §10.2 的 `UiAttachment` 形状**写死**为 Record 中附件的形状，并升版 + 同步 `REQUIREMENTS.md` §7 |
| `CLIENT_SPEC.md` | 补"工作台（步骤/证据/结论视图）、附件（内联/blob）、blob 下载/预览、取消入口"相关职责；升版 + 同步 `REQUIREMENTS.md` §7 |
| `PROTOCOL_SPEC.md` | 协议面**不改**（§7.3/§7.5/§10.3/§11 消息已存在）；仅在 §7.5 补一句"内联附件在 `attachments` 中的客户端形状"以指向 `RECORD_SPEC` |
| `REPORT_SPEC.md` | **不改**（§3 两档、§4 markdown、§6 不持久化均已定义） |

> 规范类文档一改即同步页首 `Version` 与 `REQUIREMENTS.md` §7 的版本行（`WORKFLOW.md` §5）。

## 15. 切片、依赖与计划拆分

六个切片存在天然层次：

- **S0 工作台**是 S1/S2/S3 的**落点**（报告入口、导出入口、取消入口都在工作台头部），**应先做**。
- **S5 附件 + blob** 内含 **S4**（手工动作 `details` 复用附件机制），且依赖 `client-daemon` 的 `StepStatusUpdate` 小改。

按 `WORKFLOW.md` §1"规格若覆盖多个相互独立的子系统，拆成多份计划，一次只做一份"，建议拆成 **3 份计划**（具体拆分由 `writing-plans` 定稿）：

1. **P-workbench**：S0 工作台（+ S3 取消，二者都改投影与外壳，贴着做省返工）。
2. **P-loop-end**：S1 Report + S2 KB 导出（都挂在工作台动作区，共用覆盖式查看器/结果反馈模式）。
3. **P-attachments**：S5 附件 + blob（含 daemon 的 `StepStatusUpdate` 小改）+ S4（`details`）。

**依赖与风险**：

- `RECORD_SPEC`/`CLIENT_SPEC` 的**附件形状写死**是 S4/S5 的前提，须**先于** UI 落地（可同计划内先做）。
- blob 的**往期渲染**依赖 Record 里保留 `content_ref`——`RECORD_SPEC` §3 已承诺保留；写作/responses 时需在测试里钉住。
- 大附件会让 WS 消息变重——**64 KiB 阈值 + 32 MiB 总上限**是护城河；超限拒绝而非截断。
- 不碰 `ADR-006` 的决定与 `PROTOCOL_SPEC` 的既有消息。
