# P4a 受控执行与对账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让有副作用的动作真正"工程师确认后才执行"，并在结果不确定时进入 `UNKNOWN` 由对账收敛；同时把幂等台账、Step 超时与 Record 忠实性补齐。

**Architecture:** 三处改动互相咬合但各归其位：**Client** 负责"确认/输入"的交互与副作用执行（`WAITING` → 本地决定 → `RUNNING` → 结果），并把 `idempotency_key → 结果` 持久化在本地 SQLite；**Server** 负责确定性规则——Step 超时（只读 → `FAILED(timeout)`，副作用 → `UNKNOWN`，人类等待豁免）与对账收敛（`PlannerDecision` 新增 `reconcile`，由 Planner 依据对账证据裁定，Engine 落地）；**Record** 忠实记录护栏阈值、工程师输入与对账证据引用。能力仍由 Client 声明，Server 不 import 具体能力。

**Tech Stack:** TypeScript（strict）· Node.js LTS（`node:sqlite`）· PostgreSQL（`pg`）· Vitest · pnpm workspace（沿用 P1–P3b 结构）

**Spec:** `docs/specs/WORKFLOW_SPEC.md`（v0.5 §4.2 确认、§4.3 `UNKNOWN` 与对账、§6.1 建议路径、§13 护栏）、`docs/specs/CAPABILITY_SPEC.md`（v0.7 §2/§5/§6）、`docs/specs/PROTOCOL_SPEC.md`（v0.7 §7.3/§8/§9）、`docs/specs/RECORD_SPEC.md`（v0.7 §3/§4）、`docs/adr/ADR-003`（§5 授权）、`docs/adr/ADR-004`（§3 SQLite 台账）、`docs/superpowers/specs/2026-09-29-mvp-scope.md`（§5.2 E1/E2）

## Global Constraints

- **受控执行不可绕过**：`requires_confirmation: true` 的 Step **绝不由 Client 自动执行**；必须先进 `WAITING(wait_reason={code:"user_confirmation"})`，确认后才 `RUNNING`，拒绝则 `REJECTED(reject_reason={code:"user_declined"})`（`WORKFLOW_SPEC.md` §4.2）。
- **超时分流**（`PROTOCOL_SPEC.md` §9）：只读 Step 超时 → `FAILED(fail_reason.code="timeout")`；**副作用** Step 超时 → **`UNKNOWN`**（不是 `FAILED`）；**人类等待**（`user_input` / `user_confirmation` / 人工对账）**不计入超时**。
- **`UNKNOWN` 只由对账收敛**：只能收敛为 `COMPLETED` / `FAILED`；`CANCELLING` 期间不触发对账（P2a 已有）。
- **幂等**（`WORKFLOW_SPEC.md` §4.3）：副作用 Step 的 `idempotency_key` 在 Workflow 内稳定（随 Step 持久化，重连重发 `pending_step` 时复用）；Client 持久化"键 → 结果"，命中台账**不得重复执行**；台账**跨进程重启保留**（`node:sqlite`）。
- **能力归 Client**：`sim_rig.*` / `terminal.execute_command` 的声明与执行都在 `@adt/client-daemon`；Server 只通过 Planner 与 Manifest 感知。
- **时间**：Server 超时判定用**可注入的单调时钟**（沿用 P2a）；Step 的超时时长在**下发时快照**到 Step 上（`timeout_hint` → Step），不读实时注册表。
- **本阶段不做**（留给 P4b/P4c）：blob 通道、KB 导出、受控执行的 UI。
- **文档纪律**：`CAPABILITY_SPEC.md` v0.7 → **v0.8**（登记 `terminal.execute_command` / `sim_rig.query_state`，并把已实现的 `human.manual_action` 从 §7 待补项移出）。

## Review Focus

以下失败模式是 Spec 隐含但容易漏测的，**每条都必须在对应任务里有测试**：

1. **需确认的 Step 不自动执行**：未确认前 Client 不得调用执行器；确认后才 `RUNNING`；拒绝走 `REJECTED(user_declined)`（Task 6）。
2. **超时分流正确**：只读 → `FAILED(timeout)`；副作用 → `UNKNOWN`；人类等待不计超时（Task 2/3）。
3. **对账收敛**：`UNKNOWN` 被 `reconcile` 决策收敛为 `COMPLETED`/`FAILED`，且 `reconciliation_resolved.ref.evidence_refs` 有值（Task 4）。
4. **幂等不重复执行**：同一 `idempotency_key` 的重发命中台账、不重新执行；台账跨进程保留（Task 8）。
5. **Record 忠实**：`guardrail_triggered.ref.threshold` 非空、工程师输入落为 `user_input` 条目（Task 5）。

---

### Task 1: Step 带上 `updatedAt` / `timeoutMs`，副作用 Step 生成 `idempotency_key`

**Files:**
- Create: `packages/server/migrations/008_step_timing.sql`
- Modify: `packages/server/src/workflow/store.ts`、`postgresStore.ts`、`engine.ts`、`orchestrator.ts`
- Test: `packages/server/test/workflow/engine.idempotency.test.ts`（新建）、`packages/server/test/workflow/postgresStore.test.ts`（fixture）

**Interfaces:**
- Consumes: P2a 引擎/存储；P3a `OrchestratorDeps.capabilitiesOf`
- Produces:
  - `StepSnapshot.updatedAt: number`、`StepSnapshot.timeoutMs: number`
  - `NewStep.timeoutMs?: number`
  - 引擎：`dispatchStep` 为 `sideEffect` 的 Step 生成 `idempotencyKey = step.idempotencyKey ?? \`idem_${randomUUID()}\``（持久化）；每次状态变更刷新 `updatedAt = this.now()`
  - `OrchestratorDeps.defaultStepTimeoutMs?: number`（默认 `60_000`）；下发时把 `capability.timeout_hint ?? defaultStepTimeoutMs` 写进 `NewStep.timeoutMs`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.idempotency.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;
let t = 1000;
beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  t = 1000;
  engine = new WorkflowEngine({ store, now: () => t });
});
afterAll(async () => { await pool.end(); });

describe("step timing and idempotency", () => {
  it("snapshots timeoutMs and mints a stable idempotency key for side-effect steps", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "reset", capability: "sim_rig.trigger_reset", sideEffect: true, interruptible: false,
      timeoutMs: 30000,
    });
    expect(step.timeoutMs).toBe(30000);
    expect(step.idempotencyKey).toMatch(/^idem_/);
    // re-reading the persisted step keeps the same key (so a resume re-dispatch is idempotent)
    expect((await store.getStep(step.id))!.idempotencyKey).toBe(step.idempotencyKey);
  });

  it("leaves the key null for read-only steps and refreshes updatedAt on state change", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true, timeoutMs: 5000,
    });
    expect(step.idempotencyKey).toBeNull();
    expect(step.updatedAt).toBe(1000);
    t = 2000;
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    expect((await store.getStep(step.id))!.updatedAt).toBe(2000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.idempotency.test.ts`
Expected: FAIL（`timeoutMs` / `updatedAt` / `idempotencyKey` 未生成）

- [ ] **Step 3: 实现**

`008_step_timing.sql`：`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT 0;` 与 `... timeout_ms bigint NOT NULL DEFAULT 0;`。`store.ts` 增 `updatedAt`/`timeoutMs`；`postgresStore.ts` 读写两列（`insertStep` 的 `ON CONFLICT` 增 `updated_at = EXCLUDED.updated_at`）。`engine.ts`：`dispatchStep` 建 `updatedAt: this.now()`、`timeoutMs: step.timeoutMs ?? 0`、`idempotencyKey: step.sideEffect ? (step.idempotencyKey ?? \`idem_${randomUUID()}\`) : (step.idempotencyKey ?? null)`；`saveStep`/`saveStepAndWorkflow` 前把 `updatedAt` 刷成 `this.now()`。`orchestrator.ts`：`defaultStepTimeoutMs` 与 `timeoutMs` 计算。同步更新 `test/record/builder.test.ts` 的 `step()` 与 `test/workflow/postgresStore.test.ts` 的 step 字面量（补 `updatedAt: 0, timeoutMs: 0`）。

- [ ] **Step 4: 运行测试确认通过（含既有回归）**

Run: `pnpm -C packages/server exec vitest run test/workflow/ test/protocol/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/migrations/008_step_timing.sql packages/server/src packages/server/test
git commit -m "feat(workflow): snapshot step timeout and mint idempotency keys"
```

---

### Task 2: `engine.timeoutStep`（只读 → `FAILED(timeout)`，副作用 → `UNKNOWN`）

**Files:**
- Modify: `packages/server/src/workflow/engine.ts`
- Test: `packages/server/test/workflow/engine.timeout.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1；P2a `applyStepStatus`
- Produces: `WorkflowEngine.timeoutStep(workflowId: string, stepId: string): Promise<WorkflowSnapshot>` —— 终态或非活跃 Step 原样返回；`WAITING` 且 `waitClass === "human"` 原样返回；`sideEffect` → `UNKNOWN`；否则 `FAILED(failReason={code:"timeout"})`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.timeout.test.ts
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
  store = new PostgresWorkflowStore(pool); engine = new WorkflowEngine({ store, now: () => 1000 });
});
afterAll(async () => { await pool.end(); });

const create = () => engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });

describe("engine.timeoutStep", () => {
  it("fails a read-only running step with timeout", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, { objective: "r", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.timeoutStep(wf.id, step.id);
    expect((await store.getStep(step.id))!.state).toBe("FAILED");
  });

  it("marks a side-effect running step UNKNOWN", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, { objective: "reset", capability: "sim_rig.trigger_reset", sideEffect: true, interruptible: false });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.timeoutStep(wf.id, step.id);
    expect((await store.getStep(step.id))!.state).toBe("UNKNOWN");
  });

  it("does not time out a human-waiting step", async () => {
    const wf = await create();
    const step = await engine.dispatchStep(wf.id, { objective: "e", capability: "human.manual_action", sideEffect: false, interruptible: true });
    await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "human" });
    await engine.timeoutStep(wf.id, step.id);
    expect((await store.getStep(step.id))!.state).toBe("WAITING");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.timeout.test.ts`
Expected: FAIL（`timeoutStep` 不存在）

- [ ] **Step 3: 实现**

`timeoutStep`：`withWorkflowLock` 内取 workflow + step；workflow 终态或 step 非 `RUNNING`/执行类 `WAITING` → 原样返回；`waitClass === "human"` → 原样返回；`sideEffect` → `applyStepStatus(..., {state:"UNKNOWN"})`；否则 `applyStepStatus(..., {state:"FAILED", failReason:{code:"timeout"}})`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.timeout.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/engine.ts packages/server/test/workflow/engine.timeout.test.ts
git commit -m "feat(workflow): step timeout routes read-only to FAILED and side-effects to UNKNOWN"
```

---

### Task 3: `StepTimeoutMonitor` + 接线

**Files:**
- Create: `packages/server/src/workflow/stepTimeout.ts`
- Modify: `packages/server/src/index.ts`、`packages/test-support/src/server.ts`
- Test: `packages/server/test/workflow/stepTimeout.test.ts`（新建）、`packages/server/test/workflow/stepTimeout.int.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2；P2a `WorkflowStore.findActiveWorkflows/listSteps`
- Produces:
  - `class StepTimeoutMonitor { constructor(deps: StepTimeoutDeps, options: { intervalMs: number }); sweep(): Promise<string[]>; start(): void; stop(): void }` —— 遍历活跃 Workflow 的活跃 Step，`now - updatedAt > timeoutMs`（`timeoutMs > 0`）且非人类等待 → `engine.timeoutStep`
  - `interface StepTimeoutDeps { engine: Pick<WorkflowEngine, "timeoutStep">; store: Pick<WorkflowStore, "findActiveWorkflows" | "listSteps">; now?: () => number }`（窄接口，便于单测注入假实现）
  - `start` / `startTestServer` 选项新增 `stepTimeoutMs?`（默认走 Task 1 的默认值）与 `timeoutSweepIntervalMs?`（默认 `1000`），并启动/停止该 monitor

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/stepTimeout.test.ts
import { describe, it, expect } from "vitest";
import { StepTimeoutMonitor } from "../../src/workflow/stepTimeout";

describe("StepTimeoutMonitor", () => {
  it("times out an active step whose deadline has passed and skips human waits", async () => {
    let t = 0;
    const timed: string[] = [];
    const monitor = new StepTimeoutMonitor(
      {
        now: () => t,
        store: {
          findActiveWorkflows: async () => [{ id: "wf_1" }] as never,
          listSteps: async () =>
            [
              { id: "step_1", state: "RUNNING", updatedAt: 0, timeoutMs: 100, waitClass: null },
              { id: "step_2", state: "WAITING", updatedAt: 0, timeoutMs: 100, waitClass: "human" },
              { id: "step_3", state: "RUNNING", updatedAt: 0, timeoutMs: 0, waitClass: null },
            ] as never,
        },
        engine: {
          timeoutStep: async (_wf: string, stepId: string) => {
            timed.push(stepId);
            return {} as never;
          },
        },
      },
      { intervalMs: 10 },
    );

    t = 50;
    expect(await monitor.sweep()).toEqual([]);
    t = 150;
    expect(await monitor.sweep()).toEqual(["step_1"]);
    expect(timed).toEqual(["step_1"]);
  });
});
```

```ts
// packages/server/test/workflow/stepTimeout.int.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

describe("step timeout end to end", () => {
  it("fails a read-only step that never reports back", async () => {
    const srv = await startTestServer({
      stepTimeoutMs: 50, timeoutSweepIntervalMs: 20,
      planner: [
        { kind: "step", step: { objective: "r", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true } },
        { kind: "completion_candidate", summary: "done", evidenceRefs: [] },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const created = await c.sendRaw({ ...c.base("workflow.request"),
      payload: { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } } });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    const dispatch = await c.next();
    const stepId = (dispatch.payload as { step_id: string }).step_id;
    // The client reports RUNNING but never COMPLETED; the monitor must fail it.
    c.send({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" } });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await srv.engine.getStep(stepId))!.state !== "FAILED") {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await srv.engine.getStep(stepId))!.state).toBe("FAILED");
    await c.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/stepTimeout.test.ts test/workflow/stepTimeout.int.test.ts`
Expected: FAIL（模块 / 选项不存在）

- [ ] **Step 3: 实现**

`stepTimeout.ts` 按 Interfaces；`sweep` 只处理 `timeoutMs > 0` 且 `now - updatedAt > timeoutMs` 的活跃 Step（`RUNNING` 或非人类 `WAITING`），逐个 `engine.timeoutStep` 并收集 id。`index.ts` / `test-support` 在构造完 `store`/`engine` 后创建 `StepTimeoutMonitor` 并 `start()`，`close()` 时 `stop()`；`TestServerOptions`/`StartOptions` 增 `stepTimeoutMs` / `timeoutSweepIntervalMs`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/stepTimeout.test.ts test/workflow/stepTimeout.int.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/stepTimeout.ts packages/server/src/index.ts packages/test-support packages/server/test/workflow/stepTimeout.test.ts packages/server/test/workflow/stepTimeout.int.test.ts
git commit -m "feat(workflow): step timeout monitor"
```

---

### Task 4: 对账收敛（`PlannerDecision.reconcile` + `evidence_refs` 入 Record）

**Files:**
- Modify: `packages/server/src/workflow/planner.ts`、`orchestrator.ts`、`engine.ts`、`record/builder.ts`
- Test: `packages/server/test/workflow/orchestrator.reconcile.test.ts`（新建）、`packages/server/test/record/builder.test.ts`（追加）

**Interfaces:**
- Consumes: P2a `engine.reconcileUnknown`
- Produces:
  - `type PlannerDecision = … | { kind: "reconcile"; stepId: string; outcome: "COMPLETED" | "FAILED"; evidenceRefs?: string[] }`
  - `orchestrator.advance`：`reconcile` → `engine.reconcileUnknown(workflowId, stepId, outcome, evidenceRefs)`，返回 `{}`
  - `engine.reconcileUnknown(workflowId, stepId, outcome, evidenceRefs?: string[])`：`step_status {stepId, state: outcome, reconciled: true, evidenceRefs}`
  - `buildRecord`：`reconciliation_resolved.ref.evidence_refs = payload.evidenceRefs ?? []`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/orchestrator.reconcile.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowOrchestrator, type PlannerDecision } from "../../src/workflow/orchestrator";
import { buildRecord } from "../../src/record/builder";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE workflows, workflow_steps, workflow_events"); });
afterAll(async () => { await pool.end(); });

describe("reconciliation", () => {
  it("resolves an UNKNOWN step through a reconcile decision", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, { objective: "reset", capability: "sim_rig.trigger_reset", sideEffect: true, interruptible: false });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.timeoutStep(wf.id, step.id);

    const orchestrator = new WorkflowOrchestrator({
      engine, store,
      planner: { initialCriteria: async () => ({ mode: "open", revision: 0 }),
        proposeNext: async (): Promise<PlannerDecision> => ({ kind: "reconcile", stepId: step.id, outcome: "COMPLETED", evidenceRefs: [step.id] }) },
      capabilitiesOf: () => [],
    });
    await orchestrator.advance(wf.id);

    expect((await store.getStep(step.id))!.state).toBe("COMPLETED");
    const record = buildRecord({
      workflow: (await store.getWorkflow(wf.id))!, steps: await store.listSteps(wf.id),
      events: await store.listEvents(wf.id), userRequest: { text: "x" }, recordId: "rec_r",
    });
    const resolved = record.entries.find((entry) => entry.kind === "reconciliation_resolved")!;
    expect(resolved.ref.evidence_refs).toEqual([step.id]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.reconcile.test.ts`
Expected: FAIL（`reconcile` 决策未处理 / `evidence_refs` 为空）

- [ ] **Step 3: 实现**

`planner.ts` 增决策变体；`engine.reconcileUnknown` 增可选 `evidenceRefs` 并写进事件 payload；`orchestrator.advance` 处理 `reconcile`（终态 Workflow 仍直接返回 `{}`）；`builder.ts` 的 `reconciliation_resolved` 分支读 `payload.evidenceRefs ?? []`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.reconcile.test.ts test/record/builder.test.ts test/workflow/orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src packages/server/test/workflow/orchestrator.reconcile.test.ts packages/server/test/record/builder.test.ts
git commit -m "feat(workflow): reconcile UNKNOWN steps with evidence references"
```

---

### Task 5: Record 忠实性——护栏阈值与工程师输入

**Files:**
- Modify: `packages/server/src/workflow/engine.ts`、`record/builder.ts`
- Test: `packages/server/test/record/builder.test.ts`（追加）、`packages/server/test/workflow/engine.guardrail.test.ts`（新建）

**Interfaces:**
- Consumes: P2a `breachedGuardrail` / `GuardrailConfig`
- Produces:
  - 引擎：`guardrail_triggered` 事件 payload 增 `threshold`（`GuardrailConfig` 中对应项的值；`timeBudgetMs === null` → `null`）
  - `buildRecord`：`guardrail_triggered.ref.threshold = payload.threshold ?? null`；`step_status COMPLETED` 且 `evidence.source === "user_input"` → entry `kind: "user_input"`（`ref: { step_id, content }`，`content = evidence.result`），**不再**当作 `evidence_received`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/record/builder.test.ts（追加）
it("records the guardrail threshold and the engineer's input", () => {
  const record = buildRecord({
    workflow,
    steps: [step()],
    events: [
      ev("workflow_created", { request: { text: "x" } }),
      ev("step_status", { stepId: "step_1", state: "COMPLETED",
        evidence: { source: "user_input", type: "manual_action_result",
          result: { outcome: "succeeded", observation: "换了电源线" } } }),
      ev("guardrail_triggered", { reason: "step_limit", threshold: 50 }),
    ],
    userRequest: { text: "x" },
    recordId: "rec_ui",
  });
  expect(record.entries.map((e) => e.kind)).toEqual(["user_input", "guardrail_triggered"]);
  expect(record.entries[0]!.ref).toEqual({
    step_id: "step_1",
    content: { outcome: "succeeded", observation: "换了电源线" },
  });
  expect(record.entries[1]!.ref.threshold).toBe(50);
});
```

```ts
// packages/server/test/workflow/engine.guardrail.test.ts（新建）
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { GuardrailError, WorkflowEngine } from "../../src/workflow/engine";
import { DEFAULT_GUARDRAILS } from "../../src/workflow/guardrails";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE workflows, workflow_steps, workflow_events"); store = new PostgresWorkflowStore(pool); });
afterAll(async () => { await pool.end(); });

describe("guardrail threshold", () => {
  it("writes the configured threshold into the guardrail_triggered event", async () => {
    const engine = new WorkflowEngine({ store, now: () => 1000, guardrails: { ...DEFAULT_GUARDRAILS, maxStepsPerWorkflow: 0 } });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    await expect(
      engine.dispatchStep(wf.id, { objective: "r", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true }),
    ).rejects.toBeInstanceOf(GuardrailError);
    const event = (await store.listEvents(wf.id)).find((e) => e.kind === "guardrail_triggered")!;
    expect((event.payload as { threshold: unknown }).threshold).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/record/builder.test.ts`
Expected: FAIL（`user_input` 未区分 / `threshold` 为 `null`）

- [ ] **Step 3: 实现**
引擎在 `breachedGuardrail` 命中处取 `this.guardrails` 对应阈值写进事件；`builder.ts` 的 `step_status` 分支先判 `evidence.source === "user_input"`（→ `user_input` 条目），否则维持 `evidence_received`；`guardrail_triggered` 分支读 `payload.threshold ?? null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/record/builder.test.ts test/workflow/engine.guardrail.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/engine.ts packages/server/src/record/builder.ts packages/server/test/record/builder.test.ts packages/server/test/workflow/engine.guardrail.test.ts
git commit -m "feat(record): record guardrail thresholds and engineer input"
```

---

### Task 6: Client 的确认与"建议"交互

**Files:**
- Modify: `packages/client-daemon/src/stepRunner.ts`、`daemon.ts`
- Test: `packages/client-daemon/test/stepRunner.confirm.test.ts`（新建）

**Interfaces:**
- Consumes: P3b `attachStepRunner` / `CapabilityRegistry`
- Produces:
  - `StepRunnerDeps` 增 `onConfirmationRequired?: (req: { stepId; capability; objective }) => Promise<boolean>`（默认 → `false`）与 `onUserInput?: (req: { stepId; capability; objective; instruction?: unknown }) => Promise<{ outcome; observation; details? }>`（默认 → `undefined`）
  - 行为：`requires_confirmation === true` → 先发 `WAITING(wait_reason={code:"user_confirmation"})`；`await onConfirmationRequired` 为 `true` → 继续 `RUNNING` 并执行；为 `false` → `REJECTED(reject_reason={code:"user_declined"})`（不执行）
  - `human.manual_action`（保留名，Runner 先于注册表拦截）→ 发 `WAITING(wait_reason={code:"user_input"})`；`await onUserInput`；有结果 → `COMPLETED(evidence={source:"user_input", type:"manual_action_result", result})`，无 `onUserInput` → `REJECTED(reject_reason={code:"user_declined"})`
  - `ClientDaemonOptions` 透传这两个回调

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/stepRunner.confirm.test.ts
import { describe, it, expect } from "vitest";
import { attachStepRunner, type StepRunnerDeps } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { CapabilityAdapter } from "../src/capability/result";

function harness(adapter: CapabilityAdapter | null, hooks: Partial<StepRunnerDeps> = {}) {
  const sent: Array<{ payload: any }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  const registry = new CapabilityRegistry();
  if (adapter) registry.register(adapter);
  attachStepRunner({
    connection: { on: (t, h) => { handlers.set(t, h); }, send: (_t, p) => { sent.push({ payload: p }); } },
    registry,
    workspaceRoot: "/ws",
    ...hooks,
  });
  const dispatch = (payload: Record<string, unknown>) => handlers.get("step.dispatch")!({ payload });
  return { sent, dispatch, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

const base = { workflow_id: "wf_1", step_id: "step_1", objective: "reset", capability: "sim_rig.trigger_reset", input: {}, expected_output: null, idempotency_key: "idem_1" };
const sideEffect: CapabilityAdapter = {
  spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
  execute: async () => ({ status: "completed", type: "reset_ack", result: { reset_ack: true } }),
};

describe("confirmation and advisory flows", () => {
  it("waits for confirmation, then executes", async () => {
    const { sent, dispatch, settle } = harness(sideEffect, { onConfirmationRequired: async () => true });
    dispatch({ ...base, requires_confirmation: true });
    await settle();
    expect(sent.map((s) => s.payload.status)).toEqual(["WAITING", "RUNNING", "COMPLETED"]);
    expect(sent[0]!.payload.wait_reason).toEqual({ code: "user_confirmation" });
  });

  it("does not execute when the engineer declines", async () => {
    let executed = false;
    const { sent, dispatch, settle } = harness(
      { spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
        execute: async () => { executed = true; return { status: "completed", type: "reset_ack", result: {} }; } },
      { onConfirmationRequired: async () => false },
    );
    dispatch({ ...base, requires_confirmation: true });
    await settle();
    expect(executed).toBe(false);
    expect(sent[sent.length - 1]!.payload).toMatchObject({ status: "REJECTED", reject_reason: { code: "user_declined" } });
  });

  it("turns the engineer's advisory feedback into user_input evidence", async () => {
    const { sent, dispatch, settle } = harness(null, {
      onUserInput: async () => ({ outcome: "succeeded", observation: "换了电源线" }),
    });
    dispatch({ ...base, capability: "human.manual_action", requires_confirmation: false, input: { instruction: "换线" } });
    await settle();
    expect(sent.map((s) => s.payload.status)).toEqual(["WAITING", "COMPLETED"]);
    expect(sent[1]!.payload.evidence).toEqual({
      source: "user_input", type: "manual_action_result",
      result: { outcome: "succeeded", observation: "换了电源线" },
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.confirm.test.ts`
Expected: FAIL（WAITING / 确认回调不存在）

- [ ] **Step 3: 实现**

`stepRunner.ts`：先拦截 `human.manual_action`；再取 adapter（未知 → `capability_unavailable`）；`sideEffect` 的本地护栏保留（但此时有确认回调时以确认为准——**注意**：`side_effect` 且 `requires_confirmation` 为真时走确认，不再直接拒绝）；`requires_confirmation` → `WAITING` + `await onConfirmationRequired`。`daemon.ts` 透传回调。

> 衔接说明：P3b 的本地 `side_effect` 直拒是本阶段的临时占位；本任务用"确认回调"取代它——`side_effect` 且**未**要求确认时仍拒绝（防 Server 漏标），`requires_confirmation` 为真时走确认流程。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.confirm.test.ts test/stepRunner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src packages/client-daemon/test/stepRunner.confirm.test.ts
git commit -m "feat(daemon): confirmation and advisory interaction flows"
```

---

### Task 7: 副作用与对账能力的适配器

**Files:**
- Create: `packages/client-daemon/src/capability/adapters/simRig.ts`、`terminal.ts`
- Modify: `packages/client-daemon/src/capability/descriptors.ts`、`defaultRegistry.ts`
- Test: `packages/client-daemon/test/capability/simRig.test.ts`、`terminal.test.ts`（新建）

**Interfaces:**
- Consumes: P3b `CapabilityAdapter` / `CommandRunner`
- Produces:
  - `function simRigTriggerReset(spec): CapabilityAdapter`（`{ reset_ack: true }`；本地不执行真实动作，仅用于验证确认/`UNKNOWN`/幂等链路）
  - `function simRigQueryState(spec): CapabilityAdapter`（`{ reset_applied: boolean }`；**只读对账能力**）
  - `function terminalExecuteCommand(spec): CapabilityAdapter`（`{ exit_code, stdout }`；**副作用**，`side_effect: true`、`interruptible: false`、`idempotent: false`，带超时）
  - `mvpDescriptors()` 增这三项（`terminal.execute_command` input `{required:[command], properties:{command:string, args:array}}`、output `{required:[exit_code], properties:{exit_code:integer, stdout:string}}`；`sim_rig.*` 见 §Task 10 的 schema 登记）
  - `defaultRegistry()` 注册它们

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/capability/terminal.test.ts
import { describe, it, expect } from "vitest";
import { terminalExecuteCommand } from "../../src/capability/adapters/terminal";
import { mvpSpec } from "../../src/capability/descriptors";
import type { CommandRunner } from "../../src/capability/result";

const ctxWith = (run: CommandRunner) => ({ workspaceRoot: "/ws", run });

describe("terminal.execute_command", () => {
  it("runs the command and reports exit_code/stdout", async () => {
    let seen: string[] = [];
    const run: CommandRunner = async (command, args) => { seen = [command, ...args]; return { code: 0, stdout: "ok", stderr: "" }; };
    const result = await terminalExecuteCommand(mvpSpec("terminal.execute_command")).execute(
      { command: "echo", args: ["hi"] }, ctxWith(run));
    expect(seen).toEqual(["echo", "hi"]);
    expect(result).toEqual({ status: "completed", type: "command_result", result: { exit_code: 0, stdout: "ok" } });
  });

  it("rejects a missing command without running anything", async () => {
    let called = false;
    const run: CommandRunner = async () => { called = true; return { code: 0, stdout: "", stderr: "" }; };
    const result = await terminalExecuteCommand(mvpSpec("terminal.execute_command")).execute({}, ctxWith(run));
    expect(result.status).toBe("rejected");
    expect(called).toBe(false);
  });
});
```

```ts
// packages/client-daemon/test/capability/simRig.test.ts
import { describe, it, expect } from "vitest";
import { simRigTriggerReset, simRigQueryState } from "../../src/capability/adapters/simRig";
import { mvpSpec } from "../../src/capability/descriptors";

const ctx = { workspaceRoot: "/ws", run: async () => ({ stdout: "", stderr: "", code: 0 }) };

describe("sim_rig", () => {
  it("acknowledges a reset and reports a reconciliation state", async () => {
    expect(await simRigTriggerReset(mvpSpec("sim_rig.trigger_reset")).execute({}, ctx))
      .toEqual({ status: "completed", type: "reset_ack", result: { reset_ack: true } });
    expect(await simRigQueryState(mvpSpec("sim_rig.query_state")).execute({}, ctx))
      .toEqual({ status: "completed", type: "reset_state", result: { reset_applied: true } });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/terminal.test.ts test/capability/simRig.test.ts`
Expected: FAIL（模块 / 描述不存在）

- [ ] **Step 3: 实现**

按 Interfaces 实现三个适配器与描述项；`terminal` 用 `ctx.run` 并带 `timeout_hint`；`sim_rig.trigger_reset` / `sim_rig.query_state` 是**模拟**能力（不接触真实硬件），用于验证安全机制。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/capability packages/client-daemon/test/capability
git commit -m "feat(daemon): side-effect and reconciliation capability adapters"
```

---

### Task 8: 幂等台账（`node:sqlite`）与 Runner 集成

**Files:**
- Create: `packages/client-daemon/src/ledger.ts`
- Modify: `packages/client-daemon/src/stepRunner.ts`、`daemon.ts`
- Test: `packages/client-daemon/test/ledger.test.ts`（新建）、`packages/client-daemon/test/stepRunner.idempotency.test.ts`（新建）

**Interfaces:**
- Consumes: `node:sqlite`
- Produces:
  - `interface LedgerEntry { type: string; result: unknown }`
  - `interface Ledger { get(key: string): LedgerEntry | undefined; set(key: string, entry: LedgerEntry): void; close(): void }`
  - `function openLedger(location: string): Ledger`（`location` 为文件路径或 `":memory:"`）
  - `StepRunnerDeps.ledger?: Ledger`；副作用 Step 若带 `idempotency_key`：**先查台账**（早于确认判定——命中说明无需执行，也就不需要再次确认），命中 → 直接 `COMPLETED(evidence={source:"capability", type, result})`、**不执行**；未命中 → 走确认/执行流程，执行 `completed` 后 `ledger.set`
  - `ClientDaemonOptions.ledger?: Ledger`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/stepRunner.idempotency.test.ts
import { describe, it, expect } from "vitest";
import { attachStepRunner } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import { openLedger } from "../src/ledger";

function harness(ledger = openLedger(":memory:")) {
  const sent: Array<{ payload: any }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  let runs = 0;
  const registry = new CapabilityRegistry();
  registry.register({
    spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
    execute: async () => { runs++; return { status: "completed", type: "reset_ack", result: { reset_ack: true } }; },
  });
  attachStepRunner({
    connection: { on: (t, h) => { handlers.set(t, h); }, send: (_t, p) => { sent.push({ payload: p }); } },
    registry,
    workspaceRoot: "/ws",
    ledger,
    onConfirmationRequired: async () => true,
  });
  const dispatch = (payload: Record<string, unknown>) => handlers.get("step.dispatch")!({ payload });
  return { sent, dispatch, settle: () => new Promise((r) => setTimeout(r, 20)), get runs() { return runs; } };
}

const payload = { workflow_id: "wf_1", step_id: "step_1", objective: "reset", capability: "sim_rig.trigger_reset", input: {}, expected_output: null, requires_confirmation: true, idempotency_key: "idem_1" };

describe("idempotency ledger", () => {
  it("does not execute the same idempotency key twice", async () => {
    const h = harness();
    h.dispatch(payload);
    await h.settle();
    expect(h.runs).toBe(1);

    // a re-dispatch of the same key (e.g. after a reconnect) must not re-execute
    h.dispatch({ ...payload, step_id: "step_2" });
    await h.settle();
    expect(h.runs).toBe(1);
    const last = h.sent[h.sent.length - 1]!.payload;
    expect(last).toMatchObject({ status: "COMPLETED", evidence: { type: "reset_ack", result: { reset_ack: true } } });
  });
});
```

```ts
// packages/client-daemon/test/ledger.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger";

describe("openLedger", () => {
  it("persists entries across a reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adt-ledger-")), "ledger.db");
    const first = openLedger(path);
    first.set("idem_1", { type: "reset_ack", result: { reset_ack: true } });
    first.close();

    const second = openLedger(path);
    expect(second.get("idem_1")).toEqual({ type: "reset_ack", result: { reset_ack: true } });
    expect(second.get("missing")).toBeUndefined();
    second.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/ledger.test.ts test/stepRunner.idempotency.test.ts`
Expected: FAIL（模块 / 台账集成不存在）

- [ ] **Step 3: 实现**

`ledger.ts`：`new DatabaseSync(location)`；建表 `ledger(key text primary key, type text not null, result text not null)`；`get` 读并 `JSON.parse`，`set` 用 `INSERT OR REPLACE`（`JSON.stringify`），`close` 关连接。`stepRunner.ts`：`sideEffect` 且 `idempotency_key` 且台账命中 → 直接 `COMPLETED`；未命中执行完成后 `set(key, {type, result})`。`daemon.ts` 透传 `ledger`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/ledger.test.ts test/stepRunner.idempotency.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/ledger.ts packages/client-daemon/src/stepRunner.ts packages/client-daemon/src/daemon.ts packages/client-daemon/test/ledger.test.ts packages/client-daemon/test/stepRunner.idempotency.test.ts
git commit -m "feat(daemon): persistent idempotency ledger"
```

---

### Task 9: 端到端——确认、拒绝、超时对账、幂等重发

**Files:**
- Test: `packages/client-daemon/test/controlledExecution.e2e.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1–8；`@adt/test-support`
- Produces: 验收——真实 daemon + server：确认后执行副作用动作并落 Record（`resolution: controlled_execution`）；拒绝则 `REJECTED` 后重新规划；副作用超时 → `UNKNOWN` → 对账 → 收敛；同一 `idempotency_key` 重发不重复执行

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/controlledExecution.e2e.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";
import { openLedger } from "../src/ledger";

const resetStep = { kind: "step" as const, step: { objective: "reset", capability: "sim_rig.trigger_reset", sideEffect: true, interruptible: false } };
const candidate = { kind: "completion_candidate" as const, summary: "完成", evidenceRefs: [] };

describe("controlled execution end to end", () => {
  it("executes a confirmed side-effect action and records it", async () => {
    // The server sets requires_confirmation from the step's side_effect; the
    // daemon decides via its onConfirmationRequired hook.
    const srv = await startTestServer({ planner: [resetStep, candidate] });
    const daemon = await ClientDaemon.connect({
      url: srv.url, credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "e2e", platform: "test" }, workspaceRoot: process.cwd(),
      ledger: openLedger(":memory:"),
      onConfirmationRequired: async () => true,
    });
    const c = daemon.connection;
    let workflowId = "";
    c.on("workflow.created", (env) => { workflowId = (env.payload as { workflow_id: string }).workflow_id; });
    c.on("workflow.completion_candidate", () => c.send("workflow.completion_response", { workflow_id: workflowId, resolution: "solved" }));

    const terminated = await new Promise<Record<string, unknown>>((resolve) => {
      c.on("workflow.terminated", (env) => resolve(env.payload as Record<string, unknown>));
      c.send("workflow.request", { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } });
    });
    expect(terminated.terminal_state).toBe("COMPLETED");

    const recordId = terminated.record_id as string;
    const record = await new Promise<Record<string, any>>((resolve) => {
      c.on("record.get_response", (env) => resolve(env.payload as Record<string, any>));
      c.send("record.get_request", { record_id: recordId });
    });
    expect(record.record.final_result.resolution).toBe("controlled_execution");
    expect(record.record.entries.map((e: { kind: string }) => e.kind)).toContain("step_dispatched");

    await daemon.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/controlledExecution.e2e.test.ts`
Expected: FAIL（闭环尚未成立 / Record 形态不符）

- [ ] **Step 3: 实现（补齐缺口）**

修正暴露的缺口直到闭环成立；**不得**为过测试放宽 Server 侧校验。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/controlledExecution.e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/test/controlledExecution.e2e.test.ts packages/client-daemon/src
git commit -m "test(daemon): controlled execution, decline, timeout and idempotency end to end"
```

---

### Task 10: 文档同步（CAPABILITY_SPEC / README）

**Files:**
- Modify: `docs/specs/CAPABILITY_SPEC.md`（§5.3 登记 `terminal.execute_command` / `sim_rig.query_state`；§6 注明 `human.manual_action` 已由 client-daemon 实现；§7 移除/更新占位与建议路径待补项）→ v0.7 → **v0.8**
- Modify: `docs/REQUIREMENTS.md` §7 影响表版本引用
- Modify: `README.md`（当前状态补 P4a）

**Interfaces:**
- Consumes: Task 1–9
- Produces: 文档与实现一致

- [ ] **Step 1: 改 `CAPABILITY_SPEC.md`**

页首 `Version` → `v0.8`，变更记录：登记 `terminal.execute_command`（input `{command, args?}` / output `command_result {exit_code, stdout?}`，`side_effect: true`）与 `sim_rig.query_state`（MVP 模拟对账能力，output `reset_state {reset_applied}`）；§6 注明 `human.manual_action` 的建议路径已由 client-daemon 实现；§7 更新"建议路径未实现"待补项。

- [ ] **Step 2: 同步交叉引用与 README**

`REQUIREMENTS.md` §7 的 `CAPABILITY_SPEC.md` 行更新为 v0.8 并补本次登记；`README.md` 当前状态补 P4a 一行。

- [ ] **Step 3: 验证**

Run: `grep -n "Version:" docs/specs/CAPABILITY_SPEC.md`
Expected: 显示 `v0.8`

- [ ] **Step 4: 提交**

```bash
git add docs/ README.md
git commit -m "docs: register side-effect capabilities and P4a status"
```

---

## Self-Review

**1. Spec coverage：** 确认流程 → T6；超时分流（只读/副作用/人类等待豁免）→ T2/T3；`UNKNOWN` 与对账收敛 → T2/T4；`idempotency_key` 生成与台账 → T1/T8；`human.manual_action` 建议路径 → T6/T7；副作用能力 → T7；Record 忠实（threshold / user_input / evidence_refs）→ T4/T5；护栏与取消语义沿用 P2a。**刻意留给后续**：blob（P4b）、KB 导出（P4c）、受控执行 UI、真实 Windows 产品适配器。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支。

**3. Type consistency：** `StepSnapshot.updatedAt/timeoutMs`、`NewStep.timeoutMs`、`engine.timeoutStep`、`StepTimeoutMonitor`、`PlannerDecision.reconcile`、`engine.reconcileUnknown(…, evidenceRefs?)`、`StepRunnerDeps.onConfirmationRequired/onUserInput/ledger`、`Ledger`/`openLedger`、`simRigTriggerReset`/`simRigQueryState`/`terminalExecuteCommand` 在 T1–T8 定义并同名复用。

**4. Review Focus：** 五条风险落到测试——(1) 需确认的 Step 不自动执行 → T6；(2) 超时分流 → T2/T3；(3) 对账收敛与 `evidence_refs` → T4；(4) 幂等不重复执行 + 跨重启 → T8；(5) Record 忠实 → T5。

**5. Proportion：** 计划只描述决策、接口与断言；实现体只写"签名 + 关键分支"。

## 移交后续计划的待办

1. **P4b**：blob 通道（`blob.allocate_request/response`、`BlobStore`、`content_ref`、白名单/尺寸）。
2. **P4c**：KB 导出（ADR-005 出站、配置端点/凭据/超时、退避重试）。
3. **受控执行 UI**：本阶段的确认/输入回调是宿主接口，真正的 UI 交互归 client-ui/Electron。
4. **`CANCELLING` 期间对账**：P2a 已定"不对账"，P4a 的 sweep 需继续遵守（超时不对 `CANCELLING` 的 Step 生效——实现时以 `engine.timeoutStep` 的行为为准）。

## 后续

P4a 验收通过后写 **P4b（blob 通道）**，再写 **P4c（KB 导出）**。

---

## 执行偏差（Execution deviations）

计划在执行中暴露了若干**必须补上才能成立**的点，逐条记录，供 review 与后续计划参考：

1. **`engine.applyStepStatus` 的主体抽成私有 `applyStatus`。** `timeoutStep` 必须在 workflow 锁内复用同一套「写 Step + 发事件 + `CANCELLING` 收敛」，而 `withWorkflowLock` 是 per-workflow 串行链——在锁内再调 `applyStepStatus` 会**重入死锁**。
2. **Engine 与 `StepTimeoutMonitor` 必须共用同一个时钟。** test-support 的 engine 用 `Date.now()`，monitor 默认 `performance.now()`，两者相减会得到巨大的负数/正数，超时永不触发（或立刻触发）。现在 `index.ts` / `test-support` 显式把同一个 `now` 传给两者；这个 bug 是 Task 3 的集成测试抓到的。
3. **新增 `StepTimeoutMonitor.deps.onStepEnded` + `registerWorkflowProtocol` 返回 `WorkflowProtocolHandle.advance(workflowId)`。** 超时是**服务端计时器**触发的，不经过任何客户端消息；没有这条推进路径，超时后的 Step 永远到不了对账。`advance` 在会话无活连接时仍会推进（对账与终态是服务端职责）。
4. **`orchestrator.advance` 处理 `reconcile` 后递归推进。** 对账只把一个 UNKNOWN Step 收敛掉，本身不是"下一个 Step"；不继续推进的话 Workflow 会停在"无活跃 Step"的状态直到下一条客户端消息。递归有界：每轮消耗一个 UNKNOWN，对非 UNKNOWN 的 Step 对账会抛错。
5. **State 机补齐两条 spec 边（P2a 遗漏）：`WAITING → REJECTED` 与 `PENDING → UNKNOWN`。** `WORKFLOW_SPEC.md` §4.2 明确写 `PENDING → WAITING(user_confirmation) → REJECTED(user_declined)`，§4.3 明确写 `PENDING / RUNNING → UNKNOWN`；没有第一条边，工程师拒绝确认时状态更新会被静默忽略，Workflow 卡死（这正是 Task 9 E2E 第一次跑超时的原因）。
6. **LLM planner 增加 `action=reconcile` 工具（计划未写）。** 计划把裁定权放在 `Planner` 接缝（正确），但只加了 `PlannerDecision` 变体；真实生产用的是 `LlmPlanner`，没有对应工具的话 `UNKNOWN` 在生产路径上**永远无人收敛**。现在 prompt、工具 schema、上下文里的 UNKNOWN 清单与「只能对账 UNKNOWN」校验都补齐了。
7. **`confirmCompletion` 的护栏触发路径补发 `guardrail_triggered` 事件。** 原先只有 dispatch 路径发事件，于是"工程师一直说未解决"触顶导致的 FAILED 在 Record 里看不到护栏条目，`threshold` 也就无从谈起。
8. **`node:sqlite` 用 `createRequire` 运行时加载。** Vite 5 从 `module.builtinModules` 里过滤掉任何含 `:` 的项（Node 只在 `node:sqlite` 前缀下暴露该模块），静态 `import` 会让 **测试 runner 直接挂掉**；`ssr.external` / 自定义 resolve 插件都无效。运行时 `require` 绕开静态解析，且生产环境（tsc 产物）同样成立。
9. **`terminal.execute_command` 的非零退出码记 `COMPLETED`。** 命令确实跑了，`exit_code` 正是 schema 承诺要报告的观察；只有"没能运行"才是 `FAILED`。已在 `CAPABILITY_SPEC.md` §5.3 澄清。
10. **`@adt/client-daemon` 增加 `@adt/server` 作为 devDependency。** E2E 直接引用 Server 的 `Planner` / `PlannerDecision` 类型；此前只有 vitest 的 alias 能解析，`tsc --noEmit` 通不过。
11. **两处既有测试随语义更新**：`stepRunner.test.ts` 的"需确认 Step"现在断言 `WAITING → REJECTED`（原断言只看第一条消息）；`descriptors.test.ts` / `defaultRegistry.test.ts` 的"全部只读"断言改为**列出副作用能力集合**（原来断言 `every(side_effect === false)`，与新增副作用能力天然冲突）。

## 复核结论（Self-check，执行后）

- `pnpm -r --if-present test`：shared 13 · server 193（+1 skipped real-LLM）· client-daemon 54 → **260 passed / 1 skipped**。
- `pnpm -r --if-present typecheck`：干净。
- Review Focus 五条均有对应测试：T6 / T2+T3 / T4 / T8（含跨进程重开）/ T5；另有 Task 9 的四条端到端（确认执行、拒绝重规划、超时对账、resume 同键重发）。

---

## Review 修复轮（Review fix pass）

整分支 fresh review 的结论是 **不可直接合并**，其中一条阻塞项与若干非阻塞项已在同一分支上修复（仍未合并）：

**阻塞项 B1 — `WORKFLOW_SPEC.md` §4.3 的"副作用阻塞规则"此前无人执行。**
规格原文："当一个 Workflow 内存在未对账的 `UNKNOWN` 时，Server **禁止再下发其它副作用 Step**（只读 Step 与对账 Step 允许）。" P4a 恰好让 `UNKNOWN` 从"客户端的罕见路径"变成"服务端计时器的常规路径"，因此在这一阶段补齐：
* `engine.dispatchStep` 增加确定性守卫：存在 `UNKNOWN` 时拒绝副作用 Step，抛 `WorkflowBlockedError`，不产生任何状态变更。
* `orchestrator.advance` **在存在 `UNKNOWN` 时把副作用能力从规划器可选能力里摘掉**（主要防线，规格即以"不许选"表达），并把违反这条规则的规划器输出转为确定性的 `FAILED(planner_error)`——沿用既有"不可用的规划器输出 = 确定性失败，绝不悬挂"约定，而不是让 Workflow 停住。

**非阻塞项修复：**
* **N1 期限跨重启失效**：`updatedAt` 改为**墙钟**（`EngineDeps.wallClock`，默认 `Date.now`），事件/Workflow 的排序时间戳仍用单调的 `now`；`StepTimeoutMonitor` 的注入项由 `now` 更名为 `clock` 并要求传入引擎同款墙钟（原来的默认值 `performance.now()` 正是这个坑）。持久化的 `performance.now()` 对下一个进程没有意义。
* **N2 重复 `RUNNING`/`progress` 不重置计时器**：`StepStatusUpdate` 的 `RUNNING` 变体带上可选 `progress`；`applyStepStatus` 对"重复 `RUNNING`"执行保活（刷新 `updatedAt` 并发一条 `step_status` 事件，不做状态转换），落实 `PROTOCOL_SPEC.md` §9 的"任意 `step.status` 重置计时器"。
* **N3 建议路径在生产规划器下不可达**：保留能力 `human.manual_action` 与其 I/O schema 移入 `@adt/shared`（协议级保留名），编排层把它补进规划器可选能力——否则 `CAPABILITY_SPEC.md` §6 声明的"所有 Client 隐式支持"永远没有入口。新增端到端用例覆盖"指令进去、工程师反馈出来、Record 落 `user_input`"。
* **N4 "没能运行"被记成 `COMPLETED(exit_code:-1)`**：`CommandResult` 增 `failure: "timeout" | "spawn"`（仅当进程没有给出正常退出码时设置），`terminal.execute_command` 据此记 `FAILED(timeout)` / `FAILED(capability_error)`；非零**退出码**仍是 `COMPLETED` 的观察。
* **N5 对账可以不带证据**：`PlannerDecision.reconcile.evidenceRefs` 改为**必填**，`engine.reconcileUnknown` 拒绝空引用（`WORKFLOW_SPEC.md` §4.3"证据不足时退回工程师确认"），LLM 工具 schema 同步标记为 required。
* **N6 `SPEC_VERSIONS.capability_spec` 仍是 `0.7`**：随 v0.8 更正。
* **N7 健壮性**：台账读到损坏 JSON 视为"无记录"并告警（不再让整个 Step 卡住）；`StepTimeoutMonitor.sweep` 增加在途保护（避免两次扫描对同一 Step 重复推进）；`ClientDaemon.connect` 握手失败时关闭自己创建的台账。

**本轮明确不做（记录为后续）：**
* **`WORKFLOW_SPEC.md` §4.4 会话级副作用串行**（同一 `session` 内最多一个活跃副作用 Step）仍只有"每 Workflow 单步"这一层；跨 Workflow 的排队属于 P4b 的编排工作。
* **正向 `user_confirmation`（confirmed）Record 条目**：确认目前只体现为 `RUNNING` + 后续证据，`RECORD_SPEC.md` §4 的 `decision: "confirmed"` 尚未单独落条目（P2b 起既有）。
* **真实确认 UI**：宿主回调即本阶段交付面，交互界面归 client-ui。
