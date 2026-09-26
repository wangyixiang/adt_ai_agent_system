# PROTOCOL_SPEC.md

**Version:** v0.2
**Status:** Draft
**Scope:** Client ↔ Server Protocol

---

# 1. Purpose

本文档定义 AI Client 与 Central Server 之间的通信协议语义。

协议负责定义：

* Client 与 Server 如何交换信息
* User Request 如何进入 Server
* Workflow 如何驱动
* Step 如何下发
* Execution 如何发生
* Evidence 如何返回
* WAITING 如何处理
* Completion Candidate 如何产生和确认
* Capability 如何声明
* User Feedback 如何重新进入 Workflow
* 局部 Execution Failure 与 Workflow Failure 的区别

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
│               User                  │
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
Context Update
      ↓
Re-plan / Completion Evaluation
```

---

# 3. Participants

## 3.1 Client

Client 负责：

* 接收 User Request
* 向 Server 提交 User Request
* 声明本地 Capability
* 接收 Server 下发的 Step
* 验证本地是否允许执行 Step
* 创建并执行 Execution
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
* 修改 Server 的 authoritative Workflow State

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
* 判断 Workflow 是否仍然可以继续

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
   │ Execution
   │
   │ Evidence N
   ▼
Server
   │
   │ Step N+1
   ▼
Client
```

Server 不应在协议层要求 Client 一次执行一个完整的多步骤 Workflow。

一个 Step 可以在 Client 内部调用一个复合 Capability。

例如：

```text
Step
  ↓
git.collect_diagnostics
  ├── git status
  ├── git diff
  └── git log
```

对于 Server 来说，这仍然是一个 Step。

但一个完整的 Workflow 不应被隐藏成一个 Step。

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

Step Completion 解决：

> 当前 Step 是否完成？

Request Completion 解决：

> 原始 User Request 是否可能已经解决？

二者不能混为一谈。

---

## 4.7 User Owns Final Request Judgment

Server 可以判断：

```text
Request may be complete
```

但最终是否真正满足 User Request，由 User 确认。

---

## 4.8 Local Execution Failure Is Not Automatically Workflow Failure

一个 Step 或 Execution 的失败是**局部执行结果**。

它本身不能直接导致：

```text
Workflow = FAILED
```

Server 必须根据失败原因、Evidence、Capability 和剩余可行路径判断 Workflow 是否仍然可以继续。

因此：

```text
Execution FAILED
      ↓
Server Evaluation
   ┌──┴──────────────┐
   ↓                 ↓
Can Continue      Cannot Continue
   ↓                 ↓
Re-plan         Workflow FAILED
```

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

其中最重要的关系是：

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

Workflow 是 Server 的 authoritative state object。

Client 不直接修改 Workflow State。

---

# 8. Step

Step 是 Server 当前要求 Client 执行的一个具体动作。

Step 表达：

> **Server 希望 Client 做什么。**

概念结构：

```text
Step:
    step_id
    workflow_id
    capability
    input
    expected_output
```

例如：

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

Step 本身不表示执行已经发生。

---

# 9. Execution

Execution 表示 Client 对某一个 Step 的一次实际执行。

Execution 表达：

> **这个 Step 实际执行了一次，执行过程和执行结果如何。**

关系：

```text
Step
  │
  ├── Execution 1
  │
  ├── Execution 2
  │
  └── Execution N
```

一个 Step 在需要 Retry / Re-execution 时，可以存在多个 Execution。

例如：

```text
Step-001
   │
   ├── Execution-001 → FAILED
   │
   └── Execution-002 → COMPLETED
```

Execution 可以包含：

```text
execution_id
step_id
status
started_at
finished_at
error
runtime_information
```

Execution 描述的是**执行本身**，而不是执行产生的事实内容。

---

# 10. Evidence

Evidence 是 Execution 实际产生或观察到的事实、输出或结果。

Evidence 表达：

> **执行之后实际观察到了什么。**

例如：

```text
Execution:
    status: COMPLETED
    exit_code: 0

Evidence:
    type: command_output

    stdout:
        "connection refused: postgres:5432"
```

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

Evidence 应尽可能表达实际观察结果，而不是 LLM 推测。

---

# 11. Step / Execution / Evidence Boundary

三者必须保持明确边界：

| 对象        | 核心问题      | 主要方向            |
| --------- | --------- | --------------- |
| Step      | 要做什么？     | Server → Client |
| Execution | 这一次执行怎么样？ | Client → Server |
| Evidence  | 实际观察到了什么？ | Client → Server |

关系：

```text
                 Server
                   │
                   │ Step
                   ▼
              ┌─────────┐
              │  Step   │
              └────┬────┘
                   │
                   │ execute
                   ▼
              ┌───────────┐
              │ Execution │
              └─────┬─────┘
                    │
                    │ produces
                    ▼
              ┌───────────┐
              │ Evidence  │
              └─────┬─────┘
                    │
                    ▼
                  Server
```

特别需要区分：

```text
Step ≠ Execution
Execution ≠ Evidence
Step ≠ Evidence
```

---

# 12. Execution and Evidence Relationship

一个 Execution 可以产生多个 Evidence。

例如：

```text
Execution-001
    ├── Evidence-001: command output
    ├── Evidence-002: log
    ├── Evidence-003: test result
    └── Evidence-004: generated report
```

因此：

```text
Execution 1 : N Evidence
```

是协议允许的关系。

Evidence 可以进一步被 Server 组合进入 Context。

---

# 13. One-Step Execution Protocol

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
  ├── Create Execution
  │
  ├── Execute
  │
  └── Return Execution Result + Evidence
          │
          ▼
        Server
```

协议要求：

1. Server 发送当前 Step。
2. Client 接收 Step。
3. Client 验证 Capability 是否存在。
4. Client 验证本地是否允许执行。
5. Client 创建 Execution。
6. Client 执行 Step。
7. Client 收集 Execution Result。
8. Client 收集 Evidence。
9. Client 返回 Execution Result / Evidence。
10. Server 更新 Workflow。
11. Server 进行 Request Completion Evaluation 或 Re-plan。

---

# 14. Execution States and Results

Execution 描述一次具体执行。

执行结果至少可以表达：

```text
SUCCESS
FAILURE
WAITING
REJECTED
```

这些结果描述的是**当前 Execution**，不是整个 Workflow。

例如：

```text
Execution:
    FAILURE
```

只说明：

> 这次执行失败。

并不直接说明：

> 整个 Workflow 已经失败。

---

# 15. Capability Manifest

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

# 16. Capability Advertisement

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

# 17. Step Validation

Client 收到 Step 后，应首先进行本地验证。

验证至少包括：

```text
Capability exists?
        ↓
Local execution allowed?
        ↓
Required local resources available?
        ↓
Create Execution
        ↓
Execute
```

如果不能执行，Client 不应伪造 Evidence。

Client 应返回明确的 Execution Rejection / Failure 信息。

Server 根据该结果决定后续处理方式。

---

# 18. Evidence Return

Client 完成或中止当前 Execution 后：

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

# 19. Waiting Protocol

Step 可以进入：

```text
WAITING
```

WAITING 表示：

> 当前 Step 的 Execution 暂时无法继续，需要外部条件。

可能原因：

```text
User Input
User Confirmation
Local Service
Device
External Resource
```

例如：

```text
Step
 ↓
Execution
 ↓
WAITING
 ↓
External condition satisfied
 ↓
Execution resumes
 ↓
Evidence
```

WAITING 是 Step / Execution 级条件。

它不是 Workflow 的独立全局状态。

---

# 20. User Input During Execution

如果当前 Execution 需要 User 提供信息：

```text
Step
 ↓
Execution
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

User Input 可以：

* 作为当前 Execution 的继续条件
* 作为 Evidence
* 进入 Workflow Context

具体语义由后续 `USER_INTERACTION_SPEC.md` 定义。

---

# 21. Request Completion Evaluation

每次 Step / Execution 完成并产生新的 Evidence 后，Server 可以进行：

```text
Request Completion Evaluation
```

判断对象是：

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

# 22. Completion Evaluation Result

Request Completion Evaluation 至少有两类结果：

```text
NOT_COMPLETE
POSSIBLY_COMPLETE
```

## 22.1 NOT_COMPLETE

表示当前 Evidence 不足以认为整个 Request 已经完成。

流程：

```text
NOT_COMPLETE
    ↓
Re-plan
    ↓
Next Step
```

---

## 22.2 POSSIBLY_COMPLETE

表示 Server 判断整个 Request 可能已经完成。

流程：

```text
POSSIBLY_COMPLETE
       ↓
Completion Candidate
```

---

# 23. Completion Candidate

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

# 24. User Confirmation

User 对 Completion Candidate 进行最终确认。

结果：

```text
CONFIRMED
REJECTED
```

## 24.1 CONFIRMED

```text
Completion Candidate
        ↓
User Confirmed
        ↓
Workflow COMPLETED
```

## 24.2 REJECTED

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

# 25. Completion Candidate Is Not Step Completion

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

每一个 Step 都可能只是 Workflow 的中间过程。

只有 Server 判断整个 Request 可能完成时，才产生：

```text
Completion Candidate
```

---

# 26. Re-planning

Re-planning 是 Server 根据新的 Evidence / User Feedback 重新生成下一 Step 的过程。

基本流程：

```text
Evidence
   ↓
Context Update
   ↓
Planner
   ↓
Step Proposal
   ↓
Workflow Engine Validation
   ↓
New Step
```

Re-planning 的输入可以包括：

```text
User Request
Workflow State
Current Step
Previous Steps
Execution Results
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

# 27. User Feedback

User Feedback 是 User 对当前 Workflow、Completion Candidate 或 Execution 结果提供的额外信息。

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

# 28. Failure and Error Semantics

Protocol 必须明确区分三个层次：

```text
Error
Execution Failure
Workflow Failure
```

## 28.1 Error

Error 描述某个操作、Capability、消息或执行过程出现的问题。

例如：

```text
CAPABILITY_UNAVAILABLE
INVALID_INPUT
COMMAND_EXIT_NONZERO
RESOURCE_UNAVAILABLE
PERMISSION_DENIED
```

Error 是一种事实描述。

---

## 28.2 Execution Failure

Execution Failure 表示：

> 当前这一次 Execution 没有成功完成。

例如：

```text
Step:
    terminal.execute
    command: docker compose up
```

Execution：

```text
status:
    FAILURE
```

Evidence：

```text
exit_code: 1

stderr:
    "port 8080 is already allocated"
```

此时：

```text
Execution = FAILED
```

但：

```text
Workflow = RUNNING
```

仍然完全合法。

---

## 28.3 Workflow Failure

Workflow FAILED 表示：

> Server 判断当前 Workflow 已经无法继续完成 User Request。

例如：

```text
Execution FAILED
      ↓
Server evaluates failure
      ↓
Re-plan
      ↓
No available Capability
      ↓
No viable alternative
      ↓
Workflow FAILED
```

因此：

```text
Execution FAILED
        ≠
Workflow FAILED
```

---

# 29. Failure Recovery

Execution Failure 后，Server 可以根据具体情况选择：

```text
Execution Failure
       ↓
Server Evaluation
   ┌───┼───────────┬────────────┐
   ↓   ↓           ↓            ↓
Retry  Re-plan   Alternative   Fail Workflow
```

例如：

### Retry

```text
Step-001
   │
   ├── Execution-001 → FAILED
   │
   └── Execution-002 → SUCCESS
```

### Re-plan

```text
Step-001
   ↓
Execution FAILED
   ↓
Evidence
   ↓
Planner
   ↓
Step-002
```

### Alternative Capability

```text
Step:
    terminal.execute

Execution:
    REJECTED

       ↓

Planner

       ↓

Alternative Step:
    local-agent.diagnose
```

### Workflow Failure

只有在 Server 判断不存在可继续的有效路径时：

```text
Workflow → FAILED
```

具体 Retry / Recovery Policy 不在本 Protocol 中规定。

---

# 30. Protocol Message Direction

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

# 31. Core Interaction Sequence

## 31.1 Request Creation

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

## 31.2 Step Execution

```text
Server
  │
  │ Step
  ▼
Client
  │
  │ Create Execution
  ▼
Local Capability
  │
  │ Execution Result
  │ Evidence
  ▼
Client
  │
  │ Evidence
  ▼
Server
```

---

## 31.3 Re-planning

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

## 31.4 Execution Failure and Recovery

```text
Step
  ↓
Execution
  ↓
FAILURE
  ↓
Evidence
  ↓
Server Evaluation
  ├── Retry
  ├── Re-plan
  ├── Alternative Step
  └── Workflow FAILED
```

前三种情况 Workflow 仍然可以保持：

```text
RUNNING
```

---

## 31.5 Completion

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

# 32. Protocol Invariants

以下规则是 Protocol 的强约束。

## Invariant 1 — Server Owns Workflow State

Client 不直接修改 Server Workflow State。

---

## Invariant 2 — One Active Step

对于一个 Workflow，Server 在正常执行过程中只向 Client 提供当前需要执行的 Step。

---

## Invariant 3 — Step and Execution Are Different

Step 表达 Server 希望执行的动作。

Execution 表达 Client 对该 Step 的一次实际执行。

一个 Step 可以存在多个 Execution。

---

## Invariant 4 — Evidence Represents Observed Facts

Evidence 表达实际执行产生或观察到的事实。

Evidence 不应被伪造成未实际执行的结果。

---

## Invariant 5 — Evidence Before Re-plan

正常情况下，当前 Execution 的结果和 Evidence 应成为下一次 Planning 的输入。

---

## Invariant 6 — Step Failure Is Local

Execution Failure 或 Step Failure 不自动导致 Workflow FAILED。

Server 必须判断 Workflow 是否仍然可以继续。

---

## Invariant 7 — Workflow Failure Is Global

Workflow FAILED 表示 Server 判断当前 Workflow 已经无法继续完成 User Request。

---

## Invariant 8 — Step Completion Is Not Request Completion

Step 完成不能直接导致 Workflow 完成。

---

## Invariant 9 — Completion Candidate Is Request-level

Completion Candidate 针对整个 User Request，而不是单个 Step。

---

## Invariant 10 — User Final Confirmation

Workflow 只有在 User 确认 Completion Candidate 后，才能进入：

```text
COMPLETED
```

---

## Invariant 11 — LLM Does Not Own State

LLM 产生 Proposal，但不能直接修改 authoritative Workflow State。

---

## Invariant 12 — Client Owns Local Execution

Server 可以要求 Client 执行 Capability，但 Client 保留本地执行许可与执行控制。

---

## Invariant 13 — No Fabricated Evidence

Client 不应把推测、假设或未实际执行的结果作为实际 Evidence 返回。

---

## Invariant 14 — Waiting Is Step / Execution-level

WAITING 表示当前 Step / Execution 等待外部条件。

它不是 Workflow 的独立全局状态。

---

# 33. Protocol Versioning

Protocol 必须具有明确版本。

示例：

```text
protocol_version: "0.2"
```

Protocol Version 用于：

* Client / Server compatibility
* Message schema evolution
* Feature negotiation
* Backward compatibility

具体 Version Negotiation 机制由后续 API Specification 定义。

---

# 34. Non-Goals

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

# 35. Protocol Definition

本系统 Protocol 的核心定义：

> **Client 向 Server 提交 User Request；Server 创建并驱动 Workflow，以 One-Step-at-a-Time 的方式向 Client 下发当前 Step；Client 对 Step 创建并执行 Execution，通过本地 Capability 完成实际操作并返回 Execution Result 与 Evidence；Server 基于 Evidence 更新 Context，并进行 Re-planning 或 Request Completion Evaluation。Execution Failure 只表示当前执行失败，不自动意味着 Workflow Failure；Server 根据失败 Evidence 判断是否 Retry、Re-plan、采用替代路径，或者最终将 Workflow 标记为 FAILED。当 Server 判断 User Request 可能完成时产生 Completion Candidate，由 Client 交给 User 最终确认；User 确认后 Workflow 才进入 COMPLETED，否则根据 User Feedback 继续 Re-planning。**

核心闭环：

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

核心失败闭环：

```text
Step
  ↓
Execution
  ↓
FAILURE
  ↓
Evidence
  ↓
Server Evaluation
  ├── Retry
  ├── Re-plan
  ├── Alternative Step
  └── Workflow FAILED
```

其中：

```text
Execution FAILED
        ≠
Workflow FAILED
```

只有 Server 判断整个 Workflow 已经不存在可继续完成 User Request 的有效路径时，Workflow 才进入 `FAILED`。
