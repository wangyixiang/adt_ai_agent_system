# SERVER_SPEC.md

**Version:** v0.2
**Role:** Central AI Orchestrator

---

# 1. Purpose

Central Server 是整个系统的 AI Brain + Context Engine + Knowledge Engine + Workflow Orchestrator。

Server 负责：

* 接收 Client 提交的 User Request
* 理解 User Request
* 管理 Workflow
* 组合 Context
* 提取 Knowledge
* 调用 LLM / Planner
* 根据 Client Capability 制定下一步
* 一次只生成一个 Step
* 根据 Client 返回的 Evidence 重新规划
* 判断是否达到系统可判断的完成条件
* 将最终结果交给 Client，由 User 确认 Request 是否真正解决

核心原则：

> **Server 不直接执行本地操作，只负责决定下一步应该做什么。**

---

# 2. Architecture

```text
                  Client
                     │
                     │ User Request
                     ▼
              ┌──────────────┐
              │    Server    │
              │              │
              │ Request      │
              │ Context      │
              │ Knowledge    │
              │ Workflow     │
              │ Planner      │
              └──────┬───────┘
                     │
                     │ One Step
                     ▼
                  Client
                     │
                     │ Execution
                     ▼
              Local Capability
                     │
                     │ Evidence
                     ▼
                  Server
```

---

# 3. Responsibilities

Server MUST：

1. 接收 User Request
2. 创建和维护 Workflow
3. 管理 Workflow 状态
4. 组合当前 Context
5. 获取相关 Knowledge
6. 获取并考虑 Client Capability
7. 调用 LLM / Planner
8. 生成当前 Step
9. 一次只向 Client 下发一个 Step
10. 接收 Step Execution Result / Evidence
11. 根据 Evidence 更新 Context
12. 决定是否继续 Re-plan
13. 在达到系统可判断的完成条件后进入最终确认流程

Server MUST NOT：

* 直接执行 Client 本地操作
* 绕过 Client 访问本地资源
* 让 LLM 直接修改 Workflow authoritative state
* 一次向 Client 下发完整的未来执行计划

---

# 4. User Request

User Request 由 Client 提交。

```text
User
 ↓
Client
 ↓
User Request
 ↓
Server
```

Server 接收到 Request 后创建对应 Workflow。

```text
User Request
     ↓
 Workflow
```

User Request 是：

> **User 想解决的问题。**

Workflow 是：

> **Server 为解决这个 Request 而运行的过程。**

Step 是：

> **Workflow 当前需要执行的具体动作。**

Evidence 是：

> **Step 实际执行后得到的结果。**

---

# 5. Workflow

Workflow 是 Server 管理的核心执行对象。

基本状态：

```text
CREATED
RUNNING
COMPLETED
FAILED
```

其中：

* `CREATED`：Workflow 已创建，尚未开始执行
* `RUNNING`：Workflow 正在推进
* `COMPLETED`：Request 已完成最终确认
* `FAILED`：Workflow 无法继续完成

Step 的状态独立于 Workflow。

---

# 6. Workflow State Authority

Workflow State 的最终权威是 Workflow Engine。

LLM 是 Planner，不是 Workflow State Authority。

```text
LLM
 ↓
Proposal
 ↓
Workflow Engine
 ↓
State Transition
```

LLM 可以提出：

* 下一步是什么
* Step 如何执行
* 是否已经达到完成条件
* 下一步应该如何处理 Evidence

但 LLM 不直接修改 Workflow 的 authoritative state。

---

# 7. Context

Server 负责构建当前 Workflow Context。

Context 可以包括：

```text
User Request
+
Conversation
+
Previous Steps
+
Evidence
+
Client Capability
+
Knowledge
+
Current Workflow State
```

Server 在每次 Re-plan 前重新组合 Context。

---

# 8. Knowledge

Server 可以从 Knowledge Base 获取与当前 Request 相关的信息。

```text
User Request
      ↓
Knowledge Retrieval
      ↓
Relevant Knowledge
      ↓
Context
      ↓
LLM
```

Knowledge 是 Planner 的输入，不是 Workflow State。

---

# 9. Client Capability

Server 应考虑当前 Client 的 Capability。

例如：

```text
Client A

Capabilities:
- filesystem.read
- git.collect_diagnostics
- docker.inspect
- terminal.execute
```

Planner 可以根据 Capability 选择可执行的 Step。

因此：

> **Server 的计划必须建立在 Client 实际可用能力之上。**

---

# 10. One-Step Planning

这是 Server 的核心约束。

Server 一次只生成一个当前 Step。

```text
Request
 ↓
Plan
 ↓
Step 1
 ↓
Execute
 ↓
Evidence
 ↓
Re-plan
 ↓
Step 2
 ↓
Execute
 ↓
Evidence
 ↓
...
```

Server 不应该：

```text
Step 1
Step 2
Step 3
Step 4
```

一次全部发送给 Client。

原因：

> 每一个 Step 执行后都会产生新的 Evidence，下一步应该基于最新 Evidence 重新规划。

---

# 11. Step

一个 Step 至少描述：

```text
Step
├── objective
├── capability
├── input
└── expected_output
```

例如：

```text
objective:
  检查项目为什么无法启动

capability:
  project.diagnose

input:
  project_path: /workspace/app

expected_output:
  diagnostic_result
```

Step 描述：

> **做什么。**

而不是：

> **整个问题应该如何解决。**

---

# 12. Execution Loop

核心循环：

```text
Plan
 ↓
Execute
 ↓
Observe
 ↓
Re-plan
```

完整过程：

```text
                    ┌───────────────┐
                    │ User Request  │
                    └───────┬───────┘
                            ↓
                         Context
                            ↓
                           LLM
                            ↓
                          Step
                            ↓
                         Client
                            ↓
                      Local Execution
                            ↓
                         Evidence
                            ↓
                     Context Update
                            ↓
                           LLM
                            │
                     ┌──────┴──────┐
                     │             │
                   Continue       Done Candidate
                     │             │
                     ↓             ↓
                   Step          Client
                                   ↓
                                  User
```

---

# 13. Step States

Server 管理 Step 状态：

```text
PENDING
RUNNING
WAITING
COMPLETED
FAILED
```

### PENDING

Step 已创建，但尚未开始执行。

### RUNNING

Client 正在执行。

### WAITING

当前 Step 需要外部条件才能继续。

例如：

* User Input
* User Confirmation
* 本地服务
* 设备
* 外部资源

### COMPLETED

Step 已成功执行并产生 Evidence。

### FAILED

Step 执行失败。

失败不一定意味着 Workflow 立即失败。

Server 可以根据失败 Evidence：

* Retry
* Change Approach
* Generate Another Step
* 判断无法继续

---

# 14. Evidence

Evidence 是 Server Re-plan 的核心输入。

```text
Step
 ↓
Execution
 ↓
Evidence
 ↓
Context Update
 ↓
Re-plan
```

Evidence 可以来自：

* Client 工具
* Local Agent
* 文件
* 日志
* 服务
* 设备
* 测试
* User Input
* User Feedback

Server 不应只依赖 LLM 的推测，而应尽可能使用实际 Evidence。

---

# 15. Completion

Server 根据 Workflow 的完成条件和当前 Evidence 判断：

> 当前 Request 是否已经达到系统可以判断的完成条件。

对于可形式化的 Request：

```text
Evidence
 ↓
Completion Criteria
 ↓
Workflow Engine
 ↓
Completion Candidate
```

例如：

```text
service.status == running
health_check == OK
```

对于开放式 Request：

```text
Evidence
 ↓
LLM
 ↓
Completion Proposal
 ↓
Workflow Engine
```

LLM 可以提出：

> “当前证据表明 Request 可能已经解决。”

但：

> **LLM 不直接决定最终 Workflow State。**

---

# 16. User Final Confirmation

达到 Completion Candidate 后，不立即把 User Request 视为最终解决。

Server 将结果发送给 Client：

```text
Server
 ↓
Result / Completion Candidate
 ↓
Client
 ↓
User
```

User 最终确认：

```text
          User
         /    \
     Solved   Not Solved
       ↓          ↓
  Completed    Re-plan
```

### Solved

Workflow 进入：

```text
COMPLETED
```

### Not Solved

Client 将 User Feedback 返回 Server。

Server：

```text
User Feedback
 ↓
Context Update
 ↓
Re-plan
 ↓
Next Step
```

因此：

> **Server 判断“是否达到系统完成条件”，User 判断“是否真正解决了自己的 Request”。**

---

# 17. Human-in-the-loop

Human Interaction 不等于 Workflow Control。

User 可以在两个阶段参与：

### Execution-time

```text
Step
 ↓
WAITING
 ↓
User Input
 ↓
Continue
```

### Request-level

```text
Completion Candidate
 ↓
User Confirmation
 ↓
Completed / Re-plan
```

User 不直接修改 Workflow State。

User 的输入通过 Client 返回 Server，由 Server 决定后续 Workflow 行为。

---

# 18. LLM Role

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

---

# 19. Server / Client Boundary

核心边界只有一句话：

> **Server 决定“要做什么”，Client 决定“本地是否允许执行”。**

```text
Server
  │
  │ What to do
  ▼
Client
  │
  │ Can / How to execute locally
  ▼
Local Capability
```

Server 不需要知道 Client 内部具体如何实现 Capability。

---

# 20. Core Protocol Concepts

v0.2 只定义概念，不固定具体消息 Schema。

Server → Client：

```text
workflow.start
execution.request
user.input.request
completion.candidate
```

Client → Server：

```text
capability.manifest
capability.updated
execution.started
execution.waiting
execution.completed
execution.failed
user.response
evidence
client.status
```

具体字段和通信机制放入独立的：

```text
PROTOCOL_SPEC.md
```

---

# 21. Core Architecture

```text
                    USER
                     │
                     ▼
                  CLIENT
                     │
              User Request
                     │
                     ▼
              ┌─────────────┐
              │   SERVER    │
              │             │
              │   Context   │
              │   Knowledge │
              │   Workflow  │
              │   Planner   │
              └──────┬──────┘
                     │
                  One Step
                     │
                     ▼
                  CLIENT
                     │
              Local Execution
                     │
                     ▼
                 Evidence
                     │
                     ▼
                  SERVER
                     │
                   Re-plan
                     │
                    ...
                     │
                     ▼
            Completion Candidate
                     │
                     ▼
                  CLIENT
                     │
                     ▼
                   USER
                ↙         ↘
            Solved       Not Solved
               │             │
               ▼             ▼
          COMPLETED       Re-plan
```

---

# 22. Design Principle

Server 的核心原则：

> **Server 不负责执行整个解决方案，而是持续决定当前最合理的下一步。**

整个系统形成：

> **Request → Plan → Step → Execute → Evidence → Re-plan → ... → User Confirmation**

最终：

> **LLM 负责思考，Workflow Engine 负责状态，Client 负责执行和交互，User 负责确认自己的 Request 是否真正解决。**
