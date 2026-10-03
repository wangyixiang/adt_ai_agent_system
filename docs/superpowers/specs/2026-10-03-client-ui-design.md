# Client UI 设计（Electron 桌面产品线）

- **日期:** 2026-10-03
- **状态:** 待评审（批准后据此写实施计划）
- **层级:** Design — 单体 Electron 客户端（`packages/client-electron`）的产品外观与交互
- **关联:** `ADR-006`（Client 形态：单体 Electron）、`ADR-002`（One-Step Planning）、`docs/architecture/CLIENT_SPEC.md`、`docs/specs/PROTOCOL_SPEC.md` §5.2（`session.resume` / `workflow.state_sync`）、`docs/REQUIREMENTS.md` NFR-3（断线恢复）、`docs/superpowers/specs/2026-10-01-workbench-and-loop-closeout-design.md`、`docs/superpowers/plans/2026-10-01-workbench.md`、`docs/superpowers/plans/2026-10-01-electron-monolith.md`（M1）、参考设计稿 `docs/superpowers/reference/2026-10-03-client-ui-mockup/`

---

## 1. 目标与判断标准

把已交付的三栏外壳（左会话 / 中对话流 / 右工作台）从"能跑、几乎无样式"提升为**产品级外观与交互**，并补齐日常可用性上缺的屏幕与状态。

判断标准：**打包后的 Electron 应用打开后"看起来是有意设计的"**；每个状态（空 / 加载 / 断线 / 恢复中 / 错误 / 往期）都能自我解释；界面上的**每一个元素都能对应到一个真实字段**，没有凭空造出的遥测或能力。

## 2. 已锁定的决定（本轮讨论得出，别推翻）

1. **现实优先**：设计稿只作视觉参考；凡与真实数据模型冲突的元素，按现实重画，不将就设计稿。
2. **不动协议（方向 A）**：本次工作只改 UI 与客户端内部模型（`shared/ui.ts`、`shared/contract.ts` 是本单体自己的模型，不是 Server 协议）。要给 UI 增补协议（总步数、授权代执行、defer 等）一律**不在本次**。
3. **一个数据一个家**：同一份**长内容**（证据全文、完成候选正文、终态指纹）只渲染一处；另一栏只允许**导航性镜像**（紧凑行/指针，不复制长内容与操作按钮）。
4. **中栏 = 流 + 操作面（chat & act）；右栏 = 账本 + 控制面（ledger & control）**（分工见 §6）。
5. **状态用颜色 + 图标 + 文字**三态，不靠颜色单独表意。
6. **不引入新依赖 / CSS 框架 / CSS-in-JS**；renderer 不 `import @adt/server`（`ADR-006`）。
7. **断线后自动重连（带退避）**，不是手动按钮。
8. **live 与往期同形**：同一套组件、同一形状，数据同源。
9. **取消保留二次确认**（已实现，`Workbench.tsx`），设计稿的单击取消**不采纳**。

## 3. 范围与刻意不做

**范围（六面）**：视觉系统落地、三栏 IA 去重、补缺失屏幕（登录 / 设置）、补覆盖层（Report / blob）、断线恢复 / resume 可视化、状态与无障碍基线。

**刻意不做**：

- **D2 token 流式 / 推理文字**（要改协议）。
- **A5 多 Workflow 并行**（"一次一条"仍是输入框谓词；`ADR-002`）。
- **B1 Electron 安全硬化**（CSP / `setWindowOpenHandler` / sender 校验）——另立计划。
- **浏览器线（`electron-wrapper`）** 的任何内容与编号（UI-1/2/3/4 均在冻结分支，不引用）。
- 任何**动协议**的项：总步数、授权平台代执行、`defer`、编造遥测。

## 4. Global Constraints

- **现实绑定**：每个视觉元素必须出现在 §11 数据绑定表里；表中没有的新元素不得上线（防"又画现实没有的东西"）。
- **不动协议**；`shared/ui.ts` / `shared/contract.ts` 可扩展（单体自有模型）。
- **无新依赖**（本地打包字体是静态资产，不是依赖）；只有一个 `renderer/src/theme.css`（`:root` 变量）+ 纯 `className`，不搭组件库。
- **最小字号 11px**；正文 13px；等宽 12px。
- **颜色 + 图标 + 文字**。
- **一个数据一个家**（§6）。
- **LF**；改文件用 `edit`。
- 验证口径沿用 `WORKFLOW.md` §7。

## 5. 设计 token（唯一来源）与字体

### 5.1 token 的唯一来源

**以 `DESIGN.md` 头部 YAML（也是 `code.html` 实际使用的那套）为唯一来源**；正文 `## Colors` 段落里那套 `#0284c7 / #6366f1 / #0f172a / #020617` **作废**。

核心 token（色）：

| 用途 | token | 值 |
|---|---|---|
| 画布 / 背景 | `background` | `#0b1326` |
| 面板（低） | `surface-container-low` | `#131b2e` |
| 面板 | `surface-container` | `#171f33` |
| 卡片（高） | `surface-container-high` | `#222a3d` |
| 凸起（最高） | `surface-container-highest` | `#2d3449` |
| 凹陷（控制台） | `surface-container-lowest` | `#060e20` |
| 正文 / 前景 | `on-surface` | `#dae2fd` |
| 次要文字 | `on-surface-variant` | `#bfc7d2` |
| 结构线 | `outline-variant` | `#3f4850` |
| 主色（活动/进行中，文字态） | `primary` | `#93ccff` |
| 主色填充 + 前景 | `primary-container` / `on-primary` | `#3198dc` / `#003351` |
| 次色（agent/启发式） | `secondary` | `#c0c1ff` |
| 成功 | `tertiary` | `#4edea3` |
| 失败 / 危险 | `error` | `#ffb4ab` |
| **等待 / 取消（补）** | `warning` | `#fbbf24`（HTML 实际用的 amber-400；token 头缺失，此处补定义） |

> 说明：A 这套里没有独立的 warning 色，而状态芯片需要"等待 / CANCELLING"。取 `code.html` 实际渲染所用的 amber 值补上，保持"以 HTML 为准"。
>
> 圆角取 `DESIGN.md` 的 4px 基准（`rounded`），大容器最多 8px；不用胶囊形。字体、间距沿用 `DESIGN.md` token，但最小字号抬到 11px。

### 5.2 字体

**本地打包 Inter + JetBrains Mono**（放 `renderer/src/assets/fonts/`，以 `@font-face` 引入），离线可用；不用 Google Fonts CDN。回退栈：Inter → Segoe UI；JetBrains Mono → Cascadia Mono / Consolas。

### 5.3 语言

中文做人读文案；英文等宽仅用于能力名、状态、`id`、hash。列表项**标题用问题简述**（`problem_short` / 请求文本），`wf_` / `rec_` 降为副标题小字。

## 6. 信息架构与去重

### 6.1 三栏职责

- **左栏 `ConversationList`**：过滤器（全部 / 进行中 / 往期）、会话列表。
- **中栏 `Thread`**：`ProgressHeader`（请求简述 + 已走 N 步（完成 M））→ 对话流（用户气泡 + 附件、assistant 说明、**步骤紧凑行**、**四种 ask 的唯一可作答卡**、notice、终态一行）→ 底部 `Composer`（仅新建；有运行中则禁用 + 一句说明）。**（设计稿把新建输入框放在左栏底部；不采纳，沿用中栏底部——现实优先。）**
- **右栏 `Workbench`**：状态 + 动作（取消[二次确认] / 报告 / 导出）；**步骤与证据时间线（证据全文、input、blob 预览/另存、人工决定小标的唯一家）**；完成候选；终态指纹。

### 6.2 判定规则

- **禁止**：同一份长内容在两栏各渲染一次。
- **允许**：中栏的步骤紧凑行 / 终态一行是**指针**——点它定位并高亮右栏对应节点。

### 6.3 逐项落点

| 数据 | 家 | 中栏 | 右栏 |
|---|---|---|---|
| 请求 + 附件 | **中栏** | 用户气泡 + 附件 chips（blob 可预览/另存） | 删附件 section |
| 四种 ask | **中栏** | `AskCard` 唯一可作答处 | 节点只显示"等待你回答" |
| 步骤能力 / 状态 | 镜像 | 紧凑行：能力 + 状态点 + 一句 `objective` | 完整节点（能力 + 状态 + objective + 证据 + input + blob 动作 + 决定小标） |
| step `input` | **右栏** | ✗ | 折叠展开 |
| 证据全文 | **右栏** | ✗ | 唯一 |
| 完成候选 | 拆分 | 决策卡：`summary` + 已解决 / 没解决 | `evidenceRefs`（点回步骤）+ 决定状态，不重复 `summary` |
| 终态 / `recordId` | **右栏** | 一行"已收敛 · 见右栏结论" | 唯一权威 |
| 连接状态 | **应用栏** | ✗ | ✗ |
| 运行状态 | **右栏** | `ProgressHeader` 只留"已走 N 步（完成 M）" | 状态徽章 + 动作 |
| 取消 / 报告 / 导出 | **右栏** | ✗ | 唯一 |

**删掉的多余物**：中栏底部"流状态条"、右栏页脚 `METRICS_STORE/TRACE`、左侧"约束 tooltip"（并入 Composer 禁用提示）、顶部全局 subheader 里的编造遥测。

## 7. 顶部应用栏

一条**真实**的极简应用栏（不放 `AGENT ENGINE/LEASE/TRACE`）：应用名 + **连接状态指示（连接状态只在这一处）**（`已连接 / 正在重连… / 已断开`）+ 当前用户（`UiSnapshot.userId`）+ **设置入口**（把现在塞在中栏的"设置"按钮挪到这里，`app.tsx`）。

## 8. 屏幕与状态清单

**屏幕**：应用栏、三栏工作台、登录、设置（首次运行 / 改配置）、Report 覆盖层、blob 覆盖层。

**工作台状态**：空、live running、live cancelling、live 等待作答、live 终态、往期 record、**断线（disconnected）**、**恢复中（resuming）**。

**Ask 四形态**：`confirmation` / `manual_action` / `resource_conflict` / `completion`（形状严格照 `packages/shared/src/decisions.ts`）。

**全局**：加载中、错误、通知 / 导出反馈、空态。

## 9. 断线恢复 / resume 可视化

### 9.1 现实（代码事实）

- 协议支持同一逻辑会话内恢复：`session.resume` → `workflow.state_sync`（带 `pending_step`），会话 TTL 默认 24h（`PROTOCOL_SPEC.md` §5.2）。
- daemon **在连接时**先试 resume，被拒回落新握手（`connection.ts:78-224`、`daemon.ts:129-205`）；resume 成功会在 `onReady` 重跑 `pending_step`（`daemon.ts:193-203`）。
- **没有任何自动重连**：socket 掉了只打日志（`connection.ts:64-66`）。
- **renderer 的连接状态是假的**：只看 daemon 对象在不在（`projection.ts:186`），会话中途断线仍显示"已连接"。
- **M1 光卡**：投影是本进程新建的；resume 时被重发的 step，投影从没见过其 `step.dispatch`，于是 `deriveTranscript` 用空 `capability/objective` 造卡（`projection.ts:134-141` + `transcript.ts:169-220`）。原条目见 `2026-10-01-electron-monolith.md`「M1」。

### 9.2 设计（均不动协议）

1. **可感知的连接状态**：连接状态从"daemon 存在与否"改为**真实 transport 状态** `connected | reconnecting | disconnected`，经 main 更新到 `UiSnapshot.connection`；**应用栏据此显示（唯一处）**。
2. **自动重连（带退避）**：daemon 在物理连接断开后自动重连（指数退避，如 0.5s→1s→2s→4s→8s→上限 30s），重连即走 `session.resume`；每次尝试把状态推给 main/renderer。
3. **`state_sync` 播种投影**：把 `pending_step` 的完整派发（`capability` / `objective` / `input`）先交给投影建 step，**在它的新状态到达前**即显示"恢复中"，从而不再出现空卡。
4. **恢复中的 step**：右栏节点与中栏紧凑行显示"恢复中"（一个明确的非终态样式，即"光卡"改造）；权威状态到达后转为真实态。
5. **对账呈现**：若该 step 属于 in-flight，daemon 报 `UNKNOWN`；UI 用 `STEP_STATE_TEXT.UNKNOWN`＝"未对账（系统判定结果不确定）"，与人工的"我说不准"（`MANUAL_OUTCOME_TEXT.unknown`）区分。
6. **会话过期（致命）**：如实提示"会话已过期，无法恢复；未完成的工作需要重新提交"，不假装能自动接回。

### 9.3 边界（照 `REQUIREMENTS.md` NFR-3）

只保证**同一逻辑会话内**的断线；会话过期 / Server 重启 → 不恢复。恢复只对**服务端重发的 `pending_step`**；已终态的 step 不重跑。

## 10. 组件规格

> 每个组件列"渲染什么 / 有哪些状态 / 测试点"。字段名以 §11 为准。

- **AppBar**（新）：应用名、连接指示、用户、设置入口。状态：三种连接态。测试：三种态渲染。
- **ConversationList**：过滤器计数、列表项（标题 / 副标题 / 状态芯片）。状态：空、进行中、往期、选中。测试：过滤、选中、空态。
- **ProgressHeader**：请求简述 + "已走 N 步（完成 M）"。**不含总步数、不含连接**（连接在应用栏）。测试：计数、请求简述。
- **Transcript**：按 `TranscriptItem.kind` 分派。用户气泡带附件 chips；assistant 说明；**ToolCard 压缩为紧凑行**；`AskCard`（四形态，唯一作答）；`Notice`；`Summary` 缩为一行。测试：各 kind、附件 chips、终态一行。
- **ToolCard**（改）：能力 + 状态点 + 一句 `objective`；点击 → 右栏定位高亮。**移除** `input` 裸 JSON 与 `evidenceSummary`。测试：紧凑行内容、点击发出定位意图。
- **AskCard**：四形态严格映射 `Ask`/`Answer`；`manual_action` 保留 `outcome` 四选一 + `observation` + `details.note` + 附件（`details.attachments`）；`confirmation` 确认/拒绝；`resource_conflict` 等待/停止；`completion` 已解决/没解决 + `feedback`。**不含**设计稿的"授权自动执行""拒绝"三选一、"DEFER"。测试：每形态的提交载荷、往期只读态。
- **Workbench**：头部（状态 + 动作）、步骤时间线（唯一家）、完成候选（refs + 决定）、终态指纹、空态。取消保留二次确认。测试：动作门控（`recordId` / `reportReady` / `canCancel`）、二次确认、往期不可取消。
- **Composer**：仅新建；有运行中则禁用 + 说明；附件入口。测试：禁用谓词、提交。
- **Login**：`username` / `secret`；错误提示。测试：提交、错误。
- **Settings**：`serverUrl` / `workspaceRoot` / `configured`；首次运行与改配置两种入口。测试：保存、取消、未配置强制。
- **ReportViewer**：`UiReport`（markdown 或错误）；复制 / 另存 / 关闭。测试：成功、失败、复制/另存。
- **BlobViewer**：`UiBlobPreview`（text / image / binary）；另存 / 关闭。测试：三形态。
- **Notice**：`info` / `warn`；导出反馈如实（"端点已接收 ≠ 已收录"，`ADR-005` §4）。

## 11. 数据绑定表（防止画现实没有的东西）

| UI 元素 | 字段 |
|---|---|
| 应用栏连接指示 | `UiSnapshot.connection`（本次扩为三态） |
| 应用栏用户 | `UiSnapshot.userId` |
| 列表过滤器计数 | `UiConversation[]` 按 `state`/`live` 聚合 |
| 列表项标题 | `UiConversation.title`（← `record.summary.problem_short` 或请求文本） |
| 列表项副标题 | `UiConversation.recordId` / `workflowId` / `durationMs` |
| 列表项状态芯片 | `UiConversation.state` + `live` + `UiWorkflow.cancelling` |
| ProgressHeader | 请求简述（`UiConversation.title`）；`TranscriptItem` 里 `tool` 的总数 / `COMPLETED` 数 |
| 用户气泡 + 附件 | `TranscriptItem{kind:"user"}.text` + `.attachments`（`UiAttachment`） |
| assistant 说明 | `TranscriptItem{kind:"assistant"}.text`（← `objective`） |
| 步骤紧凑行 | `TranscriptItem{kind:"tool"}`：`capability` / `state` / `objective` |
| step `input`（右栏） | `TranscriptItem{kind:"tool"}.input` |
| 证据全文（右栏） | `TranscriptItem{kind:"tool"}.evidenceSummary` |
| 证据 blob 动作（右栏） | `TranscriptItem{kind:"tool"}.evidenceBlob`（`UiEvidenceBlob`） |
| ask 卡 | `TranscriptItem{kind:"ask"}.ask`（`Ask` 四形态）+ `.answered` + `.text` |
| 人工决定小标（右栏） | `WorkbenchStep.decisions` |
| 通知 / 导出反馈 | `TranscriptItem{kind:"notice"}.level` / `.text` |
| 终态一行（中栏） | `TranscriptItem{kind:"summary"}.terminalState` / `.terminalReason` |
| 右栏状态徽章 | `WorkbenchModel.state`（`running` / `CANCELLING` / `COMPLETED` / `FAILED` / `CANCELLED`） |
| 右栏动作门控 | `WorkbenchModel.conclusion.recordId`、`reportReady`、`canCancel` |
| 完成候选 | `WorkbenchModel.completion.summary` / `.evidenceRefs` |
| 终态指纹（右栏） | `WorkbenchModel.conclusion`（`terminalState` / `terminalReason` / `recordId`） |
| Report 覆盖层 | `UiReport`（`markdown` 或 `errorCode`/`message`） |
| blob 覆盖层 | `UiBlobPreview`（`text` / `image` / `binary`） |
| 登录 | 提交 `username` / `secret` |
| 设置 | `UiConfig.serverUrl` / `.workspaceRoot` / `.configured` |

## 12. 测试策略

- **纯函数单测**（已有基础）：`transcript`、`workbench`、`conversations`、`attachments`、`recordTranscript`。
- **组件测试**（Vitest + Testing Library，jsdom）：每个组件按 §10 的测试点。
- **桌面冒烟**（Playwright Electron）：外壳渲染、设置可达、报告/覆盖层打开。
- **断线恢复**：daemon 层重连/退避/resume 播种的单测 + 一条 `client-daemon` e2e（沿用现有 `reconnect.e2e.test.ts` 思路）+ desktop 冒烟里的"断开→自动恢复"路径。
- 验证口径：`pnpm -r --if-present test`（串行）+ `typecheck`，以及 `client-electron` 打包冒烟（`WORKFLOW.md` §7）。

## 13. 计划拆法（一次一份，按依赖）

| 计划 | 内容 | 依赖 | 出口 |
|---|---|---|---|
| **UI-1 基石 + 外壳** | token / 字体 / `theme.css`、应用栏（含设置入口）、三栏布局与基础态 | — | 新外壳渲染、设置可达 |
| **UI-2 中/右去重** | 中栏压缩步骤、右栏独占证据/输入/blob/决定、附件归中栏、完成候选拆分、终态唯一、删多余物 | UI-1 | 无长内容重复；组件测试 |
| **UI-3 覆盖层 + 登录/设置** | Report 查看器、blob 预览/另存、登录页、设置页 | UI-1 | 覆盖层为正式模态；登录/设置成形 |
| **UI-4 断线恢复 / resume** | 连接状态 daemon→main→renderer、自动重连退避、`state_sync` 播种投影、"恢复中"呈现、过期提示 | UI-2 | 断线→自动恢复冒烟 |
| **UI-5 状态与无障碍收口** | 空/加载/错误态、字号/对比度、三态审计 | UI-1..4 | 无障碍清点通过 |

每份计划按 `WORKFLOW.md` §1–§4 执行，末尾带评审裁决表。
