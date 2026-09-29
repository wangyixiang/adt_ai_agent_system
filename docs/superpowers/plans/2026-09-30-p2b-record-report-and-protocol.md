# P2b Record / Report 与协议接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P2a 的 Workflow 引擎接到协议上，并在 Workflow 终止时生成、保存、查询 Record，以及按需生成 Report。

**Architecture:** 协议层（`WorkflowProtocol`）负责把 Client 消息翻译成引擎调用，并保证"**先落盘 Record，成功后再发 `workflow.terminated`**"。Record 由事件日志 + 快照**一次性构建**（`RECORD_SPEC.md` §0"写入时定型"）；Report 只是对 Record 的裁剪排版。规划行为通过 `Planner` 接缝注入——P2b 用脚本化实现，P3 换成 LLM，协议层不变。

**Tech Stack:** TypeScript（strict）· Node.js LTS · PostgreSQL（`pg`）· Vitest · 沿用 P1/P2a 结构

**Spec:** `docs/specs/RECORD_SPEC.md`（v0.4 §0/§3/§4/§5/§7）、`docs/specs/REPORT_SPEC.md`（v0.3 §3/§4/§5/§6）、`docs/specs/PROTOCOL_SPEC.md`（v0.5 §7/§10/§11/§12）、`docs/specs/WORKFLOW_SPEC.md`（v0.4 §12）、`docs/adr/ADR-003`（§5/§6 授权与可见性）、`docs/superpowers/specs/2026-09-29-mvp-scope.md`

## Global Constraints

- **Record 忠实**：只含实际发生的 Step、实际获得的 Evidence、实际发生的人工决定；不得出现未执行/未获得的内容（`RECORD_SPEC.md` §1）。
- **写入时定型**：Record 在 Workflow 终止那一刻**一次性**构建并落盘，此后只读（§0、§2）。
- **先落盘后通知**：Record 持久化成功后才发 `workflow.terminated`；落盘失败重试耗尽仍须终止，但 `record_id = null` 且 `record_persistence_failed = true`（`PROTOCOL_SPEC.md` §7.4、决策 D-D3）。
- **同一 Workflow 只有一份 Record**：以 `workflow_id` 唯一约束保证重复终止/重复 finalize 不产生第二份。
- **可见性**：Record 只对 `owner_user_id` 可见；查询他人的 `record_id` 返回 `protocol.error(code=unknown_record)`，**不泄露存在性**（`ADR-003` §6）。
- **`record.list` 语义**：`time_range` ISO 8601 闭区间（按 `ended_at`）；`keyword` 在 `summary` + `entries[].narrative` 上不区分大小写子串匹配；排序 `ended_at` 降序 + `record_id` tiebreak；`page_size` 默认 20、上限 100；`cursor` 为不透明 token；**详情不分页**（`PROTOCOL_SPEC.md` §10）。
- **Report**：`format` 固定 `markdown`；`detail_level` ∈ `summary | full`，**缺省 `full`**；事实性内容必须能追溯到 Record；生成失败返回 `status: "failed"` + `error_code` ∈ `generation_failed | insufficient_content | invalid_option | timeout`，**不写 Record**（`REPORT_SPEC.md` §3/§4/§6）。
- **`narrative` 生成（P2b）**：**只用确定性模板**（基于 `kind` + `ref`）；LLM 润色与一致性校验留到 P3。模板文本不得超出 `ref` 的结构化事实（`RECORD_SPEC.md` §4）。
- **`UNKNOWN` 未对账**：终止时仍有未对账的副作用 Step → `final_result.unresolved_side_effects` 必须标注，Report 也必须呈现（`RECORD_SPEC.md` §3、`REPORT_SPEC.md` §5.2）。
- **授权**：只有创建该 Workflow 的 `session`/`user` 可以操作它（`step.status`、`completion_response`、`cancel_request`）；不匹配 → `protocol.error(code=unknown_workflow)`。
- **终止后不再接受业务消息**：对已终止 Workflow 的 `step.status`/`completion_response`/`cancel_request` 一律忽略（P2a 引擎已是幂等的，协议层只需不再回推）。
- **本阶段不实现**（留给 P2c/P3/P4）：`session.resume`/`workflow.state_sync`/会话级去重窗口、`ERROR_DISPOSITION` 驱动、Capability I/O schema 校验、受控执行确认与对账编排、幂等台账、blob、KB 导出、LLM 规划。

## Review Focus

以下失败模式是 Spec 隐含但容易漏测的，**每条都必须在对应任务里有测试**：

1. **Record 忠实**：未执行的 Step、未获得的 Evidence、未发生的决定，绝不能出现在 Record 里。
2. **落盘失败**：`workflow.terminated` 仍发出，但 `record_id=null` 且 `record_persistence_failed=true`。
3. **越权查询**：他人的 `record_id` → `unknown_record`，且响应不包含任何该 Record 的字段。
4. **未对账 `UNKNOWN`**：终止后 `final_result.unresolved_side_effects` 有标注，Report 的结论段落也呈现"可能已执行"。
5. **重复终止**：同一 Workflow 触发两次终止/finalize，只产生一份 Record。

---

### Task 1: 让 Step 状态携带 Evidence（引擎扩展）

**Files:**
- Modify: `packages/server/src/workflow/engine.ts`
- Test: `packages/server/test/workflow/engine.evidence.test.ts`

**Interfaces:**
- Consumes: P2a 的 `WorkflowEngine`、`StepStatusUpdate`
- Produces:
  - `type StepStatusUpdate = { state: "RUNNING" } | { state: "WAITING"; waitClass: "human" | "execution" } | { state: "COMPLETED"; evidence?: unknown } | { state: "FAILED"; evidence?: unknown } | { state: "REJECTED" } | { state: "UNKNOWN" }`
  - `step_status` 事件的 payload 变为 `{ stepId, state, evidence? }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/engine.evidence.test.ts
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

describe("evidence on step status", () => {
  it("stores the evidence returned by the client on COMPLETED", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, {
      state: "COMPLETED",
      evidence: { source: "capability", type: "git_status", result: { branch: "main" } },
    });

    const events = await store.listEvents(wf.id);
    const completed = events.find(
      (e) => e.kind === "step_status" && (e.payload as any).state === "COMPLETED",
    )!;
    expect((completed.payload as any).evidence).toEqual({
      source: "capability", type: "git_status", result: { branch: "main" },
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.evidence.test.ts`
Expected: FAIL（`evidence` 未写入 payload）

- [ ] **Step 3: 实现**

扩展 `StepStatusUpdate` 的 `COMPLETED`/`FAILED` 分支以接受可选 `evidence`；在 `applyStepStatus` 构造 `step_status` 事件时，把 `evidence` 一并放进 payload（`undefined` 时不写入该键，保持事件简洁）。引擎**不校验** evidence 结构——那是 P3/P4 的 Capability schema 校验（`CAPABILITY_SPEC.md` §5.2）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/engine.evidence.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/engine.ts packages/server/test/workflow/engine.evidence.test.ts
git commit -m "feat(workflow): carry client evidence on step status events"
```

---

### Task 2: Record 文档与构建器

**Files:**
- Create: `packages/server/src/record/types.ts`
- Create: `packages/server/src/record/builder.ts`
- Test: `packages/server/test/record/builder.test.ts`

**Interfaces:**
- Consumes: P2a 的 `WorkflowSnapshot`/`StepSnapshot`/`WorkflowEvent`
- Produces:
  - `type RecordEntryKind = "step_dispatched" | "evidence_received" | "user_confirmation" | "user_input" | "completion_candidate" | "completion_response" | "cancellation_requested" | "step_outcome_unknown" | "reconciliation_resolved" | "guardrail_triggered"`
  - `interface RecordEntry { entry_id: string; ts: number; kind: RecordEntryKind; ref: Record<string, unknown>; narrative: string }`
  - `interface RecordSummary { problem_short: string; terminal_state: string; result_short: string; duration_ms: number }`
  - `interface RecordDocument { record_id: string; workflow_id: string; owner_user_id: string; spec_versions: { workflow_spec: string; capability_spec: string }; created_at: number; ended_at: number; terminal_state: string; terminal_reason: string | null; completion_criteria: CompletionCriteria; user_request: unknown; summary: RecordSummary; entries: RecordEntry[]; final_result: Record<string, unknown> }`
  - `interface BuildRecordInput { workflow: WorkflowSnapshot; steps: StepSnapshot[]; events: WorkflowEvent[]; userRequest: unknown; recordId: string }`
  - `function buildRecord(input: BuildRecordInput): RecordDocument`
  - `function renderNarrative(kind: RecordEntryKind, ref: Record<string, unknown>): string`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/record/builder.test.ts
import { describe, it, expect } from "vitest";
import { buildRecord, renderNarrative } from "../../src/record/builder";
import type { StepSnapshot, WorkflowEvent, WorkflowSnapshot } from "../../src/workflow/store";

const workflow: WorkflowSnapshot = {
  id: "wf_1", userId: "usr_1", sessionId: "sess_1", state: "COMPLETED",
  terminalReason: null, criteria: { mode: "open", revision: 0 },
  createdAt: 100, endedAt: 200, notSolvedRounds: 0,
};
const step = (over: Partial<StepSnapshot> = {}): StepSnapshot => ({
  id: "step_1", workflowId: "wf_1", state: "COMPLETED", objective: "read",
  capability: "git.collect_diagnostics", sideEffect: false, interruptible: true,
  idempotencyKey: null, attempt: 1, waitClass: null, ...over,
});
const ev = (kind: any, payload: any, id = `ev_${kind}`): WorkflowEvent =>
  ({ id, workflowId: "wf_1", kind, ts: 100, payload });

describe("record builder", () => {
  it("includes only what actually happened, in insertion order", () => {
    const record = buildRecord({
      workflow,
      steps: [step()],
      events: [
        ev("workflow_created", { request: { text: "svc down" } }),
        ev("step_dispatched", { stepId: "step_1", capability: "git.collect_diagnostics" }),
        ev("step_status", { stepId: "step_1", state: "RUNNING" }),
        ev("step_status", { stepId: "step_1", state: "COMPLETED",
          evidence: { source: "capability", type: "git_status", result: { branch: "main" } } }),
        ev("completion_response", { resolution: "solved" }),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "svc down" },
      recordId: "rec_1",
    });

    expect(record.record_id).toBe("rec_1");
    expect(record.owner_user_id).toBe("usr_1");
    expect(record.terminal_state).toBe("COMPLETED");
    expect(record.summary.problem_short).toContain("svc down");
    expect(record.entries.map((e) => e.kind)).toEqual([
      "step_dispatched", "evidence_received", "completion_response",
    ]);
    expect(record.entries[1]!.ref.evidence).toEqual({
      source: "capability", type: "git_status", result: { branch: "main" },
    });
    expect(record.final_result.resolution).toBe("advisory");
  });

  it("never invents entries for steps that did not happen", () => {
    const record = buildRecord({
      workflow: { ...workflow, state: "CANCELLED", terminalReason: "user_cancelled" },
      steps: [],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("cancel_requested", { reason: "user_cancelled" }),
        ev("workflow_terminated", { state: "CANCELLED", reason: "user_cancelled" }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_2",
    });
    expect(record.entries.map((e) => e.kind)).toEqual(["cancellation_requested"]);
    expect(record.final_result).toEqual({ cancelled_summary: null });
  });

  it("flags unresolved side effects when an UNKNOWN was never reconciled", () => {
    const record = buildRecord({
      workflow: { ...workflow, state: "CANCELLED", terminalReason: "user_cancelled" },
      steps: [step({ id: "step_9", state: "UNKNOWN", capability: "sim_rig.trigger_reset",
        sideEffect: true, interruptible: false, idempotencyKey: "idem_9" })],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("step_dispatched", { stepId: "step_9", capability: "sim_rig.trigger_reset" }),
        ev("step_status", { stepId: "step_9", state: "UNKNOWN" }),
        ev("cancel_requested", { reason: "user_cancelled" }),
        ev("workflow_terminated", { state: "CANCELLED", reason: "user_cancelled" }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_3",
    });
    expect(record.final_result.unresolved_side_effects).toEqual([
      { step_id: "step_9", capability: "sim_rig.trigger_reset",
        idempotency_key: "idem_9", last_known_state: "UNKNOWN" },
    ]);
    expect(record.summary.result_short).toContain("未对账");
  });

  it("marks a side-effect resolution as controlled execution", () => {
    const record = buildRecord({
      workflow,
      steps: [step({ id: "step_7", capability: "sim_rig.trigger_reset", sideEffect: true, interruptible: false })],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("step_dispatched", { stepId: "step_7", capability: "sim_rig.trigger_reset" }),
        ev("step_status", { stepId: "step_7", state: "COMPLETED",
          evidence: { source: "capability", type: "reset_ack", result: { reset_ack: true } } }),
        ev("completion_response", { resolution: "solved" }),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_4",
    });
    expect(record.final_result.resolution).toBe("controlled_execution");
  });

  it("renders narratives from the structured ref only", () => {
    expect(renderNarrative("evidence_received", {
      step_id: "step_1",
      evidence: { source: "capability", type: "git_status", result: { branch: "main" } },
    })).toContain("git_status");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/record/builder.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`buildRecord` 把事件流映射为 entries：
- `step_dispatched` → `{ step_id, capability, objective }`
- `step_status` + `state === "COMPLETED"`/`"FAILED"` 且带 `evidence` → `evidence_received`（`{ step_id, evidence }`）
- `step_status` + `state === "UNKNOWN"` → `step_outcome_unknown`（`{ step_id, capability, idempotency_key }`）
- `step_status` + `reconciled: true` → `reconciliation_resolved`（`{ step_id, resolved_to, evidence_refs }`）
- `completion_response` → `completion_response`（`{ resolution, feedback }`）
- `cancel_requested` → `cancellation_requested`
- `guardrail_triggered` → `guardrail_triggered`（`{ guardrail, threshold }`）
- 其余（`workflow_created`、`workflow_terminated`、`criteria_revised`、`completion_candidate`、`step_status` 的非终态/无证据）**不产生 entry**。

`final_result` 按 `terminal_state` 构造：`COMPLETED` 时 `resolution` = **有任一 `sideEffect: true` 的 Step 到达 `COMPLETED` 则为 `controlled_execution`，否则 `advisory`**（`RECORD_SPEC.md` §3 的取值域；受控执行的完整流程在 P4，但判定依据在 P2b 已经可得）；`FAILED` 时 `failure_summary`；`CANCELLED` 时 `cancelled_summary`（无则 `null`）。`unresolved_side_effects` 取 `steps` 中 `state === "UNKNOWN"` 的项。`summary.result_short` 在存在未对账副作用时包含"未对账"。`narrative` 由 `renderNarrative` 用模板生成，只用 `ref` 中的字段。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/record/builder.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/record packages/server/test/record
git commit -m "feat(record): record document and builder from the event log"
```

---

### Task 3: Record 持久化与查询

**Files:**
- Create: `packages/server/migrations/004_records.sql`
- Create: `packages/server/src/record/store.ts`
- Create: `packages/server/src/record/postgresRecordStore.ts`
- Test: `packages/server/test/record/store.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `RecordDocument`/`RecordSummary`
- Produces:
  - `interface RecordListFilters { timeRange?: { from: number; to: number } | null; keyword?: string | null; terminalState?: string | null }`
  - `interface RecordListPage { records: Array<{ record_id: string; workflow_id: string; summary: RecordSummary }>; next_cursor: string | null }`
  - `interface RecordStore { save(record: RecordDocument): Promise<void>; get(recordId: string, ownerUserId: string): Promise<RecordDocument | null>; listByOwner(ownerUserId: string, filters: RecordListFilters, cursor: string | null, pageSize: number): Promise<RecordListPage>; findByWorkflow(workflowId: string): Promise<RecordDocument | null> }`
  - `class PostgresRecordStore implements RecordStore { constructor(pool: Pool) }`
  - `const MAX_PAGE_SIZE = 100`
  - `const DEFAULT_PAGE_SIZE = 20`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/record/store.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresRecordStore } from "../../src/record/postgresRecordStore";
import type { RecordDocument } from "../../src/record/types";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresRecordStore;

beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE records"); });
afterAll(async () => { await pool.end(); });

const rec = (id: string, owner: string, endedAt: number, over: Partial<RecordDocument> = {}): RecordDocument => ({
  record_id: id, workflow_id: `wf_${id}`, owner_user_id: owner,
  spec_versions: { workflow_spec: "0.4", capability_spec: "0.6" },
  created_at: 100, ended_at: endedAt, terminal_state: "COMPLETED", terminal_reason: null,
  completion_criteria: { mode: "open", revision: 0 },
  user_request: { text: "svc down" },
  summary: { problem_short: "svc down", terminal_state: "COMPLETED", result_short: "fixed", duration_ms: endedAt - 100 },
  entries: [{ entry_id: "e1", ts: 100, kind: "evidence_received",
    ref: { step_id: "step_1", evidence: { source: "capability", type: "git_status", result: {} } },
    narrative: "读取了 git_status。" }],
  final_result: { resolution: "advisory" }, ...over,
});

describe("PostgresRecordStore", () => {
  it("round-trips a record and enforces one record per workflow", async () => {
    await store.save(rec("rec_1", "usr_1", 200));
    expect((await store.get("rec_1", "usr_1"))!.summary.problem_short).toBe("svc down");

    // Same workflow_id again: the unique constraint must reject a second record.
    await expect(store.save(rec("rec_9", "usr_1", 300, { workflow_id: "wf_rec_1" }))).rejects.toThrow();
  });

  it("filters by owner so another user cannot see the record", async () => {
    await store.save(rec("rec_1", "usr_1", 200));
    expect(await store.get("rec_1", "usr_2")).toBeNull();
    expect((await store.listByOwner("usr_2", {}, null, 20)).records).toEqual([]);
  });

  it("filters by time range and keyword, newest first", async () => {
    await store.save(rec("rec_1", "usr_1", 200));
    await store.save(rec("rec_2", "usr_1", 300, { user_request: { text: "can bus" },
      summary: { problem_short: "can bus", terminal_state: "COMPLETED", result_short: "ok", duration_ms: 200 } }));

    const all = await store.listByOwner("usr_1", {}, null, 20);
    expect(all.records.map((r) => r.record_id)).toEqual(["rec_2", "rec_1"]);

    const ranged = await store.listByOwner("usr_1", { timeRange: { from: 250, to: 400 } }, null, 20);
    expect(ranged.records.map((r) => r.record_id)).toEqual(["rec_2"]);

    const keyword = await store.listByOwner("usr_1", { keyword: "CAN" }, null, 20);
    expect(keyword.records.map((r) => r.record_id)).toEqual(["rec_2"]);
  });

  it("paginates with an opaque cursor and caps the page size", async () => {
    for (let i = 0; i < 3; i++) await store.save(rec(`rec_${i}`, "usr_1", 200 + i));

    const first = await store.listByOwner("usr_1", {}, null, 2);
    expect(first.records).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = await store.listByOwner("usr_1", {}, first.next_cursor, 2);
    expect(second.records).toHaveLength(1);
    expect(second.next_cursor).toBeNull();

    const capped = await store.listByOwner("usr_1", {}, null, 9999);
    expect(capped.records).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/record/store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`004_records.sql`：`records(record_id text pk, workflow_id text unique not null, owner_user_id text not null, terminal_state text not null, ended_at bigint not null, document jsonb not null)`；索引 `records(owner_user_id, ended_at desc)`。`workflow_id` 的 **unique 约束**是"一份 Workflow 一份 Record"的保证。

`PostgresRecordStore`：`save` 插入整份 `document`（冲突即抛错）；`get` 按 `record_id + owner_user_id` 查询（owner 不匹配返回 `null`）；`listByOwner` 按 `owner_user_id` 过滤，`timeRange` 走 `ended_at`，`keyword` 用 `document->'summary'->>'problem_short' ILIKE` 或 `document->'entries'` 的 narrative（用 `document::text ILIKE` 覆盖 summary+narrative，注意转义）；排序 `ended_at DESC, record_id DESC`；cursor 用 base64 的 `ended_at:record_id`；`pageSize` 先 `Math.min(pageSize, MAX_PAGE_SIZE)`；`findByWorkflow` 用于幂等 finalize。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/record/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/migrations/004_records.sql packages/server/src/record packages/server/test/record/store.test.ts
git commit -m "feat(record): record store with owner scoping, filters and pagination"
```

---

### Task 4: Record 定型服务（先落盘后通知）

**Files:**
- Create: `packages/server/src/record/service.ts`
- Test: `packages/server/test/record/service.test.ts`

**Interfaces:**
- Consumes: Task 2 `buildRecord`；Task 3 `RecordStore`；P2a `WorkflowEngine`/`WorkflowStore`
- Produces:
  - `interface FinalizeResult { recordId: string | null; persistenceFailed: boolean }`
  - `class RecordService { constructor(deps: { store: RecordStore; workflowStore: WorkflowStore; retries?: number }); finalize(workflowId: string, userRequest: unknown): Promise<FinalizeResult> }`
  - `finalize` 语义：若已有 Record（`findByWorkflow`）→ 返回既有的 `recordId`（幂等）；否则构建并 `save`；`save` 失败按 `retries` 重试（默认 2），耗尽 → `{ recordId: null, persistenceFailed: true }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/record/service.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { PostgresRecordStore } from "../../src/record/postgresRecordStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RecordService } from "../../src/record/service";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let workflowStore: PostgresWorkflowStore;
let recordStore: PostgresRecordStore;
let engine: WorkflowEngine;

beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events, records");
  workflowStore = new PostgresWorkflowStore(pool);
  recordStore = new PostgresRecordStore(pool);
  engine = new WorkflowEngine({ store: workflowStore, now: () => 1000 });
});
afterAll(async () => { await pool.end(); });

const open = { mode: "open" as const, revision: 0 };

describe("RecordService.finalize", () => {
  it("builds and persists a record for a terminated workflow", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "svc down" }, open);
    await engine.confirmCompletion(wf.id, "solved");

    const service = new RecordService({ store: recordStore, workflowStore });
    const result = await service.finalize(wf.id, { text: "svc down" });

    expect(result.recordId).toMatch(/^rec_/);
    expect(result.persistenceFailed).toBe(false);
    const stored = await recordStore.get(result.recordId!, "usr_1");
    expect(stored!.terminal_state).toBe("COMPLETED");
  });

  it("is idempotent: a second finalize returns the same record", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");
    const service = new RecordService({ store: recordStore, workflowStore });

    const first = await service.finalize(wf.id, { text: "x" });
    const second = await service.finalize(wf.id, { text: "x" });

    expect(second.recordId).toBe(first.recordId);
  });

  it("reports persistence failure after exhausting retries", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");

    const failing = {
      ...recordStore,
      save: vi.fn().mockRejectedValue(new Error("disk full")),
      findByWorkflow: vi.fn().mockResolvedValue(null),
    } as unknown as PostgresRecordStore;
    const service = new RecordService({ store: failing, workflowStore, retries: 1 });

    expect(await service.finalize(wf.id, { text: "x" })).toEqual({
      recordId: null, persistenceFailed: true,
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/record/service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`finalize`：`findByWorkflow` 命中即返回既有 id（幂等）；否则读 workflow + steps + events，`buildRecord` 生成（`record_id = rec_<uuid>`），`save`；失败重试 `retries` 次（默认 2，指数退避可选）；耗尽返回 `{ recordId: null, persistenceFailed: true }`。**本服务不做任何协议发送**——"先落盘后通知"由协议层按 `FinalizeResult` 决定。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/record/service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/record/service.ts packages/server/test/record/service.test.ts
git commit -m "feat(record): finalize service with idempotency and persistence failure"
```

---

### Task 5: Report 生成

**Files:**
- Create: `packages/server/src/report/generate.ts`
- Test: `packages/server/test/report/generate.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的 `RecordDocument`
- Produces:
  - `type DetailLevel = "summary" | "full"`
  - `type ReportResult = { status: "ok"; format: "markdown"; content: string } | { status: "failed"; error_code: "generation_failed" | "insufficient_content" | "invalid_option" | "timeout"; message: string }`
  - `function generateReport(record: RecordDocument, detailLevel: DetailLevel): ReportResult`
  - `function resolveDetailLevel(value: unknown): DetailLevel | null`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/report/generate.test.ts
import { describe, it, expect } from "vitest";
import { generateReport, resolveDetailLevel } from "../../src/report/generate";
import type { RecordDocument } from "../../src/record/types";

const base: RecordDocument = {
  record_id: "rec_1", workflow_id: "wf_1", owner_user_id: "usr_1",
  spec_versions: { workflow_spec: "0.4", capability_spec: "0.6" },
  created_at: 0, ended_at: 60_000, terminal_state: "COMPLETED", terminal_reason: null,
  completion_criteria: { mode: "open", revision: 0 },
  user_request: { text: "项目起不来了" },
  summary: { problem_short: "项目起不来", terminal_state: "COMPLETED", result_short: "修复完成", duration_ms: 60_000 },
  entries: [
    { entry_id: "e1", ts: 1000, kind: "step_dispatched", ref: { step_id: "s1", capability: "git.collect_diagnostics", objective: "读日志" }, narrative: "下发了 git.collect_diagnostics。" },
    { entry_id: "e2", ts: 2000, kind: "evidence_received", ref: { step_id: "s1", evidence: { source: "capability", type: "git_status", result: {} } }, narrative: "读取了 git_status。" },
  ],
  final_result: { root_cause: "依赖缺失", resolution: "advisory", resolution_summary: "重装依赖后恢复" },
};

describe("generateReport", () => {
  it("defaults to full and renders the whole process", () => {
    expect(resolveDetailLevel(undefined)).toBe("full");
    const r = generateReport(base, "full");
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.content).toContain("# 诊断报告");
    expect(r.content).toContain("项目起不来");
    expect(r.content).toContain("读取了 git_status。");
    expect(r.content).toContain("重装依赖后恢复");
  });

  it("renders only the conclusion for the summary level", () => {
    const r = generateReport(base, "summary");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.content).not.toContain("读取了 git_status。");
    expect(r.content).toContain("修复完成");
  });

  it("surfaces unresolved side effects in the conclusion", () => {
    const record: RecordDocument = {
      ...base, terminal_state: "CANCELLED", terminal_reason: "user_cancelled",
      summary: { ...base.summary, terminal_state: "CANCELLED", result_short: "存在未对账的副作用动作" },
      final_result: { cancelled_summary: null, unresolved_side_effects: [
        { step_id: "step_9", capability: "sim_rig.trigger_reset", idempotency_key: "idem_9", last_known_state: "UNKNOWN" },
      ] },
    };
    const r = generateReport(record, "full");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.content).toContain("未被对账");
    expect(r.content).toContain("sim_rig.trigger_reset");
  });

  it("rejects an unknown detail level", () => {
    expect(resolveDetailLevel("verbose")).toBeNull();
    expect(resolveDetailLevel(undefined)).toBe("full");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/report/generate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按 `REPORT_SPEC.md` §5 的模板骨架生成 markdown：`summary` 档只用 `summary` + `final_result`；`full` 档额外列出 `entries`（直接复用 `narrative`，不重新组织语言）。结论段按 `terminal_state` 渲染，并在存在 `unresolved_side_effects` 时追加醒目提示（逐条列出 `step_id`/`capability`/`last_known_state`，**不推断成败**）。`resolveDetailLevel`：`undefined` → `"full"`；`"summary"|"full"` 原样；其它 → `null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/report/generate.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/report packages/server/test/report
git commit -m "feat(report): markdown report generation from a record"
```

---

### Task 6: Planner 接缝与工作流推进编排

**Files:**
- Create: `packages/server/src/workflow/planner.ts`
- Create: `packages/server/src/workflow/orchestrator.ts`
- Test: `packages/server/test/workflow/orchestrator.test.ts`

**Interfaces:**
- Consumes: P2a `WorkflowEngine`；Task 2 `CompletionCriteria`
- Produces:
  - `interface PlannerInput { workflow: WorkflowSnapshot; steps: StepSnapshot[]; events: WorkflowEvent[] }`
  - `type PlannerDecision = { kind: "step"; step: NewStep } | { kind: "completion_candidate"; summary: string; evidenceRefs: string[] }`
  - `interface Planner { proposeNext(input: PlannerInput): Promise<PlannerDecision> }`
  - `interface AdvanceResult { dispatched?: StepSnapshot; completionCandidate?: { summary: string; evidenceRefs: string[] } }`
  - `class WorkflowOrchestrator { constructor(deps: { engine: WorkflowEngine; store: WorkflowStore; planner: Planner }); advance(workflowId: string): Promise<AdvanceResult> }`
  - `advance` 语义：Workflow 非终态且**无活跃步**时问 Planner；`step` → `engine.dispatchStep`；`completion_candidate` → 返回候选（由协议层发消息），**不**改状态

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/orchestrator.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowOrchestrator, type Planner, type PlannerDecision } from "../../src/workflow/orchestrator";
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

const scripted = (decisions: PlannerDecision[]): Planner => ({
  proposeNext: async () => decisions.shift()!,
});

const open = { mode: "open" as const, revision: 0 };
const readStep = {
  objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true,
};

describe("WorkflowOrchestrator.advance", () => {
  it("dispatches the step the planner proposes", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const orch = new WorkflowOrchestrator({ engine, store, planner: scripted([{ kind: "step", step: readStep }]) });

    const result = await orch.advance(wf.id);

    expect(result.dispatched!.capability).toBe("git.collect_diagnostics");
    expect((await engine.get(wf.id))!.state).toBe("RUNNING");
  });

  it("returns a completion candidate without changing state", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const orch = new WorkflowOrchestrator({
      engine, store,
      planner: scripted([{ kind: "completion_candidate", summary: "看起来好了", evidenceRefs: ["step_1"] }]),
    });

    const result = await orch.advance(wf.id);

    expect(result.completionCandidate).toEqual({ summary: "看起来好了", evidenceRefs: ["step_1"] });
    expect((await engine.get(wf.id))!.state).toBe("CREATED");
  });

  it("does not ask the planner while a step is active", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    let calls = 0;
    const planner: Planner = { proposeNext: async () => { calls++; return { kind: "step", step: readStep }; } };
    const orch = new WorkflowOrchestrator({ engine, store, planner });

    await orch.advance(wf.id);
    const second = await orch.advance(wf.id);

    expect(calls).toBe(1);
    expect(second.dispatched).toBeUndefined();
  });

  it("does not ask the planner for a terminal workflow", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");
    let calls = 0;
    const planner: Planner = { proposeNext: async () => { calls++; return { kind: "step", step: readStep }; } };
    const orch = new WorkflowOrchestrator({ engine, store, planner });

    expect(await orch.advance(wf.id)).toEqual({});
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`advance(workflowId)`：读 Workflow；终态 → 返回 `{}`；有活跃步 → 返回 `{}`（One-Step Planning）；否则读 steps/events 调 `planner.proposeNext`；`step` → `engine.dispatchStep` 并返回 `{ dispatched }`；`completion_candidate` → 返回 `{ completionCandidate }`（**不改状态**，`completion_candidate` 事件的写入留给协议层在真正发出消息时做）。`planner.ts` 只放接口与类型；`orchestrator.ts` 放 `WorkflowOrchestrator`（并从 planner 重导出类型，便于导入）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/workflow/planner.ts packages/server/src/workflow/orchestrator.ts packages/server/test/workflow/orchestrator.test.ts
git commit -m "feat(workflow): planner seam and advance orchestration"
```

---

### Task 7: 协议接线——workflow / step / completion / cancel / terminated

**Files:**
- Create: `packages/server/src/protocol/workflowProtocol.ts`
- Test: `packages/server/test/protocol/workflowProtocol.test.ts`

**Interfaces:**
- Consumes: P2a `MessageRouter`/`SessionManager`/`WorkflowEngine`；Task 4 `RecordService`；Task 6 `WorkflowOrchestrator`
- Produces:
  - `interface WorkflowProtocolDeps { router: MessageRouter; sessions: SessionManager; engine: WorkflowEngine; store: WorkflowStore; orchestrator: WorkflowOrchestrator; records: RecordService; now?: () => number }`
  - `function registerWorkflowProtocol(deps: WorkflowProtocolDeps): void`
  - 注册的消息：`workflow.request` → `workflow.created` + 首次 `advance`；`step.status` → 引擎 + `advance`；`workflow.completion_response` → 引擎；`workflow.cancel_request` → `workflow.cancel_ack` + 可能的 `workflow.terminated`；**任何导致终止的路径**都先 `records.finalize` 再发 `workflow.terminated`
  - 发送的 `step.dispatch` 载荷：`{ workflow_id, step_id, objective, capability, input, expected_output, requires_confirmation, idempotency_key }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/workflowProtocol.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

// `startTestServer` gains an optional `planner` (see Step 3) so tests can
// script decisions without an LLM.
describe("workflow protocol", () => {
  it("creates a workflow, dispatches the first step and reaches COMPLETED with a record", async () => {
    const srv = await startTestServer({
      planner: [
        { kind: "step", step: { objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true } },
        { kind: "completion_candidate", summary: "看起来好了", evidenceRefs: [] },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: { client_request_id: "req_1", user_request: { text: "项目起不来了", attachments: [], context: {} } },
    });
    expect(created.type).toBe("workflow.created");
    const workflowId = (created.payload as any).workflow_id;

    const dispatch = await c.next();
    expect(dispatch.type).toBe("step.dispatch");
    expect((dispatch.payload as any).capability).toBe("git.collect_diagnostics");
    const stepId = (dispatch.payload as any).step_id;

    // RUNNING produces no reply (the step is still active — One-Step Planning),
    // so it is a fire-and-forget send.
    c.send({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" } });

    const candidate = await c.sendRaw({ ...c.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: {} } } });
    expect(candidate.type).toBe("workflow.completion_candidate");

    const terminated = await c.sendRaw({ ...c.base("workflow.completion_response"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, resolution: "solved" } });
    expect(terminated.type).toBe("workflow.terminated");
    expect((terminated.payload as any).terminal_state).toBe("COMPLETED");
    expect((terminated.payload as any).record_id).toMatch(/^rec_/);
    expect((terminated.payload as any).record_persistence_failed).toBe(false);

    await c.close(); await srv.close();
  });

  it("acks a cancel and terminates without a record when persistence fails", async () => {
    // An exhausted planner script yields a completion candidate by default.
    const srv = await startTestServer({ planner: [], failRecordPersistence: true });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const created = await c.sendRaw({ ...c.base("workflow.request"),
      payload: { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } } });
    const workflowId = (created.payload as any).workflow_id;
    await c.next(); // drain the completion_candidate

    const ack = await c.sendRaw({ ...c.base("workflow.cancel_request"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, reason: "user_cancelled" } });
    expect((ack.payload as any).workflow_status).toBe("CANCELLED");

    const terminated = await c.next();
    expect(terminated.type).toBe("workflow.terminated");
    expect((terminated.payload as any).record_id).toBeNull();
    expect((terminated.payload as any).record_persistence_failed).toBe(true);

    await c.close(); await srv.close();
  });

  it("refuses to operate another session's workflow", async () => {
    const srv = await startTestServer({ planner: [] });
    const a = await TestClient.connect(srv.url);
    await a.hello({ username: "alice", secret: "pw-alice" });
    const created = await a.sendRaw({ ...a.base("workflow.request"),
      payload: { client_request_id: "req_1", user_request: { text: "x", attachments: [], context: {} } } });
    const workflowId = (created.payload as any).workflow_id;

    const b = await TestClient.connect(srv.url);
    await b.hello({ username: "alice", secret: "pw-alice" });
    const err = await b.sendRaw({ ...b.base("step.status"), workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: "step_x", status: "RUNNING" } });

    expect((err.payload as any).code).toBe("unknown_workflow");
    await a.close(); await b.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/workflowProtocol.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`registerWorkflowProtocol` 按 `PROTOCOL_SPEC.md` §7 注册处理器：
- `workflow.request`：校验 `client_request_id`/`user_request`；`engine.create(user.id, session.id, user_request, { mode: "open", revision: 0 })`；回 `workflow.created`；随后 `orchestrator.advance` 并发送 `step.dispatch`（若返回 `completion_candidate` 则发 `workflow.completion_candidate`）。
- `step.status`：先校验 Workflow 属于当前 `session`（否则 `unknown_workflow`）；映射到 `engine.applyStepStatus`（带 `evidence`）；然后 `advance`（仅在 Step 到达终态时才有意义——`advance` 自己判断活跃步）；发送 `step.dispatch` 或 `workflow.completion_candidate`；若 Workflow 已终止 → `finalizeTermination`。
- `workflow.completion_response`：归属校验；`engine.confirmCompletion`；若终止 → `finalizeTermination`。
- `workflow.cancel_request`：归属校验；`engine.cancel`；回 `workflow.cancel_ack`（`CANCELLING` 或 `CANCELLED`）；若已终止 → `finalizeTermination`。
- `finalizeTermination(workflowId, userRequest)`：`records.finalize` → 发 `workflow.terminated { workflow_id, terminal_state, terminal_reason, record_id, record_persistence_failed }`；**只发一次**（用 `Set<string>` 记录已通知的 workflow）。
- `startTestServer`（`@adt/test-support`）增加 `planner?: PlannerDecision[]` 与 `failRecordPersistence?: boolean`，并注册本协议、把 `SessionManager`/`engine` 暴露给断言；同时**种入两个账号**：`alice`/`pw-alice` 与 `bob`/`pw-bob`（越权测试需要第二个用户）。
- **归属检查按 `session`**：`workflow.sessionId === session.id` 才允许操作（`session.resume` 尚未实现，跨 session 续接在 P2c）。不匹配 → `protocol.error(code=unknown_workflow)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/workflowProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/protocol packages/server/test/protocol packages/test-support
git commit -m "feat(protocol): wire workflow/step/completion/cancel/terminated with record-first ordering"
```

---

### Task 8: 协议接线——Record 查询与 Report 生成（含越权）

**Files:**
- Modify: `packages/server/src/protocol/workflowProtocol.ts`
- Test: `packages/server/test/protocol/recordProtocol.test.ts`

**Interfaces:**
- Consumes: Task 3 `RecordStore`；Task 5 `generateReport`；Task 7 的注册函数
- Produces:
  - 注册：`record.list_request` → `record.list_response`；`record.get_request` → `record.get_response`；`report.generate_request` → `report.generate_result`
  - `RecordProtocolDeps` 并入 `WorkflowProtocolDeps`：`records: RecordService` 之外再传 `recordStore: RecordStore`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/recordProtocol.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

async function completedWorkflow(planner: any) {
  const srv = await startTestServer({ planner });
  const c = await TestClient.connect(srv.url);
  await c.hello({ username: "alice", secret: "pw-alice" });
  const created = await c.sendRaw({ ...c.base("workflow.request"),
    payload: { client_request_id: "req_1", user_request: { text: "项目起不来了", attachments: [], context: {} } } });
  const workflowId = (created.payload as any).workflow_id;
  const dispatch = await c.next();
  await c.sendRaw({ ...c.base("step.status"), workflow_id: workflowId,
    payload: { workflow_id: workflowId, step_id: (dispatch.payload as any).step_id, status: "RUNNING" } });
  await c.next(); // completion_candidate
  const terminated = await c.sendRaw({ ...c.base("workflow.completion_response"), workflow_id: workflowId,
    payload: { workflow_id: workflowId, resolution: "solved" } });
  return { srv, c, recordId: (terminated.payload as any).record_id as string };
}

const script = [
  { kind: "step", step: { objective: "read", capability: "git.collect_diagnostics", sideEffect: false, interruptible: true } },
  { kind: "completion_candidate", summary: "看起来好了", evidenceRefs: [] },
];

describe("record and report protocol", () => {
  it("lists and fetches the caller's own record", async () => {
    const { srv, c, recordId } = await completedWorkflow(script);

    const list = await c.sendRaw({ ...c.base("record.list_request"),
      payload: { filters: { time_range: null, keyword: null, terminal_state: null }, cursor: null, page_size: 20 } });
    expect(list.type).toBe("record.list_response");
    expect((list.payload as any).records.map((r: any) => r.record_id)).toEqual([recordId]);

    const got = await c.sendRaw({ ...c.base("record.get_request"), payload: { record_id: recordId } });
    expect(got.type).toBe("record.get_response");
    expect((got.payload as any).record.owner_user_id).toBe(c.userId);

    await c.close(); await srv.close();
  });

  it("hides another user's record behind unknown_record", async () => {
    const { srv, c, recordId } = await completedWorkflow(script);
    // A DIFFERENT user: record visibility is scoped by owner_user_id
    // (ADR-003 §6). `@adt/test-support` seeds `alice` and `bob`.
    const other = await TestClient.connect(srv.url);
    await other.hello({ username: "bob", secret: "pw-bob" });

    const err = await other.sendRaw({ ...other.base("record.get_request"), payload: { record_id: recordId } });
    expect((err.payload as any).code).toBe("unknown_record");
    expect(JSON.stringify(err.payload)).not.toContain("owner_user_id");

    await c.close(); await other.close(); await srv.close();
  });

  it("generates a full markdown report and rejects an invalid detail level", async () => {
    const { srv, c, recordId } = await completedWorkflow(script);

    const ok = await c.sendRaw({ ...c.base("report.generate_request"),
      payload: { record_id: recordId, options: { detail_level: "full" } } });
    expect(ok.type).toBe("report.generate_result");
    expect((ok.payload as any).status).toBe("ok");
    expect((ok.payload as any).report.format).toBe("markdown");
    expect((ok.payload as any).report.content).toContain("# 诊断报告");

    const bad = await c.sendRaw({ ...c.base("report.generate_request"),
      payload: { record_id: recordId, options: { detail_level: "verbose" } } });
    expect((bad.payload as any).status).toBe("failed");
    expect((bad.payload as any).error_code).toBe("invalid_option");

    await c.close(); await srv.close();
  });

  it("answers unknown_record for a missing record id", async () => {
    const srv = await startTestServer({ planner: [] });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const err = await c.sendRaw({ ...c.base("record.get_request"), payload: { record_id: "rec_nope" } });
    expect((err.payload as any).code).toBe("unknown_record");

    await c.close(); await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/recordProtocol.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按 `PROTOCOL_SPEC.md` §10/§11 注册：
- `record.list_request`：`recordStore.listByOwner(session.userId, filters, cursor, pageSize)` → `record.list_response { records, next_cursor }`；`filters.time_range` 的 ISO 字符串转 epoch ms（闭区间）。
- `record.get_request`：`recordStore.get(record_id, session.userId)`；`null` → `protocol.error(code=unknown_record)`（**不区分"不存在"与"不属于你"**）。
- `report.generate_request`：`recordStore.get(...)` 为空 → `unknown_record`；`resolveDetailLevel(options.detail_level)` 为 `null` → `report.generate_result { status: "failed", error_code: "invalid_option" }`；否则 `generateReport` → `report.generate_result { record_id, status, report, error_code: null, message: null }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/recordProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/protocol packages/server/test/protocol/recordProtocol.test.ts
git commit -m "feat(protocol): record query and report generation with owner scoping"
```

---

## Self-Review

**1. Spec coverage：** Record 结构与忠实性 → T2；持久化与查询语义 → T3；先落盘后通知与幂等 → T4/T7；Report 模板与失败返回 → T5/T8；协议消息 → T7/T8；授权与可见性 → T7/T8；`UNKNOWN` 未对账呈现 → T2/T5。**刻意留给后续**：`session.resume`/去重窗口与 `ERROR_DISPOSITION` 驱动（P2c）、LLM 规划与 Capability schema 校验（P3）、受控执行确认/对账编排/blob/KB 导出（P4）。

**2. Step scan：** 每步一个动作；实现步给签名与规则，不给完整函数体。

**3. Type consistency：** `RecordDocument`/`RecordEntry`/`RecordSummary`/`RecordStore`/`RecordService`/`DetailLevel`/`ReportResult`/`Planner`/`PlannerDecision`/`WorkflowOrchestrator`/`registerWorkflowProtocol` 在 T2–T7 定义，T8 复用同名。

**4. Review Focus：** 五条风险落到测试——(1) 忠实性 → T2（"never invents entries"）；(2) 落盘失败 → T4/T7（`record_persistence_failed`）；(3) 越权 → T8（`unknown_record` + 不泄露字段）；(4) 未对账 `UNKNOWN` → T2/T5；(5) 重复终止 → T3（`workflow_id` 唯一）+ T4（幂等）。

**5. Proportion：** 计划只描述决策、接口与断言，不含实现体。

## 移交后续计划的待办（P2b 收尾时确认延后）

1. **`guardrail_triggered.ref.threshold` 恒为 `null`；`reconciliation_resolved.ref.evidence_refs` 恒为 `[]`**（M3）→ **P4**：对账编排在 P4 才有 `evidence_refs`；threshold 可在同一次改动里从护栏配置带入。
2. **`finalize` 不校验"必须已终止"；`completion_response(solved)` 不要求前置 candidate**（M7）→ **接受现状**（协议只对终态 finalize；"工程师提前判定已解决"符合产品原则 1），若后续要收紧，在 P2c 一并加守卫。
3. **Record 只存最新 `completion_criteria`，不含修订历史**（M8）→ **P3**：P3 接入 LLM 规划后才会有 `criteria_revised` 事件可收集。
4. **`user_input` entry 未发出**（I5 剩余）→ **P4**：确认/输入流程在 P4；届时还需在 `step_status` 事件里携带 `waitClass` 才能区分 `user_input`。

## 后续

P2b 验收通过后写 **P2c**：`ERROR_DISPOSITION` 真正驱动行为、`session.resume` + `workflow.state_sync`、去重窗口改**逻辑会话**生命周期、补 P1 遗留的测试覆盖。之后 P3（LLM 只读闭环）、P4（受控执行/对账/blob/KB 导出）。
