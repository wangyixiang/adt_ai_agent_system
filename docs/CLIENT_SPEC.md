# AI Client Specification

**Status:** Draft
**Version:** 0.1
**Role:** User Interaction + Local Capability / Execution Runtime

---

## 1. Purpose

AI Client 是一个独立运行在用户本地环境中的客户端程序。

它不是主要负责 LLM 推理的程序，也不是简单的聊天 UI。

它的核心职责是：

1. 与用户进行交互。
2. 与 Central Server 建立会话和工作流连接。
3. 向 Central Server 声明本地可用能力。
4. 接收 Central Server 生成的 workflow / execution steps。
5. 根据用户授权执行本地操作。
6. 将执行结果、状态和 Evidence 返回 Central Server。
7. 在执行过程中允许用户介入、确认、暂停、修改或终止流程。

核心原则：

> **Client owns interaction and local execution. Server owns intelligence and orchestration.**

---

# 2. Architectural Position

```text
                       CENTRAL SERVER
                              │
                    HTTPS / WebSocket / SSE
                              │
                              ▼
                 ┌─────────────────────────┐
                 │       AI CLIENT         │
                 │                         │
                 │  User Interaction       │
                 │  Session                │
                 │  Capability Registry    │
                 │  Workflow Runtime       │
                 │  Local Execution        │
                 │  Evidence Collection    │
                 │  Permission / Consent   │
                 └────────────┬────────────┘
                              │
              ┌───────────────┼────────────────┐
              │               │                │
              ▼               ▼                ▼
             MCP          Local Agent       Local Apps
              │               │                │
              └───────────────┼────────────────┘
                              │
                              ▼
                         Local System
```

Client 不负责最终的 AI Planning。

Client 可以拥有少量本地规则和执行逻辑，但不得成为另一个独立的中央 Agent。

---

# 3. Responsibilities

## 3.1 User Interaction

Client 必须提供：

* Chat UI
* Conversation UI
* Workflow UI
* Execution progress
* Step status
* Human confirmation
* Pause / Resume
* Stop / Cancel
* Error display
* Evidence display

用户应该能够看到：

```text
User Request
     ↓
Central Planning
     ↓
Step 1 ── completed
     ↓
Step 2 ── waiting for confirmation
     ↓
User approval
     ↓
Step 3 ── executing
     ↓
Step 4 ── failed
     ↓
Central replanning
```

---

# 4. Session

Client 必须支持长期 Session。

Session 至少包含：

```text
session_id
user_id
client_id
created_at
updated_at
server
workflow_sessions
local_capabilities
```

Client 不应假设本地 Session 就是完整的 AI Context。

AI Context 的最终构建由 Server 负责。

Client 保存的 conversation history 主要用于：

* UI 展示
* 本地缓存
* 离线恢复
* 与 Server 同步

---

# 5. Capability System

这是 Client 最重要的功能之一。

Client 必须能够向 Server 声明：

> “我本地可以做什么。”

例如：

```text
filesystem.read
filesystem.search
filesystem.write

shell.execute

browser.open
browser.navigate

git.status
git.diff
git.commit

docker.list
docker.start
docker.stop

python.execute

mcp.github
mcp.database

local.agent.execute
```

每个 Capability 必须具有明确的 schema。

示例：

```json
{
  "id": "filesystem.search",
  "version": "1.0",
  "description": "Search files in permitted local directories",
  "input_schema": {},
  "output_schema": {},
  "permission": "user_confirmation",
  "execution": "local"
}
```

---

# 6. Capability Discovery

Client 连接 Server 后，应主动发送 Capability Manifest。

```text
Client
  │
  │ capability.manifest
  ▼
Server
```

Server 可以根据这些能力进行后续 Planning。

Capability Manifest 不代表 Server 可以直接执行这些能力。

它只表示：

> Client 当前具备这些能力。

---

# 7. Dynamic Capability Updates

Capabilities 可能动态变化。

例如：

```text
Client started
    ↓
MCP connected
    ↓
+ mcp.github

Docker started
    ↓
+ docker.*

User revoked shell permission
    ↓
- shell.execute
```

Client 必须能够通知 Server：

```text
capability.added
capability.removed
capability.updated
```

Server 的 Planning 必须基于当前 Capability 状态。

---

# 8. Workflow Runtime

Client 必须支持 Server 驱动的 Workflow。

基本流程：

```text
User
 │
 │ request
 ▼
Client
 │
 │ user.request
 ▼
Server
 │
 │ workflow.plan
 ▼
Client
 │
 │ execute
 ▼
Local Capability
 │
 │ result
 ▼
Client
 │
 │ execution.result
 ▼
Server
 │
 │ re-plan
 ▼
...
```

Workflow 不应该要求 Client 预先知道完整流程。

Server 可以一次只发送一个 Step 或一个小批次 Steps。

---

# 9. Workflow Step

一个 Workflow Step 至少包含：

```json
{
  "workflow_id": "wf_xxx",
  "step_id": "step_001",
  "capability": "filesystem.search",
  "arguments": {},
  "reason": "...",
  "requires_confirmation": true,
  "timeout": 30000
}
```

Client 的职责：

1. 验证 capability 是否存在。
2. 验证参数。
3. 检查权限。
4. 根据策略决定是否需要用户确认。
5. 执行。
6. 捕获结果。
7. 捕获 Evidence。
8. 返回 Server。

---

# 10. Permission Model

Client 必须拥有最终的本地执行权限。

Server 不能绕过 Client 的权限系统直接控制本地机器。

建议至少支持：

```text
ALLOW
DENY
ASK
```

例如：

```text
filesystem.read      ALLOW
filesystem.write     ASK
shell.execute        ASK
docker.stop          ASK
browser.open         ALLOW
```

对于高风险操作：

```text
shell.execute
filesystem.delete
git.push
docker.stop
credential.access
```

默认应要求用户确认。

---

# 11. Human-in-the-loop

用户必须能够在 Workflow 中介入。

支持：

```text
Approve
Reject
Modify
Pause
Resume
Cancel
Retry
Skip
```

例如：

```text
Server:
"Please execute shell command:
 rm -rf ./build"

Client:
┌────────────────────────────┐
│ Central requests action    │
│                            │
│ rm -rf ./build             │
│                            │
│ [Approve] [Reject] [Edit]  │
└────────────────────────────┘
```

Client 是最终的人机控制边界。

---

# 12. Evidence

Client 不仅返回执行结果，还应尽可能返回 Evidence。

例如：

```json
{
  "type": "execution.result",
  "status": "completed",
  "result": {},
  "evidence": [
    {
      "type": "file",
      "path": "...",
      "content_hash": "...",
      "metadata": {}
    },
    {
      "type": "command_output",
      "command": "...",
      "stdout": "...",
      "stderr": "...",
      "exit_code": 0
    }
  ]
}
```

Evidence 可以成为 Server 后续 Context Assembly 的输入。

---

# 13. Local Agents

Client 可以连接本地 Agent。

例如：

```text
Client
 ├── MCP
 ├── Local Agent A
 ├── Local Agent B
 ├── Python Runtime
 ├── Shell
 └── Desktop Application
```

这些 Local Agents 不应该自动取代 Central Planner。

它们属于：

> execution capability

而不是：

> global orchestration authority

---

# 14. MCP

Client 应支持 MCP 或类似 Capability Protocol。

MCP Server 可以作为本地 Capability Provider：

```text
Client
  │
  ├── MCP Server A
  ├── MCP Server B
  ├── Local Tools
  └── Local Agents
```

Client 将 MCP 能力转换为统一 Capability Manifest 提供给 Central。

---

# 15. Communication

初始版本建议：

```text
REST API
+
WebSocket
```

REST 用于：

```text
authentication
session
workflow history
capability registration
file metadata
```

WebSocket 用于：

```text
workflow events
streaming
execution request
execution result
approval
pause/resume
```

必要时支持 SSE。

---

# 16. Reconnection

Client 必须支持断线恢复。

场景：

```text
Client
  │
  │ executing
  ▼
Network disconnected
  │
  ▼
Client reconnects
  │
  ▼
Server resumes session
```

Workflow 状态必须由 Server 持久化。

Client 不应该因为进程重启而丢失 Workflow 状态。

---

# 17. Security Boundary

Client 必须假设 Server 是：

```text
trusted orchestration service
```

但 Server 不应被授予：

```text
unrestricted local execution
```

本地安全边界始终位于 Client。

---

# 18. Non-Goals

Client 第一阶段不负责：

* LLM inference
* global context assembly
* global RAG
* global knowledge management
* global workflow planning
* model routing
* prompt optimization
* central agent memory

这些功能属于 Server。

---

# 19. Design Principle

最终 Client 应该满足：

> **Thin in intelligence, rich in capability.**

也就是说：

```text
少做：
LLM / Planning / Context

多做：
Interaction / Capability / Execution / Evidence
```

---

# 20. MVP

第一阶段只实现：

```text
Desktop UI
     │
     ▼
Authentication
     │
     ▼
Session
     │
     ▼
Central Server
     │
     ├── workflow request
     ├── workflow step
     └── result
     │
     ▼
Local Capability Runtime
     │
     ├── filesystem
     ├── shell
     └── MCP
```

暂不实现复杂 Local Agent。

---

# 21. Success Criteria

Client MVP 完成后，应能够完成：

```text
User:
"分析我的项目为什么无法启动"

        ↓

Client → Server

        ↓

Server:
发现 Client 有：

filesystem.search
filesystem.read
shell.execute

        ↓

Server:
生成 workflow

        ↓

Client:
请求用户授权

        ↓

Client:
执行本地操作

        ↓

Client → Server:
返回 logs / files / command output

        ↓

Server:
重新组装 Context

        ↓

Server:
调用 LLM

        ↓

Client:
展示最终结果
```

这就是 Client 的核心闭环。
