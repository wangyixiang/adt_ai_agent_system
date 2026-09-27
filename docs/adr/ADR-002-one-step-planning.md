# ADR-002: Server 一次只下发一个 Step（One-Step Planning）

- **Status:** ACCEPTED
- **拆分说明:** 沉淀自原 `SERVER_SPEC.md` v0.2 §10 "One-Step Planning"。

---

## Context

Server 在收到 User Request 后，理论上可以一次性生成完整的执行计划（Step 1、Step 2、Step 3 ...）再交给 Client 依次执行,也可以每次只生成"当前该做的一步"，执行完拿到 Evidence 后再决定下一步。

## Decision

Server 一次只生成、下发一个当前 Step：

```text
Request → Plan → Step 1 → Execute → Evidence → Re-plan → Step 2 → Execute → Evidence → ...
```

Server 不应该把 `Step 1 / Step 2 / Step 3 / Step 4` 一次性全部发送给 Client。

## Rejected Alternatives

* **一次性下发完整未来计划**：直觉上更"高效"（减少 Server-Client 往返），但每一个 Step 执行后都会产生新的 Evidence，而这些 Evidence 很可能改变后续步骤的合理性——例如诊断类任务中，Step 1 的结果可能直接排除掉原计划里 Step 2、Step 3 的必要性。如果计划是提前固定的，Server 要么忽略新证据机械执行完整个预定计划（浪费资源、可能得出错误结论），要么需要一套复杂的"计划中途作废并重新生成"机制，而这套机制本质上就是把 One-Step Planning 又实现了一遍，只是多绕了一圈。
* **允许 Client 根据本地情况自主调整计划顺序**：这会让"决定下一步做什么"的职责从 Server 泄露到 Client，直接违反 `ARCHITECTURE.md` §3 的核心边界（Server 决定要做什么，Client 决定本地是否允许执行），也会让同一个 Workflow 在不同 Client 上出现不一致的执行路径。

## Consequences

* Server 与 Client 之间的往返次数会更多（每个 Step 都是一次完整的 request/response），需要在协议设计（`PROTOCOL_SPEC.md`）里考虑这个开销，例如是否需要为低延迟场景做批量确认之类的优化，但不能突破"一次一个 Step"的规划边界本身。
* Client 不需要、也不应该知道 Workflow 的未来步骤，这简化了 Client 的实现——它只需要正确执行"当前收到的这一个 Step"，不需要维护任何计划状态。
* 这条约束是 Evidence 驱动重新规划（Evidence-driven Re-planning）能够成立的前提：如果计划是提前固定的，Evidence 就只能用来判断"计划有没有走完"，而不能真正影响"接下来该做什么"。