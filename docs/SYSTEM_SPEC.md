# SYSTEM_SPEC.md

**Version:** v0.1
**Status:** Draft
**Purpose:** Define the core behavior, responsibilities, boundaries, and lifecycle of the AI Client + Central Server system.
**写作要求**: SYSTEM_SPEC.md 保持在系统行为层，暂时不进入 API 字段、数据库、具体 LLM、WebSocket、Electron 等实现细节。 它的作用是成为后面所有 Spec 的“母规格”：后面的 Protocol / Workflow / Capability / Evidence 都必须能够从这里推导出来。

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

系统的核心执行模型：

> **Request → Plan → Step → Execute → Evidence → Re-plan → ... → User Confirmation**

---

# 2. Core Concept

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
  Re-planning
      │
      ▼
    Step ...
```

最终：

```text
Completion Candidate
        │
        ▼
       User
      /     \
  Solved   Not Solved
     │          │
     ▼          ▼
 Completed   Re-plan
```

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
* Completion 状态

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
  │ Re-plan
  │
  │ Step 2
  ▼
Client
```

Server 不提前向 Client 下发完整的未来 Step 序列。

原因：

> 每个 Step 执行后产生的新 Evidence 都可能改变下一步的决策。

因此系统采用：

> **Plan → Execute → Observe → Re-plan**

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

Evidence 是 Re-planning 的主要输入。

```text
Step
 ↓
Execution
 ↓
Evidence
 ↓
Context
 ↓
Planner
 ↓
Next Step
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

**Context** 是 Server 为当前 Planning 决策构建的工作上下文。

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

Context 在每次 Re-plan 前可以重新组合。

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
Planner
```

Knowledge 用于辅助 Planning 和 Reasoning。

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
* 触发 Re-plan
* 处理 Completion Proposal
* 管理 Workflow 生命周期

核心关系：

```text
Planner
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

> **LLM 负责提出建议，Workflow Engine 负责决定系统状态如何变化。**

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

Server 可以根据 Failure Evidence 重新规划。

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

# 18. Re-planning

Re-planning 是本系统的核心机制。

触发条件包括：

* Step Completed
* Step Failed
* Step Waiting 后获得所需输入
* User 提供新的信息
* User 判断当前结果仍未解决 Request
* Client Capability 发生变化
* 新 Evidence 改变了问题理解

基本流程：

```text
Evidence
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

---

# 19. Completion Model

系统区分：

### System Completion Candidate

Server 根据当前 Evidence 判断：

> 当前结果已经达到系统可以判断的完成条件。

对于可以形式化的任务：

```text
Evidence
   ↓
Completion Criteria
   ↓
Workflow Engine
   ↓
Completion Candidate
```

对于开放式任务：

```text
Evidence
   ↓
Planner
   ↓
Completion Proposal
   ↓
Workflow Engine
   ↓
Completion Candidate
```

Completion Candidate **不直接意味着 User Request 已经最终解决**。

---

# 20. User Final Confirmation

当 Server 认为当前结果已经达到 Completion Candidate 时：

```text
Server
  ↓
Completion Candidate
  ↓
Client
  ↓
User
```

Client 将结果展示给 User。

User 判断：

> **这个结果是否真正解决了我的 Request？**

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

> **系统可以判断“达到完成条件”，但最终“Request 是否真正解决”由 User 确认。**

---

# 21. Human-in-the-loop

Human-in-the-loop 存在于两个层次。

## 21.1 Execution-level

User 为当前 Step 提供信息或确认。

```text
Step
 ↓
WAITING
 ↓
User Interaction
 ↓
Continue
```

## 21.2 Request-level

Workflow 达到 Completion Candidate 后：

```text
Completion Candidate
 ↓
User Confirmation
 ↓
Completed / Re-plan
```

User 不直接管理 Workflow State。

User 的输入通过 Client 提交给 Server，由 Workflow Engine 决定后续状态。

---

# 22. Responsibility Boundary

系统的核心职责边界：

```text
┌────────────────────────────────────────┐
│ User                                   │
│                                        │
│ 决定自己的 Request 是否真正解决          │
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
│ Planning                               │
│ Re-planning                            │
└──────────────────┬─────────────────────┘
                   │
                   ▼
                 LLM
```

核心原则：

> **User 决定是否真正解决。**
> **Client 负责交互和执行。**
> **Server 负责编排和状态。**
> **LLM 负责推理和规划。**

---

# 23. End-to-End Lifecycle

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
                    Update Context
                          │
                          ▼
                       Re-plan
                          │
                 ┌────────┴────────┐
                 │                 │
              Continue        Completion
                 │              Candidate
                 │                 │
                 │                 ▼
                 │              Client
                 │                 │
                 │                 ▼
                 │               User
                 │              /     \
                 │         Solved     Not Solved
                 │            │           │
                 │            ▼           │
                 │       COMPLETED        │
                 │                        │
                 └────────────────────────┘
                          Re-plan
```

---

# 24. Core Design Principles

系统必须遵循以下原则：

### 24.1 Central Orchestration

> Central Server 是全局 Workflow 的编排中心。

### 24.2 Edge Execution

> Client 负责本地能力和本地执行。

### 24.3 One Step at a Time

> Server 一次只下发一个当前 Step。

### 24.4 Evidence Driven

> 下一步规划应尽可能基于实际 Evidence。

### 24.5 LLM Is Not State Authority

> LLM 可以提出决策，但不直接拥有 Workflow State。

### 24.6 User Owns the Final Judgment

> 系统可以判断达到 Completion Candidate，但 User 最终确认 Request 是否真正解决。

### 24.7 Client Is More Than UI

> Client 不只是 UI，而是 User Interaction + Local Capability + Execution Runtime。

### 24.8 Local Intelligence Is Subordinate

> Client 可以拥有 Local Agent，但 Local Agent 不拥有全局 Workflow 控制权。

---

# 25. Non-Goals

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

# 26. Next Specifications

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

# 27. System Definition

本系统最终可以概括为：

> **一个由 Central Server 负责 AI Planning 和 Workflow Orchestration、由 AI Client 负责 User Interaction 和 Local Execution、通过 Evidence 驱动持续 Re-planning，并由 User 最终确认 Request 是否真正解决的 Human-in-the-loop AI 系统。**
