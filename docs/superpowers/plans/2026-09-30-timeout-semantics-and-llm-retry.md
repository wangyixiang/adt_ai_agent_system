# D4+D5（超时语义统一 + LLM 有界重试）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **编号说明：** 本阶段是审计遗留项的第二批（D4、D5），**先于 P4d（KB 导出）**落地。按 `WORKFLOW.md` 的流程：分支 → 逐任务 TDD → 一次整分支 review → 修复 + 评审项裁决表 → 文档交叉检查 → 本地 ff-merge（不 push）。**D6 的调研简报与 D7 的 `client-cli` 不在本阶段。**

**Goal:** 清掉两处"信息丢失"：① **超时语义在两端统一**——副作用超时无论由哪一端触发都判 `UNKNOWN`（它可能已部分生效），只读超时才是 `FAILED(timeout)`，并让服务端的 `step_timeout` 比客户端的本地上限**略晚**，使客户端的观察优先；② **LLM 调用有界重试**——只对可重试失败（429 / 5xx / 网络）做指数退避，**不重试**模型语义错误，最终仍以 `planner_error` 收场。

**Architecture:** 两处各自独立。**超时**分两半：客户端在 `stepRunner` 的失败分支加一条规则（`side_effect` + `code === "timeout"` → `UNKNOWN`，且**不清除**台账标记，这样重连重发仍然报 `UNKNOWN`）；服务端在编排层给快照的 `timeoutMs` 加一个可配宽限（默认 2s），让"客户端自己判超时"这条路径在多数情况下先到。**重试**放在 `LlmProvider` 的**实现**里（`OpenAiCompatibleProvider`），因为那是唯一知道 HTTP 语义的地方；引擎与编排层的确定性失败规则不变——重试只发生在一次 `proposeNext` 调用内部，不会重复派发 Step。

**Tech Stack:** TypeScript（strict）· Node.js LTS · Vitest · pnpm workspace（沿用 P1–P4c 结构）

**Spec:** `docs/specs/PROTOCOL_SPEC.md`（§9 `step_timeout` 与人类等待豁免）、`docs/specs/CAPABILITY_SPEC.md`（§2.4 `timeout_hint`）、`docs/specs/WORKFLOW_SPEC.md`（§4.3 结果未知与对账）、`docs/adr/ADR-004-tech-stack.md`（§2 LLM Provider 抽象）、`docs/REQUIREMENTS.md`（NFR-5 可靠性方向）

## Global Constraints

- **副作用超时 → `UNKNOWN`，两端一致**（本阶段确立）：`FAILED(timeout)` 只用于**只读**步骤；副作用被"到点掐掉"意味着可能已部分生效，那是"结果未知"，不是"确定失败"。
- **客户端造成的副作用超时同样保留台账标记**：`UNKNOWN` 与"执行中"是同一件事的两种说法，标记**不得**清除（`forget()` 只在 `failed`/`rejected` 这类"确实没发生"的终态上调用）。
- **服务端宽限**：`step_timeout = 依据值 + 宽限`，依据值 = 显式 `timeoutMs` ?? 能力 `timeout_hint` ?? 全局默认；宽限默认 **2000ms**，可通过编排层依赖覆盖（测试用 0）。理由写进 `PROTOCOL_SPEC.md` §9：让客户端自己的本地超时先到，客户端的观察优先于服务端推断。
- **重试只针对可重试失败**：HTTP `429` 与 `5xx`、以及**网络错误**（fetch 抛出）。**不重试**其它 `4xx`、**不重试我们自己的超时**（`TimeoutError`/`AbortError`：请求已经等满 `timeoutMs`，重试只会把最坏耗时放大三倍）、也**不重试**响应体解析失败与工具调用形状错误（`name` 缺失 / `arguments` 非 JSON / 非对象）——那是模型语义问题，重试只会重复犯错。最终失败仍抛错 → 编排层 `FAILED(planner_error)`（既有规则不变）。
- **重试参数**：`maxRetries` 默认 **2**（最多 3 次尝试）、`retryBaseMs` 默认 **500**（指数：500ms、1000ms）；`sleep` 可注入以便测试不真等。**最坏耗时 = `timeoutMs × (maxRetries + 1)` + 退避总和**（每次尝试各有独立的 `timeoutMs` 窗口）；**我们自己的超时不重试**，所以"挂死"只花一个窗口。生产可用 `LLM_MAX_RETRIES=0` 关闭重试，或调小 provider 的 `timeoutMs`。
- **一次 `proposeNext` 内重试，绝不重复派发**：重试不得触发第二次 `dispatchStep`；本阶段不引入任何"重试 Step"的行为。
- **不 push**；合并用本地 `ff-merge`（`docs/superpowers/WORKFLOW.md`）。
- **文档纪律**：`PROTOCOL_SPEC.md` v0.10 → **v0.11**（§9 宽限与客户端本地超时的分流）、`CAPABILITY_SPEC.md` v0.10 → **v0.11**（§2.4 说明 `timeout_hint` 是客户端本地上限、服务端在其上叠宽限）、`WORKFLOW_SPEC.md` v0.6 → **v0.7**（§4.3 补"副作用超时两端一致走 `UNKNOWN`"）、`docs/REQUIREMENTS.md` §7 三行同步、README 当前状态。

## Review Focus

以下失败模式规格隐含、但默认的测试不会覆盖，**每条都必须在对应任务里有测试**：

1. **只读超时不能被误判成 `UNKNOWN`**：读操作掐掉是"确定失败"，应可重试/换方式，不能拖进对账（§4.3 的对账成本很高）。见 Task 1。
2. **被掐掉的副作用不得丢掉"执行中"的记忆**：否则重连重发会把它当成"没发生过"再执行一次（正是上一阶段刚堵掉的那类漏洞）。见 Task 1。
3. **宽限必须跟着快照走**：`timeoutMs` 仍然只能在派发时确定并冻结在 Step 上（`CAPABILITY_SPEC.md` §4 的在途规则），宽限不能变成"读实时配置"。见 Task 2。
4. **重试不得吞掉不可重试的失败**：`400`、坏 JSON、缺 `name` 必须是**一次**尝试就抛——否则会把确定性问题重试成偶发问题，还可能放大计费。见 Task 3。
5. **重试不得改变 Workflow 结局**：重试耗尽后仍必须是 `planner_error`（不能变成"静默降级成完成候选"或别的状态）。见 Task 3 + 既有 `plannerFailure` 测试。

---

### Task 1: 客户端——副作用本地超时走 `UNKNOWN`

**Files:**
- Modify: `packages/client-daemon/src/stepRunner.ts`
- Test: `packages/client-daemon/test/stepRunner.timeout.test.ts`（新建）

**Interfaces:**
- Consumes: `ExecutionResult` 的失败分支（`{ status: "failed"; code: string }`，`code === "timeout"` 由 `terminal` 适配器在本地掐掉时产生）、`adapter.spec.side_effect`、**上一阶段引入的**台账三态
- Produces: 在 `result.status === "failed"` 分支里——
  - `adapter.spec.side_effect && result.code === "timeout"` → 发 `UNKNOWN`，**不** `forget()`（台账标记保留）
  - 其它失败 → `forget()` → `FAILED(fail_reason)`（既有行为）

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/stepRunner.timeout.test.ts
import { describe, it, expect } from "vitest";
import { attachStepRunner } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { CapabilitySpec } from "../src/capability/spec";
import type { ExecutionResult } from "../src/capability/result";
import { openLedger } from "../src/ledger";

function harness(spec: CapabilitySpec, result: ExecutionResult, ledger = openLedger(":memory:")) {
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  const registry = new CapabilityRegistry();
  registry.register({ spec, execute: async () => result });

  attachStepRunner({
    connection: {
      on: (type, handler) => { handlers.set(type, handler); },
      send: (_type, payload) => { sent.push({ payload: payload as Record<string, unknown> }); },
    },
    registry,
    workspaceRoot: "/ws",
    ledger,
    onConfirmationRequired: async () => true,
  });

  return {
    sent,
    ledger,
    dispatch: (payload: Record<string, unknown>) => handlers.get("step.dispatch")!({ payload }),
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
}

const dispatch = {
  workflow_id: "wf_1",
  step_id: "step_1",
  objective: "run",
  capability: "terminal.execute_command",
  input: { command: "sleep" },
  requires_confirmation: true,
  idempotency_key: "idem_1",
};

describe("local timeout semantics", () => {
  it("reports UNKNOWN for a side effect it had to kill, keeping the ledger marker", async () => {
    const h = harness(
      { name: "terminal.execute_command", side_effect: true, interruptible: false },
      { status: "failed", code: "timeout", message: "command exceeded its timeout" },
    );
    h.dispatch(dispatch);
    await h.settle();

    // May have taken (partial) effect: unknown, not failed.
    expect(h.sent.at(-1)!.payload).toMatchObject({ status: "UNKNOWN" });
    // A re-dispatch after a reconnect must still refuse to run it again.
    expect(h.ledger.get("idem_1")).toEqual({ state: "in_flight" });
  });

  it("keeps FAILED(timeout) for a read-only step", async () => {
    const h = harness(
      { name: "git.collect_diagnostics", side_effect: false, interruptible: true },
      { status: "failed", code: "timeout", message: "git failed" },
    );
    h.dispatch({
      ...dispatch,
      capability: "git.collect_diagnostics",
      requires_confirmation: false,
      idempotency_key: null,
    });
    await h.settle();

    // Nothing in the real world changed: this is a plain failure the planner
    // may retry or route around.
    expect(h.sent.at(-1)!.payload).toMatchObject({
      status: "FAILED",
      fail_reason: { code: "timeout" },
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.timeout.test.ts`
Expected: FAIL（副作用超时现在报 `FAILED(timeout)`，且台账标记被清除）

- [ ] **Step 3: 实现**

在 `executeStep` 的 `result.status === "failed"` 分支最前面加一条：`adapter.spec.side_effect && result.code === "timeout"` → `send("UNKNOWN")` 后 `return`（**不要**调用 `forget()`）。其余失败路径保持 `forget()` + `FAILED`。注释写明理由与"标记必须留着"。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.timeout.test.ts test/stepRunner.idempotency.test.ts test/stepRunner.resourceConflict.test.ts test/capability/terminal.test.ts`
Expected: PASS（既有失败/冲突/超时测试不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/stepRunner.ts packages/client-daemon/test/stepRunner.timeout.test.ts
git commit -m "fix(daemon): an unknown side effect stays unknown when we time it out"
```

---

### Task 2: 服务端——`step_timeout` 在依据值之上加宽限

**Files:**
- Modify: `packages/server/src/workflow/orchestrator.ts`、`packages/server/src/index.ts`、`packages/test-support/src/server.ts`（透传可选宽限）
- Test: `packages/server/test/workflow/orchestrator.stepTimeout.test.ts`（新建）

**Interfaces:**
- Produces:
  - `OrchestratorDeps.stepTimeoutGraceMs?: number`（默认 `2000`）
  - 派发时 `timeoutMs = (decision.step.timeoutMs ?? capability?.timeout_hint ?? defaultStepTimeoutMs ?? 60_000) + grace`
  - `StartOptions.stepTimeoutGraceMs?` 与 `TestServerOptions.stepTimeoutGraceMs?`（测试传 0 以断言精确值）
  - 常量 `DEFAULT_STEP_TIMEOUT_GRACE_MS = 2_000`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/workflow/orchestrator.stepTimeout.test.ts
// 用既有 orchestrator 测试的夹具（store + engine + 脚本规划器），断言：
// 1) 能力声明 timeout_hint: 5000、grace 默认 → 派发出的 Step timeoutMs === 7000
// 2) 能力声明 timeout_hint: 5000、grace 传 0 → timeoutMs === 5000（精确对齐能力声明）
// 3) 能力没有 timeout_hint、也没有显式 timeoutMs → 用全局默认 + grace
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/workflow/orchestrator.stepTimeout.test.ts`
Expected: FAIL（现在是 `timeoutMs === 5000`，没有宽限）

- [ ] **Step 3: 实现**

在编排层的派发处把计算结果加宽限，并加注释说明理由（让客户端自己的本地超时先到，它的观察优先）。`index.ts` / `test-support` 把可选值透传（默认走常量）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/workflow/ test/protocol/`
Expected: PASS（既有超时/派发测试不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src packages/test-support/src packages/server/test/workflow/orchestrator.stepTimeout.test.ts
git commit -m "feat(workflow): let the client's own timeout speak first"
```

---

### Task 3: LLM provider 的有界重试

**Files:**
- Modify: `packages/server/src/llm/openaiCompatible.ts`
- Test: `packages/server/test/llm/retry.test.ts`（新建）

**Interfaces:**
- Produces:
  - `OpenAiCompatibleOptions` 增 `maxRetries?: number`（默认 2）、`retryBaseMs?: number`（默认 500）、`sleep?: (ms: number) => Promise<void>`
  - 可重试判定：`status === 429 || status >= 500`，或网络错误（`fetchImpl` 抛出且不是我们自己的超时）
  - 不可重试：其它 `4xx`；**我们自己的超时**（`TimeoutError`/`AbortError`）；响应体解析失败；工具调用形状错误（`name` 缺失 / `arguments` 非 JSON / 非对象）
  - `llmProviderFromEnv` 读 `LLM_MAX_RETRIES`（缺省 2）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/llm/retry.test.ts
import { describe, it, expect } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/llm/openaiCompatible";
import type { LlmRequest } from "../../src/llm/provider";

const ok = (): Response =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { tool_calls: [{ function: { name: "propose_step", arguments: "{}" } }] } },
      ],
    }),
    { status: 200 },
  );

const providerWith = (responses: Array<Response | Error>, over: Record<string, unknown> = {}) => {
  let attempts = 0;
  const sleeps: number[] = [];
  const provider = new OpenAiCompatibleProvider({
    baseUrl: "http://llm.test/v1",
    apiKey: "k",
    model: "m",
    sleep: async (ms) => { sleeps.push(ms); },
    fetch: (async () => {
      const next = responses[Math.min(attempts, responses.length - 1)]!;
      attempts++;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
    ...over,
  });
  return { provider, attempts: () => attempts, sleeps };
};

const request: LlmRequest = {
  messages: [{ role: "user", content: "decide" }],
  tools: [],
  toolChoice: "propose_step",
};

describe("LlmProvider retry", () => {
  it("retries a 429 and a 5xx with exponential backoff", async () => {
    const h = providerWith([
      new Response("slow down", { status: 429 }),
      new Response("boom", { status: 503 }),
      ok(),
    ]);

    await h.provider.complete(request);

    expect(h.attempts()).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  it("retries a network failure", async () => {
    const h = providerWith([new TypeError("fetch failed"), ok()]);
    await h.provider.complete(request);
    expect(h.attempts()).toBe(2);
  });

  it("does not retry a 4xx that is not 429", async () => {
    const h = providerWith([new Response("bad request", { status: 400 })]);
    await expect(h.provider.complete(request)).rejects.toThrow(/LLM HTTP 400/);
    expect(h.attempts()).toBe(1);
  });

  it("does not retry a malformed tool call", async () => {
    const bad = new Response(
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: "propose_step", arguments: "not json" } }] } }],
      }),
      { status: 200 },
    );
    const h = providerWith([bad, ok()]);

    await expect(h.provider.complete(request)).rejects.toThrow(/not valid JSON/);
    // Retrying a model-semantics error would just repeat it.
    expect(h.attempts()).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    const h = providerWith([new Response("boom", { status: 500 })], { maxRetries: 2 });
    await expect(h.provider.complete(request)).rejects.toThrow(/LLM HTTP 500/);
    expect(h.attempts()).toBe(3);
  });

  it("does not retry its own timeout", async () => {
    // An aborted request already waited the full timeout; retrying would triple
    // the worst case for a request that is hanging rather than blipping.
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const h = providerWith([timeout, ok()]);

    await expect(h.provider.complete(request)).rejects.toThrow(/timeout/);
    expect(h.attempts()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/server exec vitest run test/llm/retry.test.ts`
Expected: FAIL（没有重试；`sleep`/`maxRetries` 不是选项）

- [ ] **Step 3: 实现**

按 Interfaces 重构 `complete()`：把"发请求"抽成一个小函数（它的 catch 只包住 transport，产出**可重试**错误），循环 `attempt = 0..maxRetries`；`!response.ok` 时按状态判可重试；**响应体解析与工具调用形状校验留在重试循环之外**（一次就抛）。退避用 `retryBaseMs * 2 ** attempt`。`llmProviderFromEnv` 读 `LLM_MAX_RETRIES`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/server exec vitest run test/llm/`
Expected: PASS（既有 provider / selectPlanner / plannerFailure 测试不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/llm packages/server/test/llm
git commit -m "feat(llm): bounded retry for transient provider failures"
```

---

### Task 4: 规格与文档同步

**Files:**
- Modify: `docs/specs/PROTOCOL_SPEC.md`（v0.10 → **v0.11**：§9 的 `step_timeout` 明确为"依据值 + 宽限（默认 2s）"，并补客户端**本地**超时的分流——只读 → `FAILED(timeout)`、副作用 → `UNKNOWN`）
- Modify: `docs/specs/CAPABILITY_SPEC.md`（v0.10 → **v0.11**：§2.4 说明 `timeout_hint` 是**客户端本地执行上限**，服务端在其上叠加宽限）
- Modify: `docs/specs/WORKFLOW_SPEC.md`（v0.6 → **v0.7**：§4.3 补"副作用超时无论由哪一端触发都走 `UNKNOWN`，只读才是 `FAILED(timeout)`"）
- Modify: `docs/REQUIREMENTS.md`（§7 三行版本与说明）
- Modify: `README.md`（当前状态补本阶段：超时语义与 LLM 重试）

**Interfaces:**
- Consumes: Task 1–3
- Produces: 文档与实现一致

- [ ] **Step 1: 改三份 spec 与 REQUIREMENTS/README**

- [ ] **Step 2: 验证**

Run: `for f in WORKFLOW_SPEC CAPABILITY_SPEC PROTOCOL_SPEC; do …比较自身版本与 REQUIREMENTS §7 引用…; done`
Expected: 三行全部 `OK`

- [ ] **Step 3: 提交**

```bash
git add docs/ README.md
git commit -m "docs: one timeout vocabulary on both sides, and bounded LLM retries"
```

---

## Self-Review

**1. Spec coverage：** D4 → T1（客户端分流）+ T2（服务端宽限）+ T4（三份 spec 写实）；D5 → T3（provider 重试）+ T4（重试参数与最坏耗时写进文档）。D6（调研简报）与 D7（`client-cli`）**不在本阶段**，已记录在待办。**刻意不做**：`Retry-After` 头解析、按模型/端点区分重试策略、重试指标（等有可观测性再说）。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支。

**3. Type consistency：** `stepTimeoutGraceMs`（T2 在编排层依赖、`StartOptions`、`TestServerOptions` 三处同名）、`DEFAULT_STEP_TIMEOUT_GRACE_MS`（T2/T4）、`maxRetries`/`retryBaseMs`/`sleep`（T3/T4）在各任务间同名复用。

**4. Review Focus：** 五条风险落到测试——只读超时不被误判（T1 第二例）、被掐掉的副作用保留"执行中"（T1 第一例断言台账）、宽限随快照冻结（T2 第二例 grace=0 精确对齐断言）、不可重试失败只尝试一次（T3 第三/四例）、重试不改变结局（T3 第五例 + 既有 `plannerFailure`）。

**5. Proportion：** 计划只描述决策、接口与断言；Task 2 的测试写"断言清单"（夹具要复用既有 orchestrator 测试写法）。

**6. 执行顺序依赖：** T1 与 T2 相互独立但**成对才有意义**（只做宽限而不统一语义，仍会丢信息）；T3 独立；T4 最后。

## 移交后续计划的待办

1. **P4d（KB 导出）**：ADR-005 出站 —— 本阶段之后的下一份计划。
2. **D6（a）**：真实 Windows 适配器的**调研简报**（问题清单 + 结论要落成什么 ADR），不写代码。
3. **D7（b）**：`client-cli`（控制台客户端），在 P4d 之后、正式 UI 之前。
4. **幂等键的"同一意图"语义**：本阶段只在 `WORKFLOW_SPEC.md` §4.3 记下实现口径（按 Step 稳定）；跨重试的意图级稳定键需要 Planner 表达意图，列为后续项。
5. 其余延后项见 `docs/superpowers/plans/2026-09-30-p4-gap-closure.md` 与 `2026-09-30-p4c-blob-channel.md` 的裁决表。

---

## Review 修复轮（Review fix pass）

整体评审：**无代码阻塞项**；分支的四项修复各自都有"回退即失败"的测试（评审用变异测试逐条验证，并纠正了自己的夹具错误后才得出结论）；重连/超时/重试的每条边角都被实际跑过。**一条文档阻塞项**（我写错的最坏耗时）已修。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **B1（阻塞）** 三份文档把最坏耗时写成"`timeoutMs` + 退避总和"，但**被重试的失败每次尝试都有独立的 `timeoutMs` 窗口**——只在"我们自己的超时（不重试）"这条路径上成立 | **已修（改文档，代码不动）** | `ADR-004` A2、`README`、本计划统一改为 `timeoutMs × (maxRetries + 1)` + 退避总和（默认 ≈93s），并说明"要逼近上界需网关每次都拖到接近超时才回 429/5xx"、以及对延迟敏感时的两个旋钮（`LLM_MAX_RETRIES=0` / 调小 `timeoutMs`）；`openaiCompatible.ts` 的 docblock 同步 |
| **N1** `LLM_MAX_RETRIES=""` 会被 `Number("")` 解析成 0，**静默关闭重试**；且该解析没有测试 | **已修** | `parseRetries()`：空串/非整数/负数一律回落默认值；新增 `test/llm/providerFromEnv.test.ts`（4 例，含空串与 `-1`、`2.5`）；`maxRetries` 改为公开只读字段以便断言 |
| **N2** `timeoutMs: 0`（= "不超时"哨兵）被宽限无条件加成 2s，哨兵失效 | **已修** | `stepTimeoutWithGrace()`：`<= 0` 原样透传；新增测试（`defaultStepTimeoutMs: 0` → 0） |
| **N3** 客户端本地掐掉这条路只有单元测试、没有端到端 | **延后（理由）** | 该分支是纯客户端逻辑（`(side_effect, code)` 分支），单元测试直接命中；`terminal` 适配器 → `code:"timeout"` 的映射也有测试。端到端目前覆盖的是"服务端到点"那条（`controlledExecution.e2e` 的挂住适配器）。等有真实长命令场景再补 |
| **N4** `resourceConflict` e2e 的"人类等待不被超时"断言被防御层掩盖（单去掉 monitor 的豁免仍会通过） | **评估通过，不改** | 该豁免另有直接测试（`stepTimeout.test.ts` 断言只对 `step_running` 触发）；评审确认两层都拆掉时该 e2e 会失败。属防御纵深的重叠，不是空测试 |
| **既存漂移**（评审顺带发现）`WORKFLOW_SPEC` §4.3 说幂等键"同一意图稳定"，而实现按 **Step** 稳定 | **已修（补注）** | §4.3 增"MVP 实现口径"引用块：键按 Step 稳定（重连重发复用），**意图级**稳定键需要 Planner 表达意图，列为后续项 |

**本阶段刻意不做**：`Retry-After` 头解析、按模型/端点区分重试策略、重试指标（等有可观测性再说）。
