# ARCHITECTURE.md

- **Version:** v0.3
- **层级:** Architecture — 系统应该由什么构成
- **拆分说明:** 本文件从原 `CLIENT_SPEC.md` / `SERVER_SPEC.md` v0.2 中抽取系统级架构内容整合而成。组件各自的角色定位见 `CLIENT_SPEC.md` / `SERVER_SPEC.md`；Step/Workflow/Evidence 的具体契约见 `../specs/WORKFLOW_SPEC.md`。

---

## 1. System Overview

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

*（原 SERVER_SPEC.md §21 "Core Architecture"、§12 "Execution Loop" 已统一术语后合并于此；原图中 §12 使用的 "Done Candidate" 与其余各处 "Completion Candidate" 不一致，本文件统一采用 "Completion Candidate"，"Done Candidate" 视为废弃写法。）*

---

## 2. Core Components

| 组件 | 职责 | 详见 |
|---|---|---|
| **Client** | User Interaction + Local Execution Runtime | `CLIENT_SPEC.md` |
| **Server** | AI Brain + Context Engine + Knowledge Engine + Workflow Orchestrator | `SERVER_SPEC.md` |
| **Workflow Engine**（Server 内部） | Workflow / Step 状态的唯一权威 | `SERVER_SPEC.md`, ADR-001 |
| **Local Capability / Agent**（Client 内部） | 实际执行本地操作、产生 Evidence | `CLIENT_SPEC.md`, `../specs/CAPABILITY_SPEC.md` |

---

## 3. 核心边界原则

系统只有一条最根本的边界：

> **Server 决定"要做什么"，Client 决定"本地是否允许执行"。**

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

延伸原则：

* Server 不需要知道 Client 内部具体如何实现某个 Capability。
* Client 不需要知道 Server 内部如何做 Planning、如何组织 Context —— 这条边界对内部实现细节同样成立，任何一侧的架构图都不应该把对方的内部组件（例如 Server 的 LLM）直接画进自己的流程里，否则会隐性泄露不该依赖的实现细节。

---

## 4. 系统级 MUST NOT（负面约束清单）

按照"负面约束比正面指令更重要"的原则，把两份组件文档中的 MUST NOT 合并列在这里，作为系统级红线：

**Client MUST NOT：**

* 自己决定整个 Workflow 的执行计划
* 自己决定下一个 Step
* 修改 Server 维护的 Workflow 状态
* 在 Server 未要求的情况下自主创建新的全局 Workflow
* 将本地 Agent 的判断直接作为 Workflow 最终状态

**Server MUST NOT：**

* 直接执行 Client 本地操作
* 绕过 Client 访问本地资源
* 让 LLM 直接修改 Workflow authoritative state
* 一次向 Client 下发完整的未来执行计划

---

## 5. 文档地图

| 内容 | 文件 |
|---|---|
| Client 角色定位与职责边界 | `architecture/CLIENT_SPEC.md` |
| Server 角色定位与职责边界 | `architecture/SERVER_SPEC.md` |
| Step / Workflow / Evidence / Completion 的具体契约（唯一权威定义） | `specs/WORKFLOW_SPEC.md` |
| Capability 命名规范与 Manifest 格式 | `specs/CAPABILITY_SPEC.md` |
| 消息 Schema、通信机制 | `specs/PROTOCOL_SPEC.md`（待写） |
| 关键架构决策及其被否决的替代方案 | `adr/` |