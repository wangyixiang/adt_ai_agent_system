# ADR-001: Workflow State 的最终权威归属于 Server 的 Workflow Engine

- **Status:** ACCEPTED
- **拆分说明:** 沉淀自原 `SERVER_SPEC.md` v0.2 §6 "Workflow State Authority"。

---

## Context

系统里同时存在两类"想改变 Workflow 状态"的力量：

1. **LLM（Planner）**：能够分析 Context、Evidence，提出下一步该做什么、是否已经达到完成条件。
2. **Workflow Engine**：负责实际维护 Workflow / Step 的状态转换。

如果不明确谁是"权威"，容易出现的隐患是：LLM 在一次生成中直接把"我认为已经完成了"当作系统状态写入，而不是作为一个待验证的提议——这会让 Workflow 状态的可靠性完全依赖单次 LLM 输出的质量,且难以审计、难以回滚。

## Decision

Workflow State 的最终权威是 Workflow Engine（Server 内部的确定性组件），LLM 是 Planner，不是 Workflow State Authority：

```text
LLM → Proposal → Workflow Engine → State Transition
```

LLM 可以提出：

* 下一步是什么
* Step 如何执行
* 是否已经达到完成条件
* 下一步应该如何处理 Evidence

但 LLM 不直接修改 Workflow 的 authoritative state；所有状态转换必须经过 Workflow Engine 确认。

## Rejected Alternatives

* **让 LLM 直接修改 Workflow 状态**：实现简单，但状态可靠性完全绑定单次模型输出，无法审计、无法约束、难以处理模型输出格式错误或幻觉导致的非法状态转换。
* **让 Client 维护 authoritative state**：会让状态的唯一权威分散到多个 Client 实例上，一旦同一 Workflow 被多端访问（例如手机发起、电脑继续），状态同步会变成分布式一致性问题，且与"Server 负责规划、Client 只负责本地执行"的核心边界（见 `ARCHITECTURE.md` §3）相矛盾。

## Consequences

* Workflow Engine 需要对 LLM 的每一类 Proposal（Step 提议、Completion 提议）定义明确的校验/确认逻辑，不能"LLM 说完成就完成"。
* 这也是 `Completion Candidate`（而不是直接 `Completed`）这一中间状态存在的原因：LLM 的 Completion Proposal 必须先经过 Workflow Engine 确认为 Candidate，再交给 User 做最终确认（见 `WORKFLOW_SPEC.md` §8-9），才能进入真正的 `COMPLETED`。
* 未来如果要支持多 LLM / 多 Planner 协作，可以直接复用这一模型：多个 Proposal 来源，唯一的状态权威。