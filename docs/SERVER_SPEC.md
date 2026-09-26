# Central AI Server Specification

**Status:** Draft
**Version:** 0.1
**Role:** AI Brain + Context Engine + Knowledge Engine + Workflow Orchestrator

---

# 1. Purpose

Central Server 是整个系统的 AI Brain。

它负责：

1. 管理用户 Session。
2. 管理 Conversation。
3. 组装 LLM Context。
4. 从 Knowledge Base / RAG 系统提取知识。
5. 管理 Workflow。
6. 根据 Client Capability 进行 Planning。
7. 调用 LLM。
8. 选择和调度可用 Capability。
9. 根据 Client 返回的 Evidence 重新 Planning。
10. 管理整个解决问题的闭环。

核心原则：

> **Server owns intelligence and orchestration. Client owns interaction and local execution.**

---

# 2. Architectural Position

```text
                       ┌──────────────────────┐
                       │       USER           │
                       └──────────┬───────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │       CLIENT         │
                       │ UI / Interaction     │
                       │ Local Capabilities   │
                       │ Local Execution      │
                       └──────────┬───────────┘
                                  │
                           API / WebSocket
                                  │
                                  ▼
              ┌────────────────────────────────────────┐
              │              CENTRAL SERVER             │
              │                                        │
              │ Session Manager                        │
              │ Conversation Manager                   │
              │ Context Engine                         │
              │ Knowledge / RAG                        │
              │ Workflow Engine                        │
              │ Planner                                │
              │ Capability Registry                    │
              │ LLM Gateway                            │
              │ Evidence Manager                       │
              │ Policy / Audit                         │
              └──────────────────┬─────────────────────┘
                                 │
                ┌────────────────┼─────────────────┐
                ▼                ▼                 ▼
             Vector DB        Knowledge          LLM
                                                vLLM
                                                SGLang
                                                OpenAI
                                                Claude
```

---

# 3. Core Responsibilities

Server 是：

```text
Context Engine
+
Knowledge Engine
+
Workflow Engine
+
Planner
+
LLM Gateway
```

而不是简单的：

```text
HTTP Proxy → LLM
```

---

# 4. Session Management

Server 必须维护：

```text
user
client
session
conversation
workflow
```

关系：

```text
User
 └── Session
      ├── Conversation
      ├── Workflow A
      ├── Workflow B
      └── Client Connection
```

Server 是 Session State 的最终权威来源。

---

# 5. Conversation Management

Server 必须保存：

```text
User Message
Assistant Message
System Context
Tool Call
Tool Result
Workflow Event
Evidence Reference
```

Conversation 不应该简单地作为：

```text
messages[]
```

无限增长。

Server 必须支持：

```text
summarization
compaction
context selection
message importance
memory extraction
```

---

# 6. Context Engine

Context Engine 是 Server 的核心组件。

它负责把不同来源的信息组合成最终 LLM Context。

输入：

```text
User Request
Conversation
Memory
Knowledge
Workflow State
Client Capabilities
Execution Evidence
System Instructions
Tool Definitions
```

输出：

```text
LLM Context
```

抽象为：

```text
Context =
    System Context
  + User Context
  + Conversation Context
  + Knowledge Context
  + Workflow Context
  + Capability Context
  + Evidence Context
  + Tool Context
```

---

# 7. Context Assembly Pipeline

推荐：

```text
User Request
      │
      ▼
Intent / Task Analysis
      │
      ▼
Context Retrieval
      │
      ├── Conversation
      ├── Memory
      ├── Knowledge
      ├── Workflow
      ├── Capability
      └── Evidence
      │
      ▼
Context Ranking
      │
      ▼
Context Compression
      │
      ▼
Prompt Assembly
      │
      ▼
LLM
```

Context Engine 不应该简单地把所有信息塞进 Prompt。

---

# 8. Knowledge System

Server 必须支持 Knowledge Base。

Knowledge 来源可以包括：

```text
Documents
Code
Database
Wiki
User Knowledge
Project Knowledge
External Sources
Execution Evidence
```

Knowledge Retrieval 可以使用：

```text
Vector Search
Keyword Search
Hybrid Search
Metadata Filter
Graph / Relationship Search
```

---

# 9. Project / Workspace Context

Server 应支持 Workspace。

例如：

```text
Workspace: automotive-hil-project

Knowledge:
  architecture/
  specifications/
  logs/
  test-results/

Conversation:
  ...

Capabilities:
  client-A:
    filesystem
    shell
    CAN
    serial
    oscilloscope
```

Workspace Context 可以成为 LLM Context 的重要来源。

---

# 10. Client Capability Registry

Server 必须维护 Client Capability Registry。

例如：

```text
Client A

filesystem.read
filesystem.search
shell.execute
docker.*
mcp.git
mcp.github
```

Registry 至少记录：

```text
client_id
capability_id
version
schema
availability
permission
last_seen
metadata
```

Server Planning 时必须考虑：

> 当前连接的 Client 到底有什么能力。

---

# 11. Capability Is Not Tool Execution

Server 不直接执行 Client Capability。

Server 只生成：

```text
Execution Request
```

例如：

```json
{
  "workflow_id": "wf_123",
  "step_id": "step_5",
  "target_client": "client_abc",
  "capability": "filesystem.search",
  "arguments": {
    "path": "/project",
    "pattern": "*.log"
  }
}
```

Client 执行后返回结果。

---

# 12. Workflow Engine

Workflow 是整个系统的核心控制结构。

基本状态：

```text
CREATED
PLANNING
WAITING_FOR_CLIENT
WAITING_FOR_USER
EXECUTING
OBSERVING
REPLANNING
COMPLETED
FAILED
PAUSED
CANCELLED
```

---

# 13. Workflow Loop

Server 必须支持闭环：

```text
                    ┌──────────────┐
                    │ User Request │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │   Planning   │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Execute Step │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │    Observe   │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Evidence     │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Re-context   │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Re-plan      │
                    └──────┬───────┘
                           │
                           └───────────► Execute
```

这不是一次性的 Agent Call。

它是一个：

> **Observe → Context → Plan → Execute → Observe**

循环。

---

# 14. Planner

Planner 的输入：

```text
User Goal
Conversation
Knowledge
Current Workflow State
Client Capabilities
Previous Evidence
Previous Failures
Policies
```

Planner 的输出：

```text
Plan
```

例如：

```json
{
  "goal": "find why application fails",
  "steps": [
    {
      "capability": "filesystem.search",
      "arguments": {}
    },
    {
      "capability": "shell.execute",
      "arguments": {}
    }
  ]
}
```

Planner 可以由 LLM 驱动，但 Workflow Engine 必须拥有最终状态控制权。

---

# 15. LLM Gateway

LLM 不应该直接散落在业务代码中。

Server 应提供统一：

```text
LLM Gateway
```

支持：

```text
vLLM
SGLang
OpenAI
Anthropic
Gemini
Ollama
Other OpenAI-compatible endpoints
```

统一接口：

```text
generate()
stream()
embed()
rerank()
```

---

# 16. Model Routing

Server 可以根据任务选择模型。

例如：

```text
simple classification
      ↓
small model

planning
      ↓
reasoning model

large context RAG
      ↓
long-context model
```

模型选择属于 Server。

Client 不需要知道使用哪个模型。

---

# 17. Evidence System

Evidence 是 Workflow 的一等公民。

Server 必须能够保存：

```text
Command Output
File
Log
Screenshot
Structured Result
Test Result
Measurement
Tool Output
User Confirmation
```

每个 Evidence 应包含：

```text
evidence_id
workflow_id
step_id
source
timestamp
type
content/reference
hash
metadata
```

---

# 18. Evidence → Context

Evidence 不应该全部直接塞入 Context。

流程：

```text
Evidence
   │
   ▼
Evidence Processing
   │
   ├── validation
   ├── parsing
   ├── summarization
   ├── extraction
   └── indexing
   │
   ▼
Knowledge / Context
   │
   ▼
Planner
```

这使 Server 可以处理大量本地执行结果。

---

# 19. Human-in-the-loop

Server 必须允许 Workflow 进入：

```text
WAITING_FOR_USER
```

例如：

```text
Server
 ↓
Client
 ↓
"Do you want to modify production configuration?"
 ↓
User
 ↓
Approve / Reject
 ↓
Client
 ↓
Server
```

用户的决定必须作为 Workflow Event 保存。

---

# 20. Workflow Persistence

Workflow 必须持久化。

Server 重启后：

```text
Workflow
   ↓
restore
   ↓
resume
```

Workflow State 不依赖 Client 内存。

---

# 21. Event Model

Server 与 Client 的通信应该采用 Event Model。

核心事件：

```text
session.created
session.updated

capability.registered
capability.updated
capability.removed

workflow.created
workflow.started
workflow.paused
workflow.resumed
workflow.cancelled
workflow.completed

workflow.step.created
workflow.step.started
workflow.step.waiting_confirmation
workflow.step.completed
workflow.step.failed

execution.request
execution.result

evidence.created

context.updated

assistant.message
assistant.stream
```

---

# 22. Client Connection

Server 必须支持：

```text
Client connect
Client authenticate
Capability registration
Heartbeat
Event streaming
Reconnect
Session recovery
```

推荐：

```text
HTTPS
+
WebSocket
```

---

# 23. Authentication

Server 必须验证 Client 身份。

至少支持：

```text
User Authentication
Client Authentication
Session Authentication
Capability Authorization
```

Client ID 不应该等价于 User ID。

一个 User 可以有多个 Client：

```text
User
 ├── Desktop
 ├── Laptop
 ├── HIL Bench
 └── Server Agent
```

---

# 24. Authorization

Server 应控制：

```text
who can create workflow
who can access knowledge
which client can participate
which workspace can be accessed
```

Client 再控制：

```text
which local operation can actually execute
```

形成双层安全模型：

```text
Central Authorization
          +
Local Authorization
```

---

# 25. Audit

Server 必须记录：

```text
User request
LLM decision
Workflow plan
Capability selection
Execution request
Client result
User approval
Evidence
Final result
```

这样可以完整重建：

> 为什么系统最终执行了这个操作。

---

# 26. Failure Handling

Server 必须处理：

```text
Client offline
Capability unavailable
Execution timeout
Execution failure
LLM failure
RAG failure
Context overflow
User cancellation
Network failure
```

Planner 不应该把失败简单转换成最终错误。

可以进入：

```text
OBSERVE
   ↓
ANALYZE
   ↓
REPLAN
```

---

# 27. Server Does Not Assume Client Is Always Available

例如：

```text
User asks:
"分析我的本地项目"

Client offline
```

Server 可以：

```text
保存 request
WAITING_FOR_CLIENT
```

Client 回来以后：

```text
resume workflow
```

---

# 28. Multi-Client

未来 Server 可以同时管理多个 Client。

例如：

```text
                    Central
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      Desktop        HIL Bench    Server Agent
          │            │            │
      filesystem      CAN         database
      browser         ECU         docker
```

Planner 可以根据 Capability Registry 选择目标 Client。

---

# 29. Multi-Agent

Server 可以支持多个 Agent Role：

```text
Planner
Researcher
Coder
Debugger
Verifier
Reviewer
```

但是这些 Agent 都属于 Central。

Client Local Agent 属于 Execution Layer。

---

# 30. Non-Goals

Server 第一阶段不负责：

* Desktop UI
* Local filesystem access
* Local shell execution
* Local application control
* Local hardware access
* Direct access to user's machine

Server 必须通过 Client Capability 执行这些操作。

---

# 31. MVP

Server MVP：

```text
Authentication
      ↓
Session
      ↓
Conversation
      ↓
Context Assembly
      ↓
LLM Gateway
      ↓
Capability Registry
      ↓
Workflow Engine
      ↓
Execution Request
      ↓
Evidence
      ↓
Replanning
```

第一阶段可以暂时不实现复杂 Multi-Agent。

---

# 32. MVP End-to-End Example

用户：

> "帮我分析这个项目为什么启动失败。"

Client：

```text
user.request
```

Server：

```text
create workflow
```

Server 发现：

```text
Client capabilities:

filesystem.search
filesystem.read
shell.execute
git.status
```

Server：

```text
Context Assembly
+
LLM Planning
```

生成：

```text
Step 1:
filesystem.search

Step 2:
filesystem.read

Step 3:
shell.execute
```

Client：

```text
Step 1 → result
Step 2 → result
Step 3 → user confirmation
```

用户：

```text
Approve
```

Client：

```text
Step 3 → execution
```

返回：

```text
stdout
stderr
exit_code
logs
```

Server：

```text
Evidence Processing
       ↓
Context Assembly
       ↓
LLM
       ↓
Replanning
```

最后：

```text
Server
   ↓
Final explanation / solution
   ↓
Client
   ↓
User
```

---

# 33. Core Design Principle

Central Server 应该是：

> **The Brain**

Client 应该是：

> **The Interface + Hands**

更准确地说：

```text
Server
    Understand
    Remember
    Retrieve
    Plan
    Reason
    Orchestrate
    Decide next action

Client
    Interact
    Discover capabilities
    Ask permission
    Execute
    Observe
    Collect evidence
    Report
```

最终形成：

```text
                ┌───────────────┐
                │     HUMAN     │
                └───────┬───────┘
                        │
                        ▼
                ┌───────────────┐
                │    CLIENT     │
                │               │
                │ Interface     │
                │ Capability    │
                │ Execution     │
                │ Evidence      │
                └───────┬───────┘
                        │
                        ▼
                ┌───────────────┐
                │    CENTRAL    │
                │               │
                │ Context      │
                │ Knowledge    │
                │ Planning     │
                │ Workflow     │
                │ LLM          │
                └───────┬───────┘
                        │
                        ▼
                     REASON
                        │
                        ▼
                     PLAN
                        │
                        ▼
                   EXECUTION
                        │
                        ▼
                    EVIDENCE
                        │
                        └───────────────┐
                                        │
                                        ▼
                                    RE-CONTEXT
                                        │
                                        ▼
                                     RE-PLAN
```

