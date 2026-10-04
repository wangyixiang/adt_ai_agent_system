# 时序 flake 稳化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让三个已知**计时敏感**的集成用例在机器负载下不再偶发失败：server 的 `recordProtocol`（ordering clock）、server 的 `stepTimeout.int`、daemon 的 `controlledExecution`。

**Architecture:** 这些用例用**真实计时器**（`setTimeout` 轮询、step 超时扫描）且断言正确——失败是调度噪声（隔离必绿、整仓偶发；两个包的 `vitest.config.ts` 已是 `fileParallelism: false`）。稳化：**放宽"时间不够"的轮询上限**，并对三者加**有限重试**（`{ retry: 2 }`，断言与语义不变）。不改产品代码。

**Tech Stack:** Vitest 2.x（`retry` 选项）· TypeScript

**Spec:** `docs/superpowers/WORKFLOW.md` §7（验证口径）。

## Global Constraints

- **只改测试**；不改产品代码、不改断言含义、不改配置里的 `fileParallelism`。
- `retry` 只加在**这三个已确认计时敏感**的用例上，并在用例处写明理由（避免被当成掩盖真 bug）。
- 编辑文件用 `edit`（**LF**）；**不 push**。
- 验证：`pnpm -r --if-present test`（**连跑 3 次**）+ `typecheck`。

## Review Focus

1. **断言不变**：重试只是重跑，不弱化断言。
2. **只限三处**：不给全仓或整包加 `retry`（避免掩盖真实 flake）。
3. **理由在案**：每处写明"真实计时器 + 负载噪声"。
4. **仍能捕获真 bug**：若断言真的错，重试后仍失败。

---

### Task 1: 放宽 stepTimeout 的轮询 + 三处有限重试

**Files:**
- Modify: `packages/server/test/workflow/stepTimeout.int.test.ts`
- Modify: `packages/server/test/protocol/recordProtocol.test.ts`
- Modify: `packages/client-daemon/test/controlledExecution.e2e.test.ts`

**Interfaces:**
- Produces：三个用例的签名改为 `it("<name>", { retry: 2 }, async () => { … })`，并在上方加一行注释说明；`stepTimeout.int` 的轮询上限由 3s 提到 10s（并保留 20ms 轮询间隔）。

- [ ] **Step 1: 放宽 `stepTimeout.int` 的轮询**

把 `const deadline = Date.now() + 3000;` 改为 `+ 10_000`（给超时扫描在负载下足够的时间）。

- [ ] **Step 2: 三处加 `{ retry: 2 }`**

- `packages/server/test/protocol/recordProtocol.test.ts`：`it("stamps every entry with the same ordering clock", { retry: 2 }, async () => {`
- `packages/server/test/workflow/stepTimeout.int.test.ts`：`it("fails a read-only step the client acknowledges but never completes", { retry: 2 }, async () => {`
- `packages/client-daemon/test/controlledExecution.e2e.test.ts`：`it("reconciles a side effect that timed out into an outcome", { retry: 2 }, async () => {`

每处上方加：`// Timing-sensitive: real timers under load; retry absorbs scheduler noise (the assertions are exact).`

- [ ] **Step 3: 跑这三个用例**

Run: `pnpm -C packages/server test -- recordProtocol stepTimeout` 与 `pnpm -C packages/client-daemon test -- controlledExecution`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/server/test/workflow/stepTimeout.int.test.ts \
        packages/server/test/protocol/recordProtocol.test.ts \
        packages/client-daemon/test/controlledExecution.e2e.test.ts
git commit -m "test: stabilise the timing-sensitive integration tests under load"
```

---

### Task 2: 连跑三次确认稳定（本切片出口）

- [ ] **Step 1: 全量连跑 3 次**

Run: `pnpm -r --if-present test`（三次）与 `pnpm -r --if-present typecheck`
Expected: 三次都 exit 0；typecheck exit 0。

---

## 移交后续计划的待办

- 若 `recordProtocol` 的 ordering clock 在重试后**仍偶发**，说明有真实路径用了非注入时钟，需单开一次 `systematic-debugging`（本计划只做测试侧稳化）。

## Self-Review

**1. Spec coverage：** `WORKFLOW §7` 的验证口径要求"先确认 Docker/环境再下失败结论"；本计划消除已知的负载噪声。

**2. Step scan：** 每步一个动作；改动都是测试侧、可核对。

**3. Type consistency：** 三处 `it` 签名加 `{ retry: 2 }`，Vitest 2.x 支持。

**4. Review Focus：** 四条分别由"只改测试"、三处限定、注释、重试后仍失败即真 bug 钉住。

**5. Proportion：** 计划只钉三处改动与理由。

---

## Amendment (执行中发现，随修复一起提交)

连跑三次整仓时，`client-electron` 的 `src/main/core/session.int.test.ts` 也偶发失败（3 个 `waitFor` 用例；该 helper 的 deadline 是 **10s**，负载下不够）。它是同一个"真实计时器 + 负载"家族，补进本切片：

- `session.int.test.ts` 的 `waitFor` deadline：**10s → 25s**（仍是集成测试，`testTimeout` 30s）。
- `recordProtocol` 的注释改为**准确**措辞：该用例的时钟是**注入的**（断言确定），失败源于 Record 往返 **Postgres + 真实 WebSocket** 的基础设施计时，而非"测试自身计时器"。
- `stepTimeout.int` 的注释改为：依赖**服务端 step-timeout 扫描的真实 interval**。
