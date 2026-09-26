# CLIENT_SPEC.md

**Version:** v0.2
**Role:** AI Client / User Interaction + Local Execution Runtime

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

核心原则：

> **Client 执行当前 Step，不负责决定下一个 Step。**

---

# 2. Architecture

```text
                  User
                   │
                   ▼
              ┌─────────┐
              │ Client  │
              │         │
              │ UI      │
              │ Session │
              │ Runtime │
              └────┬────┘
                   │
            User Request / Result
                   │
                   ▼
              ┌─────────┐
              │ Central │
              │ Server  │
              └─────────┘
```

Client 内部：

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

---

# 3. Responsibilities

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

Client MUST NOT：

* 自己决定整个 Workflow 的执行计划
* 自己决定下一个 Step
* 修改 Server 维护的 Workflow 状态
* 在 Server 未要求的情况下自主创建新的全局 Workflow
* 将本地 Agent 的判断直接作为 Workflow 最终状态

---

# 4. User Request

User Request 是 User 通过 Client 提交给 Server 的需求。

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

但 Client 不负责解释 User Request 并制定完整解决方案。

---

# 5. Capability

Client 应向 Server 声明当前可用的本地能力。

例如：

```text
Capability
├── git
│   └── collect_diagnostics
├── filesystem
│   └── read_file
├── terminal
│   └── execute_command
├── docker
│   └── inspect_container
├── browser
│   └── open_page
└── local-agent
    └── diagnose_project
```

Capability 描述的是：

> **Client 能够执行什么。**

Server 根据这些 Capability 决定是否以及如何利用 Client 的本地能力。

Client 的 Capability 可以动态变化。

例如：

```text
Capability Available
        ↓
Local Service Started
        ↓
Capability Updated
```

Client 应能够向 Server 更新 Capability 状态。

---

# 6. Step Execution

Server 一次只向 Client 下发一个当前 Step。

```text
Server
  │
  │ execution.request
  ▼
Client
  │
  │ execute
  ▼
Local Capability
  │
  ▼
Evidence
  │
  ▼
Server
```

Client 不需要知道整个 Workflow 的未来步骤。

例如 Server：

```text
Step:
检查项目当前 Git 状态
```

Client 执行后返回：

```text
status: COMPLETED

evidence:
  branch: main
  modified_files: 7
  untracked_files: 2
```

然后由 Server 决定下一步。

---

# 7. Composite Capability

一个 Capability 可以在 Client 内部包含多个本地操作。

例如：

```text
git.collect_diagnostics
```

内部可能执行：

```text
git status
git diff
git log
git branch
```

但对于 Server 来说，它仍然是：

```text
一个 Capability
+
一个 Step
+
一个明确的结果
```

Client 不应把一个完整 Workflow 隐藏在 Capability 中。

---

# 8. Step States

Client 需要能够表达当前 Step 的执行状态：

```text
PENDING
RUNNING
WAITING
COMPLETED
FAILED
```

### PENDING

Step 已收到，但尚未开始执行。

### RUNNING

Step 正在执行。

### WAITING

Step 无法继续，需要外部条件。

例如：

* User 输入
* User 确认
* 本地服务响应
* 设备响应
* 外部资源准备完成

### COMPLETED

Step 成功完成，并产生 Evidence。

### FAILED

Step 执行失败，并返回失败信息和已有 Evidence。

---

# 9. Human-in-the-loop

Human Interaction 属于 Client 的职责。

例如当前 Step：

```text
请确认是否允许修改配置文件。
```

Client：

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

User Response 可以成为下一轮 Workflow 的输入。

User 的拒绝或补充信息本身不等于 Workflow Failed。

Server 根据 User Response 决定后续处理。

---

# 10. Evidence

Client 是 Evidence 的主要产生端。

Evidence 可以来自：

* 命令执行
* 文件读取
* 本地 Agent
* 服务状态
* 设备状态
* 日志
* User Input
* User Confirmation
* 测试结果

例如：

```text
Evidence:
  source: local_agent
  type: diagnostic_result

  result:
    root_cause: missing_dependency
    confidence: 0.91
```

Client 应尽可能返回实际观察结果，而不是自行推测整个问题是否已经解决。

---

# 11. Request Completion Confirmation

这是 Client 的重要职责。

Server 可以根据 Workflow 的完成条件和 Evidence 判断：

> 当前结果已经达到系统能够判断的完成条件。

但这不一定代表 User 认为自己的 Request 已经真正解决。

因此：

```text
Server
  ↓
Completion Candidate
  ↓
Client
  ↓
User
```

Client 向 User 展示结果并请求最终确认。

例如：

```text
当前检查结果：

- 服务已经启动
- Health Check 正常
- API 测试通过

这个结果是否解决了你的问题？

[ 已解决 ]    [ 还没有解决 ]
```

### User 确认已解决

```text
User
 ↓
Client
 ↓
Request Completed
```

### User 判断还没有解决

Client 将 User 的反馈提交给 Server：

```text
User
 ↓
Client
 ↓
User Feedback
 ↓
Server
 ↓
Re-plan
```

因此：

> **Server 可以判断“达到完成条件”，但 User 可以最终判断“我的 Request 是否真的解决”。**

---

# 12. Client 与 Local Agent

Client 可以拥有本地 Agent。

```text
Central LLM
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

Local Agent 可以具有一定的自主性，但其作用范围属于 Client 本地执行环境。

它不应绕过 Server 创建独立的全局 Workflow。

---

# 13. Security Boundary

v0.2 只定义最基本的边界：

> **Server 决定“要做什么”，Client 决定“本地是否允许执行”。**

Client 可以根据本地权限、用户授权或运行环境拒绝某个 Step。

具体认证、授权、沙箱和安全策略属于后续 Protocol / Security Spec。

---

# 14. Core Interaction

```text
User
 ↓
Client
 ↓
User Request
 ↓
Server
 ↓
execution.request
 ↓
Client
 ↓
Local Capability / Agent
 ↓
Evidence
 ↓
Server
 ↓
Re-plan
 ↓
execution.request
 ↓
Client
 ↓
...
 ↓
Completion Candidate
 ↓
Client
 ↓
User Confirmation
 ↓
┌───────────────┐
│ Solved        │ → Completed
│ Not Solved    │ → Server Re-plan
└───────────────┘
```

---

# 15. Design Principle

Client 的核心原则：

> **Client 是 User Interaction + Local Execution Runtime，而不是 Workflow Planner。**

Server 决定：

> **下一步做什么。**

Client 决定：

> **本地是否允许做，以及如何利用本地能力执行。**

User 最终决定：

> **这个 Request 是否真的解决了。**
