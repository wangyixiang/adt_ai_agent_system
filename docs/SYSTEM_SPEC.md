# SYSTEM_SPEC.md

**Version:** v0.2
**Status:** Draft
**Purpose:** Define the core behavior, responsibilities, boundaries, and lifecycle of the AI Client + Central Server system.

---

# 1. System Overview

本系统由两个核心部分组成：

```text
┌─────────────────────┐
│      AI Client      │
│                     │
│ User Interaction    │
│ Local Capabilities  │
│ Local Execution     │
└──────────┬──────────┘
           │
           │ Protocol
           │
┌──────────▼──────────┐
│   Central Server    │
│                     │
│ Request Management  │
│ Workflow Engine     │
│ Context Engine      │
│ Knowledge Engine    │
│ AI Planner          │
└─────────────────────┘
```

系统核心执行模型：

```text
Request
   ↓
Plan
   ↓
Step
   ↓
Execute
   ↓
Evidence
   ↓
Evaluate Request Completion
   │
   ├── Not Complete → Re-plan
   │
   └── Possibly Complete
             ↓
      Completion Candidate
             ↓
       User Confirmation
          /         \
      Solved      Not Solved
         ↓            ↓
     Completed      Re-plan
```

核心原则：

> **每个 Step 都产生 Evidence，但不是每个 Step 都进入 Completion Candidate。**

---

# 2. Core Concepts

系统中的核心对象：

```text
User Request
      │
      ▼
   Workflow
      │
      ▼
     Step
      │
      ▼
  Execution
      │
      ▼
   Evidence
      │
      ▼
Request Completion Evaluation
      │
      ├── Not Complete → Re-plan
      │
      └── Possibly Complete
                  ↓
         Completion Candidate
                  ↓
            User Confirmation
```

这些对象分别代表：

| Concept              | Meaning                          |
| -------------------- | -------------------------------- |
| User Request         | User 希望解决的问题或完成的任务               |
| Workflow             | Server 为处理 Request 而管理的过程        |
| Step                 | 当前需要执行的具体动作                      |
| Execution            | Client 对 Step 的实际执行              |
| Evidence             | 实际执行、观察或 User Interaction 得到的结果  |
| Completion Candidate | Server 判断 Request 可能已经解决后的候选完成状态 |
| User Confirmation    | User 对 Request 是否真正解决的最终判断       |

---

# 3. User Request

## 3.1 Definition

**User Request** 是 User 希望系统帮助解决的问题、完成的任务或达到的目标。

User Request 由 Client 产生并提交给 Server。

```text
User
  ↓
Client Interaction
  ↓
User Request
  ↓
Server
```

Client 可以通过：

* 对话
* 表单
* 文件
* 参数
* 其他交互方式

收集 User Request。

Client 不负责制定完整解决方案。

---

# 4. Workflow

## 4.1 Definition

**Workflow** 是 Server 为处理一个 User Request 而创建并管理的执行过程。

关系：

```text
User Request
      │
      │ 1 : 1
      ▼
  Workflow
```

Workflow 负责组织：

* 当前执行状态
* 当前 Step
* Context
* Evidence
* Request Completion Evaluation
* Completion Candidate

Workflow 是 Server 端的 authoritative state。

---

# 5. Step

## 5.1 Definition

**Step** 是 Workflow 当前需要执行的一个具体动作。

例如：

```text
检查项目 Git 状态
```

或者：

```text
运行项目测试
```

Step 应描述：

```text
做什么
需要什么 Capability
输入是什么
期望得到什么结果
```

Step 不描述整个 Workflow。

---

# 6. One-Step Execution Model

Server 一次只向 Client 下发一个可执行 Step。

```text
Server
  │
  │ Step 1
  ▼
Client
  │
  │ Evidence
  ▼
Server
  │
  │ Evaluate Request
  │
  ├──── Not Complete ────→ Re-plan
  │                           │
  │                         Step 2
  │
  └──── Possibly Complete
              ↓
       Completion Candidate
```

Server 不提前向 Client 下发完整的未来 Step 序列。

原因：

> 每个 Step 执行后产生的新 Evidence 都可能改变下一步的决策。

因此系统采用：

> **Plan → Execute → Observe → Evaluate → Re-plan**

而不是：

> **Plan Everything → Execute**

---

# 7. Execution

Execution 是 Client 对当前 Step 的实际执行过程。

```text
Step
 ↓
Client
 ↓
Capability
 ↓
Local Execution
 ↓
Result
 ↓
Evidence
```

Server 负责决定：

> **What to do**

Client 负责：

> **Whether and how to execute locally**

---

# 8. Capability

**Capability** 表示 Client 当前能够提供给 Server 使用的本地能力。

例如：

```text
filesystem.read
git.collect_diagnostics
docker.inspect
terminal.execute
browser.open
device.capture
local-agent.diagnose
```

Capability 的核心作用：

> 让 Server 知道当前 Client 能够做什么。

Server 根据 Capability 生成可执行的 Step。

Client 可以动态增加、删除或更新 Capability。

---

# 9. Local Agent

Client 可以包含本地 Agent。

```text
Central Planner
      │
      ▼
    Step
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

Local Agent 可以具有一定的本地自主能力。

但：

> Local Agent 不拥有全局 Workflow 的控制权。

它只能在 Client 提供的执行边界内工作。

---

# 10. Evidence

**Evidence** 是系统从实际执行、观察或 User Interaction 中获得的事实或结果。

Evidence 是后续 Request Completion Evaluation 和 Re-planning 的主要输入。

```text
Step
 ↓
Execution
 ↓
Evidence
 ↓
Context
 ↓
Request Completion Evaluation
       │
       ├── Not Complete → Planner
       │
       └── Possibly Complete
```

Evidence 可以来自：

* 本地工具
* Local Agent
* 文件
* 日志
* 服务
* 设备
* 测试
* User Input
* User Feedback

系统应优先基于实际 Evidence 进行后续决策，而不是仅依赖 LLM 推测。

---

# 11. Context

**Context** 是 Server 为当前 Planning 和 Completion Evaluation 构建的工作上下文。

Context 可以包含：

```text
User Request
+
Conversation
+
Workflow State
+
Current Step
+
Previous Steps
+
Evidence
+
Client Capabilities
+
Knowledge
```

Context 在每次 Re-plan 或 Completion Evaluation 前可以重新组合。

因此：

> Context 不是静态对象，而是随着 Workflow 推进不断更新的工作上下文。

---

# 12. Knowledge

Server 可以从 Knowledge Source 获取与当前 User Request 相关的信息。

基本关系：

```text
User Request
      │
      ▼
Knowledge Retrieval
      │
      ▼
Relevant Knowledge
      │
      ▼
Context
      │
      ▼
Planner / Evaluation
```

Knowledge 用于辅助 Planning、Reasoning 和 Completion Evaluation。

Knowledge 本身不是 Workflow State。

---

# 13. Planner

Planner 是 Server 中负责推理和规划的组件，通常由 LLM 驱动。

Planner 的输入：

```text
User Request
Context
Knowledge
Client Capabilities
Evidence
```

Planner 可以产生：

```text
Next Step Proposal
```

或者：

```text
Completion Proposal
```

Planner 不直接修改 Workflow authoritative state。

---

# 14. Workflow Engine

Workflow Engine 是 Workflow State 的权威管理者。

其职责包括：

* 创建 Workflow
* 管理 Workflow 状态
* 管理 Step 状态
* 接收 Execution Result
* 保存 Evidence
* 触发 Request Completion Evaluation
* 触发 Re-plan
* 处理 Completion Proposal
* 管理 Workflow 生命周期

核心关系：

```text
Planner / Evaluation
          │
          │ Proposal
          ▼
Workflow Engine
          │
          │ State / Action
          ▼
       Client
```

即：

> **LLM 可以提出建议，但 Workflow Engine 负责管理 authoritative state。**

---

# 15. Workflow State

Workflow 的核心状态：

```text
CREATED
RUNNING
COMPLETED
FAILED
```

### CREATED

Workflow 已创建，但尚未开始执行。

### RUNNING

Workflow 正在处理 User Request。

### COMPLETED

User 最终确认 Request 已解决。

### FAILED

Workflow 无法继续完成 Request。

---

# 16. Step State

Step 的核心状态：

```text
PENDING
RUNNING
WAITING
COMPLETED
FAILED
```

### PENDING

Step 已创建，但尚未执行。

### RUNNING

Step 正在执行。

### WAITING

Step 需要外部条件才能继续。

例如：

* User Input
* User Confirmation
* Local Service
* Device
* External Resource

### COMPLETED

Step 已成功执行并产生 Evidence。

### FAILED

Step 执行失败。

Step Failed 不必然意味着 Workflow Failed。

Server 可以根据 Failure Evidence：

* Retry
* Change Approach
* Generate Another Step
* 判断无法继续

---

# 17. Waiting

`WAITING` 表示：

> 当前 Step 暂时无法继续，需要外部条件。

例如：

```text
Step
 ↓
WAITING
 ↓
User Input
 ↓
RUNNING
 ↓
COMPLETED
```

`WAITING` 不表示 Workflow 被暂停。

它只是当前 Step 的执行状态。

---

# 18. Request Completion Evaluation

这是系统区别于普通 Step Workflow 的关键机制。

每当一个 Step 产生新的 Evidence 后，Server 可以评估：

> **当前所有 Evidence 是否已经足以表明 User Request 可能已经解决？**

这个判断针对的是：

> **整个 User Request**

而不是当前 Step。

因此：

```text
Step Completed
      ↓
Evidence
      ↓
Request Completion Evaluation
```

可能产生两种结果：

### 18.1 Not Complete

```text
Evidence
   ↓
Evaluation
   ↓
Request Not Complete
   ↓
Re-plan
   ↓
Next Step
```

这是最常见的路径。

### 18.2 Possibly Complete

```text
Evidence
   ↓
Evaluation
   ↓
Request Possibly Complete
   ↓
Completion Candidate
```

只有这一种情况下才进入 User Confirmation。

---

# 19. Completion Candidate

**Completion Candidate** 不是每个 Step 的必经状态。

它表示：

> Server 根据当前 Workflow 的全部相关 Evidence，认为 User Request 可能已经解决，并准备请求 User 最终确认。

例如：

```text
Step 1 → Evidence
            ↓
        Not Complete
            ↓
          Step 2
            ↓
         Evidence
            ↓
        Not Complete
            ↓
          Step 3
            ↓
         Evidence
            ↓
        Possibly Complete
            ↓
     Completion Candidate
```

因此：

> **Step Completion ≠ Request Completion Candidate**

两者必须明确区分。

---

# 20. Completion Model

系统采用三级完成模型：

```text
Step Completion
      ↓
Request Completion Evaluation
      ↓
Completion Candidate
      ↓
User Confirmation
      ↓
Request Completion
```

## 20.1 Step Completion

回答：

> 当前 Step 是否完成？

主要根据当前 Step 的 Execution Result 和 Evidence 判断。

---

## 20.2 Request Completion Evaluation

回答：

> 当前整个 User Request 是否已经可能解决？

这是 Request-level 判断。

可能由：

* Workflow Engine
* 明确的 Completion Criteria
* Planner / LLM 提出的 Completion Proposal

共同参与。

---

## 20.3 User Confirmation

回答：

> 这个结果是否真的解决了 User 自己的问题？

这是最终的 User-level 判断。

---

# 21. Completion Evaluation Examples

## 21.1 Formalizable Request

例如：

> “确认服务是否正常运行。”

Completion Criteria：

```text
service.status == running
health_check == OK
```

执行：

```text
Step
 ↓
Evidence
 ↓
Completion Criteria
 ↓
Possibly Complete
 ↓
User Confirmation
```

---

## 21.2 Open-ended Request

例如：

> “帮我解决这个项目启动问题。”

可能执行多个 Step：

```text
检查日志
 ↓
发现依赖问题
 ↓
安装依赖
 ↓
重新启动
 ↓
运行测试
 ↓
Evidence
 ↓
Planner 判断可能已经解决
 ↓
Completion Candidate
 ↓
User Confirmation
```

---

# 22. User Final Confirmation

只有当 Server 进入 `Completion Candidate` 后，才需要进行 Request-level User Confirmation。

```text
Completion Candidate
        ↓
      Client
        ↓
       User
      /     \
 Solved     Not Solved
    │           │
    ▼           ▼
COMPLETED     Re-plan
```

### User 确认已解决

```text
User
 ↓
Client
 ↓
Server
 ↓
Workflow = COMPLETED
```

### User 判断尚未解决

Client 将 User Feedback 返回 Server：

```text
User
 ↓
Client
 ↓
User Feedback
 ↓
Server
 ↓
Context Update
 ↓
Re-plan
```

因此：

> **不是每个 Step 都询问 User。**

只有：

> **Server 判断整个 Request 可能已经解决时，才请求 User 做最终确认。**

---

# 23. Human-in-the-loop

Human-in-the-loop 存在于两个层次。

## 23.1 Execution-level Human Interaction

当前 Step 需要 User 提供信息：

```text
Step
 ↓
WAITING
 ↓
User Input
 ↓
RUNNING
 ↓
COMPLETED
```

这种交互是为了帮助当前 Step 继续执行。

---

## 23.2 Request-level User Confirmation

整个 Request 被认为可能已经解决：

```text
Completion Candidate
 ↓
User Confirmation
 ↓
Completed / Re-plan
```

这种交互是为了确认：

> **User 的原始 Request 是否真正解决。**

两者不能混淆。

---

# 24. Re-planning

Re-planning 是本系统的核心机制。

触发条件包括：

* Step Completed
* Step Failed
* Step Waiting 后获得所需输入
* User 提供新的信息
* User 在 Completion Confirmation 中判断尚未解决
* Client Capability 发生变化
* 新 Evidence 改变了问题理解
* Request Completion Evaluation 判断 Not Complete

基本流程：

```text
Evidence / User Feedback
          ↓
     Context Update
          ↓
        Planner
          ↓
   Next Step Proposal
          ↓
    Workflow Engine
          ↓
       Next Step
```

注意：

> **Request Completion Evaluation 与 Re-planning 是两个不同的决策阶段。**

---

# 25. LLM Role

LLM 是 Planner / Reasoner。

LLM 可以：

* 理解 Request
* 分析 Context
* 使用 Knowledge
* 分析 Evidence
* 选择 Capability
* 生成下一 Step
* 提出 Completion Proposal

LLM 不负责：

* 直接执行 Client 操作
* 直接修改 Workflow State
* 直接访问 Client 本地资源
* 自动宣布 User Request 已最终解决

尤其：

> **LLM 可以提出“可能已经解决”的 Completion Proposal，但最终 Request Completion 需要经过 User Confirmation。**

---

# 26. Responsibility Boundary

系统的核心职责边界：

```text
┌────────────────────────────────────────┐
│ User                                   │
│                                        │
│ 最终判断自己的 Request 是否真正解决       │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Client                                 │
│                                        │
│ User Interaction                       │
│ Local Capability                       │
│ Local Execution                        │
│ Evidence Collection                    │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Server                                 │
│                                        │
│ Request Management                     │
│ Workflow State                         │
│ Context                                │
│ Knowledge                              │
│ Completion Evaluation                  │
│ Planning / Re-planning                 │
└──────────────────┬─────────────────────┘
                   │
                   ▼
                 LLM
```

核心原则：

> **User 决定是否真正解决。**
> **Client 负责交互和执行。**
> **Server 负责编排、评估和状态。**
> **LLM 负责推理和规划。**

---

# 27. End-to-End Lifecycle

完整 User Request 生命周期：

```text
                         User
                          │
                          ▼
                       Client
                          │
                     User Request
                          │
                          ▼
                   Create Workflow
                          │
                          ▼
                    Build Context
                          │
                          ▼
                    Planner / LLM
                          │
                          ▼
                        Step
                          │
                          ▼
                       Client
                          │
                    Local Execution
                          │
                          ▼
                      Evidence
                          │
                          ▼
              Request Completion Evaluation
                          │
                 ┌────────┴─────────┐
                 │                  │
            Not Complete       Possibly Complete
                 │                  │
                 ▼                  ▼
              Re-plan       Completion Candidate
                 │                  │
                 ▼                  ▼
              Next Step           Client
                                    │
                                    ▼
                                  User
                               /         \
                           Solved       Not Solved
                              │              │
                              ▼              ▼
                         COMPLETED        Re-plan
```

核心循环：

```text
Plan
 ↓
Step
 ↓
Execute
 ↓
Evidence
 ↓
Evaluate Request Completion
 ↓
┌──────────────────────┐
│                      │
│ Not Complete         │──→ Re-plan
│                      │
│ Possibly Complete    │──→ User Confirmation
│                      │
└──────────────────────┘
```

---

# 28. Core Design Principles

### 28.1 Central Orchestration

> Central Server 是全局 Workflow 的编排中心。

### 28.2 Edge Execution

> Client 负责本地能力和本地执行。

### 28.3 One Step at a Time

> Server 一次只下发一个当前 Step。

### 28.4 Evidence Driven

> 后续决策应尽可能基于实际 Evidence。

### 28.5 Request-level Completion Evaluation

> Completion Evaluation 针对整个 User Request，而不是单个 Step。

### 28.6 Completion Candidate Is Not Step Completion

> Step 完成不代表 Request 已解决，也不自动触发 User Confirmation。

### 28.7 User Owns the Final Judgment

> Server 可以判断 Request 可能已经解决，但 User 最终确认 Request 是否真正解决。

### 28.8 LLM Is Not State Authority

> LLM 可以提出规划和 Completion Proposal，但不直接拥有 Workflow State。

### 28.9 Client Is More Than UI

> Client 是 User Interaction + Local Capability + Execution Runtime。

### 28.10 Local Intelligence Is Subordinate

> Client 可以拥有 Local Agent，但 Local Agent 不拥有全局 Workflow 控制权。

---

# 29. Non-Goals

本 Spec 暂不定义：

* 具体 API Schema
* WebSocket / HTTP / gRPC
* 数据库结构
* LLM Provider
* Prompt Engineering
* RAG 实现
* MCP 协议细节
* Client 技术栈
* Server 技术栈
* Authentication / Authorization 详细方案
* Retry / Idempotency 详细机制
* Deployment
* Observability
* Multi-tenant

这些内容由后续 Spec 定义。

---

# 30. Next Specifications

基于本 Spec，后续规格按以下顺序展开：

```text
SYSTEM_SPEC.md
      │
      ├── PROTOCOL_SPEC.md
      │
      ├── WORKFLOW_SPEC.md
      │
      ├── CAPABILITY_SPEC.md
      │
      ├── EVIDENCE_SPEC.md
      │
      ├── USER_INTERACTION_SPEC.md
      │
      ├── CONTEXT_SPEC.md
      │
      ├── KNOWLEDGE_SPEC.md
      │
      ├── PLANNER_SPEC.md
      │
      ├── DATA_MODEL.md
      │
      └── API_SPEC.md
```

这些 Spec 最终共同形成：

```text
Implementation Plan
        ↓
Coding Agent
        ↓
Product
```

---

# 31. System Definition

本系统最终可以概括为：

> **一个由 Central Server 负责 AI Planning、Request-level Completion Evaluation 和 Workflow Orchestration，由 AI Client 负责 User Interaction 和 Local Execution，通过 Evidence 驱动持续 Re-planning，并在 Server 判断 Request 可能已经解决后，由 User 最终确认 Request 是否真正解决的 Human-in-the-loop AI 系统。**
