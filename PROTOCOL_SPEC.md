# PROTOCOL_SPEC.md

**Version:** v0.1
**Status:** Draft
**Scope:** Client ↔ Server Protocol
**写作要求:** 1. 定义协议语义和消息交互边界 

---

# 1. Purpose

本文档定义 AI Client 与 Central Server 之间的通信协议。

协议负责定义：

* Client 与 Server 如何交换信息
* User Request 如何进入 Server
* Workflow 如何驱动
* Step 如何下发与执行
* Evidence 如何返回
* WAITING 如何处理
* Completion Candidate 如何产生和确认
* Capability 如何声明
* User Feedback 如何重新进入 Workflow

本文档只定义**协议语义和交互规则**。

不定义：

* HTTP / WebSocket / gRPC 等传输协议
* 具体 API URL
* 数据库 Schema
* LLM Provider
* Prompt
* RAG 实现
* MCP 实现细节
* Authentication / Authorization 具体机制
* Deployment

这些内容由后续 Specification 定义。

---

# 2. Protocol Scope

Protocol 位于：

```text
┌─────────────────────────────────────┐
│             User                    │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│              Client                 │
│                                     │
│  User Interaction                   │
│  Capability Runtime                 │
│  Local Execution                    │
└──────────────────┬──────────────────┘
                   │
             Protocol
                   │
┌──────────────────▼──────────────────┐
│              Server                 │
│                                     │
│  Workflow Engine                    │
│  Context Engine                     │
│  Knowledge Engine                   │
│  Planner / LLM                      │
└─────────────────────────────────────┘
```

Protocol 的核心职责是连接：

```text
User Request
      ↓
Workflow
      ↓
Step
      ↓
Execution
      ↓
Evidence
      ↓
Re-plan
```

---

# 3. Participants

Protocol 包含两个主要参与者。

## 3.1 Client

Client 负责：

* 接收 User Request
* 向 Server 提交 User Request
* 声明本地 Capability
* 接收 Server 下发的 Step
* 验证本地是否允许执行 Step
* 执行 Step
* 调用 Local Agent / Tool / Service / Device
* 收集 Evidence
* 返回 Execution Result / Evidence
* 处理 Step 的 WAITING
* 展示 Completion Candidate
* 收集 User Confirmation
* 收集 User Feedback

Client 不负责：

* 决定全局 Workflow
* 决定下一 Step
* 全局 Re-planning
* 全局 Context 管理
* 全局 Knowledge Retrieval
* 修改 Server 的 Workflow State

---

## 3.2 Server

Server 负责：

* 接收 User Request
* 创建和管理 Workflow
* 管理 Workflow State
* 组合 Context
* 获取 Knowledge
* 检查 Client Capability
* 调用 Planner / LLM
* 生成当前 Step
* 将 Step 下发给 Client
* 接收 Execution / Evidence
* 更新 Workflow Context
* 进行 Request Completion Evaluation
* 继续 Re-plan 或生成 Completion Candidate
* 根据 User Feedback 重新规划

Server 不负责：

* 直接执行 Client 本地操作
* 直接操作 Client 本地文件、设备或服务
* 代替 Client 决定本地 Capability 是否允许执行

---

# 4. Protocol Principles

## 4.1 Server Orchestration

Server 是 Workflow 的编排中心。

```text
Server decides:
    What should be done

Client decides:
    Whether and how the local execution is permitted
```

Server 决定当前需要执行什么。

Client 决定本地是否允许执行，以及如何调用实际 Capability。

---

## 4.2 One Step at a Time

Server 每次只向 Client 下发一个当前 Step。

```text
Server
   │
   │ Step N
   ▼
Client
   │
   │ Evidence N
   ▼
Server
   │
   │ Step N+1
   ▼
Client
```

Server 不应该在协议层要求 Client 一次执行一个完整的多步骤 Workflow。

---

## 4.3 Evidence Driven

Client 返回的 Evidence 是 Server 后续决策的重要事实输入。

```text
Step
  ↓
Execution
  ↓
Evidence
  ↓
Context Update
  ↓
Re-plan / Completion Evaluation
```

Server 不应仅根据此前的计划假设继续执行。

---

## 4.4 Client Is More Than UI

Client 同时承担：

```text
User Interaction
+
Capability Runtime
+
Execution Runtime
```

因此 Client 不只是 Server 的显示界面。

---

## 4.5 LLM Is Not Protocol State Authority

LLM 可以：

* 生成 Step Proposal
* 分析 Evidence
* 提出下一步
* 提出 Completion Proposal

但 LLM 不直接拥有 Workflow State 的最终修改权。

Workflow State 由 Server 的 Workflow Engine 管理。

---

## 4.6 Request Completion Is Different From Step Completion

协议必须区分：

```text
Step Completion
```

和：

```text
Request Completion
```

Step 完成：

```text
当前 Step 是否完成
```

Request Completion：

```text
原始 User Request 是否可能已经解决
```

二者不能混为一谈。

---

## 4.7 User Owns Final Request Judgment

Server 可以判断：

```text
Request may be complete
```

但最终是否真正满足 User Request，由 User 确认。

---

# 5. Core Protocol Objects

Protocol 中的核心对象包括：

```text
User Request
Workflow
Step
Execution
Evidence
Capability Manifest
User Input
Completion Candidate
User Feedback
```

---

# 6. User Request

User Request 是 User 通过 Client 提交给 Server 的需求。

```text
User
  ↓
Client
  ↓
User Request
  ↓
Server
```

User Request 至少包含：

```text
request_id
content
client_id
session_id
```

其中：

* `request_id`：Request 唯一标识
* `content`：User 原始需求
* `client_id`：提交 Request 的 Client
* `session_id`：所属用户交互 Session

User Request 是整个 Workflow 的根输入。

---

# 7. Workflow

Server 接收到 User Request 后创建 Workflow。

```text
User Request
      ↓
Workflow
```

Workflow 是 Server 对 User Request 的一次解决过程。

Workflow State：

```text
CREATED
RUNNING
COMPLETED
FAILED
```

Workflow 是 Server 的权威状态对象。

Client 不直接修改 Workflow State。

---

# 8. Step

Step 是 Server 当前要求 Client 执行的一个具体动作。

Step 必须具有：

```text
step_id
workflow_id
capability
input
expected_output
```

概念示例：

```text
Step:
    capability:
        git.collect_diagnostics

    input:
        repository: "/workspace/project"

    expected_output:
        git status
        git diff
        recent commits
```

Step 必须足够具体，使 Client 能够将其映射到一个 Capability Invocation。

---

# 9. One-Step Execution Protocol

Step 的基本生命周期：

```text
Server
  │
  │ Step
  ▼
Client
  │
  ├── Validate
  │
  ├── Execute
  │
  └── Return Evidence
          │
          ▼
        Server
```

协议要求：

1. Server 发送当前 Step。
2. Client 接收 Step。
3. Client 验证 Capability 是否存在。
4. Client 验证本地是否允许执行。
5. Client 执行 Step。
6. Client 收集 Execution Result。
7. Client 返回 Evidence。
8. Server 根据 Evidence 更新 Workflow。
9. Server 决定继续 Re-plan 或进行 Request Completion Evaluation。

---

# 10. Execution

Execution 表示 Client 对一个 Step 的实际执行过程。

一个 Step 对应一次当前 Execution。

概念关系：

```text
Workflow
   │
   └── Step
        │
        └── Execution
              │
              └── Evidence
```

Execution 描述：

* 是否接受 Step
* 是否开始执行
* 是否执行成功
* 是否需要等待
* 执行产生的输出
* 执行产生的错误
* Execution Evidence

---

# 11. Capability Manifest

Client 可以向 Server 声明当前可用 Capability。

示例：

```text
filesystem.read
git.collect_diagnostics
docker.inspect
terminal.execute
browser.open
device.capture
local-agent.diagnose
```

Capability Manifest 用于帮助 Server 判断：

```text
当前 Client 能做什么
```

Server 应基于当前 Capability 生成可执行 Step。

---

# 12. Capability Advertisement

Client 可以在以下情况下向 Server 提供 Capability 信息：

* 建立 Session
* 创建 Workflow
* Workflow 执行过程中 Capability 发生变化
* Server 请求 Capability 信息

概念交互：

```text
Client
  │
  │ Capability Manifest
  ▼
Server
```

Capability 是动态信息。

Server 不应假设 Client 的 Capability 永远不变。

---

# 13. Step Validation

Client 收到 Step 后，应首先进行本地验证。

验证至少包括：

```text
Capability exists?
        ↓
Local execution allowed?
        ↓
Required local resources available?
        ↓
Execute
```

如果不能执行，Client 不应伪造 Evidence。

Client 应返回明确的 Execution Failure / Execution Rejection 信息。

Server 根据该结果决定后续处理方式。

---

# 14. Evidence

Evidence 是 Client 对 Step Execution 产生的实际事实、输出或观察结果。

Evidence 可以来自：

```text
Local Tool
Local Agent
File
Log
Service
Device
Test
User Input
User Feedback
```

示例：

```text
Evidence:
    type: command_output

    command:
        git status --short

    result:
        " M src/main.py"
```

Evidence 应尽可能表达实际观察结果，而不是 LLM 推测。

---

# 15. Evidence Return

Client 完成 Step 后：

```text
Client
  │
  │ Execution Result
  │ Evidence
  ▼
Server
```

Server 接收 Evidence 后：

```text
Evidence
   ↓
Context Update
   ↓
Request Completion Evaluation
   ↓
Re-plan / Completion Candidate
```

Evidence 不直接决定下一 Step。

下一 Step 由 Server Workflow Engine / Planner 根据更新后的 Context 决定。

---

# 16. Waiting Protocol

Step 可以进入：

```text
WAITING
```

WAITING 表示当前 Step 暂时无法继续执行，需要外部条件。

可能原因：

```text
User Input
User Confirmation
Local Service
Device
External Resource
```

示例：

```text
Step
 ↓
WAITING
 ↓
User provides information
 ↓
Client
 ↓
Server
 ↓
Step resumes
```

WAITING 是 Step 级状态。

它不是 Workflow 的全局暂停状态。

---

# 17. User Input During Execution

如果当前 Step 需要 User 提供信息：

```text
Step
 ↓
WAITING
 ↓
Client asks User
 ↓
User Input
 ↓
Client
 ↓
Server
```

User Input 可以成为当前 Step 的继续执行条件，也可以进入 Workflow Context。

---

# 18. Completion Evaluation

每次 Step 完成并产生 Evidence 后，Server 可以进行：

```text
Request Completion Evaluation
```

其判断对象是：

> 当前 Evidence 是否表明整个 User Request 可能已经解决？

而不是：

> 当前 Step 是否完成？

因此：

```text
Step Completed
      ↓
Request Completion Evaluation
```

不是：

```text
Step Completed
      ↓
Completion Candidate
```

---

# 19. Completion Evaluation Result

Request Completion Evaluation 至少有两类结果：

```text
NOT_COMPLETE
POSSIBLY_COMPLETE
```

### NOT_COMPLETE

表示当前 Evidence 不足以认为整个 Request 已经完成。

流程：

```text
NOT_COMPLETE
    ↓
Re-plan
    ↓
Next Step
```

### POSSIBLY_COMPLETE

表示 Server 判断整个 Request 可能已经完成。

流程：

```text
POSSIBLY_COMPLETE
       ↓
Completion Candidate
```

---

# 20. Completion Candidate

Completion Candidate 表示：

> Server 判断当前 User Request 可能已经解决，需要 User 最终确认。

Protocol：

```text
Server
  │
  │ Completion Candidate
  ▼
Client
  │
  ▼
User
```

Completion Candidate 应包含：

```text
request_id
workflow_id
summary
supporting_evidence
```

其中：

* `summary`：Server 对当前解决结果的总结
* `supporting_evidence`：支持完成判断的 Evidence

---

# 21. User Confirmation

User 对 Completion Candidate 进行最终确认。

结果：

```text
CONFIRMED
REJECTED
```

### CONFIRMED

```text
Completion Candidate
        ↓
User Confirmed
        ↓
Workflow COMPLETED
```

### REJECTED

User 可以提供 Feedback：

```text
Completion Candidate
        ↓
User Rejected
        ↓
User Feedback
        ↓
Server
        ↓
Context Update
        ↓
Re-plan
```

---

# 22. Completion Candidate Is Not Step Completion

协议必须明确：

```text
Step Completed
```

不等于：

```text
Completion Candidate
```

例如：

```text
Step 1 → Completed
Step 2 → Completed
Step 3 → Completed
Step 4 → Completed
```

每一个 Step 都可能只代表 Workflow 的中间过程。

只有 Server 判断整个 Request 可能完成时，才产生：

```text
Completion Candidate
```

---

# 23. Re-planning

Re-planning 是 Server 根据新的 Evidence / User Feedback 重新生成下一 Step 的过程。

基本流程：

```text
Evidence
   ↓
Context Update
   ↓
Planner
   ↓
New Step
```

Re-planning 的输入可以包括：

```text
User Request
Workflow State
Current Step
Previous Steps
Evidence
Capability Manifest
Knowledge
User Feedback
```

Planner 生成：

```text
Step Proposal
```

Workflow Engine 对其进行协议层验证后，才能作为正式 Step 下发。

---

# 24. User Feedback

User Feedback 是 User 对当前 Workflow / Completion Candidate / Execution 结果提供的额外信息。

例如：

```text
"问题还没有解决。"

"这个方案不能使用。"

"我真正想解决的是另一个错误。"

"请继续检查数据库连接。"
```

User Feedback 应进入 Server Context。

然后：

```text
User Feedback
      ↓
Context Update
      ↓
Re-plan
```

---

# 25. Protocol Message Direction

Protocol 消息按照方向分为：

## Client → Server

```text
User Request
Capability Manifest
Step Acceptance / Rejection
Execution Started
Execution Result
Evidence
User Input
User Confirmation
User Feedback
```

## Server → Client

```text
Workflow Created
Step
Waiting Request
Completion Candidate
Workflow Result
```

具体消息结构由后续 API / Protocol Schema 定义。

---

# 26. Core Interaction Sequence

## 26.1 Request Creation

```text
User
  ↓
Client
  │ User Request
  ▼
Server
  │
  │ Create Workflow
  ▼
Workflow
```

---

## 26.2 Step Execution

```text
Server
  │
  │ Step
  ▼
Client
  │
  │ Execution
  ▼
Local Capability
  │
  │ Evidence
  ▼
Client
  │
  │ Evidence
  ▼
Server
```

---

## 26.3 Re-planning

```text
Server
  │
  │ Evidence
  ↓
Context Update
  ↓
Planner
  ↓
Next Step
  │
  ▼
Client
```

---

## 26.4 Completion

```text
Evidence
   ↓
Request Completion Evaluation
   ↓
POSSIBLY_COMPLETE
   ↓
Completion Candidate
   ↓
Client
   ↓
User
   ├── CONFIRMED
   │      ↓
   │  Workflow COMPLETED
   │
   └── REJECTED
          ↓
      User Feedback
          ↓
        Re-plan
```

---

# 27. Protocol Invariants

以下规则是 Protocol 的强约束。

## Invariant 1 — Server Owns Workflow State

Client 不直接修改 Server Workflow State。

---

## Invariant 2 — One Active Step

对于一个 Workflow，Server 在正常执行过程中只向 Client 提供当前需要执行的 Step。

---

## Invariant 3 — Evidence Before Re-plan

正常情况下，当前 Step 的 Execution Result / Evidence 应成为下一次 Planning 的输入。

---

## Invariant 4 — Step Completion Is Not Request Completion

Step 完成不能直接导致 Workflow 完成。

---

## Invariant 5 — Completion Candidate Is Request-level

Completion Candidate 针对整个 User Request，而不是单个 Step。

---

## Invariant 6 — User Final Confirmation

Workflow 只有在 User 确认 Completion Candidate 后，才能进入：

```text
COMPLETED
```

---

## Invariant 7 — LLM Does Not Own State

LLM 产生 Proposal，但不能直接修改 authoritative Workflow State。

---

## Invariant 8 — Client Owns Local Execution

Server 可以要求 Client 执行 Capability，但 Client 保留本地执行许可与执行控制。

---

## Invariant 9 — No Fabricated Evidence

Client 不应把推测、假设或未实际执行的结果作为实际 Evidence 返回。

---

## Invariant 10 — Waiting Is Step-level

WAITING 表示当前 Step 等待外部条件，不代表 Workflow 必须进入一个独立的全局暂停状态。

---

# 28. Protocol Error Semantics

协议错误至少分为：

```text
INVALID_REQUEST
INVALID_WORKFLOW
INVALID_STEP
CAPABILITY_UNAVAILABLE
EXECUTION_REJECTED
EXECUTION_FAILED
INVALID_EVIDENCE
WAITING
PROTOCOL_ERROR
```

错误不应默认意味着 Workflow FAILED。

例如：

```text
CAPABILITY_UNAVAILABLE
        ↓
Server
        ↓
Re-plan
        ↓
Alternative Step
```

只有 Server 判断 Workflow 无法继续时，Workflow 才进入：

```text
FAILED
```

---

# 29. Protocol Versioning

Protocol 必须具有明确版本。

示例：

```text
protocol_version: "0.1"
```

Protocol Version 用于：

* Client / Server compatibility
* Message schema evolution
* Feature negotiation
* Backward compatibility

具体 Version Negotiation 机制由后续 API Specification 定义。

---

# 30. Non-Goals

当前 Protocol 不定义：

* HTTP Endpoint
* WebSocket Channel
* gRPC Service
* JSON Schema
* Database Schema
* Authentication
* Authorization
* Token Management
* Retry Policy
* Idempotency
* Message Queue
* Persistence
* Deployment
* Observability
* LLM Provider
* Prompt Engineering
* RAG Implementation
* MCP Implementation
* Local Agent Framework
* Cancellation

这些内容留给后续 Specification。

---

# 31. Protocol Definition

本系统 Protocol 的核心定义：

> **Client 向 Server 提交 User Request；Server 创建并驱动 Workflow，以 One-Step-at-a-Time 的方式向 Client 下发当前 Step；Client 通过本地 Capability 执行 Step 并返回实际 Evidence；Server 基于 Evidence 更新 Context 并进行 Re-planning 或 Request Completion Evaluation；当 Server 判断 User Request 可能完成时产生 Completion Candidate，由 Client 交给 User 最终确认；User 确认后 Workflow 才进入 COMPLETED，否则根据 User Feedback 继续 Re-planning。**

核心循环：

```text
User Request
     ↓
Workflow
     ↓
Step
     ↓
Execution
     ↓
Evidence
     ↓
Context Update
     ↓
Request Completion Evaluation
     ├── NOT_COMPLETE
     │       ↓
     │    Re-plan
     │       ↓
     │    Next Step
     │
     └── POSSIBLY_COMPLETE
             ↓
      Completion Candidate
             ↓
            User
          /       \
     Confirmed   Rejected
        ↓           ↓
   COMPLETED     Feedback
                    ↓
                 Re-plan
```

这就是 Client ↔ Server Protocol 的核心闭环。
