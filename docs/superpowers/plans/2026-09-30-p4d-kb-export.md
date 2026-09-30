# P4d KB 导出（ADR-005 出站）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ADR-005` 的**导出半边**真正做出来：提交人显式把一条 Record（默认）或 Report 投递给**配置的 KB 接收端点**，同步拿到"已接收/失败"的结论；未配置就明确回 `export_unavailable`，绝不假装成功。

**Architecture:** 三段。**投递包**由纯函数生成（`deposit_version` / 稳定 `deposit_id` / `content_sha256` / `submitted_at` / `content`），这样去重键可单测、可复现。**出站**是一个可注入的 `KnowledgeDepositor` 接缝，生产实现 `HttpKnowledgeDepositor` 负责 POST、鉴权、超时与**有限重试**（ADR-005 §5 的表格就是它的规格）。**协议层**在既有的 `record.export_request` 上接线：按 `object` 取 Record（可见性同 §10）或据其生成 Report，调 depositor，回 `record.export_result`。导出**不修改** Record，也**不影响** Workflow 状态。

**Tech Stack:** TypeScript（strict）· Node.js LTS（`node:crypto`、全局 `fetch`）· Vitest · pnpm workspace（沿用 P1–P4c 结构）

**Spec:** `docs/adr/ADR-005-kb-integration-contract.md`（§2 传输与鉴权、§3 投递包、§4 投递语义、§5 失败与重试）、`docs/specs/PROTOCOL_SPEC.md`（§10.3 协议面与 `error_code`、§10 可见性）、`docs/specs/RECORD_SPEC.md`（§6 `spec_versions`、原则 7 导出不改 Record）、`docs/specs/REPORT_SPEC.md`（Report 生成）、`docs/REQUIREMENTS.md`（FR-24）

## Global Constraints

- **严格按用户选择投递**（ADR-005 §3）：`object=report` 时**只**投递 Report，**不**附带 Record——"导出 Report"可能就是刻意不暴露原始 Evidence。
- **同步投递**（ADR-005 §4）：在 `record.export_request` 的处理过程中完成出站。`ok` 只表示"KB 端点已接收（2xx）"，**不等于已被收录**；本系统不追踪审核状态。
- **失败语义与重试**（ADR-005 §5，逐行照做）：
  | 情况 | `error_code` | 重试 |
  |---|---|---|
  | 未配置端点 / 凭据 | `export_unavailable` | 否 |
  | 网络错误 / 超时 / `5xx` | `export_failed` | **是**（默认 2 次，指数退避） |
  | `4xx`（鉴权失败 / 格式不被接受） | `export_failed`（`message` 说明） | **否** |
  | `object` 非法 | `invalid_object` | 否 |
- **导出不改 Record**（`RECORD_SPEC.md` 原则 7）：本阶段不写任何存储，只有读 + 出站。
- **凭据只在 Server 端**（ADR-005 §2）：不下发 Client、不写入 Record、不写进日志/错误信息。
- **稳定 `deposit_id`**：`hash(record_id, object, content_sha256)`——内容不变则键不变，KB 可据此去重；**重复导出是允许的**。
- **超时**：默认 **10s**（ADR-005 §4 建议值）。**最坏耗时** = `timeout × (maxRetries + 1)` + 退避总和（默认 30s + 1.5s）；ADR 明确把超时列为可重试，所以这条上界要写进文档。
- **`submitted_at` 用墙钟**（与 `RECORD_SPEC.md` §6.1 的时间基准一致）；测试可注入时钟。
- **不 push**；合并用本地 `ff-merge`（`docs/superpowers/WORKFLOW.md`）。
- **文档纪律**：`PROTOCOL_SPEC.md` v0.11 → **v0.12**（§10.3 的"由后续 ADR 定义"改为指向 `ADR-005` 并写明已实现）、`SERVER_SPEC.md` v0.11 → **v0.12**（职责清单增"按 ADR-005 出站导出"，并更新"仍未实现"那段）、`ADR-005` §1 的实现状态补注、`docs/REQUIREMENTS.md` §7 两行 + FR-24 的落实说明、`README.md` 当前状态。

## Review Focus

以下失败模式规格隐含、但默认的测试不会覆盖，**每条都必须在对应任务里有测试**：

1. **不能假装成功**：未配置端点时必须回 `export_unavailable`，绝不能返回 `ok`；`4xx` 必须回 `export_failed` 且**不重试**（否则把"格式不被接受"重试成"反复投递"）。见 Task 2/3。
2. **`report` 不得夹带 Record**：`object=report` 的投递包里**只有** Report（ADR-005 §3 的意图是"可能刻意不暴露原始日志"）。见 Task 1/3。
3. **去重键必须稳定**：同一 Record、同一 object → 同一 `deposit_id`（重复导出可被 KB 去重）；object 或内容变了 → 键要变。见 Task 1。
4. **凭据不得泄漏**：任何失败信息（`message`）里不能出现 token / Authorization 头。见 Task 2。
5. **导出不得有副作用**：导出前后 Record 的内容与 `record.list/get` 的结果一致（原则 7）。见 Task 3。

---

### Task 1: 投递包（纯函数，可复现）

**Files:**
- Create: `packages/server/src/kb/deposit.ts`
- Test: `packages/server/test/kb/deposit.test.ts`（新建）

**Interfaces:**
- Produces:
  - `type DepositObject = "record" | "report"`
  - `interface DepositPayload { deposit_version: "1"; deposit_id: string; source: "adt_ai_agent_system"; record_id: string; workflow_id: string; owner_user_id: string; object: DepositObject; spec_versions?: Record<string, string>; content_sha256: string; submitted_at: string; content: unknown }`
  - `buildDeposit(input: { record: RecordDocument; object: DepositObject; report?: { format: "markdown"; content: string }; now: () => number }): DepositPayload`
  - `content_sha256` = `sha256` of the canonical JSON of `content`（键序稳定，便于复现）；`deposit_id` = `sha256(\`${record_id}|${object}|${content_sha256}\`)`，前缀 `dep_`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/kb/deposit.test.ts
import { describe, it, expect } from "vitest";
import { buildDeposit } from "../../src/kb/deposit";
import type { RecordDocument } from "../../src/record/types";

const record = {
  record_id: "rec_1",
  workflow_id: "wf_1",
  owner_user_id: "usr_1",
  spec_versions: { workflow_spec: "0.7", capability_spec: "0.11" },
  created_at: 1,
  ended_at: 2,
  terminal_state: "COMPLETED",
  entries: [],
} as unknown as RecordDocument;

const now = () => 1_700_000_000_000;

describe("buildDeposit", () => {
  it("is stable for the same record and object", () => {
    const a = buildDeposit({ record, object: "record", now });
    const b = buildDeposit({ record, object: "record", now });

    expect(a.deposit_id).toBe(b.deposit_id);
    expect(a.deposit_version).toBe("1");
    expect(a.source).toBe("adt_ai_agent_system");
    expect(a.submitted_at).toBe("2023-11-14T22:13:20.000Z");
    expect(a.spec_versions).toEqual({ workflow_spec: "0.7", capability_spec: "0.11" });
  });

  it("changes the key when the object changes", () => {
    const asRecord = buildDeposit({ record, object: "record", now });
    const asReport = buildDeposit({
      record,
      object: "report",
      report: { format: "markdown", content: "# 报告" },
      now,
    });

    expect(asReport.deposit_id).not.toBe(asRecord.deposit_id);
    // A report deposit carries the report only — never the raw record.
    expect(asReport.content).toEqual({ format: "markdown", content: "# 报告" });
    expect(asReport.spec_versions).toBeUndefined();
    expect(JSON.stringify(asReport)).not.toContain("\"entries\"");
  });

  it("changes the key when the content changes", () => {
    const a = buildDeposit({ record, object: "record", now });
    const b = buildDeposit({
      record: { ...record, terminal_state: "FAILED" } as unknown as RecordDocument,
      object: "record",
      now,
    });
    expect(b.deposit_id).not.toBe(a.deposit_id);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/kb/deposit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

按 Interfaces 实现。要点：canonical JSON = 递归按 key 排序后 `JSON.stringify`（这样同一内容总是同一摘要）；`content` 对 `record` 是**整份成品文档**，对 `report` 是 `{format, content}`；`submitted_at` 用 `new Date(now()).toISOString()`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/kb/deposit.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/kb/deposit.ts packages/server/test/kb/deposit.test.ts
git commit -m "feat(kb): a stable, reproducible deposit payload"
```

---

### Task 2: 出站投递（`KnowledgeDepositor` + HTTP 实现 + 配置）

**Files:**
- Create: `packages/server/src/kb/depositor.ts`、`packages/server/src/kb/config.ts`
- Test: `packages/server/test/kb/depositor.test.ts`（新建）

**Interfaces:**
- Produces:
  - `interface DepositOutcome` = `{ status: "ok" }` | `{ status: "failed"; error_code: "export_unavailable" | "export_failed"; message: string }`
  - `interface KnowledgeDepositor { deposit(payload: DepositPayload): Promise<DepositOutcome> }`
  - `interface KbConfig { endpointUrl: string; authHeader: string; authScheme: string; token: string; timeoutMs: number; maxRetries: number; retryBaseMs: number }`、`kbConfigFromEnv(env): KbConfig | null`（**端点或凭据缺失 → `null`**，对应 ADR-005 §5 的"未配置端点 / 凭据 → `export_unavailable`"）
  - `createHttpDepositor(config: KbConfig, deps?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): KnowledgeDepositor`
  - 重试判定与 ADR-005 §5 一一对应：网络错误/超时/`5xx` → 重试；`4xx` → 不重试；耗尽后 `export_failed`
    * 注意这与 LLM provider 的策略**故意不同**：ADR-005 明确把超时列为可重试，所以这里**重试超时**（代价是最坏 `timeout × (maxRetries+1)`，写进文档）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/kb/depositor.test.ts
import { describe, it, expect } from "vitest";
import { createHttpDepositor } from "../../src/kb/depositor";
import { kbConfigFromEnv } from "../../src/kb/config";
import type { DepositPayload } from "../../src/kb/deposit";

const payload = { deposit_id: "dep_1" } as unknown as DepositPayload;
const config = {
  endpointUrl: "http://kb.test/deposit",
  authHeader: "Authorization",
  authScheme: "Bearer",
  token: "s3cret",
  timeoutMs: 50,
  maxRetries: 2,
  retryBaseMs: 500,
};

function depositorWith(responses: Array<Response | Error>, over: Record<string, unknown> = {}) {
  let attempts = 0;
  const sleeps: number[] = [];
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const depositor = createHttpDepositor(
    { ...config, ...over },
    {
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        const next = responses[Math.min(attempts, responses.length - 1)]!;
        attempts++;
        if (next instanceof Error) throw next;
        return next;
      }) as unknown as typeof fetch,
    },
  );
  return { depositor, attempts: () => attempts, sleeps, seen };
}

describe("HttpKnowledgeDepositor", () => {
  it("posts the deposit with the configured auth", async () => {
    const h = depositorWith([new Response(null, { status: 202 })]);

    expect(await h.depositor.deposit(payload)).toEqual({ status: "ok" });
    expect(h.seen[0]!.url).toBe("http://kb.test/deposit");
    expect((h.seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(h.seen[0]!.init.body).toBe(JSON.stringify(payload));
  });

  it("retries a 5xx and a network error, then succeeds", async () => {
    const h = depositorWith([
      new Response("boom", { status: 503 }),
      new TypeError("fetch failed"),
      new Response(null, { status: 200 }),
    ]);

    expect(await h.depositor.deposit(payload)).toEqual({ status: "ok" });
    expect(h.attempts()).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  it("does not retry a 4xx and explains it", async () => {
    const h = depositorWith([new Response("bad format", { status: 422 })]);

    const outcome = await h.depositor.deposit(payload);
    expect(outcome).toMatchObject({ status: "failed", error_code: "export_failed" });
    expect(h.attempts()).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    const h = depositorWith([new Response("boom", { status: 500 })], { maxRetries: 1 });

    expect(await h.depositor.deposit(payload)).toMatchObject({
      status: "failed",
      error_code: "export_failed",
    });
    expect(h.attempts()).toBe(2);
  });

  it("never leaks the token in a failure message", async () => {
    const h = depositorWith([new Response("denied", { status: 401 })]);

    const outcome = await h.depositor.deposit(payload);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("s3cret");
  });

  it("retries a timeout, because ADR-005 §5 lists it as retryable", async () => {
    // Deliberately different from the LLM provider, which does not retry its own
    // timeout; here the contract says to retry, so the worst case is bounded by
    // the documented `timeout × (maxRetries + 1)`.
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const h = depositorWith([timeout, new Response(null, { status: 200 })]);

    expect(await h.depositor.deposit(payload)).toEqual({ status: "ok" });
    expect(h.attempts()).toBe(2);
  });
});

describe("kbConfigFromEnv", () => {
  it("is unavailable without an endpoint or without credentials", () => {
    expect(kbConfigFromEnv({})).toBeNull();
    expect(kbConfigFromEnv({ KB_ENDPOINT_URL: "http://kb.test" })).toBeNull();
    expect(kbConfigFromEnv({ KB_TOKEN: "t" })).toBeNull();
    expect(kbConfigFromEnv({ KB_ENDPOINT_URL: "", KB_TOKEN: "t" })).toBeNull();
  });

  it("applies the documented defaults and honours overrides", () => {
    const base = kbConfigFromEnv({ KB_ENDPOINT_URL: "http://kb.test", KB_TOKEN: "t" })!;
    expect(base).toMatchObject({
      authHeader: "Authorization",
      authScheme: "Bearer",
      timeoutMs: 10_000,
      maxRetries: 2,
    });

    const custom = kbConfigFromEnv({
      KB_ENDPOINT_URL: "http://kb.test",
      KB_TOKEN: "t",
      KB_AUTH_HEADER: "X-API-Key",
      KB_AUTH_SCHEME: "",
      KB_TIMEOUT_MS: "3000",
      KB_MAX_RETRIES: "0",
    })!;
    expect(custom).toMatchObject({
      authHeader: "X-API-Key",
      authScheme: "",
      timeoutMs: 3000,
      maxRetries: 0,
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/kb/depositor.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`depositor.ts`：`POST` + `Content-Type: application/json` + `${authScheme ? `${authScheme} ` : ""}${token}` 放进 `authHeader`（`authScheme` 为空即裸 token，适配 `X-API-Key` 这类自定义头）；`AbortSignal.timeout(timeoutMs)`；网络错误/超时/`5xx` 重试（指数退避），`4xx` 立即失败；错误信息只写状态码与响应体片段（**不碰 header**）。
`config.ts`：`kbConfigFromEnv` 读 `KB_ENDPOINT_URL` / `KB_AUTH_HEADER`（默认 `Authorization`）/ `KB_AUTH_SCHEME`（默认 `Bearer`）/ `KB_TOKEN` / `KB_TIMEOUT_MS`（默认 10000）/ `KB_MAX_RETRIES`（默认 2）；**端点或 token 缺失/空 → `null`**（导出不可用）。数值解析沿用 `LLM_MAX_RETRIES` 那套严格口径（空串/非整数/负数回落默认值）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/kb/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/kb packages/server/test/kb/depositor.test.ts
git commit -m "feat(kb): outbound depositor with ADR-005 failure semantics"
```

---

### Task 3: 协议接线 `record.export_request`

**Files:**
- Modify: `packages/server/src/protocol/workflowProtocol.ts`（`WorkflowProtocolDeps` 增 `knowledgeDepositor?: KnowledgeDepositor | null`）、`packages/server/src/index.ts`、`packages/test-support/src/server.ts`
- Test: `packages/server/test/protocol/export.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `buildDeposit`、Task 2 的 `KnowledgeDepositor`、既有 `recordStore.get(recordId, userId)` 与 `generateReport`
- Produces: `record.export_request` → `record.export_result`
  - `object` 非 `record`/`report` → `{status:"failed", error_code:"invalid_object", message}`
  - Record 不存在或不属于自己 → `protocol.error(unknown_record)`（与 §10 一致）
  - `object=report` → 先用既有 `generateReport` 生成；生成失败 → `{status:"failed", error_code:"export_failed", message}`
  - 未配置 depositor（`null`/`undefined`）→ `{status:"failed", error_code:"export_unavailable", message}`
  - 否则 `depositor.deposit(buildDeposit(...))` 的结果原样映射到 `status`/`error_code`/`message`
  - 失败**不影响** Workflow 状态（此时 Workflow 早已终止；本阶段不碰任何状态）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/protocol/export.test.ts
// 用既有 recordProtocol.test.ts 的夹具（起测试服务器 + 跑完一个 Workflow 拿到 recordId），断言：
// 1) 注入一个"总是 ok"的假 depositor → record.export_result {status:"ok"}，
//    且 depositor 收到的 payload.object === "record"、content 是整份文档
// 2) object: "report" → payload.object === "report"、content 形如 {format:"markdown", content: string}，
//    且 payload 里**没有** entries（不夹带 Record）
// 3) object: "nonsense" → {status:"failed", error_code:"invalid_object"}
// 4) 不注入 depositor（未配置）→ {status:"failed", error_code:"export_unavailable"}
// 5) depositor 回 failed → 结果原样透出 error_code/message
// 6) record_id 不存在 → protocol.error(code="unknown_record")
// 7) 导出前后 record.get 的结果不变（原则 7）
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/protocol/export.test.ts`
Expected: FAIL（没有该 handler → `unknown_message_type`）

- [ ] **Step 3: 实现**

在 `registerWorkflowProtocol` 里注册 `record.export_request`（放在 `report.generate_request` 之后）；`index.ts` 与 `test-support` 把 `kbConfigFromEnv(process.env)` 的 depositor 传进去（测试可注入假实现）。注意：**同步**等待出站（ADR-005 §4），失败只回消息、不改状态。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/protocol/`
Expected: PASS（既有 record/report 协议测试不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src packages/test-support/src packages/server/test/protocol/export.test.ts
git commit -m "feat(protocol): export a record or report to the knowledge base"
```

---

### Task 4: 端到端——真实 HTTP 出站

**Files:**
- Test: `packages/server/test/kb/export.e2e.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1–3；一个**本地假 KB 端点**（用 `node:http` 起一个只收 `POST` 的服务）
- Produces: 验收——真的发了一次 HTTP POST：请求体是投递包、带上了配置的鉴权头；KB 回 `2xx` → 客户端拿到 `ok`；KB 回 `4xx` → `export_failed` 且**只尝试一次**；KB 先 `503` 后 `200` → 重试后 `ok`（尝试 2 次）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/kb/export.e2e.test.ts
// 1) 起 node:http 假端点，记录每次请求的 headers/body，按预设脚本回状态码
// 2) startTestServer({ knowledgeDepositor: createHttpDepositor({ endpointUrl: `http://127.0.0.1:${port}/deposit`, ... }) })
// 3) 跑完一个 Workflow → record.export_request → 断言状态、尝试次数、收到的投递包字段
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/kb/export.e2e.test.ts`
Expected: FAIL（handler / 注入点尚不存在）

- [ ] **Step 3: 实现（补齐缺口）**

修正暴露的缺口直到闭环成立；**不得**为过测试放宽 Server 侧校验，也不得让"未配置"看起来像成功。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/kb/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/test/kb/export.e2e.test.ts packages/server/src
git commit -m "test(kb): export really leaves the building over HTTP"
```

---

### Task 5: 规格与文档同步

**Files:**
- Modify: `docs/specs/PROTOCOL_SPEC.md`（v0.11 → **v0.12**：§10.3 的"实际出站…由后续 KB 集成 ADR 定义"改为指向 `ADR-005`，并写明已实现、以及同步投递的代价）
- Modify: `docs/architecture/SERVER_SPEC.md`（v0.11 → **v0.12**：职责清单增"按 `ADR-005` 出站导出 Record/Report"；更新"仍未实现"那段——出站已实现，只剩 FR-23 检索）
- Modify: `docs/adr/ADR-005-kb-integration-contract.md`（§1 的实现状态补注：出站已实现（P4d）；并记下**本阶段不做**的事——见下）
- Modify: `docs/REQUIREMENTS.md`（§7 两行版本；FR-24 的落实说明）
- Modify: `README.md`（当前状态补 P4d + KB 相关环境变量）

**Interfaces:**
- Consumes: Task 1–4
- Produces: 文档与实现一致

- [ ] **Step 1: 改四份文档**

`README.md` 的 LLM 段旁边补 KB 配置（`KB_ENDPOINT_URL` / `KB_AUTH_HEADER` / `KB_AUTH_SCHEME` / `KB_TOKEN` / `KB_TIMEOUT_MS` / `KB_MAX_RETRIES`，未配置 → `export_unavailable`）。`ADR-005` 里明确记录本阶段**不做**：① **blob 引用不随导出解析**（投递包里的 `content_ref` 只是引用，KB 拿不到字节——要真正把大体积证据交给 KB 需要按其存储接口另做决定）；② FR-23 检索；③ 审核状态回读。

- [ ] **Step 2: 验证**

Run: `for f in WORKFLOW_SPEC CAPABILITY_SPEC PROTOCOL_SPEC RECORD_SPEC SERVER_SPEC; do …比较自身版本与 REQUIREMENTS §7 引用…; done`
Expected: 全部 `OK`

- [ ] **Step 3: 提交**

```bash
git add docs/ README.md
git commit -m "docs: the export half is implemented, and what it still does not do"
```

---

## Self-Review

**1. Spec coverage：** ADR-005 §2 传输与鉴权 → T2；§3 投递包 → T1；§4 同步投递与超时 → T2/T3；§5 失败与重试表 → T2（逐行）+ T3（协议映射）；§6 检索接口预留 → **本阶段不做**（ADR 已定，只占位）；`PROTOCOL_SPEC` §10.3 的协议面与 `error_code` → T3；可见性 → T3；原则 7（导出不改 Record）→ T3 的测试 7。**刻意不做**：blob 解析、FR-23 检索、审核状态、多 KB 路由、异步投递。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支。

**3. Type consistency：** `DepositPayload`/`buildDeposit`（T1）、`KnowledgeDepositor`/`DepositOutcome`/`KbConfig`/`kbConfigFromEnv`/`createHttpDepositor`（T2）、`WorkflowProtocolDeps.knowledgeDepositor`（T3）在各任务间同名复用；`error_code` 取值与 `PROTOCOL_SPEC` §10.3 完全一致（`export_unavailable` / `export_failed` / `invalid_object`）。

**4. Review Focus：** 五条风险落到测试——不假装成功（T3 第 4/5 例）、report 不夹带 Record（T1 第 2 例 + T3 第 2 例）、去重键稳定（T1）、凭据不泄漏（T2 第 5 例）、导出无副作用（T3 第 7 例）。

**5. Proportion：** 计划只描述决策、接口与断言；T3/T4 的测试写"断言清单"（夹具要复用既有 record 协议测试与 `node:http` 写法）。

**6. 执行顺序依赖：** T1 → T2 → T3 → T4（投递包 → 出站 → 接线 → 真实 HTTP 验收）；T5 最后。

## 移交后续计划的待办

1. **D7（b）`client-cli`**：控制台客户端（确认 / 建议 / 资源冲突 / Record·Report 阅读 / blob 取回 / **导出触发**）——本阶段之后。
2. **D6（a）**：真实 Windows 适配器的调研简报。
3. **blob 与导出**：投递包里的 `content_ref` 需要按 KB 的存储接口决定"上传字节 / 内联小文件 / 只给引用"。
4. **FR-23 KB 检索**：`KnowledgeProvider` 接口预留（ADR-005 §6），等目标 KB 确定。
5. 其余延后项见前几份计划的裁决表。
