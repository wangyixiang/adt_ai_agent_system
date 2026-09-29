# CLIENT_SPEC.md

- **Version:** v0.6（缺口收敛：补幂等台账、迟到状态处理、确认 UI 锁定、blob 通道职责；对齐 `WORKFLOW_SPEC.md` v0.4、`PROTOCOL_SPEC.md` v0.4，取代 v0.5）
- **Role:** AI Client / User Interaction + Local Execution Runtime
- **层级:** Architecture — 组件角色定位
- **拆分说明:** 本文件是原 v0.2 CLIENT_SPEC.md 的瘦身版本。Step/Evidence/Completion 的具体契约已抽取到 `../specs/WORKFLOW_SPEC.md`（Client 与 Server 共享，避免两边各写一份、逐渐漂移），Capability 命名规范已抽取到 `../specs/CAPABILITY_SPEC.md`。系统级架构图和核心边界原则见 `ARCHITECTURE.md`。

---

## 1. Purpose

AI Client 是用户与 Central Server 之间的交互和执行端。

Client 不负责整个问题的规划，而负责：

* 与 User 交互
* 向 Server 提交 User Request
* 向 Server 声明本地可用能力
* 接收 Server 当前要执行的 Step
* 在本地执行 Step
* 与本地服务、Agent、MCP、工具、设备等协作
* 收集并返回 Evidence
* 在需要时向 User 获取信息
* 在 Server 认为 Request 已达到完成条件后，让 User 对最终结果进行确认
* **让 User 查看历史 Record（列表与详情）**（v0.4 新增）
* **在 User 明确请求时，向 Server 发起 Report 生成请求，并展示结果**（v0.4 新增）
* **持久化副作用 Step 的幂等台账，结果不确定时不得静默重执行**（v0.6 新增）
* **对已到达终态 Step 的迟到状态更新做忽略处理，不改写本地状态**（v0.6 新增）
* **在用户提交某一个互斥意图后锁定对应 UI**（v0.6 新增）

核心原则：

> **Client 执行当前 Step，不负责决定下一个 Step。**

---

## 2. Internal Architecture

```text
Client
│
├── User Interaction
│
├── Workflow Session
│
├── Capability Registry
│
├── Step Executor
│
├── Local Services / Agents
│
├── MCP / Tools / Devices
│
└── Evidence Collector
```

Capability Registry 与 Step Executor 遵循 `../specs/CAPABILITY_SPEC.md` 与 `../specs/WORKFLOW_SPEC.md` 中定义的契约，本文件不重复定义。Record 的查看与 Report 的请求（§1、§3 新增职责）不需要新增内部模块，属于 User Interaction 的一部分——是否需要独立拆出（例如 "Record Viewer"）留给实现阶段决定，本文件不预设。

幂等台账（§3 第 13 条）是 Step Executor 的**本地持久状态**，必须跨进程重启保留；blob 通道（§3 第 15 条）是 Step Executor 与本地服务 / 设备之间的协作，具体拆分留给实现阶段。

---

## 3. Responsibilities

Client MUST：

1. 接收 User Request
2. 将 User Request 提交给 Server
3. 提供本地 Capability 信息
4. 接收 Server 下发的当前 Step
5. 检查本地是否允许执行
6. 执行 Step
7. 返回执行状态和 Evidence
8. 处理当前 Step 所需的 User Interaction
9. 展示 Workflow 最终结果
10. 在需要时获取 User 对 Request 是否解决的最终确认
11. **展示历史 Record 列表与详情，供 User 查看**（v0.4 新增，对应 `REQUIREMENTS.md` FR-14）
12. **在 User 明确请求时，向 Server 发起针对指定 Record 的 Report 生成请求，并展示生成结果；User 不请求则不发起**（v0.4 新增，对应 `REQUIREMENTS.md` FR-17）
13. **持久化 `idempotency_key` → 结果的台账；命中台账时直接返回缓存证据而不重新执行；无法确认台账时回报 `UNKNOWN` 而非重执行**（v0.6 新增，对应 `WORKFLOW_SPEC.md` §4.3）
14. **在用户提交某一个互斥的人工意图（确认 / 拒绝 / 取消）后锁定相应 UI，避免同一确认窗口内提交第二个互斥意图**（v0.6 新增，对应 `WORKFLOW_SPEC.md` §2.1）
15. **通过 blob 通道上传 / 下载大体积附件与 Evidence，并在消息中携带 `content_ref` 引用**（v0.6 新增，对应 `PROTOCOL_SPEC.md` §7.5）

Client MUST NOT：

* 自己决定整个 Workflow 的执行计划
* 自己决定下一个 Step
* 修改 Server 维护的 Workflow 状态
* 在 Server 未要求的情况下自主创建新的全局 Workflow
* 将本地 Agent 的判断直接作为 Workflow 最终状态
* **自行生成 Report 内容，或在未收到 Server 返回结果前展示"已生成"的报告**（v0.4 新增）：Report 的内容必须来自 Server 基于 Record 生成的结果（`REQUIREMENTS.md` FR-18），Client 只负责发起请求和展示，不能本地拼凑或缓存伪造内容
* **在无法确认幂等台账时静默重新执行一个有副作用的 Step**（v0.6 新增）：此时必须回报 `UNKNOWN`，由 Server 安排对账（见 `WORKFLOW_SPEC.md` §4.3）

---

## 4. User Request 的收集职责

```text
User
  ↓
Client Interaction
  ↓
User Request
  ↓
Server
```

Client 可以负责：

* 对话
* 表单
* 文件选择
* 参数收集
* 环境信息收集

但 Client 不负责解释 User Request 并制定完整解决方案——这一点由 Server 的 Planner 负责（见 `SERVER_SPEC.md`）。

---

## 5. Human-in-the-loop 的执行角色

Human Interaction 属于 Client 的职责：Client 负责把 Server 下发的交互需求呈现给 User，并把 User Response 传回 Server。

```text
Server Step
    ↓
Client UI
    ↓
User
    ↓
User Response
    ↓
Server
```

User 的拒绝或补充信息本身不等于 Workflow Failed；具体的等待/继续/重新规划语义（例如 Execution-time 等待与 Request-level 未解决之间的区别）由 `../specs/WORKFLOW_SPEC.md` §4.1、§10 统一定义，Client 只负责按该定义呈现交互并转发结果，不做自己的判断。

---

## 6. Client 与 Local Agent

Client 可以拥有本地 Agent：

```text
Server
   │
   ▼
Server Step
   │
   ▼
Client
   │
   ▼
Local Agent
   │
   ▼
Evidence
```

*（原 v0.2 §12 此处画的是 `Central LLM → Server Step → ...`，直接把 Server 内部的 LLM 组件暴露进了 Client 的模型里，违反了 `ARCHITECTURE.md` §3 "任何一侧不应把对方内部组件画进自己流程" 的边界原则，已改正为 `Server`。）*

Local Agent 可以具有一定的自主性，但其作用范围属于 Client 本地执行环境。它不应绕过 Server 创建独立的全局 Workflow。

---

## 7. Security Boundary

v0.3 只定义最基本的边界：

> **Server 决定"要做什么"，Client 决定"本地是否允许执行"。**

Client 可以根据本地权限、用户授权或运行环境拒绝某个 Step。信号为 `step.status(REJECTED)`，并在 `reject_reason.code` 中说明原因（`permission_denied` / `capability_unavailable` / `unsafe_operation` / `invalid_input` / `user_declined` / `other`，见 `../specs/PROTOCOL_SPEC.md` §8）——与"尝试执行但失败"（`FAILED`）严格区分。

具体认证、授权、沙箱和安全策略属于后续 Protocol / Security Spec；Client 拒绝执行时应产生的信号类型（与"执行失败"区分开）已由 `../specs/PROTOCOL_SPEC.md` §8 定义（`REJECTED` 与 `FAILED` 完全分开）。查看 Record、请求 Report 是否需要额外的权限校验（例如 Q-2：Record 谁能查看），留给该安全规格统一处理，本文件不重复定义。

---

## 8. Design Principle

Client 的核心原则：

> **Client 是 User Interaction + Local Execution Runtime，而不是 Workflow Planner。**

Server 决定：**下一步做什么，以及 Record/Report 的内容。**
Client 决定：**本地是否允许做、如何利用本地能力执行，以及如何呈现 Record 与 Report 的用户入口。**
User 最终决定：**这个 Request 是否真的解决了，以及是否需要生成报告。**

---

## 9. 相关文档

* 系统级架构图与核心边界原则 → `ARCHITECTURE.md`
* Step / Evidence / Completion 的具体契约 → `../specs/WORKFLOW_SPEC.md`
* Capability 命名规范与 Manifest 格式 → `../specs/CAPABILITY_SPEC.md`
* Record 的结构与保存时机 → `../specs/RECORD_SPEC.md`
* Report 的触发与内容约束 → `../specs/REPORT_SPEC.md`
