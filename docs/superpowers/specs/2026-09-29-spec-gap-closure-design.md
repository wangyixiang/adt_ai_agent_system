# Spec 缺口收敛设计稿（24 项决策）

- **日期：** 2026-09-29
- **状态：** 待审阅（Approved 后据此修订 `docs/` 下现有 Spec）
- **层级：** Design（设计稿 / 审阅入口）——不是最终 Spec，最终落地形态是修订现有文档
- **输入：** `PRODUCT.md` v0.7 / `REQUIREMENTS.md` v0.8 / `ARCHITECTURE.md` v0.5 / `CLIENT_SPEC.md` v0.5 / `SERVER_SPEC.md` v0.6 / `specs/*` / `adr/*`
- **来源：** 对现有架构与 Spec 做缺口评审后，逐条与产品方问答达成一致的 24 项决策

---

## 0. 背景与目标

对现有 `docs/` 全套文档做缺口评审，目标是找出并补齐三类缺失：

1. **边界条件**（状态机未定义的转移、竞态、无穷循环）；
2. **错误处理逻辑**（失败路径、幂等、持久化失败）；
3. **未定义的接口规范**（Capability I/O、Evidence 词表、分页、错误分级）。

评审发现 24 项缺口（其中 1 项为讨论中新发现），逐条问答后全部收敛。本文件是决策的唯一汇总入口，`docs/` 下的 Spec 修订以本文件为准。

### 0.1 范围

- 只补 Spec 细节，**不改变产品范围**（`PRODUCT.md` §7；`REQUIREMENTS.md` §4 的非目标保持不动）。
- 不重新打开已有明确结论的“已延后/非目标”项。

### 0.2 明确不处理（确认即可，非缺口）

| 项 | 状态 |
|---|---|
| 认证 / 授权 / 沙箱 | 仍由待建 Security Spec 承担（`REQUIREMENTS.md` NFR-6、Q-1） |
| 第三方 Knowledge Base 集成、Record 导出 | 仍为 P1 / 未实现方向（FR-23、FR-24、Q-6） |
| 跨 Client 续接同一 Workflow | v0.1 明确不支持（`PROTOCOL_SPEC.md` §14/§16-3） |
| 多 Server 实例路由 | 不在本版本 |
| Record 修订 / 编辑机制 | 只读不变（假设 A-3、`RECORD_SPEC.md` §9-3） |
| 多工程师操作同一硬件 | 假设 A-2 不变 |
| 硬件资源 / 目标（resource/target）模型 | 本次**不引入**，改用会话级副作用串行（见 D-B6） |

---

## 1. 版本规划

### 1.1 文档版本（各自 +1 minor）

| 文件 | 现版本 | 目标版本 |
|---|---|---|
| `PRODUCT.md` | v0.7 | v0.8 |
| `REQUIREMENTS.md` | v0.8 | v0.9 |
| `ARCHITECTURE.md` | v0.5 | v0.6 |
| `architecture/CLIENT_SPEC.md` | v0.5 | v0.6 |
| `architecture/SERVER_SPEC.md` | v0.6 | v0.7 |
| `specs/WORKFLOW_SPEC.md` | v0.3 | v0.4 |
| `specs/PROTOCOL_SPEC.md` | v0.3 | v0.4 |
| `specs/CAPABILITY_SPEC.md` | v0.4 | v0.5 |
| `specs/RECORD_SPEC.md` | v0.2 | v0.3 |
| `specs/REPORT_SPEC.md` | v0.1 | v0.2 |

### 1.2 协议版本（E5：与文档版本解耦）

- 协议版本从 `"0.2"` 提升为 `"0.3"`。
- 推进规则：`<major>.<minor>`；向后兼容新增 → minor+1；破坏性变更 → major+1；`v0.x` 阶段允许在 minor 做不兼容调整。
- 信封 `protocol_version` 仅用于日志，实际以 `session.hello` / `session.welcome` 协商结果为准（沿用 `PROTOCOL_SPEC.md` §13）。

### 1.3 本文件使用的统一术语

以下术语在本文件（以及后续 Spec 修订）中含义固定，避免歧义：

| 术语 | 定义 |
|---|---|
| **活跃 Step** | 已下发且**未到达终态**的 Step，即 `PENDING` / `RUNNING` / `WAITING`。用于取消判定（D-B2）、副作用串行化（D-B6）、副作用阻塞（D-A1）。 |
| **Step 终态** | `COMPLETED` / `FAILED` / `REJECTED` / `UNKNOWN`。到达终态后不可变（D-A2），唯一例外是 `UNKNOWN` 可被对账收敛。 |
| **执行类等待** | `wait_reason` 属本地服务 / 设备响应 / 外部资源，受 `step_timeout`（D-B1）。 |
| **人类等待** | `wait_reason` 属 `user_input` / `user_confirmation` / 人工对账，豁免 `step_timeout`（D-B1）。 |
| **副作用 Step** | 引用的 Capability 声明 `side_effect: true` 的 Step。 |

> 注：对账本身若由工程师确认，属于**人类等待**；若由只读对账 Step 执行，该对账 Step 是**执行类等待**的正常只读 Step。

---

## 2. 决策清单（D-xx）

### A. 安全与一致性

#### D-A1 副作用 Step 的“结果未知”与幂等重试

- **语义**：有副作用（`side_effect: true`）且结果不确定的 Step **不自动重试**，进入“结果未知”并对账；Capability 可显式声明 `idempotent`，**仅这些**允许幂等重试。
- **表示**：Step 状态机新增终态 **`UNKNOWN`**（结果未知，需对账）。Workflow 保持 `RUNNING`，但受“副作用阻塞”约束——存在未对账 `UNKNOWN` 时，**禁止再下发其它副作用 Step**（只读 / 对账 Step 允许）。
- **对账**：优先由 Server 生成只读对账 Step 取客观证据，由 Workflow Engine 将原 `UNKNOWN` 裁定为 `COMPLETED` / `FAILED`；证据不足时退回工程师确认。
- **幂等**：
  - Capability Manifest 新增 `idempotent`（布尔，**缺省 `false`**，仅对 `side_effect: true` 有意义）。
  - Server 为“同一意图”生成 Workflow 内稳定的 `idempotency_key`，随 `step.dispatch` 下发（`side_effect: true` 的 Step 必须携带）。
  - Client **必须持久化**“`idempotency_key` → 结果”台账；收到同一 key 的重试直接返回缓存证据，不重新执行。
  - Client 无法确认台账（重装 / 丢失）时**不得静默重执行**，应回报 `UNKNOWN` 待对账。
- **终止**：允许带 `UNKNOWN` 终止；Record 如实记为 `UNKNOWN`，`final_result` 标注“存在未对账的副作用动作（可能已执行）”。

#### D-A2 迟到 / 重复的 `step.status`

- Step 到达终态后，同一 `step_id` 的**非终态更新忽略并告警**。
- 终态之间**不互相覆盖**，先到者为准。
- **唯一例外**：`UNKNOWN` 可被对账收敛为 `COMPLETED` / `FAILED`。
- 迟到的只读证据可由 Server 选择性并入 Context（**不改 Step 状态**）。
- Workflow 已终止后才到达、且可能涉及已执行的副作用 → **告警用户**，Record 不变（符合假设 A-3）。
- 派生规则：Server 对同一 `(step_id, 终态)` 只接受一次，避免重连补报在 Record 中产生重复条目。

#### D-A3 / D-B5 断线恢复边界与孤儿回收

- `NFR-3` 的适用面收敛为：**同一逻辑会话内的网络中断**（`session_id` 有效时按 §5.2 恢复）。
- 会话过期 / Server 重启**不保证**恢复；Client 重提为新 Workflow（沿用 §5.2），但必须定义旧 Workflow 的去向。
- **孤儿回收**：可配置宽限期（建议与 session TTL 一致）内等待重连；逾期无重连：
  - 若此前**未**表达取消意图 → 终止为 `FAILED`，`terminal_reason = client_unreachable`；
  - 若此前**已**表达取消意图 → 见 D-A5（取消意图优先，判 `CANCELLED`）。
  - 两种情况均**照常保存 Record**（假设 A-1）。

#### D-A4 取消 / 完成确认竞态

- Workflow Engine 单点串行处理，**以到达顺序为准**，先被接受者生效。
- 后到的冲突意图因终态不可变（D-A2）被忽略并告警。
- **Client MUST 在某一个意图提交后锁定确认 UI**，防止同一确认窗口内提交第二个互斥意图。
- 无新增状态、无优先级特例。跨 Client / 多设备在 v0.1 明确不支持。

#### D-A5 `CANCELLING` 的收敛条件

- 结束条件：当前不可中断 Step 到达**任一终态**（`COMPLETED` / `FAILED` / `UNKNOWN`），随后 Workflow → `CANCELLED`。
- 因用户已取消，`UNKNOWN` **不再对账**（Record 如实记 `UNKNOWN`）。
- 收敛期间 Client 失联：**取消意图优先** → 判 `CANCELLED`（保留 `terminal_reason`），不判 `FAILED`。
- `CANCELLING` 不再可能无限悬挂。

### B. 状态机未定义的转移

#### D-B1 人类等待与 `step_timeout`

- 按 `wait_reason` 分两类：
  - **执行类等待**（本地服务 / 设备响应 / 外部资源）受 `step_timeout`；
  - **人类等待**（`user_input` / `user_confirmation` / 人工对账）**完全豁免 `step_timeout`**。
- 人类等待只由：用户响应 / 用户取消 / 失联后的孤儿回收 结束。

#### D-B2 `WAITING` 状态下的取消

- `WORKFLOW_SPEC.md` §2.1 的判定从“Step 处于 `RUNNING`”推广为“**存在活跃 Step（见 §1.3）**”。
- 可中断性仍按该 Capability 的 `interruptible` 声明。
- 判定细化：
  - 无活跃 Step，或活跃 Step 仅为 `PENDING`（尚未执行）→ 立即 `CANCELLED`；
  - 活跃 Step 为 `RUNNING` 或执行类 `WAITING` → 看该 Capability 的 `interruptible`：`true` 立即 `CANCELLED`，`false` 进入 `CANCELLING`（收敛规则见 D-A5）；
  - 人类等待（确认前副作用尚未发生，或等工程师输入）→ 视为可中断，立即 `CANCELLED`。

#### D-B3 / D-B4 终止护栏（防无穷循环）

由 Workflow Engine 确定性强制执行（不依赖 LLM 自觉）：

| 护栏 | 建议默认 | 触顶后 |
|---|---|---|
| `max_steps_per_workflow` | 50 | `FAILED(step_limit)` |
| 同一 Capability 连续重试上限（仅只读） | 2 次重试（共 3 次尝试） | `FAILED(retry_limit)` |
| `max_not_solved_rounds` | 5 | `FAILED(user_round_limit)` |
| Workflow 总时长预算 | 默认不限（可配置） | `FAILED(time_budget)` |

- 全部可配置；任一触顶 → 保存 Record。

#### D-B6 同一 Client 多个并发 Workflow 的副作用串行化

- **会话级串行化**：同一 `session` 内，任意时刻最多一个**副作用 Step 处于活跃状态**（活跃定义见 §1.3：`PENDING` / `RUNNING` / `WAITING`）。
- 只读 Step 可并发。
- 不引入硬件资源 / 目标模型。
- 与 D-A1 的“副作用阻塞”共同成立：既阻断同 Workflow 内的重复动作，也阻断跨 Workflow 的并发副作用。

### C. 接口规范

#### D-C1 Capability 输入 / 输出 Schema

- **语言**：JSON Schema 的**受限子集**（`type` / `properties` / `required` / `enum` / `items`；不引入外部 `$ref` 与复杂组合）。
- **载体（双重）**：
  - `CAPABILITY_SPEC.md` 登记标准 Capability 的 schema（文档权威）；
  - Manifest / `session.hello` 运行时携带 schema（自包含，与 `requires_confirmation` 同一设计原则）。
- **校验（两端）**：
  - Server 下发前校验 `step.dispatch.input`；不合 schema 属 Server 侧问题，不应下发；
  - Client 收到不合 schema 的 `input` → `step.status(REJECTED, reject_reason.code = invalid_input)`；
  - Client 返回的 `evidence.result` 不合 output schema → Server 记 `FAILED`，`fail_reason.code = invalid_output` 并告警。
- `expected_output` 保留，语义改为 **output schema 的名称引用**。

#### D-C2 完成条件（`completion_criteria`）

- 完成条件是 **Request 级**，不归 Capability。
- Planner 在创建 / 推进 Workflow 时产出并显式记录 `completion_criteria`：
  - 可形式化 → 一组可判定断言；
  - 否则标记 `open-ended`，走 LLM Completion Proposal + Workflow Engine 确认（`WORKFLOW_SPEC.md` §8）。
- 作为 Workflow 状态持久化，可被修订；**每次修订入 Record**，使“为什么判定完成”可追溯。
- **明确 `CAPABILITY_SPEC.md` 不声明完成条件**——关闭 `REQUIREMENTS.md` §7 对 `CAPABILITY_SPEC.md` 的待办（原清单 F1）。

#### D-C3 `step_timeout` 配置来源

- Capability Manifest 新增可选 `timeout_hint`（建议超时 / 预期时长），并在 `CAPABILITY_SPEC.md` 登记。
- Server 可覆盖并设硬上限；未声明时用全局默认。

#### D-C4 Evidence 的 `source` / `type` 受控词表

- `source` 限定为来源类别（`capability` / `user_input` / `system`，登记管理）。
- `type` 与对应 Capability 的 output schema 绑定并登记。
- Server 用 output schema 校验 `result`；`type` 与声明不一致，或 `result` 不合 schema → `FAILED`，`fail_reason.code = invalid_output`，并告警。

#### D-C5 `human.manual_action` 反馈结构

```text
manual_action_result:
  outcome: succeeded | failed | partially | unknown
  observation: <string，工程师原话>
  details?: <自由对象>
```

- 作为保留 Capability 的 output schema 登记在 `CAPABILITY_SPEC.md`。

#### D-C6 附件与大体积 Evidence 传输

- 主协议只传**引用**：`{ content_ref, media_type, size, sha256, name }`。
- 二进制经**独立 blob 通道**（分块上传 / 下载，带鉴权与生命周期）传输。
- 定义大小上限与允许的 `media_type` 白名单，超限拒收。
- Record 保留 `content_ref`，使证据可回溯。
- 建议默认（可配置）：内联阈值 64 KiB；单 blob 上限 512 MiB；`content_ref` 有 TTL。

#### D-C7 `record.list` 语义

- `filters.time_range`：ISO 8601 闭区间，按 `ended_at`。
- `filters.keyword`：`summary` + `entries[].narrative` 的不区分大小写子串匹配。
- `filters.terminal_state`：可选枚举（新增，便于筛选）。
- `cursor`：Server 生成的不透明 token；排序键 = `ended_at` 倒序 + `record_id` 稳定 tiebreak。
- `page_size`：默认 20，上限 100。
- Record **详情不分页**（`entries` 完整返回；未来超大再议）。

#### D-C8 `protocol.error` 处置矩阵

| code | 处置 |
|---|---|
| `unsupported_version` | 致命：断开（不下发 `session.welcome`） |
| `session_expired` | 致命：Client 重新 `session.hello`；未完成工作作为新 `workflow.request` 提交 |
| `unknown_record` | 请求级失败（连接继续） |
| `unknown_workflow` | 请求级失败 |
| `unknown_step` | 请求级失败 |
| `malformed_payload` | 请求级失败（丢弃该消息 + 告警） |
| `unknown_message_type` | 可忽略 + 告警 |

- **明确规定：收到无法识别的消息类型不得断开连接**（与 §6 对未登记 Capability“忽略并告警”一致）。

### D. 错误处理与幂等

#### D-D1 `workflow.request` 幂等

- Client 为每个请求生成稳定的 `client_request_id`。
- Server 按 `(session_id, client_request_id)` 去重，重复请求返回同一 `workflow_id`。
- 作用域限 session（与 D-A3 一致：跨 session 重提仍是有意为之的新 Workflow）。

#### D-D2 Report 生成失败

- `report.generate_result` 新增 `status: ok | failed`。
- `failed` 时携带 `error_code`：`generation_failed` / `insufficient_content` / `invalid_option` / `timeout`，以及 `message`。
- Client 展示失败并可重试；不写 Record。

#### D-D3 Record 落盘失败与终止通知

- 顺序固定：**先持久化 Record，成功后再发 `workflow.terminated`（带有效 `record_id`）**。
- 落盘失败按策略重试（指数退避）。
- 重试耗尽仍失败：**仍必须发 `workflow.terminated`**（终态已定，不可回退），但 `record_id = null` 且携带显式标记 `record_persistence_failed = true`，同时服务端告警。
- Client 据此知道“已终止但记录不可用”。

#### D-D4 `narrative` 生成

- 分层：
  - 结构化字段由确定性代码生成；
  - `narrative` 优先用确定性模板（基于 `kind` + `ref`）；
  - 仅当涉及无法模板化的自然语言（如 `user_input` 反馈）时用 LLM 润色。
- 无论哪种，生成后做**一致性校验**（不得引入 `ref` 之外的实体 / 数值）；失败回退模板。
- `narrative` 生成失败**绝不阻塞 Record 落盘**。关闭 `RECORD_SPEC.md` §9-1。

### E. 协议一致性

#### D-E1 应用层心跳

- 保留 `heartbeat_interval_ms`，正名为**应用层心跳间隔**。
- 新增 `session.heartbeat`（Client → Server），**仅当 transport 无原生保活时启用**。
- Server 连续 N 个间隔未收到 → 判连接失效，触发 D-A3 的宽限 / 回收。
- WebSocket 等有原生 ping/pong 时可忽略，不增开销。

#### D-E2 `capability.sync` 版本与在途规则

- 新增会话内**单调递增 `revision`**；`session.hello` 内联能力记为 `revision: 0`。
- Server 只应用更高 `revision`；陈旧 / 乱序丢弃并告警。
- 能力变化**只影响未来 dispatch**，不影响已下发 Step。
- 若 Client 收到引用已不可用能力的 Step → `REJECTED(capability_unavailable)`。

#### D-E3 `in_reply_to` 与去重窗口

- **必须**设置 `in_reply_to`：`session.welcome`、`workflow.created`、`workflow.cancel_ack`、`workflow.state_sync`、`record.list_response`、`record.get_response`、`report.generate_result`、以及回应某消息的 `protocol.error`。
- **主动推送**为 `null`：`step.dispatch`、`workflow.completion_candidate`、`workflow.terminated`。
- `step.status` **可选**指向对应 `step.dispatch`（便于调试）；关联**仍以 `step_id` 为准**。
- 去重窗口 = **会话生命周期**，会话结束清空；重复消息忽略并告警。
- 职责澄清：`message_id` 去重挡“同一条消息重传”；`idempotency_key` 挡“同一意图的语义重复”。

#### D-E4 时钟与排序权威

- `ts` 一律 **UTC（ISO 8601 带 `Z`）**，仅作展示。
- 排序与超时判定用 **Server 侧单调时钟 / 序列**，不做跨端 wall clock 比较。
- Record 的权威时间取 **Server 接收时间**；Client 自报时间仅供展示 / 调试。

#### D-E5 文档版本与协议版本解耦

- 见 §1.2。

### F. 可追溯

#### D-F2 用户身份预留

- 信封新增**可选** `user_id`（当前可为 `null` 且**不校验**）。
- Record 的人工决定条目新增**可选** `actor`。
- Report 模板预留“生成人”字段。
- 实际身份体系与鉴权仍由待建 Security Spec 承担（NFR-6）；本版本不强制、不校验。目的仅为**避免未来的破坏性变更**。

---

## 3. 各文件变更明细

> 说明：以下为落地要点，具体措辞在修订时按各文件既有风格展开。

### 3.1 `specs/WORKFLOW_SPEC.md`

- §2 状态机：补 `CANCELLING` 收敛规则（D-A5）；`terminal_reason` 扩展到 `FAILED`（新增 `client_unreachable` / `step_limit` / `retry_limit` / `user_round_limit` / `time_budget`）。
- §2.1 取消语义：判定条件推广为“活跃 Step（RUNNING/WAITING）”（D-B2）；取消意图优先（D-A5）；人类等待视为可中断。
- §4 Step 状态机：新增终态 `UNKNOWN`（D-A1）；终态不可变与迟到更新处理（D-A2）；对账流程；`idempotency_key` / `idempotent` 说明。
- §4.2 确认规则：补充“会话级副作用串行”引用（D-B6）。
- §5 Evidence：`source` / `type` 受控词表与 schema 绑定（D-C4）。
- 新增小节：`completion_criteria`（D-C2）；终止护栏（D-B3/B4）。
- §9 / §11 / §12：更新对应引用与待补项关闭情况（`PROTOCOL_SPEC` 已解决的项同步）。

### 3.2 `specs/PROTOCOL_SPEC.md`

- §2 信封：`user_id`（D-F2）、`in_reply_to` 分类（D-E3）、`ts` 规范（D-E4）、协议版本 `"0.3"`（D-E5）。
- §3 标识符：`client_request_id`（D-D1）、`idempotency_key`（D-A1）。
- §5 生命周期：`session.heartbeat`（D-E1）。
- §6 `capability.sync`：`revision`（D-E2）、`idempotent` / `timeout_hint` / `input_schema` / `output_schema`（D-A1/C1/C3）；在途规则。
- §7 `workflow.request` 带 `client_request_id`；`workflow.terminated` 增加 `record_persistence_failed`；排序/落盘顺序（D-D3）。
- §8 `step.status`：新增 `UNKNOWN` 状态；`fail_reason.code` 新增 `invalid_output`；`requires_confirmation` + `idempotency_key`；迟到状态处理引用（D-A2）。
- §9 心跳与超时：人类等待豁免（D-B1）；`timeout_hint`（D-C3）；Server 单调时钟（D-E4）。
- §10 `record.list`：过滤器 / 上限 / cursor / 排序（D-C7）。
- §11 Report：`status` + `error_code`（D-D2）。
- §12 错误处理：处置矩阵（D-C8）。
- 新增：附件结构与 blob 通道（D-C6）。
- §15 / §16：更新已解决与未解决待补项。

### 3.3 `specs/CAPABILITY_SPEC.md`

- §2 命名表：新增 `idempotent`、`timeout_hint` 列（D-A1/C3）。
- §3 Manifest：`input_schema` / `output_schema`（D-C1）、`idempotent`、`timeout_hint`。
- §4 动态更新：`revision`（D-E2）。
- §5 待补项：关闭 §5-1（schema 已定）、§5-2（映射到 D-C4 / D-C8）。
- §6 `human.manual_action`：`manual_action_result` schema（D-C5）。

### 3.4 `specs/RECORD_SPEC.md`

- §3 结构：新增 `completion_criteria`（D-C2）；`final_result` 覆盖 `UNKNOWN` 未对账情形（D-A1）；`terminal_reason` 覆盖 `FAILED`。
- §4 entries：新增 kind（建议 `step_outcome_unknown` / `step_reconciled` / `guardrail_triggered`）；条目可选 `actor`（D-F2）；`narrative` 生成规则（D-D4）。
- §9 待补项：关闭 §9-1（narrative 生成方式已定）。

### 3.5 `specs/REPORT_SPEC.md`

- §5 模板：结论渲染覆盖 `UNKNOWN` / `record_persistence_failed`；预留“生成人”（D-F2）。
- §6 边界：生成失败返回（D-D2）。

### 3.6 `architecture/SERVER_SPEC.md` / `CLIENT_SPEC.md` / `ARCHITECTURE.md`

- `SERVER_SPEC.md`：职责补 `completion_criteria`（D-C2）、终止护栏（D-B3/B4）、会话级副作用串行（D-B6）、幂等键生成（D-A1）。
- `CLIENT_SPEC.md`：职责补幂等台账（D-A1）、blob 通道（D-C6）、确认 UI 锁定（D-A4）、迟到状态处理（D-A2）。
- `ARCHITECTURE.md`：主循环图补 `UNKNOWN` 的说明；§4 MUST NOT 无需变化。

### 3.7 `REQUIREMENTS.md` / `PRODUCT.md`

- `REQUIREMENTS.md`：`NFR-3` 范围澄清（D-A3）；§7 影响表关闭 `CAPABILITY_SPEC` 待办（D-C2）；§4 非目标不变。
- `PRODUCT.md`：本次无产品决策变化，仅版本引用同步。

---

## 4. 新增 / 变更的协议要素汇总

- **Step 状态**：`+ UNKNOWN`（终态，可对账收敛）。Workflow 六状态不变。
- **Workflow 终态原因**：`terminal_reason` 扩展到 `FAILED`（`client_unreachable` / `step_limit` / `retry_limit` / `user_round_limit` / `time_budget`）。
- **消息**：`+ session.heartbeat`；`+` blob 控制消息（上传 / 下载引用）；Report 不新增消息（走 `status` 字段）。
- **Step `fail_reason.code`**：`+ invalid_output`。
- **新字段**：`client_request_id`、`idempotency_key`、`revision`、`user_id`、`idempotent`、`timeout_hint`、`input_schema`、`output_schema`、`record_persistence_failed`、`completion_criteria`、`actor`、`content_ref`。
- **保留 Capability**：`human.manual_action` 的 output schema 定为 `manual_action_result`。

---

## 5. 关闭与仍开放的待补项

### 5.1 本次关闭

| 待补项 | 出处 | 关闭方式 |
|---|---|---|
| Capability 输入 / 输出 Schema | `CAPABILITY_SPEC.md` §5-1 | D-C1 |
| Capability 声明真实性 | `CAPABILITY_SPEC.md` §5-2 | D-C4 / D-C8（运行时校验 + 明确错误码） |
| 大体积 / 二进制 Evidence 传输 | `PROTOCOL_SPEC.md` §16-4 | D-C6 |
| Schema 语言选型 | `PROTOCOL_SPEC.md` §16-2 | D-C1 |
| `narrative` 生成方式 | `RECORD_SPEC.md` §9-1 | D-D4 |
| `terminal_reason` 枚举细化 | `RECORD_SPEC.md` §9-4 | D-A3 / D-A5 / D-B3 |
| “完成条件是否随 Capability 声明” | `REQUIREMENTS.md` §7 | D-C2（明确不随 Capability） |

### 5.2 仍开放（本次明确不处理）

- 认证 / 授权 / 沙箱（Security Spec）
- 第三方 Knowledge Base 集成与 Record 导出
- 跨 Client 续接、多 Server 路由
- Record 修订机制、存储介质选型
- 多工程师同硬件冲突（A-2）
- 用户身份的实际校验（仅预留，D-F2）

---

## 6. 审阅指引（建议重点确认）

1. **D-A1**：`UNKNOWN` 作为新终态、以及“副作用不自动重试 + 对账”的整套语义，是本次最大的结构性改动。
2. **D-A3 / D-A5**：恢复边界收窄 + 孤儿回收 + “取消意图优先”，涉及 `NFR-3` 措辞变更。
3. **D-B3 / D-B4**：护栏的**默认数值**是否接受（50 / 2 / 5 / 不限）。
4. **D-B6**：会话级副作用串行是否符合预期（未引入资源模型）。
5. **D-C1**：JSON Schema 受限子集 + 双重载体，锁定了一个长期组件契约。
6. **D-C6**：blob 通道与默认阈值（64 KiB / 512 MiB / TTL）。
7. **D-E5 / §1.2**：协议版本 `"0.3"` 与文档版本解耦的推进规则。

---

## 7. 下一步

1. 产品方审阅本文件，提出修改或确认；
2. 确认后，按 §3 修订 `docs/` 下现有 Spec（各自 bump 版本 + 变更记录 + 交叉引用同步）；
3. 修订完成后再次审阅，并按需进入实现计划（writing-plans）。
