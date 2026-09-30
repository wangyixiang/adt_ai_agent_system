# P3a 服务端只读闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 LLM 规划器驱动一条**只读**诊断闭环：Planner 产出当前 Step / 完成候选，Server 用 Capability 的 I/O schema 双向校验，`completion_criteria` 可修订并留痕，`workflow.request` 按 `client_request_id` 幂等。

**Architecture:** LLM 只出现在一个可替换的 `LlmProvider` 之后，`Planner` 接口把"下一步做什么"与引擎隔离（复用 P2b 的接缝）。Capability 的 schema 由 Client 在 Manifest 中声明、经 `CapabilityRegistry` 进入规划与校验：Server 下发前校验 `input`，收到 Evidence 后校验 `result`。校验器是 `@adt/shared` 内手写的 JSON Schema 受限子集实现。确定性部分（校验、criteria 留痕、幂等）不依赖网络，LLM 部分默认用脚本化 fake 测试。

**Tech Stack:** TypeScript（strict）· Node.js LTS · PostgreSQL（`pg`）· Fastify + `ws` · Vitest · pnpm workspace（沿用 P1–P2c 结构）

**Spec:** `docs/specs/CAPABILITY_SPEC.md`（v0.6 §2/§3/§5：声明字段、受限子集、两端校验职责）、`docs/specs/WORKFLOW_SPEC.md`（v0.4 §3 Step schema、§5 Evidence、§7 Execution Loop、§8.1 `completion_criteria`、§13 护栏）、`docs/specs/RECORD_SPEC.md`（v0.5 §3/§4：criteria 修订历史、`step_dispatched.ref`）、`docs/specs/PROTOCOL_SPEC.md`（v0.7 §3 `client_request_id`、§7.1、§8）、`docs/adr/ADR-004-tech-stack.md`（§2 LLM：Provider 抽象 + 云端 API）、`docs/adr/ADR-002-one-step-planning.md`、`docs/adr/ADR-001-server-owns-workflow-state.md`

## Global Constraints

- **只读范围**：本阶段不执行任何副作用 Step、不做 `UNKNOWN`/对账、不做 blob、不做 KB 导出（P4）。规划器只应产出 `side_effect: false`（或 `human.manual_action`）的 Step；`sim_rig.*` / `terminal.execute_command` 等副作用能力在 P3a 不进入闭环测试。
- **schema 语言**：JSON Schema **受限子集**（`type` / `properties` / `required` / `enum` / `items` / `description` / `default`），禁止 `$ref` 与 `oneOf` / `anyOf` / `allOf` / `not`（`CAPABILITY_SPEC.md` §5.1）。
- **校验职责**（`CAPABILITY_SPEC.md` §5.2）：Server 下发前用 `input_schema` 校验 `step.dispatch.input`，**不合则不下发**；Client 返回的 `evidence.result` 不合 `output_schema` → Server 记 `FAILED`，`fail_reason.code = invalid_output` 并告警。schema 缺失时**不强校验**并告警（§5.4）。
- **ADR-001/002**：Server 是状态权威；Planner 只提"下一步/完成候选"，最终状态仍由 Workflow Engine 决定；一次只下发一个 Step。
- **LLM 接入**（`ADR-004` §2）：`LlmProvider` 抽象 + 一个 **OpenAI 兼容**实现（Chat Completions + function calling），`baseUrl` / `apiKey` / `model` 走环境变量；**默认模型 `deepseek-v4.1-flash`**。测试默认用脚本化 fake，**任何真实 LLM 调用必须由 `LLM_API_KEY` 显式开启**（否则 `describe.skipIf` 跳过）。
- **错误暴露**：LLM 输出是不可信输入。规划器产出不合 schema 的 `input`、或 LLM 调用失败，都不得让 Workflow 静默停滞或死循环；必须以确定的失败收尾（见 §Review Focus）。
- **协议版本常量 `PROTOCOL_VERSION = "0.3"` 不变**；本阶段不新增协议消息。
- **文档纪律**：改 Spec 要 bump 版本 + 写变更说明 + 同步交叉引用（见 `REQUIREMENTS.md` §7）。本阶段涉及 `RECORD_SPEC.md`（§4 的 `step_dispatched.ref` 增 `input`；§3 的 `completion_criteria` 留修订历史）与 `WORKFLOW_SPEC.md`（§2 的 `FAILED` 系统原因补 `invalid_input` / `invalid_output` / `planner_error`）。

## Review Focus

以下失败模式是 Spec 隐含但容易漏测的，**每条都必须在对应任务里有测试**：

1. **LLM 产出的 `input` 不合 schema** → Server **不得下发**该 Step，且 Workflow 以确定的 `FAILED(invalid_input)` 收尾（不是停滞、不是循环）。
2. **Evidence `result` 不合 `output_schema`** → 该 Step 记为 `FAILED(invalid_output)` 并告警，不得被当成 `COMPLETED` 接受。
3. **LLM 返回畸形 / 缺失 tool call** → 规划器不得崩溃或污染状态；失败可诊断（`FAILED(planner_error)`），且 `message_id` 去重与引擎状态不受影响。
4. **`client_request_id` 重放** → 不创建第二个 Workflow，返回此前创建的 `workflow_id`；同一 session 内有效。
5. **criteria 修订** → Record 同时保留最新 `completion_criteria` 与修订历史；第二次修订的 `revision` 单调递增。

---

### Task 1: `@adt/shared` 的受限子集 JSON Schema 校验器

**Files:**
- Create: `packages/shared/src/schema/validate.ts`
- Modify: `packages/shared/src/index.ts`（re-export）
- Test: `packages/shared/test/schema.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"`
  - `interface JsonSchema { type?: JsonSchemaType; properties?: Record<string, JsonSchema>; required?: string[]; enum?: readonly unknown[]; items?: JsonSchema; description?: string; default?: unknown }`
  - `interface SchemaValidation { valid: boolean; errors: string[] }`
  - `function validateJsonSchema(schema: JsonSchema, value: unknown): SchemaValidation`
  - `function findUnsupportedKeyword(raw: unknown): string | null`（检出 `$ref` / `oneOf` / `anyOf` / `allOf` / `not`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/test/schema.test.ts
import { describe, it, expect } from "vitest";
import { validateJsonSchema, findUnsupportedKeyword } from "../src";

describe("validateJsonSchema", () => {
  it("checks object required + property types", () => {
    const schema = {
      type: "object" as const,
      required: ["path"],
      properties: { path: { type: "string" as const } },
    };
    expect(validateJsonSchema(schema, { path: "/a" }).valid).toBe(true);
    const bad = validateJsonSchema(schema, { path: 7 });
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/path/);
    expect(validateJsonSchema(schema, {}).valid).toBe(false);
  });

  it("checks enum, items and integer vs number", () => {
    expect(validateJsonSchema({ enum: ["a", "b"] }, "a").valid).toBe(true);
    expect(validateJsonSchema({ enum: ["a", "b"] }, "c").valid).toBe(false);
    expect(validateJsonSchema({ type: "array", items: { type: "string" } }, ["x"]).valid).toBe(true);
    expect(validateJsonSchema({ type: "array", items: { type: "string" } }, [1]).valid).toBe(false);
    expect(validateJsonSchema({ type: "integer" }, 1).valid).toBe(true);
    expect(validateJsonSchema({ type: "integer" }, 1.5).valid).toBe(false);
    expect(validateJsonSchema({ type: "number" }, 1.5).valid).toBe(true);
  });

  it("rejects unsupported keywords rather than passing them silently", () => {
    expect(findUnsupportedKeyword({ oneOf: [] })).toBe("oneOf");
    const result = validateJsonSchema({ oneOf: [] } as never, {});
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unsupported/i);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/shared exec vitest run test/schema.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

按 `CAPABILITY_SPEC.md` §5.1 的受限子集实现递归校验：`type` 判定（`integer` 要求 `Number.isInteger`；`object` 排除 `null` 与数组；`array` 用 `Array.isArray`）；`required` 逐项存在；`properties` 存在时递归；`enum` 用 `includes`（`Object.is` 语义可用 `some((e) => Object.is(e, value))`）；`items` 对数组每项递归。`description` / `default` 忽略。`findUnsupportedKeyword` 递归扫描 schema 树，命中即返回关键字名；`validateJsonSchema` 首先调用它，命中则 `{ valid: false, errors: ["unsupported keyword: <kw>"] }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/shared exec vitest run test/schema.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/schema packages/shared/src/index.ts packages/shared/test/schema.test.ts
git commit -m "feat(shared): restricted-subset JSON Schema validator"
```

---

### Task 2: Step 携带 `input`（规划 → 引擎 → dispatch → Record）

**Files:**
- Modify: `packages/server/src/workflow/engine.ts`（`NewStep.input`）
- Modify: `packages/server/src/workflow/store.ts`（`StepSnapshot.input`）
- Create: `packages/server/migrations/006_step_input.sql`
- Modify: `packages/server/src/workflow/postgresStore.ts`
- Modify: `packages/server/src/protocol/workflowProtocol.ts`（`stepDispatchPayload` 用真实 `input`）
- Modify: `packages/server/src/record/builder.ts`（`step_dispatched.ref` 带 `input`）
- Test: `packages/server/test/workflow/engine.input.test.ts`（新建）、`packages/server/test/record/builder.test.ts`（追加）

**Interfaces:**
- Consumes: P2a 引擎/存储、P2b `buildRecord`
- Produces:
  - `interface NewStep { objective: string; capability: string; sideEffect: boolean; interruptible: boolean; input?: Record<string, unknown>; idempotencyKey?: string | null }`
  - `interface StepSnapshot { …existing…; input: Record<string, unknown> }`
  - `stepDispatchPayload(step)` 的 `input` 取自 `step.input`（不再是硬编码 `{}`）
  - `step_dispatched` 事件 payload 与 Record entry ref 包含 `input`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.input.test.ts
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

describe("step input", () => {
  it("persists and returns the step input", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true,
      input: { project_path: "/workspace/app" },
    });
    expect(step.input).toEqual({ project_path: "/workspace/app" });
    expect((await store.getStep(step.id))!.input).toEqual({ project_path: "/workspace/app" });
    const dispatched = (await store.listEvents(wf.id)).find((e) => e.kind === "step_dispatched")!;
    expect((dispatched.payload as { input: unknown }).input).toEqual({ project_path: "/workspace/app" });
  });
});
```

```ts
// packages/server/test/record/builder.test.ts（追加到既有 describe）
it("records the step input on the dispatched entry", () => {
  const record = buildRecord({
    workflow,
    steps: [step()],
    events: [
      ev("workflow_created", { request: { text: "svc down" } }),
      ev("step_dispatched", { stepId: "step_1", capability: "git.collect_diagnostics", input: { project_path: "/a" } }),
      ev("workflow_terminated", { state: "COMPLETED", reason: null }),
    ],
    userRequest: { text: "svc down" },
    recordId: "rec_input",
  });
  expect(record.entries[0]!.ref.input).toEqual({ project_path: "/a" });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.input.test.ts test/record/builder.test.ts`
Expected: FAIL（`input` 未持久化 / entry ref 不含 `input`）

- [ ] **Step 3: 实现**

`006_step_input.sql`：`ALTER TABLE workflow_steps ADD COLUMN input jsonb not null default '{}'::jsonb;`。`postgresStore.ts`：`StepRow.input`、`insertStep` 增列、`toStep` 映射（`row.input ?? {}`）。`engine.ts`：`NewStep.input` 可选，`dispatchStep` 建 `StepSnapshot.input = step.input ?? {}`，`step_dispatched` 事件 payload 增 `input`。`workflowProtocol.ts`：`stepDispatchPayload` 用 `step.input`。`builder.ts`：`step_dispatched` 的 ref 增 `input`（`renderNarrative` 不变）。

- [ ] **Step 4: 运行测试确认通过（含既有回归）**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.input.test.ts test/record/builder.test.ts test/protocol/workflowProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/migrations/006_step_input.sql packages/server/src/workflow/engine.ts packages/server/src/workflow/store.ts packages/server/src/workflow/postgresStore.ts packages/server/src/protocol/workflowProtocol.ts packages/server/src/record/builder.ts packages/server/test/workflow/engine.input.test.ts packages/server/test/record/builder.test.ts
git commit -m "feat(workflow): carry and persist step input end to end"
```

---

### Task 3: 引擎的确定性失败与 `fail_reason` 透传

**Files:**
- Modify: `packages/server/src/workflow/engine.ts`（`fail()`、`StepStatusUpdate` 增 `failReason`）
- Test: `packages/server/test/workflow/engine.fail.test.ts`（新建）

**Interfaces:**
- Consumes: P2a `terminate`
- Produces:
  - `WorkflowEngine.fail(workflowId: string, reason: string): Promise<WorkflowSnapshot>` —— 终态则原样返回；`CANCELLING` → `CANCELLED`（取消意图优先，沿用 `reclaimOrphan` 语义）；否则 `FAILED`，`terminalReason = reason`
  - `type StepStatusUpdate = … | { state: "FAILED"; evidence?: unknown; failReason?: { code: string; message?: string } }`
  - `step_status` 事件 payload 在 `failReason` 存在时包含它

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.fail.test.ts
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

describe("engine.fail", () => {
  it("terminates a running workflow as FAILED with the given reason", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const failed = await engine.fail(wf.id, "planner_error");
    expect(failed.state).toBe("FAILED");
    expect(failed.terminalReason).toBe("planner_error");
  });

  it("converges a CANCELLING workflow to CANCELLED", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, { objective: "r", capability: "git.collect_diagnostics", sideEffect: false, interruptible: false });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.cancel(wf.id, "abandoned");
    const failed = await engine.fail(wf.id, "planner_error");
    expect(failed.state).toBe("CANCELLED");
    expect(failed.terminalReason).toBe("abandoned");
  });

  it("records fail_reason on the step_status event", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, { objective: "r", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true });
    await engine.applyStepStatus(wf.id, step.id, { state: "FAILED", failReason: { code: "invalid_output" } });
    const event = (await store.listEvents(wf.id)).find((e) => e.kind === "step_status")!;
    expect((event.payload as { failReason: unknown }).failReason).toEqual({ code: "invalid_output" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.fail.test.ts`
Expected: FAIL（`fail` 不是函数 / `failReason` 未写入）

- [ ] **Step 3: 实现**

`fail`：`withWorkflowLock` 内 `requireWorkflow`；终态返回；`CANCELLING` → `terminate(wf, "CANCELLED", wf.terminalReason ?? "user_cancelled")`；否则 `terminate(wf, "FAILED", reason)`。`applyStepStatus` 构造 `step_status` 时，`FAILED` 分支把 `update.failReason` 放进 payload（`undefined` 不写该键）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.fail.test.ts test/workflow/engine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/engine.ts packages/server/test/workflow/engine.fail.test.ts
git commit -m "feat(workflow): deterministic fail() and fail_reason propagation"
```

---

### Task 4: Capability 进入规划器 + `input` 校验（不合则 `FAILED(invalid_input)`）

**Files:**
- Modify: `packages/server/src/workflow/planner.ts`（`PlannerInput.capabilities`）
- Modify: `packages/server/src/workflow/orchestrator.ts`（`capabilitiesOf` + 校验）
- Modify: `packages/server/src/index.ts`、`packages/test-support/src/server.ts`（构造 orchestrator 时传 `capabilitiesOf`）
- Modify: `packages/test-support/src/server.ts`（`TestServerOptions` 增 `llm?`，见 Task 9；本任务先加 `capabilitiesOf` 接线）
- Test: `packages/server/test/workflow/orchestrator.capabilities.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `validateJsonSchema`；P1 `CapabilityRegistry`/`NormalizedCapability`；Task 3 `engine.fail`
- Produces:
  - `interface PlannerInput { workflow; steps; events; capabilities: NormalizedCapability[] }`
  - `interface OrchestratorDeps { engine; store; planner; capabilitiesOf?: (sessionId: string) => NormalizedCapability[] }`（默认 `() => []`）
  - `function validateStepInput(capabilities: NormalizedCapability[], capability: string, input: unknown): string | null`（返回错误信息或 `null`）
  - `advance()`：Planner 给出 `step` 但 `input` 不合该 Capability 的 `input_schema` → 不下发，`engine.fail(workflowId, "invalid_input")`，返回 `{}`；schema 缺失 → 不校验并 `console.warn`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/orchestrator.capabilities.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowOrchestrator, type PlannerDecision } from "../../src/workflow/orchestrator";
import type { NormalizedCapability } from "@adt/shared";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE workflows, workflow_steps, workflow_events"); });
afterAll(async () => { await pool.end(); });

const readCap = (over: Partial<NormalizedCapability> = {}): NormalizedCapability => ({
  name: "git.collect_diagnostics", side_effect: false, interruptible: true, idempotent: false,
  input_schema: { type: "object", required: ["project_path"], properties: { project_path: { type: "string" } } },
  ...over,
});

function orchestrated(decisions: PlannerDecision[], capabilities: NormalizedCapability[]) {
  const store = new PostgresWorkflowStore(pool);
  const engine = new WorkflowEngine({ store, now: () => 1000 });
  const script = [...decisions];
  return {
    engine,
    store,
    orch: new WorkflowOrchestrator({
      engine, store,
      planner: { proposeNext: async () => script.shift()! },
      capabilitiesOf: () => capabilities,
    }),
  };
}

describe("planner capabilities + input validation", () => {
  it("passes the session's capabilities to the planner", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    let seen: unknown;
    const orch = new WorkflowOrchestrator({
      engine, store,
      planner: { proposeNext: async (input) => { seen = input.capabilities; return { kind: "completion_candidate", summary: "", evidenceRefs: [] }; } },
      capabilitiesOf: () => [readCap()],
    });
    await orch.advance(wf.id);
    expect(seen).toEqual([readCap()]);
  });

  it("dispatches a step whose input matches the capability schema", async () => {
    const { engine, orch } = orchestrated(
      [{ kind: "step", step: { objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true, input: { project_path: "/a" } } }],
      [readCap()],
    );
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const result = await orch.advance(wf.id);
    expect(result.dispatched!.capability).toBe("git.collect_diagnostics");
    expect(result.dispatched!.input).toEqual({ project_path: "/a" });
  });

  it("does not dispatch invalid input and fails the workflow instead", async () => {
    const { engine, store, orch } = orchestrated(
      [{ kind: "step", step: { objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true, input: { project_path: 7 } } }],
      [readCap()],
    );
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    expect(await orch.advance(wf.id)).toEqual({});
    const after = (await engine.get(wf.id))!;
    expect(after.state).toBe("FAILED");
    expect(after.terminalReason).toBe("invalid_input");
    expect(await store.listSteps(wf.id)).toHaveLength(0);
  });

  it("fails the workflow as planner_error when the planner throws", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const orch = new WorkflowOrchestrator({
      engine, store,
      planner: { proposeNext: async () => { throw new Error("llm down"); } },
      capabilitiesOf: () => [],
    });
    expect(await orch.advance(wf.id)).toEqual({});
    const after = (await engine.get(wf.id))!;
    expect(after.state).toBe("FAILED");
    expect(after.terminalReason).toBe("planner_error");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.capabilities.test.ts`
Expected: FAIL（`capabilities` 未传入 / 非法 input 仍下发或停滞）

- [ ] **Step 3: 实现**

`planner.ts`：`PlannerInput` 增 `capabilities: NormalizedCapability[]`（`NormalizedCapability` 从 `@adt/shared` 导入）。`orchestrator.ts`：`OrchestratorDeps.capabilitiesOf`；`advance` 里 `const capabilities = this.deps.capabilitiesOf?.(workflow.sessionId) ?? []`，并入 `PlannerInput`；`planner.proposeNext(...)` 用 `try/catch` 包裹，抛出（LLM 不可用 / 输出不可解析）→ `await engine.fail(workflowId, "planner_error")` 并返回 `{}`（不留 RUNNING 停滞）；对 `kind === "step"` 先 `validateStepInput(capabilities, step.capability, step.input ?? {})`——非 `null` 则 `await engine.fail(workflowId, "invalid_input")` 并返回 `{}`。`validateStepInput`：按 `name` 找 capability；无 `input_schema` → `console.warn` + `null`；有则 `validateJsonSchema(schema, input)`，`valid` 返回 `null`，否则返回 `errors.join("; ")`。`index.ts` / `test-support` 构造 orchestrator 时传 `capabilitiesOf: (sessionId) => [...server.sessions.capabilitiesOf(sessionId).values()]`。

- [ ] **Step 4: 运行测试确认通过（含既有回归）**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.capabilities.test.ts test/workflow/orchestrator.test.ts test/protocol/workflowProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/planner.ts packages/server/src/workflow/orchestrator.ts packages/server/src/index.ts packages/test-support/src/server.ts packages/server/test/workflow/orchestrator.capabilities.test.ts
git commit -m "feat(workflow): planner sees capabilities; validate step input before dispatch"
```

---

### Task 5: Evidence `result` 校验（不合则 `FAILED(invalid_output)`）

**Files:**
- Modify: `packages/server/src/protocol/workflowProtocol.ts`（`step.status` 处理器）
- Test: `packages/server/test/protocol/evidenceValidation.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `validateJsonSchema`；Task 3 `StepStatusUpdate.failReason`；P1 `CapabilityRegistry`
- Produces: `step.status(COMPLETED, evidence)` 且 `evidence.result` 不合该 Step 对应 Capability 的 `output_schema` → 以 `{ state: "FAILED", failReason: { code: "invalid_output" } }` 交给引擎并 `conn.warn`；schema 缺失或 `result` 缺失 → 不校验并告警

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/evidenceValidation.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

const readStep = {
  kind: "step" as const,
  step: { objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true, input: { project_path: "/a" } },
};

async function running(srv: Awaited<ReturnType<typeof startTestServer>>) {
  const c = await TestClient.connect(srv.url);
  await c.hello({
    username: "alice", secret: "pw-alice",
    capabilities: [{
      name: "git.collect_diagnostics", side_effect: false, interruptible: true,
      output_schema: { type: "object", required: ["branch"], properties: { branch: { type: "string" } } },
    }],
  });
  const created = await c.sendRaw({ ...c.base("workflow.request"),
    payload: { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } } });
  const workflowId = (created.payload as { workflow_id: string }).workflow_id;
  const dispatch = await c.next();
  return { c, workflowId, stepId: (dispatch.payload as { step_id: string }).step_id };
}

describe("evidence output validation", () => {
  it("records FAILED(invalid_output) when result does not match the schema", async () => {
    const srv = await startTestServer({ planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }] });
    const { c, workflowId, stepId } = await running(srv);
    await c.send({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" } });
    const candidate = await c.sendRaw({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: { branch: 7 } } } });
    // The invalid evidence is rejected as a FAILED step; planning continues.
    expect(candidate.type).toBe("workflow.completion_candidate");
    const step = await srv.engine.getStep(stepId);
    expect(step!.state).toBe("FAILED");
    await c.close(); await srv.close();
  });

  it("accepts evidence that matches the schema", async () => {
    const srv = await startTestServer({ planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }] });
    const { c, workflowId, stepId } = await running(srv);
    await c.send({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" } });
    await c.sendRaw({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: { branch: "main" } } } });
    expect((await srv.engine.getStep(stepId))!.state).toBe("COMPLETED");
    await c.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/evidenceValidation.test.ts`
Expected: FAIL（非法 `result` 被当作 `COMPLETED`）

- [ ] **Step 3: 实现**

`workflowProtocol.ts` 的 `step.status`：在 `toStepStatusUpdate` 之后，若 `update.state === "COMPLETED"`，取该 Step 的 capability（`await engine.getStep(payload.step_id)` → `session.capabilities.get(step.capability)`），若存在 `output_schema` 则校验 `(update.evidence as { result?: unknown })?.result`；不合则改写为 `{ state: "FAILED", failReason: { code: "invalid_output" } }` 并 `conn.warn`。`result` 缺失或 schema 缺失 → 告警但不改写。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/evidenceValidation.test.ts test/protocol/workflowProtocol.test.ts test/workflow/engine.evidence.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/protocol/workflowProtocol.ts packages/server/test/protocol/evidenceValidation.test.ts
git commit -m "feat(protocol): validate evidence result and record FAILED(invalid_output)"
```

---

### Task 6: `completion_criteria` 由规划器产出、修订留痕入 Record

**Files:**
- Modify: `packages/server/src/workflow/planner.ts`（`initialCriteria`、`PlannerDecision.criteria?`）
- Modify: `packages/server/src/workflow/orchestrator.ts`（`criteria` → `engine.reviseCriteria`）
- Modify: `packages/server/src/protocol/workflowProtocol.ts`（`workflow.request` 用 `planner.initialCriteria`；失败回退 `open/0`）
- Modify: `packages/server/src/record/builder.ts`、`packages/server/src/record/types.ts`（`criteria_revisions`）
- Modify: `packages/server/src/index.ts`、`packages/test-support/src/server.ts`（planner 提供 `initialCriteria`；`TestServerOptions.plannerImpl?`）
- Test: `packages/server/test/record/criteria.test.ts`（新建）、`packages/server/test/protocol/criteria.test.ts`（新建）；`packages/server/test/record/store.test.ts` 与 `packages/server/test/report/generate.test.ts` 的 `RecordDocument` 字面量补 `criteria_revisions: []`

**Interfaces:**
- Consumes: P2a `reviseCriteria`、`criteria_revised` 事件
- Produces:
  - `interface Planner { initialCriteria(request: unknown, capabilities: NormalizedCapability[]): Promise<CompletionCriteria>; proposeNext(input: PlannerInput): Promise<PlannerDecision> }`
  - `type PlannerDecision = { kind: "step"; step: NewStep; criteria?: Omit<CompletionCriteria, "revision"> } | { kind: "completion_candidate"; summary: string; evidenceRefs: string[]; criteria?: Omit<CompletionCriteria, "revision"> }`
  - `RecordDocument.criteria_revisions: Array<{ ts: number; criteria: CompletionCriteria }>`
  - `buildRecord`：`criteria_revised` 事件 → `criteria_revisions`；`completion_criteria` 仍为最新

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/record/criteria.test.ts
import { describe, it, expect } from "vitest";
import { buildRecord } from "../../src/record/builder";
import type { StepSnapshot, WorkflowEvent, WorkflowSnapshot } from "../../src/workflow/store";

const workflow: WorkflowSnapshot = {
  id: "wf_1", userId: "usr_1", sessionId: "sess_1", state: "COMPLETED", terminalReason: null,
  criteria: { mode: "open", revision: 1, description: "问题消失" },
  createdAt: 100, endedAt: 200, notSolvedRounds: 0,
};
const ev = (kind: any, payload: any, id = `ev_${kind}`): WorkflowEvent => ({ id, workflowId: "wf_1", kind, ts: 150, payload });

describe("criteria revisions", () => {
  it("keeps the latest criteria and its revision history", () => {
    const record = buildRecord({
      workflow,
      steps: [] as StepSnapshot[],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("criteria_revised", { criteria: { mode: "open", revision: 1, description: "问题消失" } }, "ev_r1"),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_c",
    });
    expect(record.completion_criteria.revision).toBe(1);
    expect(record.criteria_revisions).toHaveLength(1);
    expect(record.criteria_revisions[0]!.criteria.description).toBe("问题消失");
  });
});
```

```ts
// packages/server/test/protocol/criteria.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";
import type { Planner } from "@adt/server";

const planner: Planner = {
  initialCriteria: async () => ({ mode: "open", revision: 0, description: "现象不再出现" }),
  proposeNext: async (input) =>
    input.workflow.criteria.revision === 0
      ? { kind: "completion_candidate", summary: "看起来好了", evidenceRefs: [], criteria: { mode: "open", description: "现象不再出现" } }
      : { kind: "completion_candidate", summary: "好了", evidenceRefs: [] },
};

describe("planner criteria", () => {
  it("creates the workflow with the planner's criteria and revises on demand", async () => {
    const srv = await startTestServer({ plannerImpl: planner });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const created = await c.sendRaw({ ...c.base("workflow.request"),
      payload: { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } } });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    await c.next(); // completion candidate
    const wf = (await srv.engine.get(workflowId))!;
    expect(wf.criteria.revision).toBe(1);
    await c.close(); await srv.close();
  });
});
```

> `TestServerOptions` 需新增 `plannerImpl?: Planner`（显式注入完整规划器），与既有 `planner?: PlannerDecision[]` 并存（后者用脚本包装）。P3a 的 `NOOP_PLANNER` 也要补 `initialCriteria`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/record/criteria.test.ts test/protocol/criteria.test.ts`
Expected: FAIL（`criteria_revisions` 不存在 / `plannerImpl` 未支持）

- [ ] **Step 3: 实现**

`planner.ts`：接口增 `initialCriteria`；`PlannerDecision` 增可选 `criteria`；`NOOP_PLANNER.initialCriteria = async () => ({ mode: "open", revision: 0 })`。`orchestrator.ts`：`decision.criteria` 存在时 `await engine.reviseCriteria(workflowId, decision.criteria)`（在 `dispatchStep`/返回候选之前）。`types.ts`：`RecordDocument.criteria_revisions`。`builder.ts`：遍历 `criteria_revised` → `{ ts, criteria }`。`workflowProtocol.ts` `workflow.request`：`const criteria = await planner.initialCriteria(request, capabilities).catch((e) => { conn.warn(...); return { mode: "open" as const, revision: 0 }; })`，传给 `engine.create`。`test-support`：`plannerImpl?` 优先；否则用脚本包装（补 `initialCriteria: async () => ({ mode: "open", revision: 0 })`）。`index.ts` 的 NOOP 同样补齐。`RecordDocument.criteria_revisions` 为必填，`record/store.test.ts` 与 `report/generate.test.ts` 的 fixture 补 `criteria_revisions: []`。既有内联 `Planner` stub（`test/workflow/orchestrator.test.ts` 的 `scripted`、`test/workflow/orchestrator.capabilities.test.ts` 的匿名 planner、Task 10 之前任何 `TestServerOptions.planner` 包装）一并补 `initialCriteria`，否则 `tsc --noEmit` 会因接口不完整报错。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/record/criteria.test.ts test/protocol/criteria.test.ts test/record/builder.test.ts test/protocol/workflowProtocol.test.ts test/workflow/orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/planner.ts packages/server/src/workflow/orchestrator.ts packages/server/src/protocol/workflowProtocol.ts packages/server/src/record/types.ts packages/server/src/record/builder.ts packages/server/src/index.ts packages/test-support/src/server.ts packages/server/test/record/criteria.test.ts packages/server/test/protocol/criteria.test.ts
git commit -m "feat(workflow): planner-owned completion criteria with revision history"
```

---

### Task 7: `workflow.request` 的 `client_request_id` 幂等

**Files:**
- Modify: `packages/server/src/session/sessionManager.ts`（`Session.clientRequests` + 存取方法）
- Modify: `packages/server/src/protocol/workflowProtocol.ts`（去重分支）
- Test: `packages/server/test/protocol/idempotency.test.ts`（新建）

**Interfaces:**
- Consumes: P2c `SessionManager`
- Produces:
  - `Session.clientRequests: Map<string, string>`（`client_request_id` → `workflow_id`）
  - `SessionManager.rememberClientRequest(sessionId: string, clientRequestId: string, workflowId: string): void`
  - `SessionManager.findClientRequest(sessionId: string, clientRequestId: string): string | null`
  - `workflow.request`：命中则直接回 `workflow.created`（既有 `workflow_id`），不新建；未命中则创建并登记

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/idempotency.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

describe("workflow.request idempotency", () => {
  it("returns the same workflow for a replayed client_request_id", async () => {
    const srv = await startTestServer({ planner: [] });
    const c = await TestClient.connect(srv.url);
    const w = await c.hello({ username: "alice", secret: "pw-alice" });
    const payload = { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } };

    const first = await c.sendRaw({ ...c.base("workflow.request"), payload });
    const firstId = (first.payload as { workflow_id: string }).workflow_id;
    await c.next(); // completion candidate

    const second = await c.sendRaw({ ...c.base("workflow.request"), payload });
    expect((second.payload as { workflow_id: string }).workflow_id).toBe(firstId);

    await c.close(); await srv.close();
  });

  it("scopes idempotency to the session", async () => {
    const srv = await startTestServer({ planner: [] });
    const a = await TestClient.connect(srv.url);
    await a.hello({ username: "alice", secret: "pw-alice" });
    const payload = { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } };
    const first = await a.sendRaw({ ...a.base("workflow.request"), payload });
    await a.next();
    await a.close();

    const b = await TestClient.connect(srv.url);
    await b.hello({ username: "bob", secret: "pw-bob" });
    const other = await b.sendRaw({ ...b.base("workflow.request"), payload });
    expect((other.payload as { workflow_id: string }).workflow_id).not.toBe((first.payload as { workflow_id: string }).workflow_id);
    await b.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/idempotency.test.ts`
Expected: FAIL（重放创建了第二个 Workflow）

- [ ] **Step 3: 实现**

`SessionManager`：`create` 初始化 `clientRequests: new Map()`；`rememberClientRequest` / `findClientRequest` 读写 `byId.get(sessionId)` 的 map。`workflowProtocol.ts` `workflow.request`：校验后先 `const existingId = sessions.findClientRequest(session.id, payload.client_request_id)`；命中 → `send(..., "workflow.created", existingId, { workflow_id: existingId, workflow_status: (await engine.get(existingId))?.state ?? "CREATED" }, env.message_id)` 并 `return`（不 re-advance，避免重复候选）；未命中 → 现有创建流程 + `sessions.rememberClientRequest(...)` + `advanceAndPush`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/idempotency.test.ts test/protocol/workflowProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/session/sessionManager.ts packages/server/src/protocol/workflowProtocol.ts packages/server/test/protocol/idempotency.test.ts
git commit -m "feat(protocol): idempotent workflow.request per client_request_id"
```

---

### Task 8: `LlmProvider` 抽象 + OpenAI 兼容实现

**Files:**
- Create: `packages/server/src/llm/provider.ts`
- Create: `packages/server/src/llm/openaiCompatible.ts`
- Create: `packages/test-support/src/llm.ts`
- Modify: `packages/server/src/index.ts`、`packages/test-support/src/index.ts`（导出）
- Test: `packages/server/test/llm/openaiCompatible.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface LlmTool { name: string; description: string; parameters: Record<string, unknown> }`
  - `interface LlmMessage { role: "system" | "user" | "assistant"; content: string }`
  - `interface LlmRequest { messages: LlmMessage[]; tools: LlmTool[]; toolChoice: string; temperature?: number }`
  - `interface LlmToolCall { name: string; arguments: Record<string, unknown> }`
  - `interface LlmResponse { toolCalls: LlmToolCall[] }`
  - `interface LlmProvider { complete(request: LlmRequest): Promise<LlmResponse> }`
  - `class OpenAiCompatibleProvider implements LlmProvider { constructor(opts: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch }) }`
  - `function llmProviderFromEnv(env: NodeJS.ProcessEnv): { provider: LlmProvider; model: string } | null`
  - `class ScriptedLlmProvider implements LlmProvider { constructor(responses: LlmResponse[]); requests: LlmRequest[] }`（test-support）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/llm/openaiCompatible.test.ts
import { describe, it, expect } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/llm/openaiCompatible";

describe("OpenAiCompatibleProvider", () => {
  it("maps the request to OpenAI tool-calling and parses the tool call", async () => {
    let body: unknown;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: "propose_step", arguments: '{"action":"completion_candidate"}' } }] } }],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider({ baseUrl: "https://api.example/v1", apiKey: "k", model: "m", fetch: fakeFetch });
    const res = await provider.complete({
      messages: [{ role: "system", content: "s" }],
      tools: [{ name: "propose_step", description: "d", parameters: { type: "object" } }],
      toolChoice: "propose_step",
    });

    expect((body as { model: string }).model).toBe("m");
    expect((body as { tool_choice: unknown }).tool_choice).toEqual({ type: "function", function: { name: "propose_step" } });
    expect(res.toolCalls).toEqual([{ name: "propose_step", arguments: { action: "completion_candidate" } }]);
  });

  it("throws on a non-2xx response", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example/v1", apiKey: "k", model: "m",
      fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(provider.complete({ messages: [], tools: [], toolChoice: "t" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/llm/openaiCompatible.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`provider.ts` 只放类型。`openaiCompatible.ts`：`POST ${baseUrl}/chat/completions`，头 `Authorization: Bearer <apiKey>`、`Content-Type: application/json`；body `{ model, messages, tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: { type: "function", function: { name: toolChoice } }, temperature }`；非 2xx 抛 `Error(\`LLM HTTP <status>\`)`；解析 `choices[0].message.tool_calls[].function`（`arguments` 为 JSON 字符串，解析失败抛错）。`llmProviderFromEnv`：需要 `LLM_API_KEY`，否则 `null`；`LLM_BASE_URL` 默认 `https://api.deepseek.com/v1`，`LLM_MODEL` 默认 `deepseek-v4.1-flash`。`test-support/src/llm.ts`：`ScriptedLlmProvider` 依次返回并记录请求；队列空时抛错。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/llm/openaiCompatible.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/llm packages/server/src/index.ts packages/test-support/src/llm.ts packages/test-support/src/index.ts packages/server/test/llm/openaiCompatible.test.ts
git commit -m "feat(llm): provider abstraction and OpenAI-compatible implementation"
```

---

### Task 9: LLM 规划器（prompt + tool schema + 决策解析）

**Files:**
- Create: `packages/server/src/workflow/llmPlanner.ts`
- Modify: `packages/server/src/index.ts`（导出 `LlmPlanner`）
- Modify: `packages/test-support/src/server.ts`（`TestServerOptions.llm?: LlmProvider` → 用 `LlmPlanner`）
- Test: `packages/server/test/workflow/llmPlanner.test.ts`（新建）

**Interfaces:**
- Consumes: Task 8 `LlmProvider`/`ScriptedLlmProvider`；Task 6 `Planner`（含 `initialCriteria`）；Task 4 `PlannerInput.capabilities`
- Produces:
  - `class LlmPlanner implements Planner { constructor(deps: { provider: LlmProvider }) }`
  - `initialCriteria(request, capabilities)`：tool `set_completion_criteria`，参数 `{ mode: "formal" | "open"; description: string; assertions?: string[] }` → `CompletionCriteria`（`revision: 0`）
  - `proposeNext(input)`：tool `propose_step`，参数 `{ action: "step" | "completion_candidate"; step?: { objective; capability; input }; completion?: { summary; evidence_refs } }`，其中 `capability` 的 `enum` = 当前 capabilities 名称；`input` 为自由对象（Server 侧再按 schema 校验）
  - 解析 tool call → `PlannerDecision`；缺失/畸形 tool call → 抛 `Error("planner produced no usable decision")`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/llmPlanner.test.ts
import { describe, it, expect } from "vitest";
import { LlmPlanner } from "../../src/workflow/llmPlanner";
import { ScriptedLlmProvider } from "@adt/test-support";
import type { NormalizedCapability } from "@adt/shared";
import type { WorkflowSnapshot } from "../../src/workflow/store";

const caps: NormalizedCapability[] = [{
  name: "git.collect_diagnostics", side_effect: false, interruptible: true, idempotent: false,
  input_schema: { type: "object", properties: { project_path: { type: "string" } } },
}];
const workflow: WorkflowSnapshot = {
  id: "wf_1", userId: "usr_1", sessionId: "sess_1", state: "RUNNING", terminalReason: null,
  criteria: { mode: "open", revision: 0, description: "问题消失" }, createdAt: 0, endedAt: null, notSolvedRounds: 0,
};

describe("LlmPlanner", () => {
  it("parses an initial-criteria tool call", async () => {
    const llm = new ScriptedLlmProvider([{ toolCalls: [{ name: "set_completion_criteria", arguments: { mode: "open", description: "服务恢复" } }] }]);
    const planner = new LlmPlanner({ provider: llm });
    expect(await planner.initialCriteria({ text: "x" }, caps)).toEqual({ mode: "open", revision: 0, description: "服务恢复" });
  });

  it("parses a step decision and exposes the capability enum to the model", async () => {
    const llm = new ScriptedLlmProvider([{ toolCalls: [{ name: "propose_step", arguments: {
      action: "step", step: { objective: "查看 git", capability: "git.collect_diagnostics", input: { project_path: "/a" } } } }] }]);
    const planner = new LlmPlanner({ provider: llm });
    const decision = await planner.proposeNext({ workflow, steps: [], events: [], capabilities: caps });
    expect(decision).toEqual({ kind: "step", step: {
      objective: "查看 git", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true, input: { project_path: "/a" } } });
    const tool = llm.requests[0]!.tools[0]!;
    expect((tool.parameters as any).properties.step.properties.capability.enum).toEqual(["git.collect_diagnostics"]);
    expect(llm.requests[0]!.messages.some((m) => m.content.includes("问题消失"))).toBe(true);
  });

  it("throws on a response with no tool call", async () => {
    const planner = new LlmPlanner({ provider: new ScriptedLlmProvider([{ toolCalls: [] }]) });
    await expect(planner.proposeNext({ workflow, steps: [], events: [], capabilities: caps })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/llmPlanner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`initialCriteria` 与 `proposeNext` 各自构造 `LlmRequest`：system prompt 说明角色（HiL 诊断规划、One-Step Planning、只读优先、一次一个 Step）、输出必须走指定 tool；user prompt 内联 `user_request`、`completion_criteria`、可用 capabilities（名称 + `input_schema`）、以及已有 steps/evidence 的摘要（从 `steps` + `step_status` 事件中提取 `evidence`）。`proposeNext` 把 `side_effect`/`interruptible` 填入 `NewStep`（取自被选 Capability；未知 capability → 抛错或回退）。`toolChoice` 固定为对应 tool 名。解析后校验 `arguments` 形状，畸形即抛错。`test-support`：`TestServerOptions.llm` 存在时用 `new LlmPlanner({ provider: opts.llm })` 作为 orchestrator 的 planner。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/llmPlanner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/llmPlanner.ts packages/server/src/index.ts packages/test-support/src/server.ts packages/server/test/workflow/llmPlanner.test.ts
git commit -m "feat(workflow): LLM-backed planner over the LlmProvider seam"
```

---

### Task 10: 生产接线 + 真实 LLM 集成测试 + 端到端只读闭环

**Files:**
- Modify: `packages/server/src/index.ts`（`start`：按 env 构造 LLM planner；否则 `NOOP_PLANNER`）
- Test: `packages/server/test/protocol/readonlyLoop.e2e.test.ts`（新建，fake provider）
- Test: `packages/server/test/llm/realProvider.int.test.ts`（新建，`describe.skipIf(!process.env.LLM_API_KEY)`）

**Interfaces:**
- Consumes: Task 8 `llmProviderFromEnv`；Task 9 `LlmPlanner`；Task 4/5/6 的校验与 criteria
- Produces:
  - `start()`：`const llm = llmProviderFromEnv(process.env)`；有 → orchestrator 用 `new LlmPlanner({ provider: llm.provider })`，无 → `NOOP_PLANNER`
  - E2E：TestClient 声明带 schema 的只读 Capability → `workflow.request` → 假 LLM 依次给出「只读 Step」「完成候选」→ Client 回合法 Evidence → `completion_response(solved)` → `workflow.terminated(COMPLETED, record_id)` → `report.generate_result(ok)`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/readonlyLoop.e2e.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient, ScriptedLlmProvider } from "@adt/test-support";

const llm = () => new ScriptedLlmProvider([
  { toolCalls: [{ name: "set_completion_criteria", arguments: { mode: "open", description: "问题消失" } }] },
  { toolCalls: [{ name: "propose_step", arguments: { action: "step",
      step: { objective: "查看 git 状态", capability: "git.collect_diagnostics", input: { project_path: "/a" } } } }] },
  { toolCalls: [{ name: "propose_step", arguments: { action: "completion_candidate",
      completion: { summary: "分支正常，问题应已消除", evidence_refs: [] } } }] },
]);

describe("read-only closed loop (fake LLM)", () => {
  it("runs request → read step → completion → record → report", async () => {
    const srv = await startTestServer({ llm: llm() });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice", capabilities: [{
      name: "git.collect_diagnostics", side_effect: false, interruptible: true,
      input_schema: { type: "object", required: ["project_path"], properties: { project_path: { type: "string" } } },
      output_schema: { type: "object", required: ["branch"], properties: { branch: { type: "string" } } },
    }] });

    const created = await c.sendRaw({ ...c.base("workflow.request"),
      payload: { client_request_id: "req_1", user_request: { text: "项目起不来了", attachments: [], context: {} } } });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;

    const dispatch = await c.next();
    expect((dispatch.payload as any).capability).toBe("git.collect_diagnostics");
    expect((dispatch.payload as any).input).toEqual({ project_path: "/a" });

    await c.send({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: (dispatch.payload as any).step_id, status: "RUNNING" } });
    const candidate = await c.sendRaw({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: (dispatch.payload as any).step_id, status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: { branch: "main" } } } });
    expect(candidate.type).toBe("workflow.completion_candidate");

    const terminated = await c.sendRaw({ ...c.base("workflow.completion_response"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, resolution: "solved" } });
    expect((terminated.payload as any).terminal_state).toBe("COMPLETED");
    const recordId = (terminated.payload as any).record_id as string;

    const report = await c.sendRaw({ ...c.base("report.generate_request"), payload: { record_id: recordId, options: {} } });
    expect((report.payload as any).status).toBe("ok");

    await c.close(); await srv.close();
  });
});
```

```ts
// packages/server/test/llm/realProvider.int.test.ts
import { describe, it, expect } from "vitest";
import { llmProviderFromEnv } from "../../src/llm/openaiCompatible";

describe.skipIf(!process.env.LLM_API_KEY)("real LLM provider", () => {
  it("responds with a tool call for the planner", async () => {
    const cfg = llmProviderFromEnv(process.env)!;
    const res = await cfg.provider.complete({
      messages: [{ role: "user", content: "Return the tool call set_completion_criteria with description 'ok'." }],
      tools: [{ name: "set_completion_criteria", description: "set criteria",
        parameters: { type: "object", required: ["description"], properties: { description: { type: "string" } } } }],
      toolChoice: "set_completion_criteria",
    });
    expect(res.toolCalls[0]!.name).toBe("set_completion_criteria");
  }, 30000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/readonlyLoop.e2e.test.ts`
Expected: FAIL（`llm` 选项未接线）

- [ ] **Step 3: 实现**

`index.ts` 的 `start`：`const llm = llmProviderFromEnv(process.env)`；`planner = llm ? new LlmPlanner({ provider: llm.provider }) : NOOP_PLANNER`；传入 `new WorkflowOrchestrator({ …, planner, capabilitiesOf })`。`test-support`：`llm?: LlmProvider` 时用 `LlmPlanner`（Task 9 已加）。真实集成测试用 `describe.skipIf` 守卫。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/readonlyLoop.e2e.test.ts`
Expected: PASS；`realProvider.int.test.ts` 在无 `LLM_API_KEY` 时 SKIP（不失败）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/index.ts packages/server/test/protocol/readonlyLoop.e2e.test.ts packages/server/test/llm/realProvider.int.test.ts
git commit -m "feat(server): wire the LLM planner and prove the read-only loop end to end"
```

---

### Task 11: 文档同步（RECORD_SPEC / WORKFLOW_SPEC）

**Files:**
- Modify: `docs/specs/RECORD_SPEC.md`（§4 `step_dispatched.ref` 增 `input`；§3 说明 `completion_criteria` 含修订历史与 `criteria_revisions`）→ v0.5 → **v0.6**
- Modify: `docs/specs/WORKFLOW_SPEC.md`（§2 `FAILED` 的系统原因补 `invalid_input` / `invalid_output` / `planner_error`）→ v0.4 → **v0.5**
- Modify: `docs/REQUIREMENTS.md` §7 影响表相应版本引用
- Modify: `packages/server/src/record/builder.ts`（`SPEC_VERSIONS.workflow_spec` → `"0.5"`）

**Interfaces:**
- Consumes: Task 2/3/5/6 的实现
- Produces: 文档与实现一致

- [ ] **Step 1: 改 `RECORD_SPEC.md`**

页首 `Version` → `v0.6`，新增变更记录（v0.5 → v0.6）：`step_dispatched` 的 `ref` 增 `input`（对应 FR-12"全部 Step（目的、所用能力、输入）"）；`completion_criteria` 明确保留修订历史，并新增 `criteria_revisions` 字段（`Array<{ ts, criteria }>`）。§4 表格与 §3 结构同步。

- [ ] **Step 2: 改 `WORKFLOW_SPEC.md`**

页首 `Version` → `v0.5`，新增变更记录：§2 的 `FAILED` 行补系统原因 `invalid_input`（Planner 产出的 Step input 不合 schema，不下发）/ `invalid_output`（Evidence result 不合 output schema）/ `planner_error`（LLM 不可用或输出不可解析）。

- [ ] **Step 3: 同步交叉引用**

Run: `grep -rn "RECORD_SPEC.md\` v0\.5\|WORKFLOW_SPEC.md\` v0\.4\|RECORD_SPEC.md v0\.5\|WORKFLOW_SPEC.md v0\.4" docs/ --include=*.md | grep -v superpowers`
把 `REQUIREMENTS.md` §7 影响表中这两份文档的版本号更新为 v0.6 / v0.5，并补上本次新增能力说明。

- [ ] **Step 4: 验证**

Run: `grep -n "Version:" docs/specs/RECORD_SPEC.md docs/specs/WORKFLOW_SPEC.md`
Expected: 分别显示 `v0.6` / `v0.5`

- [ ] **Step 5: 提交**

```bash
git add docs/
git commit -m "docs: record step input and criteria history; system failure reasons"
```

---

## Self-Review

**1. Spec coverage：** 受限子集校验器 → T1；`input` 全链路 → T2；确定性失败与 `fail_reason` → T3；Server 校验 `input`（不合不下发）→ T4；Server 校验 `evidence.result`（`FAILED(invalid_output)`）→ T5；`completion_criteria` 及其修订历史 → T6；`client_request_id` 幂等 → T7；`LlmProvider` 抽象 + OpenAI 兼容 → T8；LLM Planner（tool schema/prompt/解析）→ T9；生产接线 + 端到端只读闭环 + 真实 LLM（可选）→ T10；文档同步 → T11。**刻意留给后续**：client-daemon 真实只读执行与适配器（P3b）；副作用执行、`UNKNOWN`/对账、幂等台账、blob、KB 导出（P4）；`expected_output` 的 output schema 名称绑定（需要 Manifest 增名字字段，暂不引入）。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支，不给完整函数体。

**3. Type consistency：** `JsonSchema` / `validateJsonSchema`、`NewStep.input` / `StepSnapshot.input` / `stepDispatchPayload`、`engine.fail` / `StepStatusUpdate.failReason`、`PlannerInput.capabilities` / `validateStepInput` / `OrchestratorDeps.capabilitiesOf`、`Planner.initialCriteria` / `PlannerDecision.criteria`、`RecordDocument.criteria_revisions`、`Session.clientRequests` / `findClientRequest`、`LlmProvider` / `LlmToolCall` / `ScriptedLlmProvider`、`LlmPlanner` 在 T1–T10 定义并同名复用。

**4. Review Focus：** 五条风险落到测试——(1) 非法 `input` 不下发且 `FAILED(invalid_input)` → T4；(2) 非法 `result` → `FAILED(invalid_output)` → T5；(3) 畸形 tool call / planner 抛出 → `FAILED(planner_error)`，不停滞不崩溃 → T4（编排层）与 T9（解析层）；(4) `client_request_id` 重放不新建 → T7；(5) criteria 修订留痕 → T6。

**5. Proportion：** 计划只描述决策、接口与断言；LLM prompt 只描述结构与约束，不写完整文本。

## 移交后续计划的待办（P3b 与 P4）

1. **client-daemon 只读执行**（P3b）：`step.dispatch` 处理、本地只读 Capability（`git.collect_diagnostics` / `filesystem.read_file` 等）、Capability 适配器接缝（ADR-004 的 Windows 接入调研仍是开放前置项）。
2. **LLM 调用的数据出网风险**（ADR-004 §Consequences）：在部署时显式接受；本阶段仅通过环境变量启用。
3. **`expected_output` 与 output schema 名称绑定**：需 Manifest 增一个 output 名称字段；`PROTOCOL_SPEC.md` §8 已定义语义，暂未落地。
4. **LLM 失败的重试策略**：本阶段直接 `FAILED(planner_error)`；是否有界重试/退避留待观察真实失败率后再定。

## 后续

P3a 验收通过后写 **P3b（client-daemon 只读闭环）**，再进入 **P4（受控执行 / 对账编排 / blob / KB 导出）**。
