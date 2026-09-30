# P4b 资源冲突如实上报与终结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"资源被占用"这件事由**能力提供方**判断并如实上报：工程师能腾出资源 → Workflow 继续、不留痕；腾不出 → Workflow 明确结束，Record 说明"设备被占用"。

> **编号说明：** 原定 P4b=blob 通道。按前置要求把本阶段（资源冲突）插到前面：**blob 顺延为 P4c、KB 导出顺延为 P4d**。

**Architecture:** 三处改动，各归其位。**协议层**把 `resource_conflict` 登记为人类等待语义——否则工程师腾设备期间 `step_timeout` 到点，会把一个**根本没发生**的副作用 Step 判成 `UNKNOWN`，凭空启动对账。**客户端**由 Runner（而非适配器）承担与人的交互，与 `onConfirmationRequired` 同构：适配器返回 `rejected(resource_conflict)` 时，Runner 先报 `WAITING`（停表），问工程师"等还是停"，"等"就重试直到不再冲突，"停"就报 `REJECTED(resource_conflict)`。**编排层**见到这个码就不再重规划，直接 `engine.fail(workflow_id, "resource_conflict")` —— 不允许模型换一个能力把问题绕过去。

**Tech Stack:** TypeScript（strict）· Node.js LTS · PostgreSQL（`pg`）· Vitest · pnpm workspace（沿用 P1–P4a 结构）

**Spec:** `docs/specs/PROTOCOL_SPEC.md`（v0.7 §8 `step.status`、§9 人类等待豁免、§12 错误码）、`docs/specs/WORKFLOW_SPEC.md`（v0.5 §2 `terminal_reason` 枚举、§4.4 会话级副作用串行、§6.1 建议路径）、`docs/specs/CAPABILITY_SPEC.md`（v0.8 §2 声明、§7 待补项）、`docs/specs/RECORD_SPEC.md`（v0.7 §3 `final_result`、§4 `step_rejected`）、`docs/REQUIREMENTS.md`（NFR-4、A-2、FR-7）

## Global Constraints

- **Server 不做资源仲裁**（本阶段确立）：不排队、不建资源模型、不新增协议消息、不新增终态、不新增 Record 条目 kind。资源占用由**能力提供方**判断并如实上报。
- **人类等待豁免必须包含 `resource_conflict`**（`PROTOCOL_SPEC.md` §9）：人类等待不计入 `step_timeout`。这是本阶段最关键的一行——不加它，"等设备"会被判超时。
- **两条分支，界限分明**：
  - 能解决 → 继续执行，**不落任何 Record 条目**（用户明确的取舍：Record 记问题与结局，不记过程中的磕碰）；
  - 不能解决 → Workflow 终止为 **`FAILED` + `terminal_reason = "resource_conflict"`**，Record 以 `step_rejected` 条目 + 可读的 failure 说明点明"设备被占用"。
- **只认这一个码**：只有 `reject_reason.code === "resource_conflict"` 触发终结；`capability_unavailable` / `invalid_input` / `user_declined` 等一律照旧走重规划。
- **拒绝原因只存在事件日志里**（`StepSnapshot` 没有 reject reason 字段）→ 编排层从 `events` 里读，不改表、不加列。
- **取消意图仍优先**（`WORKFLOW_SPEC.md` §2.1）：`CANCELLING` 中触发本终结 → 仍收敛为 `CANCELLED`（沿用 `engine.fail` 既有行为，不要"修正"它）。
- **不碰 §4.3**：同一 Workflow 内 `UNKNOWN` 阻塞副作用是"我方知识状态"问题（P4a 已实现），与本阶段的"资源占用"是两件事，不要合并。
- **文档纪律**：`WORKFLOW_SPEC.md` v0.5 → **v0.6**（§2 增 `resource_conflict`、§4.4 改写）、`PROTOCOL_SPEC.md` v0.7 → **v0.8**（§9 人类等待列表 + §8 冲突流程）、`CAPABILITY_SPEC.md` v0.8 → **v0.9**（§7 提供方契约）、`docs/REQUIREMENTS.md` §7 引用同步。

## Review Focus

以下失败模式规格隐含、但默认的测试不会覆盖，**每条都必须在对应任务里有测试**：

1. **等待期间被判超时**：`resource_conflict` 若未进人类等待集合，工程师腾设备的几十秒会被 `step_timeout` 判成 `FAILED(timeout)`/`UNKNOWN`（Task 1）。
2. **能解决却没继续**：工程师说"等"之后必须真的重试到成功；Workflow 不能因为一次冲突就结束（Task 3）。
3. **误终结**：其他拒绝原因必须照旧重规划，不能被顺带终结（Task 2）。
4. **停机信号丢失**：工程师说"不等"时，Record 必须能读出"设备被占用"，而不是只看到一个裸码或"工程师拒绝"（Task 3 + Task 4）。
5. **闭环不悬挂**：终结路径必须真的终结并落到 Record（不是停在无活跃 Step 的 `RUNNING`）（Task 2 + Task 5）。

---

### Task 1: `resource_conflict` 是"人类等待"，不许被超时杀掉

**Files:**
- Modify: `packages/server/src/protocol/workflowProtocol.ts`（`toStepStatusUpdate` 的 `human` 判定）
- Test: `packages/server/test/protocol/toStepStatusUpdate.test.ts`（追加）、`packages/server/test/workflow/engine.timeout.test.ts`（追加）

**Interfaces:**
- Consumes: `toStepStatusUpdate(payload): StepStatusUpdate | null`（既有）；`engine.applyStepStatus` / `engine.timeoutStep`（既有）
- Produces: `WAITING{wait_reason:{code:"resource_conflict"}}` → `{ state: "WAITING", waitClass: "human" }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/toStepStatusUpdate.test.ts（追加）
it("treats a resource conflict as a human wait, so the step timer stops", () => {
  expect(
    toStepStatusUpdate({ status: "WAITING", wait_reason: { code: "resource_conflict" } }),
  ).toEqual({ state: "WAITING", waitClass: "human" });
  // Anything unrecognised stays an execution wait — do not widen the set.
  expect(toStepStatusUpdate({ status: "WAITING", wait_reason: { code: "whatever" } })).toEqual({
    state: "WAITING",
    waitClass: "execution",
  });
});
```

```ts
// packages/server/test/workflow/engine.timeout.test.ts（追加）
it("does not time out a step parked on a resource conflict", async () => {
  const wf = await create();
  const step = await engine.dispatchStep(wf.id, {
    objective: "reset",
    capability: "sim_rig.trigger_reset",
    sideEffect: true,
    interruptible: false,
    timeoutMs: 1000,
  });
  await engine.applyStepStatus(
    wf.id,
    step.id,
    toStepStatusUpdate({ status: "WAITING", wait_reason: { code: "resource_conflict" } })!,
  );

  // Long past the deadline: a human wait has no deadline, and turning this into
  // UNKNOWN would start reconciliation for an action that never happened.
  t = 99_999;
  await engine.timeoutStep(wf.id, step.id);
  expect((await store.getStep(step.id))!.state).toBe("WAITING");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/toStepStatusUpdate.test.ts test/workflow/engine.timeout.test.ts`
Expected: FAIL（`resource_conflict` 被判为 `execution`，因此被超时成 `UNKNOWN`）

- [ ] **Step 3: 实现**

在 `toStepStatusUpdate` 的人类等待判定里加入 `resource_conflict`（现在是 `code === "user_input" || code === "user_confirmation"` 的表达式），并紧跟一行注释说明理由（人类的决定，不是执行等待）。测试文件需要 `import { toStepStatusUpdate } from "../../src/protocol/workflowProtocol";`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/ test/workflow/engine.timeout.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/protocol/workflowProtocol.ts packages/server/test/protocol/toStepStatusUpdate.test.ts packages/server/test/workflow/engine.timeout.test.ts
git commit -m "feat(protocol): treat a resource conflict as a human wait"
```

---

### Task 2: 编排层：`resource_conflict` 拒绝 → 终结 Workflow

**Files:**
- Modify: `packages/server/src/workflow/orchestrator.ts`
- Test: `packages/server/test/workflow/orchestrator.resourceConflict.test.ts`（新建）

**Interfaces:**
- Consumes: `store.listEvents`（既有）、`engine.fail(workflowId, reason)`（既有，写入 `FAILED` + `terminalReason`）、`engine.applyStepStatus`（用来造出真实的拒绝事件）
- Produces: `advance` 在咨询规划器**之前**先判定：若任一 `step_status` 事件的 `state === "REJECTED"` 且 `rejectReason.code === "resource_conflict"` → `engine.fail(workflowId, "resource_conflict")` 并返回 `{}`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/orchestrator.resourceConflict.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowOrchestrator, type PlannerDecision } from "../../src/workflow/orchestrator";
import type { Planner } from "../../src/workflow/planner";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE workflows, workflow_steps, workflow_events"); });
afterAll(async () => { await pool.end(); });

const open = { mode: "open" as const, revision: 0 };
const sideEffect = { objective: "复位测试台", capability: "sim_rig.trigger_reset", sideEffect: true, interruptible: false };

/**
 * The real sequence for a provider that finds the resource busy while
 * executing: RUNNING → WAITING(human) → REJECTED. A rejection is never legal
 * straight out of RUNNING, and the engine silently ignores illegal transitions
 * — so a test that skipped the wait would prove nothing.
 */
async function conflictRejectedWorkflow(engine: WorkflowEngine): Promise<string> {
  const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
  const step = await engine.dispatchStep(wf.id, sideEffect);
  await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
  await engine.applyStepStatus(wf.id, step.id, { state: "WAITING", waitClass: "human" });
  await engine.applyStepStatus(wf.id, step.id, {
    state: "REJECTED",
    rejectReason: { code: "resource_conflict", message: "测试台正被占用" },
  });
  return wf.id;
}

/** Any other rejection (e.g. an undeclared capability) happens before RUNNING. */
async function otherRejectedWorkflow(engine: WorkflowEngine): Promise<string> {
  const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
  const step = await engine.dispatchStep(wf.id, sideEffect);
  await engine.applyStepStatus(wf.id, step.id, {
    state: "REJECTED",
    rejectReason: { code: "capability_unavailable" },
  });
  return wf.id;
}

function orchestratorWith(engine: WorkflowEngine, store: PostgresWorkflowStore, onPlanned: () => void) {
  const planner: Planner = {
    initialCriteria: async () => open,
    proposeNext: async (): Promise<PlannerDecision> => {
      onPlanned();
      return { kind: "completion_candidate", summary: "还在跑", evidenceRefs: [] };
    },
  };
  return new WorkflowOrchestrator({ engine, store, planner, capabilitiesOf: () => [] });
}

describe("resource conflict ends the workflow", () => {
  it("fails the workflow with terminal_reason=resource_conflict and never re-plans", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const workflowId = await conflictRejectedWorkflow(engine);

    let planned = 0;
    const orch = orchestratorWith(engine, store, () => { planned++; });
    expect(await orch.advance(workflowId)).toEqual({});

    const after = (await engine.get(workflowId))!;
    expect(after.state).toBe("FAILED");
    expect(after.terminalReason).toBe("resource_conflict");
    expect(planned).toBe(0);
  });

  it("keeps re-planning for any other reject reason", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const workflowId = await otherRejectedWorkflow(engine);

    let planned = 0;
    const orch = orchestratorWith(engine, store, () => { planned++; });
    await orch.advance(workflowId);

    expect(planned).toBe(1);
    expect((await engine.get(workflowId))!.state).toBe("RUNNING");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.resourceConflict.test.ts`
Expected: FAIL（第一个用例：Workflow 仍在 `RUNNING`、`planned === 1`）

- [ ] **Step 3: 实现**

在 `advance` 里，取到 `events` 之后、咨询规划器之前插入判定：从 `events` 里找 `kind === "step_status"`、payload `state === "REJECTED"` 且 `(payload.rejectReason as {code?: string}).code === "resource_conflict"` 的事件；命中则 `console.warn` 一行（说明是哪个 workflow / 哪个 step）、`await this.deps.engine.fail(workflowId, "resource_conflict")`、`return {}`。判定要**同时**满足 `state === "REJECTED"`，避免任何其它事件误伤。注意保持既有：`CANCELLING` 中 `engine.fail` 会收敛成 `CANCELLED`（不要绕开 `engine.fail` 自己写终态）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.resourceConflict.test.ts test/workflow/`
Expected: PASS（含既有编排测试回归）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/orchestrator.ts packages/server/test/workflow/orchestrator.resourceConflict.test.ts
git commit -m "feat(workflow): end the workflow when a provider reports a resource conflict"
```

---

### Task 3: 客户端：冲突时报 `WAITING` 并问工程师，能解决就继续

**Files:**
- Modify: `packages/client-daemon/src/stepRunner.ts`、`packages/client-daemon/src/daemon.ts`
- Test: `packages/client-daemon/test/stepRunner.resourceConflict.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `attachStepRunner` 的执行结果分支（`result.status === "rejected"` → `REJECTED(reject_reason)`）
- Produces:
  - `StepRunnerDeps.onResourceConflict?: (request: { workflowId; stepId; capability; objective; message?: string }) => Promise<"wait" | "stop">`
  - 行为：适配器返回 `{status:"rejected", code:"resource_conflict", message?}` → 先发 `WAITING{wait_reason:{code:"resource_conflict"}}` → 调 `onResourceConflict`；`"wait"` → 重发 `RUNNING` 并**重新执行**（再次冲突则再问）；`"stop"` 或**没有 hook** → `REJECTED{reject_reason:{code:"resource_conflict", message?}}`
  - `ClientDaemonOptions` 透传该回调

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/stepRunner.resourceConflict.test.ts
import { describe, it, expect } from "vitest";
import { attachStepRunner, type StepRunnerDeps } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { ExecutionResult } from "../src/capability/result";

function harness(
  results: ExecutionResult[],
  hooks: Partial<StepRunnerDeps> = {},
) {
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  let runs = 0;
  const registry = new CapabilityRegistry();
  registry.register({
    spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
    execute: async () => {
      runs++;
      return results[Math.min(runs - 1, results.length - 1)]!;
    },
  });
  attachStepRunner({
    connection: {
      on: (type, handler) => { handlers.set(type, handler); },
      send: (_type, payload) => { sent.push({ payload: payload as Record<string, unknown> }); },
    },
    registry,
    workspaceRoot: "/ws",
    onConfirmationRequired: async () => true,
    ...hooks,
  });
  return {
    sent,
    dispatch: (payload: Record<string, unknown>) => handlers.get("step.dispatch")!({ payload }),
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
    get runs() { return runs; },
  };
}

const dispatch = {
  workflow_id: "wf_1",
  step_id: "step_1",
  objective: "复位测试台",
  capability: "sim_rig.trigger_reset",
  input: {},
  requires_confirmation: true,
  idempotency_key: "idem_1",
};

const conflict: ExecutionResult = { status: "rejected", code: "resource_conflict", message: "测试台正被占用" };
const ok: ExecutionResult = { status: "completed", type: "reset_ack", result: { reset_ack: true } };

describe("resource conflict on the client", () => {
  it("stops when the engineer says not to wait, keeping the reason", async () => {
    const h = harness([conflict], { onResourceConflict: async () => "stop" });
    h.dispatch(dispatch);
    await h.settle();

    expect(h.sent.map((s) => s.payload.status)).toEqual([
      "WAITING", "RUNNING", "WAITING", "REJECTED",
    ]);
    expect(h.sent[2]!.payload.wait_reason).toEqual({ code: "resource_conflict" });
    expect(h.sent[3]!.payload.reject_reason).toEqual({
      code: "resource_conflict",
      message: "测试台正被占用",
    });
  });

  it("retries after the engineer frees the resource, and the workflow continues", async () => {
    const h = harness([conflict, ok], { onResourceConflict: async () => "wait" });
    h.dispatch(dispatch);
    await h.settle();

    expect(h.runs).toBe(2);
    expect(h.sent.map((s) => s.payload.status)).toEqual([
      "WAITING", "RUNNING", "WAITING", "RUNNING", "COMPLETED",
    ]);
    expect(h.sent[4]!.payload.evidence).toMatchObject({ type: "reset_ack" });
  });

  it("stops when there is nobody to ask", async () => {
    const h = harness([conflict]); // no hook
    h.dispatch(dispatch);
    await h.settle();

    expect(h.runs).toBe(1);
    expect(h.sent.map((s) => s.payload.status)).toEqual([
      "WAITING", "RUNNING", "WAITING", "REJECTED",
    ]);
  });

  it("leaves other rejections alone", async () => {
    const h = harness([{ status: "rejected", code: "invalid_input", message: "bad" }], {
      onResourceConflict: async () => "wait",
    });
    h.dispatch(dispatch);
    await h.settle();

    expect(h.sent.map((s) => s.payload.status)).toEqual(["WAITING", "RUNNING", "REJECTED"]);
    expect(h.sent[2]!.payload.reject_reason).toEqual({ code: "invalid_input", message: "bad" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.resourceConflict.test.ts`
Expected: FAIL（没有 `onResourceConflict`，冲突直接当普通拒绝处理）

- [ ] **Step 3: 实现**

在 `stepRunner.ts` 的执行结果分支里，把 `result.status === "rejected" && result.code === "resource_conflict"` 单独处理：先 `send("WAITING", { wait_reason: { code: "resource_conflict" } })`，再 `await` 交互钩子（沿用文件里既有的 `ask()` 包装以 fail-closed、并吞掉钩子抛错）；`"wait"` → `send("RUNNING")` 并**回到执行步骤重跑适配器**（用一个循环包住"执行 + 结果判定"，冲突分支 `continue`）；`"stop"`/无 hook → `send("REJECTED", { reject_reason: { code: "resource_conflict", ...(message ? { message } : {}) } })`。`daemon.ts` 的 `ClientDaemonOptions` 增加同名可选回调并透传。

> 注意顺序：确认（`requires_confirmation`）发生在**执行之前**，冲突发生在**执行时**，所以正常序列是 `WAITING(user_confirmation) → RUNNING → WAITING(resource_conflict) → …`；测试里断言的是后半段。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.resourceConflict.test.ts test/stepRunner.confirm.test.ts test/stepRunner.idempotency.test.ts`
Expected: PASS（既有确认/幂等测试不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/stepRunner.ts packages/client-daemon/src/daemon.ts packages/client-daemon/test/stepRunner.resourceConflict.test.ts
git commit -m "feat(daemon): ask the engineer when a resource is busy, and only stop if they cannot free it"
```

---

### Task 4: Record 说人话：拒绝原因与终结原因

**Files:**
- Modify: `packages/server/src/record/builder.ts`
- Test: `packages/server/test/record/builder.test.ts`（追加）

**Interfaces:**
- Consumes: `renderNarrative`（既有）、`buildRecord`（既有）
- Produces:
  - `step_rejected` 的 narrative：`reject_reason.message` 存在时用它（"未执行 X：<message>。"），否则维持"（原因 <code>）"
  - `FAILED` 的 `result_short`/`failure_summary`：`terminal_reason` 命中已知码时用可读文案（`resource_conflict` → "设备或资源被占用"）；`terminal_reason` 字段本身仍保留裸码（机器可读）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/record/builder.test.ts（追加）
it("explains a resource conflict in the engineer's terms", () => {
  const record = buildRecord({
    workflow: { ...workflow, state: "FAILED", terminalReason: "resource_conflict" },
    steps: [step({ state: "REJECTED" })],
    events: [
      ev("workflow_created", { request: { text: "x" } }),
      ev("step_status", {
        stepId: "step_1",
        state: "REJECTED",
        rejectReason: { code: "resource_conflict", message: "测试台正被占用" },
      }),
    ],
    userRequest: { text: "x" },
    recordId: "rec_conflict",
  });

  const rejected = record.entries.find((entry) => entry.kind === "step_rejected")!;
  expect(rejected.narrative).toContain("测试台正被占用");
  // Machine-readable code stays on the workflow; humans get the sentence.
  expect(record.terminal_reason).toBe("resource_conflict");
  expect((record.final_result as { failure_summary: string }).failure_summary).toContain("占用");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/record/builder.test.ts`
Expected: FAIL（narrative 仍是"（原因 resource_conflict）"，failure_summary 是"无法继续：resource_conflict"）

- [ ] **Step 3: 实现**

在 `builder.ts` 里：`renderNarrative` 的 `step_rejected` 分支优先用 `ref.reject_reason.message`；`FAILED` 的 `resultShort` 之前加一张极小的码 → 文案表（只登记 `resource_conflict` 一项，未登记的回落到裸码），文案含"占用"二字以对齐工程师的说法。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/record/builder.test.ts test/record/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/record/builder.ts packages/server/test/record/builder.test.ts
git commit -m "feat(record): say 'the resource is busy' in the engineer's words"
```

---

### Task 5: 端到端：先问人、等得住、最后终结且落 Record

**Files:**
- Test: `packages/server/test/protocol/resourceConflict.e2e.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1–4；`startTestServer`（`stepTimeoutMs` / `timeoutSweepIntervalMs`）、`TestClient`
- Produces: 验收——`WAITING(resource_conflict)` 期间**不被超时杀掉**；随后 `REJECTED(resource_conflict)` 使 Workflow `FAILED(resource_conflict)`，Record 里有 `step_rejected` 条目与可读的 failure 说明

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/resourceConflict.e2e.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

describe("resource conflict end to end", () => {
  it("waits without timing out, then ends the workflow with the reason on record", async () => {
    const srv = await startTestServer({
      stepTimeoutMs: 50,
      timeoutSweepIntervalMs: 20,
      planner: [
        {
          kind: "step",
          step: {
            objective: "复位测试台",
            capability: "sim_rig.trigger_reset",
            sideEffect: true,
            interruptible: false,
          },
        },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_conflict",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    const dispatch = await c.next();
    const stepId = (dispatch.payload as { step_id: string }).step_id;

    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "WAITING",
        wait_reason: { code: "resource_conflict" },
      },
    });

    // Well past the 50ms step timeout: a human wait must not be killed.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await srv.engine.getStep(stepId))!.state).toBe("WAITING");

    const terminated = await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "REJECTED",
        reject_reason: { code: "resource_conflict", message: "测试台正被占用" },
      },
    });

    expect(terminated.type).toBe("workflow.terminated");
    expect(terminated.payload).toMatchObject({
      terminal_state: "FAILED",
      terminal_reason: "resource_conflict",
    });

    const recordEnv = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: (terminated.payload as { record_id: string }).record_id },
    });
    const record = (recordEnv.payload as { record: Record<string, unknown> }).record;
    expect(
      (record.entries as Array<{ kind: string }>).map((entry) => entry.kind),
    ).toContain("step_rejected");

    await c.close();
    await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/resourceConflict.e2e.test.ts`
Expected: FAIL（`WAITING` 被 50ms 后的扫描判成 `FAILED(timeout)`，或终结未发生）

- [ ] **Step 3: 实现（补齐缺口）**

修正暴露的缺口直到闭环成立；**不得**为过测试放宽 Server 侧校验，也不得绕开 `engine.fail` 自己写终态。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/resourceConflict.e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/test/protocol/resourceConflict.e2e.test.ts packages/server/src
git commit -m "test(protocol): resource conflict waits, then ends the workflow on record"
```

---

### Task 6: 规格与文档同步

**Files:**
- Modify: `docs/specs/WORKFLOW_SPEC.md`（v0.5 → v0.6：§2 `terminal_reason` 枚举加 `resource_conflict`；§4.4 改写为"资源占用由能力提供方判断并如实上报，Server 不仲裁、不排队"）
- Modify: `docs/specs/PROTOCOL_SPEC.md`（v0.7 → v0.8：§9/§8 的人类等待列表加 `resource_conflict`，并在 §8 补一小段冲突流程；§12 无需新增错误码）
- Modify: `docs/specs/CAPABILITY_SPEC.md`（v0.8 → v0.9：§2 声明规则增"提供方自行判断资源占用并如实上报"——放 §2 而非 §7：这是提供方的**声明/行为规则**，§7 是"已知待补项"清单）
- Modify: `docs/REQUIREMENTS.md`（§7 引用行的版本号与说明；A-2 加注"共享测试台由提供方如实报告冲突，不建资源模型"）
- Modify: `README.md`（当前状态补 P4b）

**Interfaces:**
- Consumes: Task 1–5
- Produces: 文档与实现一致

- [ ] **Step 1: 改三份 spec**

按上面的页首 `Version` 与变更说明更新，并把人类等待列表、`terminal_reason` 枚举、§4.4 的措辞改到位。§4.4 改写后的要点：**资源占用由能力提供方判断；冲突时提供方如实上报；Server 不做仲裁、不排队、不建资源模型**；能解决则继续、不能解决则 `FAILED(resource_conflict)`。

- [ ] **Step 2: 同步交叉引用与 README**

`docs/REQUIREMENTS.md` §7 的对应行更新版本号并补一句本阶段变更；`README.md` 的"当前状态"补 P4b 一行（含两条分支的取舍）。

- [ ] **Step 3: 验证**

Run: `grep -n "Version:" docs/specs/WORKFLOW_SPEC.md docs/specs/PROTOCOL_SPEC.md docs/specs/CAPABILITY_SPEC.md`
Expected: `v0.6` / `v0.8` / `v0.9`

- [ ] **Step 4: 提交**

```bash
git add docs/ README.md
git commit -m "docs: resource conflicts are reported by providers, not arbitrated by the server"
```

---

## Self-Review

**1. Spec coverage：** 六处改动逐条落到任务——① `resource_conflict` 的人类等待语义 → T1；② `terminal_reason` 登记 → T2 + T6；③ 编排层终结 → T2；④ 可读文案 → T4；⑤、⑥ §4.4 与提供方契约改写 → T6；客户端侧的两条分支（能解决→继续 / 不能→停止）→ T3；闭环验收 → T5。**刻意不做**：资源模型、队列、新协议消息、新终态、新 Record 条目 kind、内联阈值强制（属 P4c blob）。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支，不给完整函数体。

**3. Type consistency：** `onResourceConflict`（签名含 `workflowId/stepId/capability/objective/message?`，返回 `"wait" | "stop"`）在 T3 定义并在 `daemon.ts` 同名透传；`resource_conflict` 在 T1（wait_reason）、T2（reject_reason → terminal_reason）、T3（两者）、T4（文案）中同一字符串。

**4. Review Focus：** 五条风险落到测试——(1) 等待不被超时 → T1 + T5；(2) 能解决则继续 → T3 第二条用例；(3) 误终结 → T2 第二条用例；(4) 停机信号可读 → T4 + T5；(5) 闭环不悬挂 → T2 + T5。

**5. Proportion：** 计划只写决策、接口与断言；实现体只描述"签名 + 关键分支"。

## 移交后续计划的待办

1. **P4c（blob 通道）**：双向（上传 + 下载）、签名令牌 url、`blobs` 表 + 本地 FS `BlobStore`（内容寻址）、`blob.allocate_request/response` + `blob_rejected`、Record 的 `content_ref` 往返；过期删除**只删未被 Record 引用的 blob**；内联阈值 64 KiB 只登记不强制。
2. **P4d（KB 导出）**：ADR-005 出站。
3. **重复冲突的体验**：T3 的循环由工程师逐次"等"推进；若将来出现"一直忙"的场景，再考虑退避/上限（本阶段刻意不做）。

## 后续

P4b 验收通过后写 **P4c（blob 通道）**，再写 **P4d（KB 导出）**。

---

## 执行偏差与 Review 修复轮

### 执行中发现的计划缺陷（已就地修正）

* **计划 Task 2 的测试片段用了不合法的状态迁移**：它构造 `RUNNING → REJECTED`，而状态机只允许从 `PENDING` 或 `WAITING` 拒绝（`NON_TERMINAL_EDGES.RUNNING` 不含 `REJECTED`），引擎会**静默忽略**该迁移——于是"步骤仍是活跃的"，测试会因为错误的原因而失败。已改为真实序列 `RUNNING → WAITING(human) → REJECTED`（冲突正是执行中才发现的），并把"别的拒绝"用 `PENDING → REJECTED` 构造。计划文件已同步更正。
* **Task 5 的端到端在 T1–T4 完成后一次通过**：它是装配检查（integration），不是先红后绿的单元测试。为了让它仍然有意义，已确认它确实能抓住两类回归：去掉人类等待语义 → `expect(state).toBe("WAITING")` 失败；去掉编排层终结 → 收到的不是 `workflow.terminated`。
* **提供方契约最终落在 `CAPABILITY_SPEC.md` §2 而非 §7**：§7 是"已知待补项"清单，而这是**声明/行为规则**，放 §2 才对。计划文件已同步更正。

### Review 结论

整体评审：**代码可合并**；**分支整体不可直接合并**，因为两处规范性文档仍在自相矛盾（正是本阶段要消除的漂移）。两条都是文档一行修正，代码无需改动。

**阻塞项（已修）**
* **B1**：`PROTOCOL_SPEC.md` §8 的 `reject_reason.code` 取值表**漏了 `resource_conflict`**——同文档 §8.3 又要求上报它，自相矛盾；照表校验的实现会把这个信号丢掉。已补入取值表（并补 `message` 的说明）。
* **B2**：`SERVER_SPEC.md` 的职责清单里仍写着"**保证同一 `session` 内副作用 Step 串行**"，与本分支确立的"Server 不仲裁"直接冲突。已改写为"把提供方上报的资源冲突转达工程师，并把'不能解决'变成确定性终止"。

**非阻塞项（已修）**
* **N1**：`SPEC_VERSIONS` 仍是 `workflow_spec 0.5 / capability_spec 0.8`，而两份 spec 已升到 0.6/0.9（且 builder 现在会输出新的终止原因文案）。已同步（含两处测试 fixture）。
* **N2**：`SERVER_SPEC.md` 里我引用的"v0.11"在该文档中并不存在（头部是 v0.9）。已把头部升到 **v0.10** 并把标注统一为 v0.10。
* **N3**：`ARCHITECTURE.md` 的那条 bullet 内容已改写却仍标"（v0.6 新增）"。已改为"（v0.6 新增；v0.7 更正后半句）"。
* **N4**：`hasResourceConflict` 原本排在"有活跃 Step 就返回"之后。虽然当前接线构造不出可达触发，但已**前移到最前**（读 events 之后立刻判），闭合"并发 advance 已经越过 events 读取、先派发了一个 Step"这一类，正是设计禁止的"规划器绕过冲突"。
* **N5（测试盲区）**：补了三处——① **能解决的那条分支此前只有单元测试**，现补端到端（`WAITING → RUNNING → COMPLETED`，Workflow 继续且 Record **不含** `step_rejected`）；② `CANCELLING` 收敛（取消意图优先，仍为 `CANCELLED`）；③ 重试路径不重复要确认（`confirmations === 1`）与适配器在重试时抛错 → `FAILED(capability_error)`。
* **N6**：`final_result` 里"存在未对账副作用"的提示会**盖掉** FAILED 的原因句，工程师看不到"设备被占用"。已改为 FAILED 先说原因、未对账提示作为追加（并保留其独立字段）。另外把 `step_rejected` 里内联的提供方 message 截断（80 字符）——Record 条目是日志行，不是逐字转写。
* **N7**：`engine.timeout.test.ts` 一处被编辑弄成两行合一的格式，已修。

**评审确认无遗漏**：没有其它规范性文档仍在声称 Server 排队/串行副作用（`grep` 过 串行/排队/最多一个副作用/活跃状态）；"等待后成功不留痕"与"停驻的 Step 不会被转成 `UNKNOWN`"两条主张在真实代码路径上成立。
