# P2a Workflow 引擎与持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Server 侧的确定性 Workflow 引擎：Workflow/Step 状态机、终止护栏、完成条件、Postgres 持久化、取消与孤儿回收。

**Architecture:** 领域逻辑（状态机、取消、护栏、完成条件）是**纯函数**，先于持久化存在并可独立测试；`WorkflowEngine` 服务把领域决策与 `WorkflowStore`（Postgres）组合，每次状态转换与事件写入同一事务。本阶段不接 LLM、不接协议、不生成 Record——终止时只发出 `workflow_terminated` 事件，供 P2b 的 Record 生成订阅。

**Tech Stack:** TypeScript（strict）· Node.js LTS · PostgreSQL（`pg`）· Vitest · pnpm workspace（沿用 P1 结构）

**Spec:** `docs/specs/WORKFLOW_SPEC.md`（v0.4：§2 状态机与 `terminal_reason`、§2.1 取消、§2.2 孤儿回收、§4 Step 状态机与终态不可变、§4.3 `UNKNOWN`、§4.4 会话级串行、§8.1 `completion_criteria`、§12 Record 触发、§13 护栏）、`docs/adr/ADR-001-server-owns-workflow-state.md`、`docs/adr/ADR-004-tech-stack.md`、`docs/superpowers/specs/2026-09-29-mvp-scope.md`

## Global Constraints

- **Workflow 状态**：`CREATED | RUNNING | CANCELLING | COMPLETED | FAILED | CANCELLED`；终态为 `COMPLETED | FAILED | CANCELLED`（`WORKFLOW_SPEC.md` §2）。
- **Step 状态**：`PENDING | RUNNING | WAITING | COMPLETED | FAILED | REJECTED | UNKNOWN`；终态为 `COMPLETED | FAILED | REJECTED | UNKNOWN`（§4）。
- **终态不可变**：到达终态后忽略同一 Step 的后续状态更新；终态之间不互相覆盖，先到者为准；**唯一例外**是 `UNKNOWN` 可被对账收敛为 `COMPLETED`/`FAILED`（§4）。
- **活跃 Step** = `PENDING | RUNNING | WAITING`（§2.1）。
- **取消判定**：无活跃 Step、或活跃 Step 仅为 `PENDING`、或属人类等待（`user_input`/`user_confirmation`/人工对账）→ 立即 `CANCELLED`；活跃 Step 为 `RUNNING` 或执行类 `WAITING` → 看该 Capability 的 `interruptible`（`true` 立即、`false` 转 `CANCELLING`）（§2.1）。
- **CANCELLING 收敛**：当前不可中断 Step 到达**任一终态（含 `UNKNOWN`）**后收敛为 `CANCELLED`，不触发 Re-plan；`UNKNOWN` 不再对账（§2.1）。
- **取消意图优先**：`CANCELLING` 期间失联 → 仍判 `CANCELLED`，不判 `FAILED`（§2.1）。
- **护栏默认值**：`maxStepsPerWorkflow = 50`、`maxConsecutiveRetriesPerCapability = 2`（仅只读）、`maxNotSolvedRounds = 5`、`timeBudgetMs = null`（不限）；触顶 → `FAILED`，`terminal_reason` ∈ `step_limit | retry_limit | user_round_limit | time_budget`（§13）。
- **`terminal_reason`**：`COMPLETED` 恒为 `null`；`FAILED` 用 `client_unreachable` 或护栏原因；`CANCELLED` 用 `user_cancelled | abandoned | superseded`（§2）。
- **`completion_criteria`**：Request 级，`mode: formal | open`，带单调递增 `revision`；每次修订追加一条事件（§8.1）。
- **孤儿回收**：可配置宽限期（建议与 session TTL 一致）；未请求取消 → `FAILED(client_unreachable)`；已请求取消 → `CANCELLED`（§2.2）。
- **时间**：一律使用**可注入的单调时钟**（默认 `performance.now`），不使用 wall clock 做超时/排序（`PROTOCOL_SPEC.md` §2/§9）。
- **持久化**：PostgreSQL；一次状态转换与其事件在**同一事务**内提交。
- **本阶段不实现**（留给 P2b/P4）：Record 生成/保存/查询、Report、协议消息接线、LLM 规划、副作用串行、对账编排、幂等台账、blob。

## Review Focus

以下输入/失败模式是 Spec 隐含但容易漏测的，**每条都必须在对应任务里有测试**：

1. **已到达终态的 Step 又收到状态更新** → 必须被忽略（除 `UNKNOWN` 对账），且不产生新事件。
2. **护栏触顶** → `FAILED` + 正确的 `terminal_reason`，且此后拒绝新 Step。
3. **`CANCELLING` 期间不可中断 Step 到达任一终态（含 `UNKNOWN`）** → 收敛为 `CANCELLED`，不 Re-plan。
4. **孤儿宽限期内有活动（`touch`）** → 不得被回收。
5. **同一 Step 的重复/乱序状态上报** → 状态不回退、事件不重复。

---

### Task 1: 领域类型与 Step/Workflow 状态机（纯函数）

**Files:**
- Create: `packages/server/src/workflow/types.ts`
- Create: `packages/server/src/workflow/stateMachine.ts`
- Test: `packages/server/test/workflow/stateMachine.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type WorkflowState = "CREATED" | "RUNNING" | "CANCELLING" | "COMPLETED" | "FAILED" | "CANCELLED"`
  - `type StepState = "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "REJECTED" | "UNKNOWN"`
  - `type TerminalWorkflowState = "COMPLETED" | "FAILED" | "CANCELLED"`
  - `type TerminalStepState = "COMPLETED" | "FAILED" | "REJECTED" | "UNKNOWN"`
  - `type ActiveStepState = "PENDING" | "RUNNING" | "WAITING"`
  - `function isTerminalWorkflow(s: WorkflowState): s is TerminalWorkflowState`
  - `function isTerminalStep(s: StepState): s is TerminalStepState`
  - `function isActiveStep(s: StepState): s is ActiveStepState`
  - `function canTransitionStep(from: StepState, to: StepState): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/stateMachine.test.ts
import { describe, it, expect } from "vitest";
import {
  isTerminalWorkflow, isTerminalStep, isActiveStep, canTransitionStep,
} from "../../src/workflow/stateMachine";

describe("state machine", () => {
  it("knows the terminal workflow states", () => {
    expect(isTerminalWorkflow("COMPLETED")).toBe(true);
    expect(isTerminalWorkflow("FAILED")).toBe(true);
    expect(isTerminalWorkflow("CANCELLED")).toBe(true);
    expect(isTerminalWorkflow("RUNNING")).toBe(false);
    expect(isTerminalWorkflow("CANCELLING")).toBe(false);
  });

  it("knows the terminal step states", () => {
    expect(isTerminalStep("COMPLETED")).toBe(true);
    expect(isTerminalStep("FAILED")).toBe(true);
    expect(isTerminalStep("REJECTED")).toBe(true);
    expect(isTerminalStep("UNKNOWN")).toBe(true);
    expect(isTerminalStep("WAITING")).toBe(false);
  });

  it("treats PENDING/RUNNING/WAITING as active", () => {
    expect(isActiveStep("PENDING")).toBe(true);
    expect(isActiveStep("RUNNING")).toBe(true);
    expect(isActiveStep("WAITING")).toBe(true);
    expect(isActiveStep("COMPLETED")).toBe(false);
  });

  it("allows only the reconciliation edge out of a terminal state", () => {
    expect(canTransitionStep("UNKNOWN", "COMPLETED")).toBe(true);
    expect(canTransitionStep("UNKNOWN", "FAILED")).toBe(true);
    expect(canTransitionStep("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransitionStep("FAILED", "COMPLETED")).toBe(false);
    expect(canTransitionStep("REJECTED", "RUNNING")).toBe(false);
    expect(canTransitionStep("RUNNING", "COMPLETED")).toBe(true);
    expect(canTransitionStep("PENDING", "WAITING")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/stateMachine.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`types.ts` 只放类型与常量（`TERMINAL_WORKFLOW_STATES`、`TERMINAL_STEP_STATES`、`ACTIVE_STEP_STATES` 三个 `ReadonlySet`）。`stateMachine.ts` 的 `canTransitionStep` 规则：目标为终态时允许（除从其他终态出发，`UNKNOWN`→`COMPLETED`/`FAILED` 除外）；终态→非终态一律 `false`；非终态之间按 `PENDING→RUNNING|WAITING|REJECTED`、`RUNNING→WAITING|COMPLETED|FAILED|UNKNOWN`、`WAITING→RUNNING|COMPLETED|FAILED|UNKNOWN` 放行。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/stateMachine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow packages/server/test/workflow
git commit -m "feat(workflow): domain types and step/workflow state machine"
```

---

### Task 2: 取消语义与 CANCELLING 收敛（纯函数）

**Files:**
- Create: `packages/server/src/workflow/cancel.ts`
- Test: `packages/server/test/workflow/cancel.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `StepState`、`ActiveStepState`
- Produces:
  - `type WaitClass = "human" | "execution" | null`
  - `interface CancelContext { activeStep: { state: ActiveStepState; interruptible: boolean; waitClass: WaitClass } | null }`
  - `type CancelDecision = "IMMEDIATE" | "CANCELLING"`
  - `function decideCancel(ctx: CancelContext): CancelDecision`
  - `function convergesCancelling(stepReached: StepState): boolean`（不可中断 Step 到达任一终态即为 `true`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/cancel.test.ts
import { describe, it, expect } from "vitest";
import { decideCancel, convergesCancelling } from "../../src/workflow/cancel";

const active = (state: "PENDING" | "RUNNING" | "WAITING", interruptible: boolean, waitClass: "human" | "execution" | null) =>
  ({ activeStep: { state, interruptible, waitClass } });

describe("cancel decision", () => {
  it("is immediate when nothing is active", () => {
    expect(decideCancel({ activeStep: null })).toBe("IMMEDIATE");
  });
  it("is immediate when the only active step is PENDING", () => {
    expect(decideCancel(active("PENDING", false, null))).toBe("IMMEDIATE");
  });
  it("is immediate for human waits", () => {
    expect(decideCancel(active("WAITING", false, "human"))).toBe("IMMEDIATE");
  });
  it("is immediate when the executing step is interruptible", () => {
    expect(decideCancel(active("RUNNING", true, "execution"))).toBe("IMMEDIATE");
  });
  it("queues when a non-interruptible execution is in flight", () => {
    expect(decideCancel(active("RUNNING", false, "execution"))).toBe("CANCELLING");
    expect(decideCancel(active("WAITING", false, "execution"))).toBe("CANCELLING");
  });
});

describe("CANCELLING convergence", () => {
  it("converges on any terminal step outcome, including UNKNOWN", () => {
    expect(convergesCancelling("COMPLETED")).toBe(true);
    expect(convergesCancelling("FAILED")).toBe(true);
    expect(convergesCancelling("UNKNOWN")).toBe(true);
    expect(convergesCancelling("RUNNING")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/cancel.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`decideCancel` 严格按 `WORKFLOW_SPEC.md` §2.1 的顺序判定；`convergesCancelling` 复用 Task 1 的 `isTerminalStep`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/cancel.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/cancel.ts packages/server/test/workflow/cancel.test.ts
git commit -m "feat(workflow): cancel decision and CANCELLING convergence"
```

---

### Task 3: 终止护栏与完成条件（纯函数）

**Files:**
- Create: `packages/server/src/workflow/guardrails.ts`
- Create: `packages/server/src/workflow/criteria.ts`
- Test: `packages/server/test/workflow/guardrails.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `StepState`
- Produces:
  - `interface GuardrailConfig { maxStepsPerWorkflow: number; maxConsecutiveRetriesPerCapability: number; maxNotSolvedRounds: number; timeBudgetMs: number | null }`
  - `const DEFAULT_GUARDRAILS: GuardrailConfig`
  - `type GuardrailReason = "step_limit" | "retry_limit" | "user_round_limit" | "time_budget"`
  - `interface GuardrailInput { stepCount: number; consecutiveRetries: number; notSolvedRounds: number; elapsedMs: number }`
  - `function breachedGuardrail(input: GuardrailInput, config: GuardrailConfig): GuardrailReason | null`
  - `interface CompletionCriteria { mode: "formal" | "open"; assertions?: string[]; description?: string; revision: number }`
  - `function reviseCriteria(current: CompletionCriteria, next: Omit<CompletionCriteria, "revision">): CompletionCriteria`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/guardrails.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_GUARDRAILS, breachedGuardrail } from "../../src/workflow/guardrails";
import { reviseCriteria } from "../../src/workflow/criteria";

const base = { stepCount: 0, consecutiveRetries: 0, notSolvedRounds: 0, elapsedMs: 0 };

describe("guardrails", () => {
  it("defaults match WORKFLOW_SPEC.md §13", () => {
    expect(DEFAULT_GUARDRAILS).toEqual({
      maxStepsPerWorkflow: 50, maxConsecutiveRetriesPerCapability: 2,
      maxNotSolvedRounds: 5, timeBudgetMs: null,
    });
  });
  it("breaches on step count", () => {
    expect(breachedGuardrail({ ...base, stepCount: 51 }, DEFAULT_GUARDRAILS)).toBe("step_limit");
    expect(breachedGuardrail({ ...base, stepCount: 50 }, DEFAULT_GUARDRAILS)).toBeNull();
  });
  it("breaches on consecutive retries", () => {
    expect(breachedGuardrail({ ...base, consecutiveRetries: 3 }, DEFAULT_GUARDRAILS)).toBe("retry_limit");
    expect(breachedGuardrail({ ...base, consecutiveRetries: 2 }, DEFAULT_GUARDRAILS)).toBeNull();
  });
  it("breaches on not_solved rounds", () => {
    expect(breachedGuardrail({ ...base, notSolvedRounds: 6 }, DEFAULT_GUARDRAILS)).toBe("user_round_limit");
    expect(breachedGuardrail({ ...base, notSolvedRounds: 5 }, DEFAULT_GUARDRAILS)).toBeNull();
  });
  it("only breaches on time when a budget is configured", () => {
    expect(breachedGuardrail({ ...base, elapsedMs: 10_000 }, DEFAULT_GUARDRAILS)).toBeNull();
    expect(
      breachedGuardrail({ ...base, elapsedMs: 10_000 }, { ...DEFAULT_GUARDRAILS, timeBudgetMs: 5_000 }),
    ).toBe("time_budget");
  });
});

describe("completion criteria", () => {
  it("bumps revision on every change", () => {
    const first = reviseCriteria({ mode: "open", revision: 0 }, { mode: "formal", assertions: ["svc == up"] });
    expect(first).toEqual({ mode: "formal", assertions: ["svc == up"], revision: 1 });
    const second = reviseCriteria(first, { mode: "open" });
    expect(second.revision).toBe(2);
    expect(second.mode).toBe("open");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/guardrails.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`breachedGuardrail` 按固定顺序返回**第一个**触顶原因（`step_limit` → `retry_limit` → `user_round_limit` → `time_budget`），判定一律为**严格大于上限**（`> max`：允许恰好达到上限），`timeBudgetMs === null` 时跳过时间项。`reviseCriteria` 返回 `{ ...next, revision: current.revision + 1 }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/guardrails.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/guardrails.ts packages/server/src/workflow/criteria.ts packages/server/test/workflow/guardrails.test.ts
git commit -m "feat(workflow): termination guardrails and completion criteria"
```

---

### Task 4: 持久化 schema 与 WorkflowStore

**Files:**
- Create: `packages/server/migrations/002_workflows.sql`
- Create: `packages/server/src/workflow/store.ts`（接口 + 快照类型）
- Create: `packages/server/src/workflow/postgresStore.ts`
- Test: `packages/server/test/workflow/postgresStore.test.ts`

**Interfaces:**
- Consumes: Task 1 类型；Task 3 的 `CompletionCriteria`；P1 的 `createPool` / `migrate`
- Produces:
  - `interface WorkflowSnapshot { id: string; userId: string; sessionId: string; state: WorkflowState; terminalReason: string | null; criteria: CompletionCriteria; createdAt: number; endedAt: number | null; notSolvedRounds: number }`
  - `interface StepSnapshot { id: string; workflowId: string; state: StepState; objective: string; capability: string; sideEffect: boolean; interruptible: boolean; idempotencyKey: string | null; attempt: number; waitClass: WaitClass }`
  - `type WorkflowEventKind = "workflow_created" | "step_dispatched" | "step_status" | "criteria_revised" | "cancel_requested" | "completion_candidate" | "completion_response" | "guardrail_triggered" | "workflow_terminated"`
  - `interface WorkflowEvent { id: string; workflowId: string; kind: WorkflowEventKind; ts: number; payload: unknown }`
  - `interface WorkflowStore { createWorkflow(w, e): Promise<void>; getWorkflow(id): Promise<WorkflowSnapshot | null>; listWorkflowsByUser(userId): Promise<WorkflowSnapshot[]>; saveWorkflow(w, e): Promise<void>; createStep(s, e): Promise<void>; getStep(id): Promise<StepSnapshot | null>; listSteps(workflowId): Promise<StepSnapshot[]>; saveStep(s, e): Promise<void>; listEvents(workflowId): Promise<WorkflowEvent[]>; findActiveWorkflows(): Promise<WorkflowSnapshot[]> }`
  - `class PostgresWorkflowStore implements WorkflowStore { constructor(pool: Pool) }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/postgresStore.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
});
afterAll(async () => { await pool.end(); });

const wf = {
  id: "wf_1", userId: "usr_1", sessionId: "sess_1", state: "CREATED" as const, terminalReason: null,
  criteria: { mode: "open" as const, revision: 0 }, createdAt: 100, endedAt: null, notSolvedRounds: 0,
};
const ev = (id: string, kind: any) => ({ id, workflowId: "wf_1", kind, ts: 100, payload: {} });

describe("PostgresWorkflowStore", () => {
  it("round-trips a workflow and its event atomically", async () => {
    await store.createWorkflow(wf, ev("ev_1", "workflow_created"));
    expect(await store.getWorkflow("wf_1")).toEqual(wf);
    expect((await store.listEvents("wf_1")).map((e) => e.kind)).toEqual(["workflow_created"]);
  });

  it("persists state changes and lists by user", async () => {
    await store.saveWorkflow({ ...wf, state: "RUNNING" }, ev("ev_2", "step_dispatched"));
    expect((await store.getWorkflow("wf_1"))!.state).toBe("RUNNING");
    expect(await store.listWorkflowsByUser("usr_1")).toHaveLength(1);
    expect(await store.listWorkflowsByUser("usr_other")).toHaveLength(0);
  });

  it("round-trips steps", async () => {
    await store.createStep({
      id: "step_1", workflowId: "wf_1", state: "PENDING", objective: "check",
      capability: "git.collect_diagnostics", sideEffect: false, interruptible: true,
      idempotencyKey: null, attempt: 1, waitClass: null,
    }, ev("ev_3", "step_dispatched"));
    await store.saveStep({ ...(await store.getStep("step_1"))!, state: "RUNNING" }, ev("ev_4", "step_status"));
    expect((await store.getStep("step_1"))!.state).toBe("RUNNING");
    expect(await store.listSteps("wf_1")).toHaveLength(1);
  });

  it("finds only non-terminal workflows", async () => {
    expect((await store.findActiveWorkflows()).map((w) => w.id)).toEqual(["wf_1"]);
    await store.saveWorkflow({ ...wf, state: "CANCELLED", terminalReason: "user_cancelled" }, ev("ev_5", "workflow_terminated"));
    expect(await store.findActiveWorkflows()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/postgresStore.test.ts`
Expected: FAIL（模块/表不存在）

- [ ] **Step 3: 实现**

`002_workflows.sql` 建三张表：`workflows(id text pk, user_id text not null, session_id text not null, state text not null, terminal_reason text, criteria jsonb not null, created_at bigint not null, ended_at bigint, not_solved_rounds int not null default 0)`、`workflow_steps(id text pk, workflow_id text not null references workflows(id), state text not null, objective text not null, capability text not null, side_effect boolean not null, interruptible boolean not null, idempotency_key text, attempt int not null default 1, wait_class text)`、`workflow_events(id text pk, workflow_id text not null references workflows(id), kind text not null, ts bigint not null, payload jsonb not null)`；索引 `workflows(user_id)`、`workflows(session_id)`、`workflow_events(workflow_id, ts)`。

`PostgresWorkflowStore`：每个写方法在**一个事务**内写实体 + 事件（`client = pool.connect()`，`BEGIN`/…/`COMMIT`，`finally release`）；`findActiveWorkflows` 过滤 `state NOT IN ('COMPLETED','FAILED','CANCELLED')`；时间字段用 `bigint` 存单调时钟值。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/postgresStore.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/migrations/002_workflows.sql packages/server/src/workflow/store.ts packages/server/src/workflow/postgresStore.ts packages/server/test/workflow/postgresStore.test.ts
git commit -m "feat(workflow): postgres schema and workflow store"
```

---

### Task 5: 引擎服务：创建、下发、状态上报、完成确认

**Files:**
- Create: `packages/server/src/workflow/engine.ts`
- Test: `packages/server/test/workflow/engine.test.ts`

**Interfaces:**
- Consumes: Task 1–4 全部；P1 的 `SessionManager`（仅用于孤儿回收，Task 7 使用）
- Produces:
  - `interface NewStep { objective: string; capability: string; sideEffect: boolean; interruptible: boolean; idempotencyKey?: string | null }`
  - `type StepStatusUpdate = { state: "RUNNING" } | { state: "WAITING"; waitClass: "human" | "execution" } | { state: "COMPLETED" } | { state: "FAILED" } | { state: "REJECTED" } | { state: "UNKNOWN" }`
  - `class GuardrailError extends Error { readonly reason: GuardrailReason }`（`dispatchStep` 触顶或 Workflow 已终止时抛出）
  - `interface EngineDeps { store: WorkflowStore; guardrails?: GuardrailConfig; now?: () => number; onTerminated?: (w: WorkflowSnapshot) => Promise<void> | void }`
  - `class WorkflowEngine { constructor(deps: EngineDeps); create(userId: string, sessionId: string, request: { text: string }, criteria: CompletionCriteria): Promise<WorkflowSnapshot>; dispatchStep(workflowId, step: NewStep): Promise<StepSnapshot>; applyStepStatus(workflowId, stepId, update: StepStatusUpdate): Promise<WorkflowSnapshot>; confirmCompletion(workflowId, resolution: "solved" | "not_solved", feedback?): Promise<WorkflowSnapshot>; reviseCriteria(workflowId, next): Promise<WorkflowSnapshot>; get(workflowId): Promise<WorkflowSnapshot | null>; getStep(stepId): Promise<StepSnapshot | null> }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { DEFAULT_GUARDRAILS } from "../../src/workflow/guardrails";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;
const clock = { t: 1000 };

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  clock.t = 1000;
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => clock.t });
});
afterAll(async () => { await pool.end(); });

const open = { mode: "open" as const, revision: 0 };
const readOnly = { objective: "check", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true };

describe("WorkflowEngine basics", () => {
  it("creates a workflow in CREATED then RUNNING once a step is dispatched", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "it broke" }, open);
    expect(wf.state).toBe("CREATED");
    expect(wf.sessionId).toBe("sess_1");
    const step = await engine.dispatchStep(wf.id, readOnly);
    expect(step.state).toBe("PENDING");
    expect((await engine.get(wf.id))!.state).toBe("RUNNING");
  });

  it("ignores a status update on a terminal step", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, readOnly);
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "COMPLETED" });
    const after = await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    expect((await engine.getStep(step.id))!.state).toBe("COMPLETED");
    expect(after.state).toBe("RUNNING");
  });

  it("completes only after the user says solved", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");
    const after = await engine.get(wf.id);
    expect(after!.state).toBe("COMPLETED");
    expect(after!.terminalReason).toBeNull();
  });

  it("counts not_solved rounds and re-plans", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const after = await engine.confirmCompletion(wf.id, "not_solved", "still broken");
    expect(after.state).toBe("RUNNING");
    expect(after.notSolvedRounds).toBe(1);
  });

  it("fails with step_limit and refuses further steps", async () => {
    const limited = new WorkflowEngine({
      store,
      now: () => 1000,
      guardrails: { ...DEFAULT_GUARDRAILS, maxStepsPerWorkflow: 1 },
    });
    const wf = await limited.create("usr_1", "sess_1", { text: "x" }, open);
    await limited.dispatchStep(wf.id, readOnly);

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow(/step_limit/);

    const after = await limited.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("step_limit");

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow();
  });

  it("fails with time_budget when the workflow runs too long", async () => {
    const limited = new WorkflowEngine({
      store,
      now: () => clock.t,
      guardrails: { ...DEFAULT_GUARDRAILS, timeBudgetMs: 500 },
    });
    const wf = await limited.create("usr_1", "sess_1", { text: "x" }, open);
    clock.t = 2000;

    await expect(limited.dispatchStep(wf.id, readOnly)).rejects.toThrow(/time_budget/);

    const after = await limited.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("time_budget");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`create`：写入 `CREATED` + `workflow_created` 事件。`dispatchStep`：若 Workflow 为终态 → 抛 `GuardrailError`（拒绝新 Step）；若为 `CREATED` → 转 `RUNNING`；计算 `stepCount = 已有步数 + 1` 与 `elapsedMs = now() - createdAt`，用 `breachedGuardrail` 检查 → 触顶则 `FAILED(reason)` + `guardrail_triggered` + `workflow_terminated`，并抛 `GuardrailError`，不再下发；否则创建 `PENDING` Step + `step_dispatched`。`applyStepStatus`：读 Step；若已是终态 → 忽略并返回当前 Workflow；若 `canTransitionStep` 不允许 → 同样忽略；否则写入新状态（`WAITING` 时记录 `waitClass`）+ `step_status` 事件。`confirmCompletion("solved")` → `COMPLETED` + `workflow_terminated`；`"not_solved"` → `notSolvedRounds + 1`，用 `breachedGuardrail` 检查 `user_round_limit`（触顶则 `FAILED(user_round_limit)`），否则保持 `RUNNING` + `completion_response` 事件。`reviseCriteria` → `criteria_replaced`/`criteria_revised` 事件 + 新 revision。终态转换后调用 `deps.onTerminated`（Task 7 用于回收，P2b 用于生成 Record）。

> **`retry_limit` 的执行留给 P3**：它依赖"Server 决定重试"这一步（规划行为），P2a 只提供 `breachedGuardrail` 函数（Task 3 已测）；本任务不实现连续重试累计，因此不新增 Step 排序字段。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/engine.ts packages/server/test/workflow/engine.test.ts
git commit -m "feat(workflow): engine create/dispatch/status/completion"
```

---

### Task 6: 取消与 UNKNOWN 对账（引擎）

**Files:**
- Modify: `packages/server/src/workflow/engine.ts`
- Test: `packages/server/test/workflow/engine.cancel.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `decideCancel` / `convergesCancelling`；Task 5 的 `WorkflowEngine`
- Produces:
  - `async cancel(workflowId: string, reason?: string): Promise<WorkflowSnapshot>`
  - `async reconcileUnknown(workflowId: string, stepId: string, outcome: "COMPLETED" | "FAILED"): Promise<WorkflowSnapshot>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.cancel.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;

beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => 1000 });
});
afterAll(async () => { await pool.end(); });

const open = { mode: "open" as const, revision: 0 };

describe("engine cancel", () => {
  it("cancels immediately when nothing is in flight", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const after = await engine.cancel(wf.id, "user_cancelled");
    expect(after.state).toBe("CANCELLED");
    expect(after.terminalReason).toBe("user_cancelled");
  });

  it("queues CANCELLING for a non-interruptible execution, then converges on any terminal", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset", capability: "sim_rig.trigger_reset",
      sideEffect: true, interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    const queued = await engine.cancel(wf.id, "abandoned");
    expect(queued.state).toBe("CANCELLING");

    const after = await engine.applyStepStatus(wf.id, step.id, { state: "UNKNOWN" });
    expect(after.state).toBe("CANCELLED");
    expect(after.terminalReason).toBe("abandoned");
  });
});

describe("engine UNKNOWN reconciliation", () => {
  it("reconciles an UNKNOWN step and records the outcome", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset", capability: "sim_rig.trigger_reset",
      sideEffect: true, interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "UNKNOWN" });
    await engine.reconcileUnknown(wf.id, step.id, "COMPLETED");
    expect((await store.getStep(step.id))!.state).toBe("COMPLETED");
    expect((await engine.get(wf.id))!.state).toBe("RUNNING");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.cancel.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`cancel`：读当前活跃 Step（`PENDING/RUNNING/WAITING` 且未终态），按 `decideCancel` 分流：`IMMEDIATE` → `CANCELLED` + `terminal_reason`（默认 `user_cancelled`）+ `workflow_terminated`；`CANCELLING` → 记 `cancel_requested` 与待定 reason，状态转 `CANCELLING`（不终止）。`applyStepStatus` 中：若 Workflow 为 `CANCELLING` 且该 Step 到达终态 → 收敛 `CANCELLED`（保留待定 reason），且**不**触发 Re-plan、**不**对账。`reconcileUnknown`：仅当该 Step 当前为 `UNKNOWN` 且 Workflow 非终态时允许，写入新终态 + `step_status` 事件（`payload.reconciled = true`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.cancel.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/engine.ts packages/server/test/workflow/engine.cancel.test.ts
git commit -m "feat(workflow): cancel semantics and UNKNOWN reconciliation"
```

---

### Task 7: 孤儿回收

**Files:**
- Create: `packages/server/src/workflow/reclamation.ts`
- Test: `packages/server/test/workflow/reclamation.test.ts`

**Interfaces:**
- Consumes: Task 4 `WorkflowStore.findActiveWorkflows`；Task 5/6 `WorkflowEngine`；P1 `SessionManager`
- Produces:
  - `interface ReclamationDeps { engine: WorkflowEngine; store: WorkflowStore; sessions: SessionManager; graceMs: number; now?: () => number }`
  - `class OrphanReclaimer { constructor(deps: ReclamationDeps); reclaim(): Promise<string[]> }`（返回被终止的 workflow id）
  - `function onSessionDead(sessionId: string): void`（把 session 加入"待回收"，由 `reclaim()` 在宽限期后处理）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/reclamation.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { OrphanReclaimer } from "../../src/workflow/reclamation";
import { SessionManager } from "../../src/session/sessionManager";
import { Connection } from "../../src/ws/connection";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;
let sessions: SessionManager;
const clock = { t: 0 };

beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => clock.t });
  sessions = new SessionManager({ now: () => clock.t });
  clock.t = 1000;
});
afterAll(async () => { await pool.end(); });

const open = { mode: "open" as const, revision: 0 };
const conn = () => new Connection({ send: () => {}, close: () => {} }, "c1");

describe("OrphanReclaimer", () => {
  it("does not reclaim within the grace period", async () => {
    const session = sessions.create("usr_1", conn());
    const wf = await engine.create("usr_1", session.id, { text: "x" }, open);
    const reclaimer = new OrphanReclaimer({ engine, store, sessions, graceMs: 5000, now: () => clock.t });
    reclaimer.onSessionDead(session.id);
    clock.t = 3000;
    expect(await reclaimer.reclaim()).toEqual([]);
    expect((await engine.get(wf.id))!.state).toBe("CREATED");
  });

  it("reclaims as FAILED(client_unreachable) after the grace period", async () => {
    const session = sessions.create("usr_1", conn());
    const wf = await engine.create("usr_1", session.id, { text: "x" }, open);
    const reclaimer = new OrphanReclaimer({ engine, store, sessions, graceMs: 5000, now: () => clock.t });
    reclaimer.onSessionDead(session.id);
    clock.t = 9000;
    expect(await reclaimer.reclaim()).toEqual([wf.id]);
    const after = await engine.get(wf.id);
    expect(after!.state).toBe("FAILED");
    expect(after!.terminalReason).toBe("client_unreachable");
  });

  it("reclaims as CANCELLED when cancel was already requested", async () => {
    const session = sessions.create("usr_1", conn());
    const wf = await engine.create("usr_1", session.id, { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset", capability: "sim_rig.trigger_reset",
      sideEffect: true, interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.cancel(wf.id, "abandoned");
    expect((await engine.get(wf.id))!.state).toBe("CANCELLING");

    const reclaimer = new OrphanReclaimer({ engine, store, sessions, graceMs: 5000, now: () => clock.t });
    reclaimer.onSessionDead(session.id);
    clock.t = 9000;
    expect(await reclaimer.reclaim()).toEqual([wf.id]);

    const after = await engine.get(wf.id);
    expect(after!.state).toBe("CANCELLED");
    expect(after!.terminalReason).toBe("abandoned");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/reclamation.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`OrphanReclaimer.onSessionDead(sessionId)` 记录 `{ sessionId, deadAt: now() }`（去重）。`reclaim()`：对每个已记录且 `now() - deadAt >= graceMs` 的 session，取该 session 的**非终态** Workflow：若已 `CANCELLING` 或已请求取消 → `CANCELLED`（保留 reason）；否则 → `FAILED(client_unreachable)`；均发 `workflow_terminated` 并调用 `onTerminated`。回收后从待回收集合移除。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/reclamation.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/reclamation.ts packages/server/test/workflow/reclamation.test.ts
git commit -m "feat(workflow): orphan reclamation after grace period"
```

---

### Task 8: 端到端生命周期与重启恢复

**Files:**
- Test: `packages/server/test/workflow/engine.e2e.test.ts`
- Modify: `packages/server/src/index.ts`（导出 workflow 模块，供后续接线）

**Interfaces:**
- Consumes: Task 1–7 全部
- Produces: 无新增接口（验收）

- [ ] **Step 1: 写验收测试**

```ts
// packages/server/test/workflow/engine.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE workflows, workflow_steps, workflow_events"); });
afterAll(async () => { await pool.end(); });

describe("workflow lifecycle e2e", () => {
  it("persists a full lifecycle and survives an engine restart", async () => {
    const terminated: string[] = [];
    const engine = new WorkflowEngine({
      store: new PostgresWorkflowStore(pool),
      now: () => 1000,
      onTerminated: (w) => { terminated.push(w.id); },
    });

    const wf = await engine.create("usr_1", "sess_1", { text: "svc down" }, { mode: "formal", assertions: ["svc == up"], revision: 1 });
    const s1 = await engine.dispatchStep(wf.id, { objective: "read logs", capability: "test_rig.read_signal_log", sideEffect: false, interruptible: true });
    await engine.applyStepStatus(wf.id, s1.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, s1.id, { state: "COMPLETED" });
    await engine.confirmCompletion(wf.id, "solved");

    // A brand-new engine over the same database sees the same state.
    const reloaded = new WorkflowEngine({ store: new PostgresWorkflowStore(pool), now: () => 2000 });
    const after = await reloaded.get(wf.id);
    expect(after!.state).toBe("COMPLETED");
    expect(terminated).toEqual([wf.id]);

    const events = await new PostgresWorkflowStore(pool).listEvents(wf.id);
    expect(events.map((e) => e.kind)).toContain("workflow_created");
    expect(events.map((e) => e.kind)).toContain("step_status");
    expect(events.map((e) => e.kind)).toContain("workflow_terminated");
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.e2e.test.ts`
Expected: PASS

- [ ] **Step 3: 导出并提交**

在 `packages/server/src/index.ts` 追加导出（`WorkflowEngine`、`PostgresWorkflowStore`、`DEFAULT_GUARDRAILS`、`OrphanReclaimer`、workflow 类型），并确保 `pnpm -r --if-present typecheck` 全绿。

```bash
git add packages/server/src/index.ts packages/server/test/workflow/engine.e2e.test.ts
git commit -m "test(workflow): lifecycle end-to-end and restart recovery"
```

---

## Self-Review

**1. Spec coverage：** 状态机与终态不可变 → T1/T5；取消与 CANCELLING 收敛 → T2/T6；护栏与完成条件 → T3/T5；`UNKNOWN` 建模与对账收敛 → T1/T6；孤儿回收 → T7；持久化与重启恢复 → T4/T8。**未覆盖且刻意留给后续**：Record 生成/查询与 Report（P2b）、协议消息接线（P2b）、副作用串行与对账编排（P4）、LLM（P3）。

**2. Step scan：** 每步一个动作；实现步给签名与规则，不给完整函数体。

**3. Type consistency：** `WorkflowState`/`StepState`/`WorkflowSnapshot`/`StepSnapshot`/`WorkflowStore`/`WorkflowEngine`/`GuardrailConfig`/`CompletionCriteria` 在 T1–T5 定义，T6–T8 复用同一名称。

**4. Review Focus：** 五条风险落到测试——(1) 终态后更新被忽略 → T5；(2) 护栏触顶 → T3/T5；(3) CANCELLING 收敛（含 UNKNOWN）→ T6；(4) 宽限期内不回收 → T7；(5) 重复/乱序状态不回退、事件不重复 → T5/T4。

**5. Proportion：** 计划只描述决策、接口与断言，不含实现体。

## 后续

P2a 验收通过后写 **P2b**：Record 生成与保存（先落盘后通知）、`record.list/get` 按用户过滤、Report 生成、协议消息接线（`workflow.*` / `step.*` / `record.*` / `report.*`），以及 P1 移交的 `ERROR_DISPOSITION` 驱动与会话级去重窗口。
