# PROTOCOL_SPEC.md

**Version:** v0.3（§11 引用状态同步：`REPORT_SPEC.md` 已建成；对齐 `WORKFLOW_SPEC.md` v0.3、`CAPABILITY_SPEC.md` v0.4、`RECORD_SPEC.md` v0.2，取代 v0.2）
**层级:** Specification — 消息 Schema 与传输机制
**拆分说明:** 本文件把 `WORKFLOW_SPEC.md` 定义的概念契约（Step/Evidence/Completion）和 `CAPABILITY_SPEC.md` 定义的能力命名，落地成 Client 与 Server 之间实际传输的消息格式。原 v0.2 `SERVER_SPEC.md` §20 只列出了消息名字，没有字段定义，也没有覆盖 Step ID、拒绝执行、超时、重连等场景——本文件不是把那份名单逐条填字段，而是重新设计了一套消息分类，§0 说明具体差异。

---

## 变更记录（v0.1 → v0.2）

这一版把最近几轮对齐 `PRODUCT.md`/`REQUIREMENTS.md` v0.6 时定下的新概念落成协议消息，具体来源：

- **Workflow 取消**（新增 §7.3）：`workflow.cancel_request` / `workflow.cancel_ack`，对应 `WORKFLOW_SPEC.md` v0.2 §2.1 的取消语义（立即生效 vs 排队等不可中断 Step 结束）。
- **Workflow 终止统一通知**（新增 §7.4）：`workflow.terminated`，Workflow 进入任一终止状态时推送，携带 `record_id`，把 COMPLETED/FAILED/CANCELLED 三种终止路径统一到一个信号里，同时把 v0.1 里"Client 怎么知道 Workflow 已经 COMPLETED"这个隐含依赖显式化。
- **Record 查询**（新增 §10）：`record.list_request/response`、`record.get_request/response`，对应 `RECORD_SPEC.md` 定义的结构；`record.get_response` 的 payload 直接是 `RECORD_SPEC.md` 定义的成品文档，不是协议消息重放（呼应此前"方向三"的讨论）。
- **Report 生成**（新增 §11）：`report.generate_request/result`，对应 `REQUIREMENTS.md` FR-17~FR-19。
- **`capability.sync` payload 补字段**（§6）：加上 `side_effect`、`interruptible`，对应 `CAPABILITY_SPEC.md` v0.3 §2.1、§2.2 的声明要求。
- **`step.dispatch` 补 `requires_confirmation` 字段**（§8）：对应 `WORKFLOW_SPEC.md` §4.2 的确认规则；同时明确 `WAITING(wait_reason=user_confirmation)` 和 `REJECTED(reject_reason=user_declined)` 是这条规则在协议层的落点，不是新概念。
- **"建议"路径确认不需要新消息类型**（§8.2）：`human.manual_action` 完全复用现有 `step.dispatch`/`step.status`，只是补一句说明，避免被误解为遗漏。
- **§14 补一条**：第三方 Knowledge Base 集成、Record 导出到该系统，明确本版本不涉及，不经过这条协议。
- 消息目录从 12 种增加到 21 种（§4）。

---

## 0. 与旧版本命名的关系

原 v0.2 的消息名单（`workflow.start` / `execution.request` / `execution.started` / `execution.waiting` / `execution.completed` / `execution.failed` / `evidence` / `capability.manifest` / `capability.updated` / `user.input.request` / `user.response` / `client.status`）是按"这一刻发生了什么事件"罗列的，问题是：

* `execution.started/waiting/completed/failed` 和独立的 `evidence` 消息之间的关系没有定义清楚——Evidence 是跟着 completed/failed 一起发，还是单独发？
* 没有 Step ID/Workflow ID，无法关联消息。
* 没有"拒绝执行"和"失败"的区分（见 `WORKFLOW_SPEC.md` §11-3）。
* 没有重连/断线恢复机制。
* `user.input.request` 单独作为一种消息类型，但 `WORKFLOW_SPEC.md` §4.1 已经说明 Execution-time 的用户交互本质上就是"某个 Step 本身就是在向用户提问"，不需要单独的消息类型来触发。

本文件重新设计了一套更小、更一致的消息集合，用状态机字段代替事件名的堆叠，用显式的会话/重连机制补上原来完全没有涉及的存活性问题。下文出现的每个消息名，除非特别说明,均视为对旧名单的替代,而不是别名。

---

## 1. 设计前提与 Transport 选型

`WORKFLOW_SPEC.md` 的 Execution Loop（`ADR-002` One-Step Planning）意味着 Client 与 Server 之间是**高频、小颗粒度的双向往返**：一个 Step 执行完就要立刻把 Evidence 传回去，Server 拿到 Evidence 立刻要能推送下一个 Step,中间不应该有轮询造成的延迟。

**决策：Client 与 Server 之间维持一条持久的双向连接**（如 WebSocket，或功能等价的双向流），而不是"Client 轮询 Server 要下一个 Step"的请求-响应模式。理由：

* One-Step Planning 要求 Server 能在任意时刻主动推送（`step.dispatch`），轮询天然有延迟且浪费资源。
* 一次会话内 Client 可能同时有多个 Workflow 在跑（见 §3），复用一条连接可以避免为每个 Workflow 建立独立连接。

本文件下方所有消息结构以 JSON 表示，这只是为了可读性——序列化格式（JSON / Protobuf / MessagePack）本身是可替换的实现细节，不影响这里定义的概念结构。

---

## 2. 消息信封（Envelope）

所有消息，无论方向，共享同一个信封结构：

```json
{
  "protocol_version": "0.2",
  "message_id": "msg_...",
  "session_id": "sess_... | null",
  "workflow_id": "wf_... | null",
  "type": "<message.type>",
  "ts": "2026-09-28T10:00:00Z",
  "in_reply_to": "message_id | null",
  "payload": { }
}
```

* `message_id`：每条消息唯一，用于 `in_reply_to` 关联和去重（同一 `message_id` 因重传被收到两次时，接收方应识别并忽略重复）。
* `session_id`：握手完成前为 `null`，此后所有消息必填。
* `workflow_id`：只有 Workflow 生命周期内的消息才需要；握手、Capability 声明、Record/Report 查询等消息为 `null`（Record/Report 查询携带的是 `record_id`，不是 `workflow_id`，见 §10、§11）。
* `in_reply_to`：应答类消息指向被应答消息的 `message_id`；主动发起的消息为 `null`。

---

## 3. 标识符体系

```text
session_id   一次逻辑会话（可跨越多次物理连接，见 §5 重连机制）
  └── workflow_id   一个 User Request 对应的 Workflow（一个 session 内可并存多个）
        └── step_id   一个 Workflow 内的具体 Step
```

**设计决策：一条连接可以承载多个并行 Workflow**，靠 `workflow_id` 区分，不要求"一个连接只服务一个任务"。这也顺带解决了此前讨论过的"单 Client 是否只能有一个 Workflow"的空白——本版本的答案是"可以有多个,但都挂在同一个 session 之下"。

跨 Client 续接同一个 Workflow（例如手机发起、电脑继续）不在 v0.1 范围内，见 §14。

---

## 4. 消息目录总览

| 消息类型 | 方向 | 用途 |
|---|---|---|
| `session.hello` | Client → Server | 建立连接，声明协议版本与初始 Capability |
| `session.welcome` | Server → Client | 确认协议版本，下发 `session_id` |
| `session.resume` | Client → Server | 断线重连后恢复会话 |
| `workflow.state_sync` | Server → Client | 重连后同步当前所有 Workflow 的真实状态 |
| `capability.sync` | Client → Server | 声明或更新本地 Capability（全量/增量） |
| `workflow.request` | Client → Server | 提交 User Request，创建新 Workflow |
| `workflow.created` | Server → Client | 确认 Workflow 已创建，返回 `workflow_id` |
| `step.dispatch` | Server → Client | 下发当前唯一的 Step |
| `step.status` | Client → Server | 报告 Step 状态变化（含 Evidence） |
| `workflow.completion_candidate` | Server → Client | 提出"可能已解决"，交给 User 确认 |
| `workflow.completion_response` | Client → Server | User 的最终确认结果 |
| `workflow.cancel_request`（v0.2 新增） | Client → Server | 工程师表达取消 Workflow 的意图 |
| `workflow.cancel_ack`（v0.2 新增） | Server → Client | 确认收到取消请求，告知当前是 `CANCELLING` 还是已直接 `CANCELLED` |
| `workflow.terminated`（v0.2 新增） | Server → Client | Workflow 进入任一终止状态（COMPLETED/FAILED/CANCELLED）时的统一通知，携带 `record_id` |
| `record.list_request`（v0.2 新增） | Client → Server | 查询历史 Record 列表 |
| `record.list_response`（v0.2 新增） | Server → Client | 返回 Record 摘要列表 |
| `record.get_request`（v0.2 新增） | Client → Server | 查询单条 Record 详情 |
| `record.get_response`（v0.2 新增） | Server → Client | 返回完整 Record（结构见 `RECORD_SPEC.md`） |
| `report.generate_request`（v0.2 新增） | Client → Server | 请求基于指定 Record 生成 Report |
| `report.generate_result`（v0.2 新增） | Server → Client | 返回生成的 Report |
| `protocol.error` | 双向 | 协议层错误 |

共 21 种（v0.1 是 12 种，本版本新增 9 种：取消相关 2 种 + 终止通知 1 种 + Record 查询 4 种 + Report 生成 2 种）。

---

## 5. 会话生命周期

### 5.1 建立连接

```text
Client                                Server
  │  session.hello                     │
  │  {supported_versions, client_info, │
  │   capabilities}                    │
  │ ───────────────────────────────────▶│
  │        session.welcome              │
  │  {protocol_version, session_id,     │
  │   heartbeat_interval_ms}            │
  │◀─────────────────────────────────── │
```

`session.hello` payload：

```json
{
  "supported_protocol_versions": ["0.2"],
  "client_info": { "name": "string", "platform": "string" },
  "capabilities": [
    {"name": "filesystem.read_file", "side_effect": false, "interruptible": true},
    {"name": "git.collect_diagnostics", "side_effect": false, "interruptible": true}
  ]
}
```

`session.welcome` payload：

```json
{
  "protocol_version": "0.2",
  "session_id": "sess_abc",
  "heartbeat_interval_ms": 15000
}
```

若 Server 不支持 Client 声明的任何一个版本，回复 `protocol.error`（code=`unsupported_version`）后主动断开连接，不下发 `session.welcome`。

### 5.2 断线重连

连接可能因为网络问题中断，重连后不做"重放丢失消息"这种复杂的补偿，而是直接同步当前真实状态：

```text
Client                                        Server
  │  session.resume                            │
  │  {session_id, known_workflows:[             │
  │    {workflow_id, last_known_step_id,        │
  │     last_known_status}]}                    │
  │ ────────────────────────────────────────────▶│
  │        workflow.state_sync                   │
  │  {resumed:true, workflows:[                  │
  │    {workflow_id, workflow_status,            │
  │     pending_step}]}                          │
  │◀──────────────────────────────────────────── │
```

若 `session_id` 已过期或不存在，Server 返回 `protocol.error`（code=`session_expired`），Client 应发起全新的 `session.hello`，并把还没确认完成的工作，作为新的 `workflow.request` 重新提交——本版本不做跨 session 的自动状态迁移，避免"看起来恢复了，实际状态对不上"的隐患。

---

## 6. Capability 声明协议

```json
{
  "type": "capability.sync",
  "payload": {
    "mode": "full",
    "added": [
      {"name": "docker.inspect_container", "side_effect": false, "interruptible": true},
      {"name": "test_rig.trigger_reset", "side_effect": true, "interruptible": false}
    ],
    "removed": []
  }
}
```

* `mode: "full"`：`added` 即为当前全部可用 Capability,`removed` 忽略。用于连接建立时（也可以直接内联在 `session.hello.capabilities` 里，二者等价，`capability.sync` 用于连接建立**之后**的更新）。
* `mode: "incremental"`：只携带本次变化的新增/移除项，Server 在自己的记录上做增量合并。
* **`side_effect`、`interruptible` 为必填字段**（v0.2 新增）：对应 `CAPABILITY_SPEC.md` §2.1、§2.2。Server 收到缺失这两个字段的声明时，应按该文件规定的保守默认值处理（`side_effect` 缺失视为 `true`，`interruptible` 缺失视为 `false`），而不是拒绝整条声明。

Capability 名称必须是 `CAPABILITY_SPEC.md` 中登记的标准名称；Server 收到未登记名称时不应报错拒绝整条消息，而应忽略该项并记录警告——避免因为一个新 Capability 命名还没来得及登记，整个连接被卡住。

---

## 7. Workflow 生命周期消息

### 7.1 创建

```text
Client                              Server
  │  workflow.request                 │
  │  {user_request:{text,...}}        │
  │ ──────────────────────────────────▶│
  │        workflow.created            │
  │  {workflow_id, workflow_status:    │
  │   "CREATED"} (in_reply_to 上一条)  │
  │◀────────────────────────────────── │
```

`workflow.request` payload：

```json
{
  "user_request": {
    "text": "项目起不来了，帮我看看",
    "attachments": [],
    "context": { "project_path": "/workspace/app" }
  }
}
```

`workflow.created` payload：

```json
{ "workflow_id": "wf_001", "workflow_status": "CREATED" }
```

`workflow_status` 完整枚举（v0.2 新增，此前只在示例里出现过 `"CREATED"`，未列全，对齐 `WORKFLOW_SPEC.md` §2）：

```text
CREATED | RUNNING | CANCELLING | COMPLETED | FAILED | CANCELLED
```

其中 `COMPLETED` / `FAILED` / `CANCELLED` 为终止态，`CANCELLING` 为过渡态（见 §7.3）。

### 7.2 完成确认

Completion 阶段（对应 `WORKFLOW_SPEC.md` §8-9）：

```text
Server                                        Client
  │  workflow.completion_candidate               │
  │  {summary, evidence_refs:[step_id,...]}      │
  │◀───────────────────────────────────────────── │
  │        workflow.completion_response           │
  │  {resolution:"solved"|"not_solved",feedback}  │
  │ ──────────────────────────────────────────────▶│
```

`resolution: "solved"` → Server 将 Workflow 转为 `COMPLETED`，随后按 §7.4 推送 `workflow.terminated`。
`resolution: "not_solved"` → Server 把 `feedback` 并入 Context，触发 Re-plan，下发新的 `step.dispatch`。

### 7.3 取消（v0.2 新增）

对应 `WORKFLOW_SPEC.md` §2.1 的取消语义。工程师可以在 `CREATED`/`RUNNING`/`CANCELLING` 期间的任意时刻发起：

```json
{
  "type": "workflow.cancel_request",
  "payload": { "workflow_id": "wf_001", "reason": "user_cancelled" }
}
```

`reason` 可选，取值参考 `RECORD_SPEC.md` §9-4（枚举尚未最终定案，本版本允许自由字符串，不强制校验）。

Server 的响应分两种情况：

```text
情况 A — 当前无 Step 在 RUNNING，或该 Step 的 Capability interruptible=true：
  Server                                        Client
    │  workflow.cancel_ack                        │
    │  {workflow_id, workflow_status:"CANCELLED"} │
    │◀───────────────────────────────────────────── │
    （随后按 §7.4 推送 workflow.terminated）

情况 B — 当前 Step 在 RUNNING 且 interruptible=false：
  Server                                        Client
    │  workflow.cancel_ack                        │
    │  {workflow_id, workflow_status:"CANCELLING"} │
    │◀───────────────────────────────────────────── │
    （Server 不再下发新 Step；当前 Step 继续走到
     step.status(COMPLETED) 或 step.status(FAILED)；
     该 Step 结束后，Workflow 终止为 CANCELLED，
     按 §7.4 推送 workflow.terminated，不触发 Re-plan）
```

`workflow.cancel_ack` 只表示"取消请求已收到、当前进入的中间状态"，**不是**终止通知——终止通知统一由 §7.4 的 `workflow.terminated` 承担，即使是情况 A（立即终止）也会紧接着收到一条 `workflow.terminated`，保持"终止通知只有一种消息"的一致性，Client 不需要区分"这次终止是走 cancel_ack 直接来的，还是走 terminated 来的"。

### 7.4 终止通知（v0.2 新增）

Workflow 进入任一终止状态时，Server 推送统一的通知：

```json
{
  "type": "workflow.terminated",
  "payload": {
    "workflow_id": "wf_001",
    "terminal_state": "COMPLETED",
    "terminal_reason": null,
    "record_id": "rec_001"
  }
}
```

`terminal_state` 取值 `COMPLETED | FAILED | CANCELLED`；`terminal_reason` 只在 `CANCELLED` 时可能非空。`record_id` 指向刚生成的 Record（见 `RECORD_SPEC.md` §2），Client 收到后即可用它发起 §10 的 Record 查询或 §11 的 Report 生成。

这条消息补上了 v0.1 一个隐含的空白：v0.1 里 Client 得知 Workflow 已经 `COMPLETED`，只能靠自己发出 `workflow.completion_response(solved)` 之后"顺理成章地认为"已经完成，Server 没有一条显式的确认/回执；`FAILED` 就更没有任何推送。v0.2 统一由 `workflow.terminated` 承担这个职责，三种终止路径都不例外。

---

## 8. Step 生命周期消息

`step.dispatch`（Server → Client）：

```json
{
  "workflow_id": "wf_001",
  "step_id": "step_009",
  "objective": "检查项目当前 Git 状态",
  "capability": "git.collect_diagnostics",
  "input": { "project_path": "/workspace/app" },
  "expected_output": "diagnostic_result",
  "requires_confirmation": false
}
```

`requires_confirmation`（v0.2 新增）：布尔值，由 Server 在生成 Step 时决定——默认取自该 Step 引用的 Capability 的 `side_effect` 声明，但 Server 可以针对个别 Step 显式覆盖为 `true`（例如某个本来无副作用的 Capability，在特定上下文下 Server 想多一层工程师确认）。这个字段是自包含的：Client 不需要回查此前收到的 Capability Manifest 才能决定要不要弹确认，看这一条 `step.dispatch` 就够了（详见 §8.2 的决策记录）。

`step.status`（Client → Server）是本文件里字段最多的消息，用一个 `status` 枚举 + 对应的补充字段，取代了原来 4 个独立的 `execution.*` 消息：

```json
{
  "workflow_id": "wf_001",
  "step_id": "step_009",
  "status": "RUNNING",
  "progress": { "ratio": 0.4, "message": "正在执行 git diff" },
  "wait_reason": null,
  "reject_reason": null,
  "fail_reason": null,
  "evidence": null
}
```

| status | 必填的补充字段 | 说明 |
|---|---|---|
| `RUNNING` | `progress`（可选） | 正在执行；长任务建议定期上报，用于 §9 的存活判定 |
| `WAITING` | `wait_reason` | 需要外部条件才能继续（用户输入/确认、本地服务、外部资源），Server 收到后**不触发 Re-plan**，只是等待同一个 Step 的下一次状态更新（对应 `WORKFLOW_SPEC.md` §4.1 路径 A） |
| `COMPLETED` | `evidence` | 成功完成，`evidence` 遵循 `WORKFLOW_SPEC.md` §5 的 envelope 格式 |
| `FAILED` | `fail_reason`，`evidence`（可选，部分证据） | 尝试执行但没成功。`fail_reason.code` 建议取值：`timeout` / `capability_error` / `invalid_input` / `dependency_unavailable` / `unknown` |
| `REJECTED` | `reject_reason` | **从未真正尝试执行**，Client 主动拒绝。`reject_reason.code` 建议取值：`permission_denied` / `capability_unavailable` / `user_declined` / `unsafe_operation` / `other` |

`FAILED` 与 `REJECTED` 的区分直接对应 `WORKFLOW_SPEC.md` §11-3 留的待补项：两者都会让 Server 决定"要不要换一种方式"，但含义不同——`FAILED` 通常意味着"这条路能走,这次没走通,可以重试或调整参数"；`REJECTED` 通常意味着"这条路本身不该走,换 Capability 或提请人工授权，而不是重试同样的请求"。

### 8.1 受控执行的确认流程（v0.2 新增）

对应 `WORKFLOW_SPEC.md` §4.2。`requires_confirmation: true` 的 Step，其生命周期是：

```text
Server 下发 step.dispatch(requires_confirmation=true)
        │
        ▼
Client 弹出确认 UI，同时上报
  step.status(WAITING, wait_reason={"code":"user_confirmation"})
        │
   ┌────┴────┐
   ▼         ▼
 确认         拒绝
   │         │
   ▼         ▼
step.status   step.status
(RUNNING,     (REJECTED,
 ...)          reject_reason=
               {"code":"user_declined"})
```

`wait_reason.code = "user_confirmation"` 和 `reject_reason.code = "user_declined"` 都是 v0.1 已有的字段和取值范围，本版本只是明确规定"这是确认流程在协议层的落点"，没有新增字段。

### 8.2 "建议"路径不需要新消息类型（v0.2 新增说明）

对应 `WORKFLOW_SPEC.md` §6.1（`human.manual_action`）：这条路径完整复用 `step.dispatch` / `step.status`，具体表现为：

* `step.dispatch.capability = "human.manual_action"`，`input.instruction` 是给工程师看的指令文本，`requires_confirmation` 恒为 `false`（`side_effect` 固定 `false`，见 `CAPABILITY_SPEC.md` §6）。
* Client 展示 `instruction`，上报 `step.status(WAITING, wait_reason={"code":"user_input"})`。
* 工程师反馈后，Client 上报 `step.status(COMPLETED, evidence={source:"user_input", type:"manual_action_result", result:{...}})`。

这里特意写明，是因为"建议"路径讨论了好几轮方案，容易让人以为协议层需要专门再加点什么——实际上不需要，记录于此避免被重新提出。

---

## 9. 心跳与超时策略

连接级别的存活检测（Client 是否还在线）交给 Transport 自身（如 WebSocket 的 ping/pong 帧），本文件不重复定义。

**应用层需要单独处理的是"连接还活着，但某个 Step 卡住了"**：

* Server 为每个处于 `RUNNING` / `WAITING` 的 Step 维护一个 `step_timeout`（具体时长由 Server 按 Capability 类型配置，本文件不固定数值）。
* 只要收到该 Step 的任意 `step.status`（哪怕只是 `progress` 更新），计时器重置。
* 超时未收到任何更新 → Server 将该 Step 标记为 `FAILED`（`fail_reason.code = "timeout"`），随后按 `WORKFLOW_SPEC.md` §4 的 FAILED 处理逻辑决定 Retry / Change Approach / 判断无法继续，而不需要 Client 主动上报。

---

## 10. Record 查询（v0.2 新增）

对应 `REQUIREMENTS.md` FR-14，结构定义见 `RECORD_SPEC.md`。

### 10.1 列表

```json
{
  "type": "record.list_request",
  "payload": {
    "filters": { "time_range": null, "keyword": null },
    "cursor": null,
    "page_size": 20
  }
}
```

```json
{
  "type": "record.list_response",
  "payload": {
    "records": [
      {
        "record_id": "rec_001",
        "workflow_id": "wf_001",
        "summary": { "problem_short": "...", "terminal_state": "COMPLETED", "result_short": "...", "duration": "PT12M" }
      }
    ],
    "next_cursor": null
  }
}
```

`records[].summary` 直接对应 `RECORD_SPEC.md` §5 的 `summary` 结构——列表视图不需要展开完整 Record。

### 10.2 详情

```json
{ "type": "record.get_request", "payload": { "record_id": "rec_001" } }
```

```json
{
  "type": "record.get_response",
  "payload": { "record": { /* 完整结构见 RECORD_SPEC.md §3 */ } }
}
```

`record.get_response.payload.record` 就是 `RECORD_SPEC.md` 定义的成品文档本身，**不是**对当年协议消息的重放——这是"方向三"讨论后的直接结果：Server 不需要维护"按历史协议版本解析"的逻辑，直接把已经生成好的 Record 文档发出去即可。

请求了不存在的 `record_id` 时，Server 返回 `protocol.error`（code=`unknown_record`，v0.2 新增错误码，见 §12）。

---

## 11. Report 生成（v0.2 新增）

对应 `REQUIREMENTS.md` FR-17~FR-19。

```json
{
  "type": "report.generate_request",
  "payload": { "record_id": "rec_001", "options": { "detail_level": "full" } }
}
```

```json
{
  "type": "report.generate_result",
  "payload": {
    "record_id": "rec_001",
    "report": { "format": "markdown", "content": "..." }
  }
}
```

* `options.detail_level` 的具体取值范围（`summary` / `full`）由 `REPORT_SPEC.md` §3 定义；`report.format` 的取值（本版本固定为 `markdown`）由 `REPORT_SPEC.md` §4 定义。本文件只约定字段位置。
* 生成 Report **不修改** Record，也不创建新的 `record_id`；同一个 `record_id` 可以多次调用 `report.generate_request`，每次都基于当时的（不会变化的）Record 内容重新生成。
* 请求了不存在的 `record_id` 时，同样返回 `protocol.error`（code=`unknown_record`）。

---

## 12. 错误处理

`protocol.error`（双向）：

```json
{
  "code": "unsupported_version",
  "message": "server only supports protocol_version 0.2",
  "in_reply_to": "msg_123"
}
```

建议的最小 `code` 集合（v0.2 新增 `unknown_record`）：`unsupported_version` / `session_expired` / `unknown_message_type` / `malformed_payload` / `unknown_workflow` / `unknown_step` / `unknown_record`。

`protocol.error` 描述的是**协议层面**的问题（消息格式错、版本不兼容、引用了不存在的 workflow_id/record_id），不同于 `step.status(FAILED)` 描述的**业务执行层面**的失败——不要把两者混用。

---

## 13. 协议版本协商

`session.hello.supported_protocol_versions` 允许 Client 声明自己支持的版本列表（数组，为未来多版本共存留空间）；Server 从中选择自己也支持的最高版本，写入 `session.welcome.protocol_version`。之后同一连接内的所有消息隐式使用这个协商结果，信封里的 `protocol_version` 字段仅用于日志/调试，不再重复协商。

---

## 14. 完整时序示例

**正常路径：**

```text
session.hello → session.welcome
workflow.request → workflow.created
step.dispatch(S1) → step.status(S1, RUNNING) → step.status(S1, COMPLETED, evidence)
step.dispatch(S2) → step.status(S2, COMPLETED, evidence)
...
workflow.completion_candidate → workflow.completion_response(solved)
workflow.terminated(COMPLETED, record_id=rec_001)
```

**受控执行需要确认：**

```text
step.dispatch(S3: test_rig.trigger_reset, requires_confirmation=true)
  → step.status(S3, WAITING, wait_reason.code=user_confirmation)
  → 工程师确认
  → step.status(S3, RUNNING) → step.status(S3, COMPLETED, evidence)
```

**建议路径：**

```text
step.dispatch(S4: human.manual_action, input.instruction="请重新连接 CAN 总线适配器")
  → step.status(S4, WAITING, wait_reason.code=user_input)
  → 工程师反馈
  → step.status(S4, COMPLETED, evidence={source:user_input, type:manual_action_result, result:{...}})
```

**拒绝执行：**

```text
step.dispatch(S5: docker.inspect_container)
  → Client 检测到本地无 docker 访问权限
step.status(S5, REJECTED, reject_reason.code=permission_denied)
  → Server 不重试同一个 Step，而是重新规划（换 Capability，或生成一个请求用户授权的 Step）
```

**超时重试：**

```text
step.dispatch(S6)
step.status(S6, RUNNING, progress=0.1)
... 超过 step_timeout，未再收到任何更新 ...
Server 内部：S6 → FAILED(fail_reason.code=timeout)
Server Re-plan：视情况 Retry 同一 Capability，或 Change Approach
```

**断线重连：**

```text
[连接中断，S6 仍处于 RUNNING]
Client 重新连接
session.resume(session_id, known_workflows=[{wf_001, step_009, RUNNING}])
  → session_id 仍有效：
      workflow.state_sync(resumed=true, workflows=[{wf_001, RUNNING, pending_step: step.dispatch(S6)}])
      Client 据此确认自己应该继续执行 S6，而不是重新开始
  → session_id 已过期：
      protocol.error(session_expired)
      Client 走 session.hello 重新握手，未完成的工作作为新的 workflow.request 提交
```

**取消——立即生效（当前 Step 可中断）：**

```text
workflow.cancel_request(wf_002, reason=user_cancelled)
  → 当前 S7 的 Capability interruptible=true
workflow.cancel_ack(wf_002, workflow_status=CANCELLED)
workflow.terminated(wf_002, terminal_state=CANCELLED, record_id=rec_002)
```

**取消——排队等待（当前 Step 不可中断）：**

```text
workflow.cancel_request(wf_003, reason=abandoned)
  → 当前 S8 的 Capability interruptible=false
workflow.cancel_ack(wf_003, workflow_status=CANCELLING)
  → Server 不再下发新 Step
step.status(S8, COMPLETED, evidence)   # S8 自然跑完
  → Server 不触发 Re-plan
workflow.terminated(wf_003, terminal_state=CANCELLED, terminal_reason=abandoned, record_id=rec_003)
```

**查看历史 Record 并生成报告：**

```text
record.list_request → record.list_response(records=[...])
record.get_request(rec_001) → record.get_response(record={...})
report.generate_request(rec_001, detail_level=full) → report.generate_result(report={...})
```

---

## 15. 已解决的历史待补项

| 待补项 | 出处 | 本文件的解决方式 |
|---|---|---|
| Step ID / Workflow ID | `WORKFLOW_SPEC.md` §11-1 | 信封中的 `workflow_id` / `step_id`（§2、§3） |
| "拒绝执行" 与 "执行失败" 的区分 | `WORKFLOW_SPEC.md` §11-3 | `step.status.status` 新增独立的 `REJECTED`，与 `FAILED` 完全分开，各自有专属的 reason 结构（§8） |
| Step 超时 / Liveness | `WORKFLOW_SPEC.md` §11-4 | §9 心跳与超时策略 |
| Capability 声明与实际不符 | `CAPABILITY_SPEC.md` §5-2 | 实际调用失败时统一走 `FAILED(fail_reason.code=capability_error)`，不会静默 |
| 单 Client 多 Workflow 的关系 | （此前讨论中提出的空白） | §3：一条连接、一个 session，可并存多个 workflow_id |
| Workflow 取消语义（v0.2 新增） | `WORKFLOW_SPEC.md` §2.1 | §7.3：`workflow.cancel_request/ack`，区分立即生效与排队等待 |
| Workflow 终止如何通知 Client（v0.2 新增） | 本次讨论中发现的隐含空白 | §7.4：`workflow.terminated` 统一三种终止路径 |
| 有副作用动作的确认流程（v0.2 新增） | `WORKFLOW_SPEC.md` §4.2 | §8.1：`requires_confirmation` + 既有的 `WAITING`/`REJECTED` |
| "建议"路径的消息形态（v0.2 新增） | `WORKFLOW_SPEC.md` §6.1 | §8.2：复用现有 Step/Evidence，不新增消息类型 |
| Record 查看、Report 生成（v0.2 新增） | `REQUIREMENTS.md` FR-14、FR-17~19 | §10、§11 |

**注意**：Capability 输入/输出 Schema（`CAPABILITY_SPEC.md` §5-1）**没有**在本文件解决——本文件只定义了 `step.dispatch.input` 是一个自由结构的对象，具体每个 Capability 该填什么字段，仍然需要回到 `CAPABILITY_SPEC.md` 里逐个补充，本文件只是把"传输容器"准备好了。

---

## 16. 仍未解决 / 明确留给后续版本

1. **认证与授权**：连接建立、Capability 调用的权限校验，明确留给后续的 Security Spec，本文件不涉及。
2. **Capability 参数的强类型 Schema 语言尚未选型**：是用 JSON Schema、Protobuf，还是自定义的最小类型描述，本版本没有决定，`step.dispatch.input` 目前只是一个自由结构的对象。
3. **跨 Client 续接同一 Workflow**：例如手机发起、电脑继续同一个 `workflow_id`。本版本明确不支持——`session.resume` 只在同一逻辑 session（同一个 Client 实例）内工作。
4. **大体积/二进制 Evidence 的传输方式**：例如日志文件、截图作为 Evidence 时，是内联 base64 还是走单独的文件通道，未定义。
5. **多 Server 实例下的 Workflow 路由**：一个 Workflow 该固定在哪个 Server 实例上处理，如何做水平扩展，不在本文件范围内。
6. **第三方 Knowledge Base 集成、Record 导出到该系统**（v0.2 新增明确说明）：`SERVER_SPEC.md` v0.4 已经确认第三方 Knowledge Base 检索由 Server 直接对接，不经过 Client，因此**不经过这条 Client-Server 协议**；Record 未来是否导出到该系统（`REQUIREMENTS.md` FR-24）同样不在本文件范围内——本版本明确不涉及，不是遗漏。
