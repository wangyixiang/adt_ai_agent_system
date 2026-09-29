# PROTOCOL_SPEC.md

**Version:** v0.7（重连认证、会话 TTL 与 `workflow.state_sync` 字段；v0.6 的字段澄清——`record.list_response` 的摘要用 `duration_ms`（毫秒整数），与 `RECORD_SPEC.md` v0.5 对齐——继续有效）
**层级:** Specification — 消息 Schema 与传输机制
**拆分说明:** 本文件把 `WORKFLOW_SPEC.md` 定义的概念契约（Step/Evidence/Completion）和 `CAPABILITY_SPEC.md` 定义的能力命名，落地成 Client 与 Server 之间实际传输的消息格式。原 v0.2 `SERVER_SPEC.md` §20 只列出了消息名字，没有字段定义，也没有覆盖 Step ID、拒绝执行、超时、重连等场景——本文件不是把那份名单逐条填字段，而是重新设计了一套消息分类，§0 说明具体差异。

---

## 变更记录（v0.6 → v0.7）

依据 `ADR-003`（部署与信任模型）与 `WORKFLOW_SPEC.md` §2.2：

- **`session.resume` 携带认证凭据**（§5.2）：`{ session_id, auth: { username, secret }, known_workflows }`。认证失败 → `protocol.error(code=auth_failed)`（致命）；`session_id` 未知/过期 → `protocol.error(code=session_expired)`（致命）。依据 `ADR-003` §3"Server 只接受已认证的 Client"。
- **会话 TTL**（§5.2）：断线后 `session_id` 在可配置 TTL 内仍可 `resume`；建议默认 24 小时。超过 TTL 视为 `session_expired`。
- **`workflow.state_sync.workflows[]` 扩展**（§5.2）：新增 `record_id` / `record_persistence_failed`；明确范围为"该 session 下所有非终态 Workflow，加上 `known_workflows` 中已被 Server 判定为终态的 Workflow"，使断线期间发生的终止也能被对账。

---

## 变更记录（v0.4 → v0.5）

依据 `ADR-003`（部署与信任模型）与 MVP 范围说明：

- **认证握手**（§5.1）：`session.hello` 携带认证凭据；认证失败返回 `protocol.error(code=auth_failed)` 并断开。
- **`user_id` 启用**（§2）：从 v0.4 的"预留"变为握手后**必填、由 Server 校验**。
- **Record 按用户过滤**（§10）：`record.list` / `record.get` 只能访问当前认证用户自己的 Record。
- **KB 导出半边**（§10.3 新增）：`record.export_request` / `record.export_result`，提交人显式发起，KB 侧接收与审核不在本系统内。
- **错误码**（§12）：新增 `auth_failed`（致命）。
- 消息目录从 24 种增加到 26 种（§4）。

---

## 变更记录（v0.3 → v0.4）

这一版把缺口评审中定下的新约束落成协议消息，来源为 `docs/superpowers/specs/2026-09-29-spec-gap-closure-design.md`：

- **信封扩展**（§2）：新增可选 `user_id`（预留，不校验）；明确 `in_reply_to` 分类；`ts` 统一 UTC；去重窗口 = 会话生命周期。
- **协议版本解耦**（§2、§13）：文档版本号与协议版本号各自独立推进；协议版本更新为 `"0.3"`。
- **幂等标识**（§3、§7.1、§8）：`workflow.request` 新增 `client_request_id`；有副作用的 Step 新增 `idempotency_key`。
- **`step.status` 新增 `UNKNOWN`**（§8）：副作用动作结果不确定时的终态；配套 §4.3 的对账。
- **`fail_reason.code` 新增 `invalid_output`**（§8）：Client 返回的 Evidence `result` 不合 output schema。
- **`capability.sync` 扩展**（§6）：新增 `revision`、`idempotent`、`timeout_hint`、`input_schema` / `output_schema`；明确在途规则。
- **应用层心跳**（§5、§9）：新增 `session.heartbeat`，仅在 transport 无原生保活时启用。
- **附件与大体积 Evidence**（§7.5 新增）：主协议只传引用，二进制走独立 blob 通道。
- **`workflow.terminated` 扩展**（§7.4）：补 `terminal_reason` 语义与 `record_persistence_failed`；明确"先落盘后通知"。
- **`record.list` 语义**（§10）：过滤器、`page_size` 上限、cursor 与排序。
- **Report 失败路径**（§11）：`report.generate_result` 新增 `status` / `error_code`。
- **错误处置矩阵**（§12）：每个 `protocol.error` code 的必填动作与致命性分级。
- 消息目录从 21 种增加到 24 种（§4：+`session.heartbeat`、+blob 申请/响应）。

---

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
  "protocol_version": "0.3",
  "message_id": "msg_...",
  "session_id": "sess_... | null",
  "workflow_id": "wf_... | null",
  "user_id": "usr_... | null",
  "type": "<message.type>",
  "ts": "2026-09-28T10:00:00Z",
  "in_reply_to": "message_id | null",
  "payload": { }
}
```

* `protocol_version`：见 §13。当前为 `"0.3"`；仅用于日志 / 调试，实际以握手协商结果为准。
* `message_id`：每条消息唯一，用于 `in_reply_to` 关联和去重（同一 `message_id` 因重传被收到两次时，接收方应识别并忽略重复）。**去重窗口 = 会话生命周期**（会话结束即清空）；超出窗口的重传视为新消息。注意：`message_id` 去重只挡"同一条消息重传"，"同一意图的语义重复"由 §3 的 `idempotency_key` 负责，两者不可互相替代。
* `session_id`：握手完成前为 `null`，此后所有消息必填。
* `workflow_id`：只有 Workflow 生命周期内的消息才需要；握手、Capability 声明、Record/Report 查询等消息为 `null`（Record/Report 查询携带的是 `record_id`，不是 `workflow_id`，见 §10、§11）。
* `user_id`（v0.4 预留，v0.5 **启用**）：握手完成后**必填**，由 Server 依据认证结果填充并校验；未认证的连接不得进入业务消息（详见 §5.1、`ADR-003` §3）。
* `ts`：发生时间，**一律 UTC（ISO 8601 带 `Z`）**，仅用于展示/调试。消息排序与超时判定以 **Server 侧单调时钟/序列**为准，不做跨端 wall clock 比较（见 §9）。
* `in_reply_to`：**必须**设置的消息（指向被应答消息的 `message_id`）：`session.welcome`、`workflow.created`、`workflow.cancel_ack`、`workflow.state_sync`、`record.list_response`、`record.get_response`、`report.generate_result`、`blob.allocate_response`，以及回应某消息的 `protocol.error`。**主动推送**（`session.heartbeat` 除外）为 `null`：`step.dispatch`、`workflow.completion_candidate`、`workflow.terminated`。`step.status` 为**可选**：可指向对应的 `step.dispatch` 便于调试，但关联仍以 `step_id` 为准。

---

## 3. 标识符体系

```text
session_id   一次逻辑会话（可跨越多次物理连接，见 §5 重连机制）
  └── workflow_id   一个 User Request 对应的 Workflow（一个 session 内可并存多个）
        └── step_id   一个 Workflow 内的具体 Step
```

**设计决策：一条连接可以承载多个并行 Workflow**，靠 `workflow_id` 区分，不要求"一个连接只服务一个任务"。这也顺带解决了此前讨论过的"单 Client 是否只能有一个 Workflow"的空白——本版本的答案是"可以有多个,但都挂在同一个 session 之下"。

**另外两个标识（v0.4 新增）：**

* `client_request_id`：由 Client 为一个 `workflow.request` 生成、重发时保持不变；Server 按 `(session_id, client_request_id)` 去重，避免"提交成功但回包丢失"导致重复创建 Workflow（见 §7.1）。作用域限 session。
* `idempotency_key`：由 Server 为"同一意图"生成、在 Workflow 内稳定，随 `step.dispatch` 下发；Client 持久化"键 → 结果"台账，用于幂等重试（见 §8）。仅 `side_effect: true` 的 Step 需要。

**会话级副作用串行（v0.4 新增）：** 同一 `session` 内，任意时刻最多一个副作用 Step 处于活跃状态（`PENDING` / `RUNNING` / `WAITING`），只读 Step 可并发；Server 负责保证（见 `WORKFLOW_SPEC.md` §4.4）。

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
| `session.heartbeat`（v0.4 新增） | Client → Server | 应用层心跳，仅当 transport 不提供原生保活时启用（§5、§9） |
| `blob.allocate_request`（v0.4 新增） | Client → Server | 申请一个内容引用与 blob 传输通道（上传或下载，§7.5） |
| `blob.allocate_response`（v0.4 新增） | Server → Client | 返回 `content_ref` 与带鉴权、有生命周期的传输地址（§7.5） |
| `record.export_request`（v0.5 新增） | Client → Server | 提交人请求把某条 Record/Report 导出到第三方 Knowledge Base（§10.3） |
| `record.export_result`（v0.5 新增） | Server → Client | 返回导出结果（成功 / 失败） |
| `protocol.error` | 双向 | 协议层错误 |

共 26 种（v0.4 为 24 种；本版本新增 2 种：KB 导出请求 / 结果）。

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
  "supported_protocol_versions": ["0.3"],
  "client_info": { "name": "string", "platform": "string" },
  "auth": { "username": "engineer_a", "token": "..." },
  "capabilities": [
    {"name": "filesystem.read_file", "side_effect": false, "interruptible": true,
     "idempotent": false, "timeout_hint": 2000,
     "input_schema": { }, "output_schema": { }},
    {"name": "git.collect_diagnostics", "side_effect": false, "interruptible": true,
     "input_schema": { }, "output_schema": { }}
  ]
}
```

`session.welcome` payload：

```json
{
  "protocol_version": "0.3",
  "session_id": "sess_abc",
  "user_id": "usr_a",
  "heartbeat_interval_ms": 15000
}
```

若 Server 不支持 Client 声明的任何一个版本，回复 `protocol.error`（code=`unsupported_version`）后主动断开连接，不下发 `session.welcome`。

**认证（v0.5 新增，依据 `ADR-003` §3）：** `session.hello.auth` 携带凭据（用户名 + 密码/令牌）。Server 校验通过后，在 `session.welcome.user_id` 返回该用户的稳定标识；此后信封中的 `user_id` **必填**且必须与之匹配。认证失败：回复 `protocol.error`（code=`auth_failed`）后主动断开，不下发 `session.welcome`。凭据的具体形态（密码 / 令牌 / 过期与刷新）由实现决定；本版本**不要求 TLS**（见 `ADR-003` §4）。

**应用层心跳（v0.4 新增）：** `heartbeat_interval_ms` 表示建议的**应用层心跳**间隔（其字段名沿用 v0.3，语义由此明确）。若 transport 自身提供等价保活（如 WebSocket ping/pong），Client 可忽略该值、不发送 `session.heartbeat`；否则 Client 应按该间隔发送 `session.heartbeat`（`in_reply_to` 为 `null`，无响应）。Server 连续多个间隔未收到时判连接失效，触发 `WORKFLOW_SPEC.md` §2.2 的孤儿宽限 / 回收。具体失效判定阈值由 Server 配置。

### 5.2 断线重连

连接可能因为网络问题中断，重连后不做"重放丢失消息"这种复杂的补偿，而是直接同步当前真实状态：

```text
Client                                        Server
  │  session.resume                            │
  │  {session_id, auth:{username, secret},      │
  │   known_workflows:[                         │
  │    {workflow_id, last_known_step_id,        │
  │     last_known_status}]}                    │
  │ ────────────────────────────────────────────▶│
  │        workflow.state_sync                   │
  │  {resumed:true, workflows:[                  │
  │    {workflow_id, workflow_status,            │
  │     pending_step, record_id,                 │
  │     record_persistence_failed}]}             │
  │◀──────────────────────────────────────────── │
```

**认证（v0.7 新增）：** 重连是一条新的物理连接，因此 `session.resume` 必须**同时**携带 `auth`（结构同 `session.hello.auth`）。依据 `ADR-003` §3"Server 只接受已认证的 Client"：认证失败 → `protocol.error(code=auth_failed)`（致命，断开）；认证用户与 `session_id` 归属的 `user_id` 不符（尝试接管他人会话）→ 同样 `auth_failed`（致命）。凭据校验发生在会话查找**之前**。

**会话 TTL（v0.7 新增）：** 物理连接断开后，`session_id` 在 Server 可配置的 TTL 内仍然有效，可被 `resume` 恢复；建议默认 **24 小时**。超过 TTL（或 `session_id` 不存在）→ `protocol.error(code=session_expired)`（致命）。Resume 成功时**复用原 `session_id`**、保留会话级 `message_id` 去重窗口（§2）与 Capability 声明，并把新物理连接绑定到该逻辑会话。

`workflow.state_sync.workflows[]`（v0.7 扩展）：

```text
{workflow_id, workflow_status,
 pending_step: <step.dispatch payload> | null,
 record_id: string | null,
 record_persistence_failed: boolean}
```

* `workflows` 的范围：该 session 下**所有非终态** Workflow，**加上** `known_workflows` 中已被 Server 判定为终态的 Workflow（让断线期间发生的终止也能被对账）。`known_workflows` 仅用于挑选这些对账项，状态一律以 Server 为准。
* `pending_step`：该 Workflow 当前活跃 Step 的 `step.dispatch` 载荷（无则为 `null`）；Client 据此继续执行，而不是重新开始。
* `record_id` / `record_persistence_failed`：Workflow 已终态时指向其 Record；未终态时分别为 `null` / `false`。

若 `session_id` 已过期或不存在，Server 返回 `protocol.error`（code=`session_expired`），Client 应发起全新的 `session.hello`，并把还没确认完成的工作，作为新的 `workflow.request` 重新提交——本版本不做跨 session 的自动状态迁移，避免"看起来恢复了，实际状态对不上"的隐患。（v0.4：重新提交使用新的 `client_request_id`；Server 侧的原 Workflow 不会静默遗留，按 `WORKFLOW_SPEC.md` §2.2 的孤儿回收处理。）

---

## 6. Capability 声明协议

```json
{
  "type": "capability.sync",
  "payload": {
    "mode": "incremental",
    "revision": 3,
    "added": [
      {"name": "docker.inspect_container", "side_effect": false, "interruptible": true,
       "input_schema": { }, "output_schema": { }},
      {"name": "test_rig.trigger_reset", "side_effect": true, "interruptible": false,
       "idempotent": false, "timeout_hint": 60000,
       "input_schema": { }, "output_schema": { }}
    ],
    "removed": []
  }
}
```

* `mode: "full"`：`added` 即为当前全部可用 Capability,`removed` 忽略。用于连接建立时（也可以直接内联在 `session.hello.capabilities` 里，二者等价，`capability.sync` 用于连接建立**之后**的更新）。
* `mode: "incremental"`：只携带本次变化的新增/移除项，Server 在自己的记录上做增量合并。
* **`revision` 为必填（v0.4 新增）**：会话内**单调递增**的声明版本号；首次全量声明（含 `session.hello` 内联能力）为 `0`。Server **只应用更高 `revision` 的声明**，陈旧 / 乱序丢弃并告警——解决重连或乱序时"旧声明覆盖新声明"的问题。
* **`side_effect`、`interruptible` 为必填字段**（v0.2 新增）：对应 `CAPABILITY_SPEC.md` §2.1、§2.2。Server 收到缺失这两个字段的声明时，应按该文件规定的保守默认值处理（`side_effect` 缺失视为 `true`，`interruptible` 缺失视为 `false`），而不是拒绝整条声明。
* **`idempotent`、`timeout_hint`、`input_schema`、`output_schema`（v0.4 新增，可选）**：分别对应 `CAPABILITY_SPEC.md` §2.3、§2.4、§5。`idempotent` 缺省为 `false`；`timeout_hint` 缺省使用 Server 全局默认；`input_schema` / `output_schema` 缺失时 Server **不做强校验**并告警（兼容未补 schema 的旧接入方）。
* **在途规则（v0.4 新增）**：能力变化**只影响未来的 `step.dispatch`**，不影响已下发的 Step。若 Client 收到引用已不可用能力的 Step，回 `step.status(REJECTED, reject_reason.code = capability_unavailable)`。

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
  "client_request_id": "req_7f3a...",
  "user_request": {
    "text": "项目起不来了，帮我看看",
    "attachments": [],
    "context": { "project_path": "/workspace/app" }
  }
}
```

* `client_request_id`（v0.4 新增，必填）：Client 生成、重发时保持不变。Server 按 `(session_id, client_request_id)` 去重；收到重复请求时不新建 Workflow，直接返回此前创建的 `workflow_id`（幂等）。作用域限 session。
* `attachments` 的结构与传输见 §7.5：小体积内容可内联，超过阈值走 blob 通道。

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

`reason` 可选，取值见 `WORKFLOW_SPEC.md` §2 的 `terminal_reason` 枚举（`user_cancelled` / `abandoned` / `superseded` 等）；本版本允许自由字符串，不强制校验。

Server 的响应分两种情况（v0.4：判定依据从"Step 在 RUNNING"推广为"活跃 Step"，见 `WORKFLOW_SPEC.md` §2.1）：

```text
情况 A — 无活跃 Step，或活跃 Step 仅为 PENDING，或属人类等待；
        或活跃 Step（RUNNING / 执行类 WAITING）的 Capability interruptible=true：
  Server                                        Client
    │  workflow.cancel_ack                        │
    │  {workflow_id, workflow_status:"CANCELLED"} │
    │◀───────────────────────────────────────────── │
    （随后按 §7.4 推送 workflow.terminated）

情况 B — 活跃 Step 为 RUNNING / 执行类 WAITING 且 interruptible=false：
  Server                                        Client
    │  workflow.cancel_ack                        │
    │  {workflow_id, workflow_status:"CANCELLING"} │
    │◀───────────────────────────────────────────── │
    （Server 不再下发新 Step；当前 Step 继续走到
     step.status(COMPLETED) / (FAILED) / (UNKNOWN)；
     该 Step 到达任一终态后，Workflow 终止为 CANCELLED，
     按 §7.4 推送 workflow.terminated，不触发 Re-plan；
     因工程师已取消，UNKNOWN 不再对账）
```

**取消意图优先（v0.4 新增）：** 若 `CANCELLING` 期间 Client 失联，Workflow 仍终止为 `CANCELLED`（保留 `terminal_reason`），不按孤儿回收判 `FAILED`（见 `WORKFLOW_SPEC.md` §2.1、§2.2）。

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
    "record_id": "rec_001",
    "record_persistence_failed": false
  }
}
```

* `terminal_state` 取值 `COMPLETED | FAILED | CANCELLED`。
* `terminal_reason`（v0.4 扩展）：`CANCELLED` 时可能非空（`user_cancelled` / `abandoned` / `superseded`）；`FAILED` 时也可能非空（`client_unreachable` / `step_limit` / `retry_limit` / `user_round_limit` / `time_budget`）。统一取值见 `WORKFLOW_SPEC.md` §2。
* `record_id` 指向刚生成的 Record（见 `RECORD_SPEC.md` §2），Client 收到后即可用它发起 §10 的 Record 查询或 §11 的 Report 生成。
* `record_persistence_failed`（v0.4 新增）：布尔值。**Server 先持久化 Record，成功后才发本消息**（顺序固定）；若重试耗尽仍落盘失败，仍必须发本消息（终态已定，不可回退），但此时 `record_id = null` 且 `record_persistence_failed = true`，并在服务端告警。Client 据此知道"已终止但记录不可用"，不会去查询一个不存在的 Record。

这条消息补上了 v0.1 一个隐含的空白：v0.1 里 Client 得知 Workflow 已经 `COMPLETED`，只能靠自己发出 `workflow.completion_response(solved)` 之后"顺理成章地认为"已经完成，Server 没有一条显式的确认/回执；`FAILED` 就更没有任何推送。v0.2 统一由 `workflow.terminated` 承担这个职责，三种终止路径都不例外。

### 7.5 附件与大体积 Evidence（blob 通道，v0.4 新增）

对应 `REQUIREMENTS.md` FR-1（可附带文件）与 FR-12（记录完整）。正文类消息**不内联大体积内容**：

* **小体积**（≤ 内联阈值，建议默认 64 KiB）可直接内联在 `attachments` / `evidence.result` 中。
* **大体积 / 二进制**（日志、截图等）在主协议中只传**引用**：

```json
{ "content_ref": "blob_...", "media_type": "text/plain", "size": 12345,
  "sha256": "hex...", "name": "can_trace.log" }
```

**blob 通道流程（申请制）：**

```text
Client                                    Server
  │  blob.allocate_request                    │
  │  {direction: upload|download, name,       │
  │   media_type, size, sha256}               │
  │ ────────────────────────────────────────▶ │
  │        blob.allocate_response              │
  │  {content_ref, url, expires_at}            │
  │◀───────────────────────────────────────── │
  （二进制数据经 url 独立传输，不在本协议连接内，
    带鉴权、有生命周期；Server 校验 sha256 与 size）
```

* 允许的 `media_type` 由白名单约束；超限、超尺寸或不合规的申请被拒：`protocol.error`，code=`blob_rejected`（见 §12）。
* Record 保留 `content_ref`，使证据可回溯（见 `RECORD_SPEC.md` §3）。
* 阈值、单 blob 上限、`content_ref` 生命周期由 Server 配置；建议默认：内联阈值 64 KiB、单 blob 上限 512 MiB。

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
  "requires_confirmation": false,
  "idempotency_key": null
}
```

`requires_confirmation`（v0.2 新增）：布尔值，由 Server 在生成 Step 时决定——默认取自该 Step 引用的 Capability 的 `side_effect` 声明，但 Server 可以针对个别 Step 显式覆盖为 `true`（例如某个本来无副作用的 Capability，在特定上下文下 Server 想多一层工程师确认）。这个字段是自包含的：Client 不需要回查此前收到的 Capability Manifest 才能决定要不要弹确认，看这一条 `step.dispatch` 就够了（详见 §8.2 的决策记录）。

`idempotency_key`（v0.4 新增）：仅 `side_effect: true` 的 Step 必须非空。由 Server 为"同一意图"生成、在 Workflow 内稳定；Client 以它做"键 → 结果"的持久化台账，命中台账时直接返回缓存证据而不重新执行（见 `WORKFLOW_SPEC.md` §4.3）。

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
| `FAILED` | `fail_reason`，`evidence`（可选，部分证据） | 尝试执行但没成功。`fail_reason.code` 取值：`timeout` / `capability_error` / `invalid_input` / `invalid_output` / `dependency_unavailable` / `unknown` |
| `REJECTED` | `reject_reason` | **从未真正尝试执行**，Client 主动拒绝。`reject_reason.code` 取值：`permission_denied` / `capability_unavailable` / `user_declined` / `invalid_input` / `unsafe_operation` / `other` |
| `UNKNOWN`（v0.4 新增） | 无必填补充字段（`evidence` 可选） | **通常不由 Client 主动上报**：这是 Server 在"副作用 Step 结果不确定"（超时 / 断连导致回包丢失）时判定的终态，可由对账收敛为 `COMPLETED` / `FAILED`（见 `WORKFLOW_SPEC.md` §4.3） |

**`wait_reason` 的两类（v0.4 新增）：**

* **人类等待**：`user_input` / `user_confirmation`（以及人工对账）。**不受 `step_timeout` 约束**。
* **执行类等待**：本地服务 / 设备响应 / 外部资源等。受 `step_timeout` 约束（见 §9）。

**终态与迟到更新（v0.4 新增）：** `COMPLETED` / `FAILED` / `REJECTED` / `UNKNOWN` 均为 Step 终态。到达终态后，同一 `step_id` 的后续 `step.status` 一律忽略并告警（终态互不覆盖，先到为准）；**唯一例外是 `UNKNOWN` 可被对账收敛**。同一 `(step_id, 终态)` 只接受一次，避免重连补报在 Record 中产生重复条目。迟到的只读证据可由 Server 选择性并入 Context，但不改变 Step 状态（详见 `WORKFLOW_SPEC.md` §4）。

`FAILED` 与 `REJECTED` 的区分对应 `WORKFLOW_SPEC.md` §11-3（该待补项已由本文件解决）：两者都会让 Server 决定"要不要换一种方式"，但含义不同——`FAILED` 通常意味着"这条路能走,这次没走通,可以重试或调整参数"；`REJECTED` 通常意味着"这条路本身不该走,换 Capability 或提请人工授权，而不是重试同样的请求"。

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
* 工程师反馈后，Client 上报 `step.status(COMPLETED, evidence={source:"user_input", type:"manual_action_result", result:{outcome, observation, details?}})`（结构见 `CAPABILITY_SPEC.md` §6）。

这里特意写明，是因为"建议"路径讨论了好几轮方案，容易让人以为协议层需要专门再加点什么——实际上不需要，记录于此避免被重新提出。

---

## 9. 心跳与超时策略

连接级别的存活检测（Client 是否还在线）优先交给 Transport 自身（如 WebSocket 的 ping/pong 帧）。当 transport 不提供原生保活时，用 §5.1 的 `session.heartbeat` 作为应用层心跳。

**应用层需要单独处理的是"连接还活着，但某个 Step 卡住了"**：

* Server 为处于 `RUNNING` 的 Step，以及**执行类** `WAITING` 的 Step 维护一个 `step_timeout`。
* 超时时长：优先使用该 Capability 声明的 `timeout_hint`（见 `CAPABILITY_SPEC.md` §2.4），Server 可覆盖并设硬上限；未声明时用全局默认。
* **人类等待豁免（v0.4 新增）**：`wait_reason` 为 `user_input` / `user_confirmation`（以及人工对账）的 Step **不计入 `step_timeout`**，只由用户响应、用户取消、或失联后的孤儿回收结束（见 `WORKFLOW_SPEC.md` §2.2、§4）。
* 只要收到该 Step 的任意 `step.status`（哪怕只是 `progress` 更新），计时器重置。
* 超时未收到任何更新 → 按 Step 是否有副作用分流（v0.4 新增）：
  * **只读 Step**：标记为 `FAILED`（`fail_reason.code = "timeout"`），随后按 `WORKFLOW_SPEC.md` §4 决定 Retry / Change Approach / 判断无法继续（并受 §13 护栏约束）。
  * **副作用 Step**：标记为 `UNKNOWN`（**不是** `FAILED`），进入对账流程（见 `WORKFLOW_SPEC.md` §4.3 与 §8 的 `UNKNOWN`）。
* 计时与排序一律以 **Server 侧单调时钟 / 序列**为准（见 §2 的 `ts` 说明）。

> Workflow 级别的失联由 §5.1 的应用层心跳 + `WORKFLOW_SPEC.md` §2.2 的孤儿回收处理，与本节 Step 级超时是两件事。

---

## 10. Record 查询（v0.2 新增）

对应 `REQUIREMENTS.md` FR-14，结构定义见 `RECORD_SPEC.md`。

**可见性（v0.5 新增，依据 `ADR-003` §6）：** 只能访问**当前认证用户自己**的 Record。Server 必须按 `user_id` 过滤 `record.list_request` / `record.get_request`；请求他人的 `record_id` 返回 `protocol.error`（code=`unknown_record`），不泄露其存在。

### 10.1 列表

```json
{
  "type": "record.list_request",
  "payload": {
    "filters": { "time_range": null, "keyword": null, "terminal_state": null },
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
        "summary": { "problem_short": "...", "terminal_state": "COMPLETED", "result_short": "...", "duration_ms": 720000 }
      }
    ],
    "next_cursor": null
  }
}
```

`records[].summary` 直接对应 `RECORD_SPEC.md` §5 的 `summary` 结构——列表视图不需要展开完整 Record。

**列表语义（v0.4 明确）：**

* `filters.time_range`：ISO 8601 **闭区间**，按 `ended_at` 过滤；`null` 表示不限。
* `filters.keyword`：在 `summary` 与 `entries[].narrative` 上做**不区分大小写**的子串匹配；`null` 表示不限。
* `filters.terminal_state`：可选，取值 `COMPLETED | FAILED | CANCELLED`。
* 排序：`ended_at` **倒序**，以 `record_id` 做稳定 tiebreak。
* `cursor`：Server 生成的**不透明 token**；客户端只应回传上一次响应中的 `next_cursor`，不应自行构造。
* `page_size`：默认 20，**上限 100**；超过上限按上限处理。
* `next_cursor` 为 `null` 表示没有更多结果。
* **详情不分页**：`record.get_response` 一次性返回完整 `entries`（未来若单条 Record 过大再议）。

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

### 10.3 导出到第三方 Knowledge Base（v0.5 新增，"导出半边"）

对应 `REQUIREMENTS.md` FR-24（v0.10 调整）与 `ADR-003` §6。**提交人自己决定**是否把某条 Record/Report 沉淀给第三方 Knowledge Base；KB 是否接收由其审核人员决定——**审核完全在 KB 侧，本系统不追踪审核状态**。

```json
{ "type": "record.export_request",
  "payload": { "record_id": "rec_001", "object": "record", "target": "knowledge_base" } }
```

```json
{ "type": "record.export_result",
  "payload": { "record_id": "rec_001", "object": "record",
               "status": "ok", "error_code": null, "message": null } }
```

* `object`：`record`（默认）| `report`。`report` 时导出的是基于该 Record 生成的 Report（生成规则见 `REPORT_SPEC.md`）。
* `status`：`ok` | `failed`；`failed` 时 `error_code` 取值 `export_unavailable` / `export_failed` / `invalid_object`，并给出 `message`。
* 只能导出**自己**的 Record（同 §10 的可见性规则）；`record_id` 不存在或不属于自己 → `protocol.error(code=unknown_record)`。
* 导出**不修改** Record，可重复发起。
* 实际出站（Server → KB 的协议、鉴权、数据格式）由后续 **KB 集成 ADR** 定义；本版本只固定这一层最小协议面。

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
    "status": "ok",
    "report": { "format": "markdown", "content": "..." },
    "error_code": null,
    "message": null
  }
}
```

* `options.detail_level` 的具体取值范围（`summary` / `full`）由 `REPORT_SPEC.md` §3 定义；`report.format` 的取值（本版本固定为 `markdown`）由 `REPORT_SPEC.md` §4 定义。本文件只约定字段位置。
* `status`（v0.4 新增）：`ok` | `failed`。`failed` 时 `report` 可为 `null`，`error_code` 取值 `generation_failed` / `insufficient_content` / `invalid_option` / `timeout`，并给出 `message`；Client 可重试，失败**不写 Record**（见 `REPORT_SPEC.md` §6）。
* 生成 Report **不修改** Record，也不创建新的 `record_id`；同一个 `record_id` 可以多次调用 `report.generate_request`，每次都基于当时的（不会变化的）Record 内容重新生成。
* 请求了不存在的 `record_id` 时，属**协议层**错误（不是生成失败）：返回 `protocol.error`（code=`unknown_record`）。

---

## 12. 错误处理

`protocol.error`（双向）：

```json
{
  "code": "unsupported_version",
  "message": "server only supports protocol_version 0.3",
  "in_reply_to": "msg_123"
}
```

**code 与处置矩阵（v0.4 明确）：**

| code | 类别 | 收到后必须做什么 |
|---|---|---|
| `unsupported_version` | 致命 | 断开（Server 不下发 `session.welcome`） |
| `session_expired` | 致命 | Client 重新 `session.hello`，未完成工作作为新 `workflow.request` 提交（§5.2） |
| `unknown_record` | 请求级失败 | 原请求失败，连接继续 |
| `unknown_workflow` | 请求级失败 | 原请求失败，连接继续 |
| `unknown_step` | 请求级失败 | 原请求失败，连接继续 |
| `unknown_message_type` | 可忽略 + 告警 | **不得断开连接**，忽略该消息并记录告警 |
| `malformed_payload` | 请求级失败 | 丢弃该消息 + 告警，连接继续 |
| `blob_rejected`（v0.4 新增） | 请求级失败 | `blob.allocate_request` 被拒（超尺寸 / 类型不在白名单等），连接继续 |
| `auth_failed`（v0.5 新增） | 致命 | 认证失败：断开，不下发 `session.welcome`（§5.1） |

`session.resume` 的认证失败同样走 `auth_failed`（致命，断开）；`session_id` 未知或超过会话 TTL 走 `session_expired`（致命，断开）。两者都不下发 `workflow.state_sync`（§5.2）。

最小 `code` 集合（v0.5）：`unsupported_version` / `session_expired` / `auth_failed` / `unknown_message_type` / `malformed_payload` / `unknown_workflow` / `unknown_step` / `unknown_record` / `blob_rejected`。

`protocol.error` 描述的是**协议层面**的问题（消息格式错、版本不兼容、引用了不存在的 workflow_id/record_id），不同于 `step.status(FAILED)` 描述的**业务执行层面**的失败——不要把两者混用。

---

## 13. 协议版本协商

`session.hello.supported_protocol_versions` 允许 Client 声明自己支持的版本列表（数组，为未来多版本共存留空间）；Server 从中选择自己也支持的最高版本，写入 `session.welcome.protocol_version`。之后同一连接内的所有消息隐式使用这个协商结果，信封里的 `protocol_version` 字段仅用于日志/调试，不再重复协商。

**文档版本与协议版本解耦（v0.4 新增）：** 本文件的**文档版本号**（页首 `Version`，随每次文档修订递增）与**协议版本号**（线路契约，用于协商）是两种东西，各自独立推进。协议版本采用 `<major>.<minor>`：

* 向后兼容的新增 → `minor + 1`；
* 破坏性变更 → `major + 1`；
* `v0.x` 阶段允许在 minor 内做不兼容调整。

当前协议版本为 `"0.3"`（v0.3 时为 `"0.2"`；本次新增 `UNKNOWN` 终态、若干消息与字段，因处于 0.x 阶段按 minor 提升处理）。

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

**超时——只读 Step：**

```text
step.dispatch(S6: 只读)
step.status(S6, RUNNING, progress=0.1)
... 超过 step_timeout，未再收到任何更新 ...
Server 内部：S6 → FAILED(fail_reason.code=timeout)
Server Re-plan：视情况 Retry 同一 Capability（受 §13 护栏约束），或 Change Approach
```

**超时——副作用 Step（结果未知与对账，v0.4 新增）：**

```text
step.dispatch(S7: test_rig.trigger_reset, requires_confirmation=true, idempotency_key=idem_9)
  → 工程师确认 → step.status(S7, RUNNING)
... 超过 step_timeout，未再收到任何更新 ...
Server 内部：S7 → UNKNOWN（不是 FAILED）
  → Server 生成只读对账 Step（如 test_rig.query_dut_info）
  → 对账证据表明重置确实生效 → Workflow Engine 将 S7 收敛为 COMPLETED
  → 继续 Re-plan
（若对账证据不足以判定，则退回工程师确认）
```

**断线重连：**

```text
[连接中断，S6 仍处于 RUNNING]
Client 重新连接
session.resume(session_id, auth={username, secret}, known_workflows=[{wf_001, step_009, RUNNING}])
  → session_id 仍有效：
      workflow.state_sync(resumed=true, workflows=[{wf_001, RUNNING, pending_step: step.dispatch(S6)}])
      Client 据此确认自己应该继续执行 S6，而不是重新开始
  → session_id 已过期：
      protocol.error(session_expired)
      Client 走 session.hello 重新握手，未完成的工作作为新的 workflow.request 提交（使用新的 client_request_id）
      Server 侧原 Workflow 在宽限期后按 WORKFLOW_SPEC §2.2 回收：
        → FAILED(terminal_reason=client_unreachable)，或此前已请求取消 → CANCELLED
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
step.status(S8, COMPLETED, evidence)   # S8 自然跑完（亦可能 FAILED / UNKNOWN）
  → Server 不触发 Re-plan
workflow.terminated(wf_003, terminal_state=CANCELLED, terminal_reason=abandoned, record_id=rec_003)
```

**查看历史 Record 并生成报告：**

```text
record.list_request → record.list_response(records=[...])
record.get_request(rec_001) → record.get_response(record={...})
report.generate_request(rec_001, detail_level=full) → report.generate_result(status=ok, report={...})
```

**应用层心跳（仅 transport 无原生保活时，v0.4 新增）：**

```text
session.heartbeat → session.heartbeat → ...
（无响应；Server 连续多个间隔未收到则判连接失效，触发孤儿宽限/回收）
```

**上传大体积附件（v0.4 新增）：**

```text
超过内联阈值 → blob.allocate_request(direction=upload, name, media_type, size, sha256)
  → blob.allocate_response(content_ref=blob_1, url=..., expires_at=...)
  → Client 经 url 上传字节（带鉴权、有生命周期）
  → workflow.request / step.status 中携带 content_ref 引用
```

---

## 15. 已解决的历史待补项

| 待补项 | 出处 | 本文件的解决方式 |
|---|---|---|
| Step ID / Workflow ID | `WORKFLOW_SPEC.md` §11-1 | 信封中的 `workflow_id` / `step_id`（§2、§3） |
| "拒绝执行" 与 "执行失败" 的区分 | `WORKFLOW_SPEC.md` §11-3 | `step.status.status` 新增独立的 `REJECTED`，与 `FAILED` 完全分开，各自有专属的 reason 结构（§8） |
| Step 超时 / Liveness | `WORKFLOW_SPEC.md` §11-4 | §9 心跳与超时策略 |
| Capability 声明与实际不符 | `CAPABILITY_SPEC.md` §7-2 | schema 落地后由运行时校验捕获：`REJECTED` / `FAILED(invalid_output)`，不会静默（§8） |
| 单 Client 多 Workflow 的关系 | （此前讨论中提出的空白） | §3：一条连接、一个 session，可并存多个 workflow_id |
| Workflow 取消语义（v0.2 新增） | `WORKFLOW_SPEC.md` §2.1 | §7.3：`workflow.cancel_request/ack`，区分立即生效与排队等待 |
| Workflow 终止如何通知 Client（v0.2 新增） | 本次讨论中发现的隐含空白 | §7.4：`workflow.terminated` 统一三种终止路径 |
| 有副作用动作的确认流程（v0.2 新增） | `WORKFLOW_SPEC.md` §4.2 | §8.1：`requires_confirmation` + 既有的 `WAITING`/`REJECTED` |
| "建议"路径的消息形态（v0.2 新增） | `WORKFLOW_SPEC.md` §6.1 | §8.2：复用现有 Step/Evidence，不新增消息类型 |
| Record 查看、Report 生成（v0.2 新增） | `REQUIREMENTS.md` FR-14、FR-17~19 | §10、§11 |
| Capability I/O Schema（v0.4 新增） | `CAPABILITY_SPEC.md` §7-1 | §6 `capability.sync` 携带 `input_schema` / `output_schema`，两端校验 |
| Schema 语言选型（v0.4 新增） | 本文 v0.3 §16-2 | JSON Schema 受限子集（`CAPABILITY_SPEC.md` §5.1） |
| 大体积 / 二进制 Evidence（v0.4 新增） | 本文 v0.3 §16-4 | §7.5 blob 通道（引用 + 申请制传输） |
| 副作用结果不确定（v0.4 新增） | 本次缺口评审发现 | §8 `UNKNOWN` 终态 + `WORKFLOW_SPEC.md` §4.3 对账 |
| `workflow.request` 幂等（v0.4 新增） | 本次缺口评审发现 | §3、§7.1 `client_request_id` |
| Record 落盘失败（v0.4 新增） | 本次缺口评审发现 | §7.4 `record_persistence_failed` + 先落盘后通知 |
| Report 生成失败（v0.4 新增） | 本次缺口评审发现 | §11 `status` / `error_code` |
| 错误处置分级（v0.4 新增） | 本次缺口评审发现 | §12 处置矩阵 |
| 身份与可见性（v0.5 新增） | `ADR-003`、`REQUIREMENTS.md` Q-1/Q-2 | §5.1 认证、§2 `user_id` 必填、§10 按用户过滤 |
| KB 导出半边（v0.5 新增） | `REQUIREMENTS.md` FR-24 | §10.3 `record.export_request/result` |

**说明**：v0.3 曾在此处指出"Capability 输入/输出 Schema 没有在本文件解决"。该空白已在 v0.4 关闭：语言选定为 JSON Schema 受限子集，schema 由 `capability.sync` 携带（见 §6），校验职责见 `CAPABILITY_SPEC.md` §5.2。

---

## 16. 仍未解决 / 明确留给后续版本

1. **认证与授权的完整形态**：v0.5 已实现**最小身份与授权**（本地账号认证、`user_id` 必填并由 Server 校验、副作用确认仅限提交人、Record 仅提交人可见，见 §5.1、§10 与 `ADR-003`）。仍延后：沙箱、多租户、角色体系、组织 SSO 联邦、TLS 启用。
2. **跨 Client 续接同一 Workflow**：例如手机发起、电脑继续同一个 `workflow_id`。本版本明确不支持——`session.resume` 只在同一逻辑 session（同一个 Client 实例）内工作。
3. **多 Server 实例下的 Workflow 路由**：一个 Workflow 该固定在哪个 Server 实例上处理，如何做水平扩展，不在本文件范围内。
4. **第三方 Knowledge Base 的完整集成**：v0.5 已实现**导出半边**的最小协议面（§10.3）。仍延后：KB 检索（FR-23）的接口、导出的出站协议 / 鉴权 / 数据格式、审核状态回读——由后续 KB 集成 ADR 定义。
5. **blob 通道的具体传输协议与鉴权**（v0.4 新增）：§7.5 只定义"引用 + 申请制通道"的形态与字段位置；具体是 HTTP PUT/GET、分块协议还是对象存储直传，以及其鉴权方式，留给实现与安全规格决定。

> v0.3 的第 2 条（Schema 语言选型）与第 4 条（大体积 Evidence 传输）已在 v0.4 解决，不再列为未决项。
