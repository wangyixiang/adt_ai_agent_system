# SERVER_SPEC.md

- **Version:** v0.7（缺口收敛：补完成条件、终止护栏、会话级副作用串行、幂等键生成与对账、孤儿回收、"先落盘 Record 后通知"；对齐 `WORKFLOW_SPEC.md` v0.4、`PROTOCOL_SPEC.md` v0.4，取代 v0.6）
- **Role:** Central AI Orchestrator
- **层级:** Architecture — 组件角色定位
- **拆分说明:** 本文件是原 v0.2 SERVER_SPEC.md 的瘦身版本。Step/Workflow/Evidence/Completion 的具体契约已抽取到 `../specs/WORKFLOW_SPEC.md`，Capability 相关内容已抽取到 `../specs/CAPABILITY_SPEC.md`，协议消息清单已移至 `../specs/PROTOCOL_SPEC.md`。两条关键架构决策（Workflow State Authority、One-Step Planning）已沉淀为 ADR，本文件只保留结论并引用。

---

## 变更记录（v0.4 → v0.5）

- **§3 第14条措辞更新**：原文"已解决、未解决/放弃、已取消、失败等任一终止状态"改为和 `WORKFLOW_SPEC.md` v0.2 一致的三状态表述（`COMPLETED`/`FAILED`/`CANCELLED`）。这个措辞是在 v0.4 写的时候沿用了当时 REQUIREMENTS.md 的四分类说法，`WORKFLOW_SPEC.md` 后来把"已取消"和"未解决(放弃)"合并成一个状态，本次同步。

---

## 变更记录（v0.3 → v0.4）

- **Knowledge 澄清为第三方系统**：§1、§3、§4 涉及 Knowledge 的措辞统一改为"从第三方 Knowledge Base 检索"，明确 Server 不自建知识库、不自建案例匹配逻辑（对齐 `PRODUCT.md` D-5，详见 `ARCHITECTURE.md` §1.1）。
- **补充 Record / Report 职责**：v0.3 设计时 Record/Report 概念尚未被推演出来，因此完全没有出现在 Server 的职责列表里。本版本在 §1、§3 补上"保存 Record"与"按需生成 Report"（对应 `REQUIREMENTS.md` FR-12、FR-17~FR-19）。
- **新增一条 MUST NOT**：不自行构建历史案例检索/相似问题匹配逻辑（对齐 D-5）。
- 其余内容（LLM Role、两条关键架构决策、Server/Client 边界）未发生实质变化。

---

## 1. Purpose

Central Server 是整个系统的 AI Brain + Context Engine + Knowledge Engine（对接第三方 Knowledge Base，不自建知识库，见 `ARCHITECTURE.md` §1.1） + Workflow Orchestrator。

Server 负责：

* 接收 Client 提交的 User Request
* 理解 User Request
* 管理 Workflow
* 组合 Context
* 从第三方 Knowledge Base 检索相关 Knowledge（v0.4：措辞由"提取 Knowledge"改为强调"第三方"，避免被误读为自建检索）
* 调用 LLM / Planner
* 根据 Client Capability 制定下一步
* 一次只生成一个 Step
* 根据 Client 返回的 Evidence 重新规划
* 判断是否达到系统可判断的完成条件
* 将最终结果交给 Client，由 User 确认 Request 是否真正解决
* **在 Workflow 结束（任一终止状态）时保存完整 Record**（v0.4 新增）
* **在用户需要时，基于 Record 生成 Report**（v0.4 新增）
* **定义并维护 Request 级完成条件（`completion_criteria`）**（v0.7 新增）
* **由 Workflow Engine 确定性执行终止护栏**（v0.7 新增）
* **保证同一 `session` 内副作用 Step 串行**（v0.7 新增）
* **为有副作用的 Step 生成幂等键，并执行"结果未知 → 对账"**（v0.7 新增）
* **回收失联的孤儿 Workflow；终止时先落盘 Record、再通知**（v0.7 新增）

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
              │ Knowledge*   │
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

*`Knowledge` = 对第三方 Knowledge Base 的检索能力，非本系统自建，见 `ARCHITECTURE.md` §1.1。

---

## 3. Responsibilities

Server MUST：

1. 接收 User Request
2. 创建和维护 Workflow
3. 管理 Workflow 状态
4. 组合当前 Context
5. 从第三方 Knowledge Base 检索相关 Knowledge，并将其作为 Context 的一部分提供给 Planner（v0.4：措辞调整，见变更记录）
6. 获取并考虑 Client Capability
7. 调用 LLM / Planner
8. 生成当前 Step
9. 一次只向 Client 下发一个 Step
10. 接收 Step Execution Result / Evidence
11. 根据 Evidence 更新 Context
12. 决定是否继续 Re-plan
13. 在达到系统可判断的完成条件后进入最终确认流程
14. **在 Workflow 结束（`COMPLETED` / `FAILED` / `CANCELLED` 三种终止状态之一）时，保存完整 Record**（v0.4 新增，v0.5 措辞对齐 `WORKFLOW_SPEC.md` v0.2 的终止状态设计，对应 REQUIREMENTS FR-12、FR-13）
15. **在 User 明确请求时，基于指定 Record 生成 Report；不请求则不生成**（v0.4 新增，对应 REQUIREMENTS FR-17~FR-19）
16. **在创建 / 推进 Workflow 时确定并维护 `completion_criteria`，每次修订写入 Record**（v0.7 新增，对应 `WORKFLOW_SPEC.md` §8.1）
17. **由 Workflow Engine 确定性执行终止护栏**（步数 / 重试 / `not_solved` 轮次 / 时长预算），触顶则 `FAILED` 并保存 Record（v0.7 新增，对应 `WORKFLOW_SPEC.md` §13）
18. **保证同一 `session` 内任意时刻最多一个副作用 Step 处于活跃状态**（v0.7 新增，对应 `WORKFLOW_SPEC.md` §4.4）
19. **为 `side_effect: true` 的 Step 生成 Workflow 内稳定的 `idempotency_key`；对结果不确定的副作用 Step 判为 `UNKNOWN` 并对账（不自动重试，除非该 Capability 声明 `idempotent`）**（v0.7 新增，对应 `WORKFLOW_SPEC.md` §4.3）
20. **按可配置宽限期回收失联的孤儿 Workflow（未请求取消 → `FAILED(client_unreachable)`；已请求取消 → `CANCELLED`）；并在任何终止状态先持久化 Record、成功后再发 `workflow.terminated`**（v0.7 新增，对应 `WORKFLOW_SPEC.md` §2.2、`PROTOCOL_SPEC.md` §7.4）

Server MUST NOT：

* 直接执行 Client 本地操作
* 绕过 Client 访问本地资源
* 让 LLM 直接修改 Workflow authoritative state
* 一次向 Client 下发完整的未来执行计划
* **自行构建历史案例检索/相似问题匹配逻辑**（v0.4 新增）：这部分逻辑交给第三方 Knowledge Base 承担，不在本系统内实现（对齐 `PRODUCT.md` D-5）

---

## 4. Context 与 Knowledge：Planner 的输入

Server 负责构建当前 Workflow Context：

```text
User Request + Conversation + Previous Steps + Evidence
+ Client Capability + Knowledge + Current Workflow State + Completion Criteria
```

Server 在每次 Re-plan 前重新组合 Context。**Knowledge 来自第三方 Knowledge Base**（v0.4 澄清）：

```text
User Request → Knowledge Retrieval（查询第三方 Knowledge Base） → Relevant Knowledge → Context → LLM
```

Knowledge 和 Context 都是 Planner 的输入，不是 Workflow State——它们可以影响 LLM 提出什么 Step，但不具备直接改变 Workflow 状态的权力（见下一节）。

**关于第三方 Knowledge Base 的边界（v0.4 新增）：**

* 检索逻辑（如何匹配、如何排序、知识库本身的构建与维护）都在第三方系统内，Server 只负责查询和消费结果，不实现自己的检索引擎，也不做历史案例的相似度匹配（对齐 `PRODUCT.md` D-5、`ARCHITECTURE.md` §4 MUST NOT）。
* **本系统产生的 Record 未来是否会被沉淀/导出到这个第三方 Knowledge Base，供后续检索复用，是已确认的产品方向，但不在本版本实现范围内**——本版本不构建任何 Record → Knowledge Base 的主动推送机制。这一点已经落到 `RECORD_SPEC.md` §8 的结构设计约束（结构化字段自足、`narrative` 用领域语言书写、`summary` 与 `entries` 并存），但不需要现在就为导出预留具体接口。具体的对接方式（推送时机、数据格式、鉴权）建议留给后续单独的 ADR，而不是提前在本文件里假设。

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

> **v0.4 备注：** 是否需要为"Server 与第三方 Knowledge Base 的集成方式"、"Record 未来导出到 Knowledge Base"单独补一条 ADR，建议在下一次架构评审时决定——这两点目前只是在本文件和 `ARCHITECTURE.md` §1.1 里做了文字说明，还没有经过"排除替代方案"的决策过程，不应该被当作已经定案的架构决策。

> **v0.7 补充：** 终止护栏（`WORKFLOW_SPEC.md` §13）、副作用结果未知与对账（§4.3）、会话级副作用串行（§4.4）都是 `ADR-001`（Workflow Engine 是唯一权威）的直接推论——它们必须由**确定性组件**执行，不能委托给 LLM；这一点也是它们写进 Spec 而不是留给实现自由发挥的原因。

---

## 7. Server / Client 边界

系统级的核心边界原则（"Server 决定要做什么，Client 决定本地是否允许执行"）及其完整说明见 `ARCHITECTURE.md` §3，本文件不重复。

---

## 8. Design Principle

Server 的核心原则：

> **Server 不负责执行整个解决方案，而是持续决定当前最合理的下一步。**

整个系统形成：**Request → Plan → Step → Execute → Evidence → Re-plan → ... → User Confirmation → Record → (按需) Report**

最终：

> **LLM 负责思考，Workflow Engine 负责状态，Client 负责执行和交互，User 负责确认自己的 Request 是否真正解决。**

---

## 9. 相关文档

* 系统级架构图与核心边界原则 → `ARCHITECTURE.md`
* Step / Evidence / Completion 的具体契约 → `../specs/WORKFLOW_SPEC.md`
* Capability 命名规范与 Manifest 格式 → `../specs/CAPABILITY_SPEC.md`
* 消息 Schema → `../specs/PROTOCOL_SPEC.md`
* Record 的结构与保存时机 → `../specs/RECORD_SPEC.md`
* Report 的触发与内容约束 → `../specs/REPORT_SPEC.md`
* 关键决策记录 → `../adr/`
