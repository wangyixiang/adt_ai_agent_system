# SERVER_SPEC.md

- **Version:** v0.3
- **Role:** Central AI Orchestrator
- **层级:** Architecture — 组件角色定位
- **拆分说明:** 本文件是原 v0.2 SERVER_SPEC.md 的瘦身版本。Step/Workflow/Evidence/Completion 的具体契约已抽取到 `../specs/WORKFLOW_SPEC.md`，Capability 相关内容已抽取到 `../specs/CAPABILITY_SPEC.md`，协议消息清单已移至 `../specs/PROTOCOL_SPEC.md`（待写）。两条关键架构决策（Workflow State Authority、One-Step Planning）已沉淀为 ADR，本文件只保留结论并引用。

---

## 1. Purpose

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

## 2. Architecture

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

## 3. Responsibilities

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

## 4. Context 与 Knowledge：Planner 的输入

Server 负责构建当前 Workflow Context：

```text
User Request + Conversation + Previous Steps + Evidence
+ Client Capability + Knowledge + Current Workflow State
```

Server 在每次 Re-plan 前重新组合 Context。Knowledge 可以从 Knowledge Base 检索获得：

```text
User Request → Knowledge Retrieval → Relevant Knowledge → Context → LLM
```

Knowledge 和 Context 都是 Planner 的输入，不是 Workflow State——它们可以影响 LLM 提出什么 Step，但不具备直接改变 Workflow 状态的权力（见下一节）。

---

## 5. LLM Role

LLM 是 Planner / Reasoner。

LLM 可以：

* 理解 Request、分析 Context、使用 Knowledge、分析 Evidence
* 选择 Capability、生成下一 Step
* 提出 Completion Proposal

LLM 不负责：

* 直接执行 Client 操作
* 直接修改 Workflow State
* 直接访问 Client 本地资源

---

## 6. 两条关键架构决策

以下两条约束不是随手写的惯例，而是排除了明显替代方案之后的决策，已分别沉淀为 ADR：

* **Workflow State Authority**：Workflow State 的最终权威是 Server 内部的 Workflow Engine，LLM 只能提出 Proposal，不能直接改变 authoritative state。→ 详见 `../adr/ADR-001-server-owns-workflow-state.md`
* **One-Step Planning**：Server 一次只生成、下发一个当前 Step，而不是一次性下发完整的未来执行计划。→ 详见 `../adr/ADR-002-one-step-planning.md`

Step/Workflow 的具体状态机、Step Schema、Evidence 结构、Completion 判定流程，均已抽取到 `../specs/WORKFLOW_SPEC.md`，作为 Client 与 Server 共享的唯一权威契约，本文件不再重复定义。

---

## 7. Server / Client 边界

系统级的核心边界原则（"Server 决定要做什么，Client 决定本地是否允许执行"）及其完整说明见 `ARCHITECTURE.md` §3，本文件不重复。

---

## 8. Design Principle

Server 的核心原则：

> **Server 不负责执行整个解决方案，而是持续决定当前最合理的下一步。**

整个系统形成：**Request → Plan → Step → Execute → Evidence → Re-plan → ... → User Confirmation**

最终：

> **LLM 负责思考，Workflow Engine 负责状态，Client 负责执行和交互，User 负责确认自己的 Request 是否真正解决。**

---

## 9. 相关文档

* 系统级架构图与核心边界原则 → `ARCHITECTURE.md`
* Step / Evidence / Completion 的具体契约 → `../specs/WORKFLOW_SPEC.md`
* Capability 命名规范与 Manifest 格式 → `../specs/CAPABILITY_SPEC.md`
* 消息 Schema → `../specs/PROTOCOL_SPEC.md`（待写）
* 关键决策记录 → `../adr/`