# 工作台与取消（S0 + S3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单体 Electron 应用上加**右栏工作台**（选中会话的步骤/证据时间线 + 结论），并让进行中的会话能**取消**（二次确认 → `CANCELLING` → `CANCELLED`）。

**Architecture:** main 侧：给投影加 `cancelling` 态、给会话加 `cancel(workflowId)`（发 `workflow.cancel_request`、等 `cancel_ack`）；新增 IPC `cancel`。renderer 侧：外壳由两栏变三栏，新增纯函数 `deriveWorkbench` 与 `Workbench` 组件——**live 与往期同形**，数据都用现成的 `TranscriptItem[]`（live 来自 `deriveTranscript`，往期来自 `transcriptFromRecord`）。

**Tech Stack:** Electron + **electron-vite** · React + TypeScript（strict）· Vitest（main/core 用 Node；renderer 用 jsdom + Testing Library）· Playwright Electron（桌面冒烟）· pnpm workspace

**Spec:** `docs/superpowers/specs/2026-10-01-workbench-and-loop-closeout-design.md`（§4 工作台、§7 取消、§10 IPC、§12 测试策略、§15 拆分）。计划依据该 spec；执行者两处都读。

## Global Constraints

- **renderer 不 import `@adt/server`、不碰 Node**；`contextIsolation: true` / `nodeIntegration: false` 不变（`ADR-006` §1）。renderer 只经 preload 暴露的那一小簇方法。
- UI 词汇用 daemon 的词汇；**不引入新依赖、不引入 CSS 框架**（当前 renderer 无样式文件，保持 DOM + `className`，与现状一致）。
- **取消不带 `reason`**（`workflow.cancel_request` 只发 `workflow_id`），`terminal_reason` 保持 `null`（spec §2/§7）。
- 一条对话 = 一个 Workflow；**"一次一条"只活在输入框谓词里**（不写进组件、不假设全局只有一条）。
- 编辑文件用 `edit` 工具（仓库 **LF**）；**不 push**。
- 验证口径：`pnpm -r --if-present test`（**串行**，根脚本已强制）+ `pnpm -r --if-present typecheck` + `pnpm -C packages/client-electron build`；本切片出口含**桌面冒烟**。
- 本计划**刻意不做**（属后续计划）：Report 生成与渲染、KB 导出（工作台头部的这两个按钮在 **P-loop-end** 加）、附件与 blob、手工动作 `details`（**P-attachments**）、断线恢复体验、安全硬化、打包分发。

## Review Focus

以下失败模式是 spec 隐含、但默认测试不会覆盖的；**每条都必须在对应任务里有测试**：

1. **取消必须真的终止**：在"等人回答"的进行中会话上点取消，Workflow 必须真的走到 `workflow.terminated(CANCELLED)`——不能只改 UI、服务器上还在跑。见 Task 2。
2. **`CANCELLING` 不能被当成 `CANCELLED`**：`cancel_ack` 回 `CANCELLING` 时，UI 停在"正在取消"，直到 `workflow.terminated`；且**终止后到达的 ack 不得把已终止的 workflow 重新标成 cancelling**（竞态）。见 Task 1 / Task 3 / Task 4。
3. **往期不可取消**：选中一条往期（history）时，"取消"按钮不出现/不可用，且工作台仍能显示步骤与结论。见 Task 4。
4. **空态不崩**：没有选中会话、列表为空、或工作台拿到空 `items` 时给空态，不抛错、不白屏。见 Task 3 / Task 4。
5. **取消只发一次**：重复点击、已取消后再点，不得重复发 `workflow.cancel_request`。见 Task 4。

---

### Task 1: 投影的取消态（`cancelling`）

**Files:**
- Modify: `packages/client-electron/src/shared/ui.ts`（`UiWorkflow` 增字段）
- Modify: `packages/client-electron/src/main/core/projection.ts`
- Test: `packages/client-electron/src/main/core/projection.test.ts`（Create）

**Interfaces:**
- Produces:
  - `UiWorkflow.cancelling: boolean`——`UiWorkflow` 定义在 `src/shared/ui.ts`（`contract.ts` 已再导出）。
  - `Projection.observeCancelAck(workflowId: string): void`——把该 workflow 标为"正在取消"；**若它已终止则不改**（防竞态）。
- 说明：`projection.ts` 的 `ensure()` 初值加 `cancelling: false`；`observe("workflow.terminated")` 分支里把它清成 `false`。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/core/projection.test.ts
import { describe, it, expect } from "vitest";

import { createProjection } from "./projection";

const terminated = {
  workflow_id: "wf_1",
  payload: { terminal_state: "CANCELLED", terminal_reason: null, record_id: "rec_1" },
};

const cancelling = (p: ReturnType<typeof createProjection>): boolean | undefined =>
  p.snapshot(null).workflows.find((w) => w.workflowId === "wf_1")?.cancelling;

describe("the projection's cancellation state", () => {
  it("marks a workflow as cancelling and clears it on termination", () => {
    const p = createProjection();
    p.observeCancelAck("wf_1");
    expect(cancelling(p)).toBe(true);

    p.observe("workflow.terminated", terminated);
    expect(cancelling(p)).toBe(false);
  });

  it("does not re-mark a workflow that has already terminated", () => {
    const p = createProjection();
    p.observe("workflow.terminated", terminated);
    p.observeCancelAck("wf_1");
    expect(cancelling(p)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/projection.test.ts`

- [ ] **Step 3: 实现**

`ui.ts` 的 `UiWorkflow` 加 `cancelling: boolean`；`projection.ts`：
`ensure()` 的初值加 `cancelling: false`；`observeCancelAck(workflowId)`：`const wf = ensure(workflowId); if (wf.terminalState === null) wf.cancelling = true;`；`observe("workflow.terminated")` 里加 `workflow.cancelling = false;`；`Projection` 接口加该方法。

- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/client-electron typecheck`

- [ ] **Step 5: 提交** — `feat(electron): project the workflow's cancelling state`

---

### Task 2: 取消的会话与 IPC（`session.cancel`）

**Files:**
- Modify: `packages/client-electron/src/shared/contract.ts`（`RendererRequest` + `AdtBridge`）
- Modify: `packages/client-electron/src/main/core/session.ts`
- Modify: `packages/client-electron/src/main/core/bridge.ts`
- Modify: `packages/client-electron/src/preload/index.ts`
- Modify: `packages/client-electron/src/main/index.ts`
- Test: `packages/client-electron/src/main/core/session.int.test.ts`（Modify）、`packages/client-electron/src/main/core/bridge.test.ts`（Modify）

**Interfaces:**
- Consumes: `Projection.observeCancelAck`（Task 1）
- Produces:
  - `Session.cancel(workflowId: string): Promise<void>`——未登录抛 `not_logged_in: not logged in`；否则 `daemon.connection.request("workflow.cancel_request", { workflow_id: workflowId }, "workflow.cancel_ack")` → `projection.observeCancelAck(workflowId)` → `options.emit({ type: "state", snapshot: projection.snapshot(daemon) })`。
  - `BridgeDeps.cancel(workflowId: string): Promise<void>`；`RendererRequest` 增 `{ kind: "cancel"; workflowId: string }`；`AdtBridge.cancel(workflowId: string): Promise<void>`。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/main/core/session.int.test.ts 的 describe 里
it("cancels a run that is waiting for the human, and it terminates as CANCELLED", async () => {
  const f = await fixture([manualStep, done]);
  try {
    const workflowId = await f.session.submit("换根线");
    await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "manual_action", "the manual action");

    await f.session.cancel(workflowId);

    const settled = await waitFor(f, (s) => s.workflows[0]?.terminalState !== null, "the end");
    expect(settled.workflows[0]!.terminalState).toBe("CANCELLED");
    expect(settled.workflows[0]!.cancelling).toBe(false);
    expect(settled.workflows[0]!.pendingAskId).toBeNull();
    expect(uiTypes(f)).toContain("workflow.terminated");
  } finally {
    await f.close();
  }
});

it("refuses to cancel before login", async () => {
  const srv = await startTestServer({ planner: [readStep, done] as never });
  const session = createSession({
    serverUrl: srv.url,
    workspaceRoot: process.cwd(),
    clientInfo: { name: "session-int-test", platform: "test" },
    ledgerPath: ":memory:",
    sessionPath: ":memory:",
    emit: () => undefined,
  });
  try {
    await expect(session.cancel("wf_x")).rejects.toThrow(/not_logged_in/);
  } finally {
    await session.close();
    await srv.close();
  }
});
```

```ts
// 追加到 src/main/core/bridge.test.ts
it("routes a cancel to the session", async () => {
  const seen: string[] = [];
  const bridge = createBridge(deps({ cancel: async (workflowId) => { seen.push(workflowId); } }));
  await bridge.handle({ kind: "cancel", workflowId: "wf_1" });
  expect(seen).toEqual(["wf_1"]);
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/session.int.test.ts src/main/core/bridge.test.ts`

- [ ] **Step 3: 实现**

`session.ts`：`Session` 接口加 `cancel`；实现按 Interfaces。`bridge.ts`：`BridgeDeps` 加 `cancel`，`handle` 的 `switch` 加 `case "cancel": await deps.cancel(request.workflowId); return undefined;`。`contract.ts`：`RendererRequest` 加该变体、`AdtBridge` 加 `cancel`。`preload/index.ts`：`cancel: (workflowId) => ipcRenderer.invoke(IPC.invoke, { kind: "cancel", workflowId } satisfies RendererRequest) as Promise<void>`。`main/index.ts`：`createBridge({ …, cancel: (workflowId) => session.cancel(workflowId) })`；`bridge.test.ts` 的 `deps()` 默认加 `cancel: async () => undefined`。

- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/client-electron typecheck`

- [ ] **Step 5: 提交** — `feat(electron): cancel a running workflow, and wait for its ack`

---

### Task 3: 工作台纯模型（`deriveWorkbench`）

**Files:**
- Create: `packages/client-electron/src/renderer/src/workbench.ts`
- Test: `packages/client-electron/src/renderer/src/workbench.test.ts`（Create）

**Interfaces:**
- Produces:
```ts
export type WorkbenchState = "running" | "CANCELLING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface WorkbenchStep {
  key: string; stepId: string; capability: string; objective: string;
  state: StepState; evidenceSummary: string | null; text: string;
}
export interface WorkbenchConclusion {
  terminalState: TerminalState; terminalReason: string | null; recordId: string | null; text: string;
}
export interface WorkbenchModel {
  workflowId: string | null; state: WorkbenchState;
  steps: WorkbenchStep[]; conclusion: WorkbenchConclusion | null;
}
export function deriveWorkbench(items: TranscriptItem[], cancelling: boolean): WorkbenchModel;
```
- 规则：`steps` = `items` 里的 `tool` 项（保持原顺序）；`conclusion` = 其中的 `summary` 项（`null` 若没有）；`state` = `conclusion?.terminalState ?? (cancelling ? "CANCELLING" : "running")`；`workflowId` = 第一个非 `notice` 项的 `workflowId`，否则 `null`。**终止态优先于 `cancelling`**。

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/src/workbench.test.ts
import { describe, it, expect } from "vitest";

import type { TranscriptItem } from "./transcript";
import { deriveWorkbench } from "./workbench";

const tool = (): Extract<TranscriptItem, { kind: "tool" }> => ({
  key: "tool:wf_1:st_1", kind: "tool", workflowId: "wf_1", stepId: "st_1",
  capability: "git.collect_diagnostics", objective: "先收集诊断信息", input: {},
  state: "COMPLETED", requiresConfirmation: false, evidenceSummary: "git_status: clean", text: "完成",
});
const summary = (): Extract<TranscriptItem, { kind: "summary" }> => ({
  key: "summary:wf_1", kind: "summary", workflowId: "wf_1",
  terminalState: "COMPLETED", terminalReason: null, recordId: "rec_1", text: "工作流已终止：COMPLETED",
});

describe("deriveWorkbench", () => {
  it("collects the steps and the conclusion of a finished run", () => {
    const model = deriveWorkbench([tool(), summary()], false);
    expect(model.workflowId).toBe("wf_1");
    expect(model.state).toBe("COMPLETED");
    expect(model.steps).toHaveLength(1);
    expect(model.steps[0]!.capability).toBe("git.collect_diagnostics");
    expect(model.conclusion?.recordId).toBe("rec_1");
  });

  it("shows CANCELLING only while it is still running", () => {
    expect(deriveWorkbench([tool()], true).state).toBe("CANCELLING");
    expect(deriveWorkbench([tool()], false).state).toBe("running");
  });

  it("does not let cancelling override a terminal state", () => {
    expect(deriveWorkbench([tool(), summary()], true).state).toBe("COMPLETED");
  });

  it("survives empty input", () => {
    expect(deriveWorkbench([], false)).toEqual({
      workflowId: null, state: "running", steps: [], conclusion: null,
    });
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/renderer/src/workbench.test.ts`

- [ ] **Step 3: 实现**（按 Interfaces 与规则；纯函数，无 React）

- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/client-electron typecheck`

- [ ] **Step 5: 提交** — `feat(electron): derive the workbench's view from the transcript`

---

### Task 4: 工作台组件与三栏外壳（含取消 UI）

**Files:**
- Create: `packages/client-electron/src/renderer/src/components/Workbench.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Test: `packages/client-electron/src/renderer/src/components/Workbench.test.tsx`（Create）、`packages/client-electron/src/renderer/src/app.test.tsx`（Modify）

**Interfaces:**
- Consumes: `deriveWorkbench`（Task 3）、`STEP_STATE_TEXT`/`TranscriptItem`（`../transcript`）、`AdtClient.cancel`（Task 2）
- Produces: `Workbench(props)`——函数组件，props 如下（返回类型不写显式注解，跟现有组件一致）：
```ts
{
  items: TranscriptItem[];
  cancelling: boolean;
  canCancel: boolean;
  onCancel(workflowId: string): void;
}
```
  - 根节点 `data-testid="workbench"`。
  - **头部**：状态文本（`running`→`进行中`；`CANCELLING`→`正在取消（等待当前步骤结束）`；其余显示状态词）+ 动作区。`canCancel && !cancelling` 时显示"取消"按钮；点它进入**行内二次确认**（"确定取消这条诊断吗？" + "确定取消"/"返回"）；"确定取消"调用 `onCancel(model.workflowId!)` 并进入"已请求取消"（按钮消失，防重复）。`返回` 取消本次确认。
  - **时间线**：`model.steps` 每行显示 `capability`、`STEP_STATE_TEXT[state]`、`objective`、`evidenceSummary`（非空时）。
  - **结论**：`model.conclusion` 存在时显示 `terminalState`（`terminalReason` 非空则附上）与 `Record: <recordId>`。
  - **空态**：`items.length === 0` → `<p className="empty">还没有可看的工作台内容。</p>`。
- `app.tsx`：外壳加第三栏；`selectedCancelling` 从 `ui.snapshot.workflows` 取（`find(w => w.workflowId === effectiveSelected)?.cancelling ?? false`）；`canCancel = selectedConversation?.live === true && selectedConversation.state === "running"`；`handleCancel = (workflowId) => { setError(null); client.cancel(workflowId).catch((cause) => setError(messageOf(cause))); }`。

- [ ] **Step 1: 写失败测试**

```tsx
// src/renderer/src/components/Workbench.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { Workbench } from "./Workbench";

const tool: TranscriptItem = {
  key: "tool:wf_1:st_1", kind: "tool", workflowId: "wf_1", stepId: "st_1",
  capability: "git.collect_diagnostics", objective: "先收集诊断信息", input: {},
  state: "COMPLETED", requiresConfirmation: false, evidenceSummary: "git_status: clean", text: "完成",
};
const summary: TranscriptItem = {
  key: "summary:wf_1", kind: "summary", workflowId: "wf_1",
  terminalState: "COMPLETED", terminalReason: null, recordId: "rec_1", text: "工作流已终止：COMPLETED",
};

describe("the workbench", () => {
  it("shows an empty state when there is nothing to show", () => {
    render(<Workbench items={[]} cancelling={false} canCancel={false} onCancel={() => undefined} />);
    expect(screen.getByText(/还没有可看的工作台内容/)).toBeTruthy();
  });

  it("shows the steps and the conclusion", () => {
    render(<Workbench items={[tool, summary]} cancelling={false} canCancel={false} onCancel={() => undefined} />);
    expect(screen.getByText("git.collect_diagnostics")).toBeTruthy();
    expect(screen.getByText("先收集诊断信息")).toBeTruthy();
    expect(screen.getByText(/Record: rec_1/)).toBeTruthy();
  });

  it("confirms before cancelling, and cancels at most once", async () => {
    const cancelled: string[] = [];
    render(<Workbench items={[tool]} cancelling={false} canCancel onCancel={(id) => cancelled.push(id)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "确定取消" }));
    expect(cancelled).toEqual(["wf_1"]);
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("does not offer cancel for a past run", () => {
    render(<Workbench items={[tool, summary]} cancelling={false} canCancel={false} onCancel={() => undefined} />);
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("shows CANCELLING and hides the button while it converges", () => {
    render(<Workbench items={[tool]} cancelling canCancel onCancel={() => undefined} />);
    expect(screen.getByText(/正在取消/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });
});
```

```tsx
// 追加到 src/renderer/src/app.test.tsx
// 1) fakeClient 增加 `cancel: async () => undefined`
it("cancels the selected live run from the workbench", async () => {
  const cancelled: string[] = [];
  let push!: (e: MainEvent) => void;
  const client = fakeClient({
    onEvent: (l) => { push = l; return () => undefined; },
    cancel: async (workflowId) => { cancelled.push(workflowId); },
  });
  render(<App client={client} />);
  await screen.findByTestId("app");
  act(() => {
    pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "跑一下" } });
    pushUi(push, { id: 2, type: "step.dispatched", workflowId: "wf_1", stepId: "st_1", capability: "git.collect_diagnostics", objective: "做", input: {}, requiresConfirmation: false });
  });
  const user = userEvent.setup();
  await user.click(within(screen.getByTestId("workbench")).getByRole("button", { name: "取消" }));
  await user.click(within(screen.getByTestId("workbench")).getByRole("button", { name: "确定取消" }));
  expect(cancelled).toEqual(["wf_1"]);
});

it("shows a past run's workbench without a cancel button", async () => {
  const past: UiRecord = {
    record_id: "rec_9", workflow_id: "wf_9", created_at: 0, ended_at: 1,
    terminal_state: "COMPLETED", terminal_reason: null,
    user_request: { text: "旧" },
    summary: { problem_short: "旧", terminal_state: "COMPLETED", result_short: "", duration_ms: 1 },
    entries: [
      { entry_id: "e1", ts: 1, kind: "step_dispatched", ref: { step_id: "st_1", capability: "git.collect_diagnostics", objective: "查日志", input: {} }, narrative: "n" },
      { entry_id: "e2", ts: 2, kind: "step_status", ref: { step_id: "st_1", state: "COMPLETED" }, narrative: "n" },
    ],
    final_result: {},
  };
  const client = fakeClient({
    records: async () => ({
      records: [{ recordId: "rec_9", workflowId: "wf_9", summary: past.summary }],
      nextCursor: null,
    }),
    record: async () => past,
  });
  render(<App client={client} />);
  await screen.findByTestId("app");
  const wb = within(await screen.findByTestId("workbench"));
  expect(wb.getByText("查日志")).toBeTruthy();
  expect(wb.queryByRole("button", { name: "取消" })).toBeNull();
});
```
（`within` 从 `@testing-library/react` 取。）

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/renderer`

- [ ] **Step 3: 实现** —— `Workbench.tsx` 只画；判断在 `workbench.ts`；`app.tsx` 接第三栏与 `handleCancel`。

- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/client-electron build`

- [ ] **Step 5: 提交** — `feat(electron): a workbench panel beside the thread, and cancel from it`

---

### Task 5: 桌面冒烟扩展

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Consumes: 现有 `launchApp()` / `login()` 辅助；工作台的 `data-testid="workbench"`（Task 4）

- [ ] **Step 1: 扩展第一个用例的断言**

在已跑的诊断结束前/后，加一条断言确认工作台出现且显示了那一步（`smoke/run.ts` 的脚本 planner 里有"复位测试台"）：

```ts
await expect(page.getByTestId("workbench").getByText("复位测试台")).toBeVisible({ timeout: 20_000 });
```

- [ ] **Step 2: 跑桌面冒烟**

Run: `pnpm -C packages/client-electron test:e2e`
Expected: 既有 2 例 + 新断言全部通过。

- [ ] **Step 3: 提交** — `test(electron): the smoke asserts the workbench shows the run`

---

## Self-Review

**1. Spec coverage：** spec §4（工作台：头部/时间线/结论/空态）→ Task 3/4；§7（取消：二次确认 + `CANCELLING`，不带 reason）→ Task 1/2/4；§10（IPC `cancel`、`UiWorkflow.cancelling`）→ Task 1/2；§12（测试）→ 各任务；§15（S0 先做、与本切片边界）→ 全篇。**刻意不做**已在 Global Constraints 列明（Report/导出 → P-loop-end；附件/blob/`details` → P-attachments）。spec §4 的"生成报告/导出到知识库"两个按钮**不在本计划**，工作台头部本计划只出现"取消"。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给签名与语义；无占位步。

**3. Type consistency：** `observeCancelAck`/`UiWorkflow.cancelling`（T1）在 T2/T4 复用；`Session.cancel`/`BridgeDeps.cancel`/`AdtBridge.cancel`（T2）在 T4 的 fake 中被消费；`deriveWorkbench`/`WorkbenchModel`（T3）在 T4 复用；`data-testid="workbench"`（T4）在 T5 复用。

**4. Review Focus：** 五条都落到测试——真终止（T2 第 1 例）、`CANCELLING` 不误判 + 竞态（T1 第 2 例、T3 第 3 例、T4 第 5 例）、往期不可取消（T4 第 4 例 + app 用例）、空态（T3 第 4 例、T4 第 1 例）、只取消一次（T4 第 3 例）。

**5. Proportion：** 计划只钉接口、断言与关键分支；组件长相细节留给实现。

---

## 评审裁决表（整分支评审）

评审：`opencode-go/deepseek-v4.1-flash`，范围 `cad5ba9..2917859`（6 提交）。结论 **With fixes**（**0 Critical / 2 Important / 3 Minor**）。一轮修复（提交 `2e9f7fd`）后全绿：整仓 `pnpm -r --if-present test` exit 0（`client-electron` 63/63）、`typecheck` exit 0、桌面冒烟 2/2。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **I1（重要）** 取消态（`requested`/`confirming`）是组件全局、未按会话隔离：取消过一条后，后续 live 会话**不再出现取消按钮**（违反 Global Constraints"一次一条只活在输入框谓词里"）；陈旧 `confirming` 还可能误取消另一条 | **已修** | `app.tsx` 给 `<Workbench key={effectiveSelected ?? "none"}>` 按会话重挂载；`Workbench.confirmCancel` 失败时重置；新增 `app.test.tsx`「offers cancel again for a later run after one was cancelled」（RED→GREEN） |
| **I2（重要）** 取消请求失败后 `requested` 永久为真，按钮不再出现、无法重试（spec §11 要求"不假定已取消"） | **已修** | `onCancel` 改为返回 `Promise<void>`；`Workbench.confirmCancel` catch 后重置 `requested`/`confirming`；`app.handleCancel` 记错误并 rethrow；新增 `Workbench.test.tsx`「restores the cancel button when the request fails」（RED→GREEN） |
| **M3（次要）** spec §4 的两处工作台元素未渲染：完成候选的 `summary`/`evidenceRefs`；人工决定的行内小标 | **已记录（规格/计划）** | 属 **spec §4 与计划的有意收窄**（本计划把 `WorkbenchConclusion` 只留 terminal/record）。作为 **P-loop-end / 工作台打磨**那一份计划的输入，不属本切片 |
| **M4（次要）** `WorkbenchStep.stepId`/`.text`、`WorkbenchConclusion.text` 是死字段 | **延后** | 忠实于计划的 Interfaces；下一个触碰工作台的计划里清理 |
| **M5（次要）** `session.cancel` 忽略 `cancel_ack` 的 `workflow_status` | **已记录** | 依赖 Server 保证随后必发 `workflow.terminated`（`workflowProtocol.ts`）；今日非缺陷。Server 语义变化再处理 |

**评审"Declined to judge"各行：维持**——Report/导出（P-loop-end）、附件/blob/`details`（P-attachments）、`cancelling` 必填 + 夹具更新、`fakeClient` 提前补 `cancel`、把既有断言收窄到 `main`/`navigation`、`terminal_reason` 保持 `null`、安全硬化/打包——均在本切片范围之外或已由裁决接受。

**RED 证据（如实）**：I1/I2 为**先写出的回归测试**（评审复现 → 先红后绿），不是事后补的护栏。
