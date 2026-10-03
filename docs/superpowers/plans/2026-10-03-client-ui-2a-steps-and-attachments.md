# UI-2a 步骤与附件的单一归属 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落定 spec §6.2/§6.3 的"一个数据一个家"里**步骤与附件**这两类：附件只在中栏用户气泡呈现（blob 可预览/另存），步骤全文/`input`/证据只归右栏账号本，中栏压成一行紧凑指针并可定位右栏节点。

**Architecture:** 全在 renderer。`Transcript` 继承并转发 blob 动作回调；`ToolCard` 从"卡"变"行"；`Workbench` 成为步骤详情的唯一家并新增 `input` 折叠；`app.tsx` 用一个 `focusedStepId` 把中栏行与右栏节点连起来。不改协议、不改 `shared/`，不碰完成候选与终态（UI-2b）。

**Tech Stack:** React 18 + TS（strict）· Vitest（jsdom + Testing Library）· Playwright Electron（桌面冒烟）

**Spec:** `docs/superpowers/specs/2026-10-03-client-ui-design.md`（本计划实现 §6.2/§6.3 的**步骤与附件**两行；§6.3 的完成候选/终态两行归 UI-2b）。计划是 spec 的论证，冲突以 spec 为准。

## Global Constraints

- **一个数据一个家**：证据全文与 `input` 只在中栏**或**右栏一处渲染完整内容；中栏只留**导航性镜像**（能力+状态+objective），点它定位右栏。
- **不引入新依赖 / CSS 框架 / CSS-in-JS**；沿用 `theme.css` 变量与纯 `className`。
- **不动协议**；`shared/ui.ts`、`shared/contract.ts` 本切片不改。
- **最小字号 11px**；颜色 + 图标 + 文字。
- renderer 不 import `@adt/server`。
- 编辑文件用 `edit`（**LF**）；**不 push**。
- 验证：`pnpm -r --if-present test`（串行）+ `typecheck` + `pnpm -C packages/client-electron build` + **桌面冒烟**（本切片出口）。
- **刻意不做**：完成候选拆分与终态统一（UI-2b）、覆盖层/登录/设置（UI-3）、断线恢复（UI-4）、无障碍收口（UI-5）；不改 `AskCard` 的四形态行为。

## Review Focus

以下失败模式 spec 隐含、默认测试不覆盖；**每条都要在对应任务里钉住**：

1. **附件不再出现在右栏**：请求附件迁到中栏后，右栏不得再渲染它（否则又是重复）。见 Task 1。
2. **blob 附件仍可预览/另存**：迁移不能把 blob 的动作丢掉；inline 附件不假装能预览（没有 `content_ref`）。见 Task 1。
3. **中栏不再渲染证据全文与 `input`**：压缩后中栏只到 objective；完整内容只在右栏。见 Task 2/3。
4. **定位不悬空**：点中栏步骤行必须能标到右栏对应节点（`data-focused`），未知 stepId 不得抛错。见 Task 2。
5. **既有断言同步**：`smoke` 的 `note.txt`、`app.test` 的 `maxLines` 等随迁改，不能留旧位置。见 Task 1/2/4。

---

### Task 1: 附件归中栏

**Files:**
- Create: `packages/client-electron/src/renderer/src/components/Transcript.test.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/Transcript.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/Workbench.tsx`
- Modify: `packages/client-electron/src/renderer/src/workbench.ts`
- Modify: `packages/client-electron/src/renderer/src/workbench.test.ts`
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Consumes: `UiAttachment`（`{name, media_type, size, sha256} & ({mode:"inline";data_base64}|{mode:"blob";content_ref})`）；app 已有的 `handlePreviewBlob(contentRef, mediaType)` / `handleSaveBlob(contentRef, mediaType, name?)`。
- Produces:
  - `Transcript` props += `onPreviewBlob(contentRef: string, mediaType: string): void`、`onSaveBlob(contentRef: string, mediaType: string, name?: string): void`。
  - 用户气泡 DOM：`.bubble.user` 内文本 +（有附件时）`.bubble-attachments`；每个 `.bubble-attachment` 显示 `name` 与 `mode`（内联/blob）；`mode==="blob"` 时两个按钮 `预览` / `另存`。
  - `WorkbenchModel` **删除** `attachments` 字段；`deriveWorkbench` 不再读取 user item。

- [ ] **Step 1: 写失败测试（`Transcript.test.tsx`）**

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { Transcript } from "./Transcript";

const request = (): TranscriptItem => ({
  key: "user:wf_1",
  kind: "user",
  workflowId: "wf_1",
  text: "看附件",
  attachments: [
    { name: "note.txt", media_type: "text/plain", size: 2, sha256: "a", mode: "inline", data_base64: "aGk=" },
    { name: "big.log", media_type: "text/plain", size: 999999, sha256: "b", mode: "blob", content_ref: "blob_x" },
  ],
});

const props = { onAnswer: () => {}, onPreviewBlob: () => {}, onSaveBlob: () => {} };

describe("the transcript's user bubble", () => {
  it("shows the request's attachments", () => {
    render(<Transcript items={[request()]} {...props} />);
    expect(screen.getByText("note.txt")).toBeTruthy();
    expect(screen.getByText("big.log")).toBeTruthy();
  });

  it("previews and saves a blob attachment, and offers nothing for an inline one", async () => {
    const previewed = vi.fn();
    const saved = vi.fn();
    render(<Transcript items={[request()]} onAnswer={() => {}} onPreviewBlob={previewed} onSaveBlob={saved} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(screen.getByRole("button", { name: "另存" }));
    expect(previewed).toHaveBeenCalledWith("blob_x", "text/plain");
    expect(saved).toHaveBeenCalledWith("blob_x", "text/plain", "big.log");
    // Exactly one attachment is actionable — the inline one is not.
    expect(screen.getAllByRole("button", { name: "预览" })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- Transcript.test`
Expected: FAIL——`onPreviewBlob`/`onSaveBlob` 不被 `Transcript` 接受，且不渲染附件。

- [ ] **Step 3: 实现**

`Transcript.tsx`：签名加 `onPreviewBlob`/`onSaveBlob`；`case "user"` 渲染文本 + `.bubble-attachments`（`mode==="blob"` 才出 `预览`/`另存`，回调传 `content_ref`/`media_type`/`name`）。`app.tsx`：`<Transcript ... onPreviewBlob={handlePreviewBlob} onSaveBlob={handleSaveBlob} />`。`Workbench.tsx`：删掉 `model.attachments` 段。`workbench.ts`：`WorkbenchModel` 删 `attachments`，`deriveWorkbench` 删相应计算。

- [ ] **Step 4: 同步既有断言**

- `workbench.test.ts`「survives empty input」期望删掉 `attachments: []`。
- `smoke/electron.spec.ts`：把 `page.getByTestId("workbench").getByText("note.txt")` 改为 `page.getByRole("main").getByText("note.txt")`。

- [ ] **Step 5: 跑绿**

Run: `pnpm -C packages/client-electron test -- Transcript.test workbench.test`
Expected: PASS（Transcript 2 条 + workbench 既有）。

- [ ] **Step 6: 提交**

```bash
git add packages/client-electron/src/renderer/src/components/Transcript.tsx \
        packages/client-electron/src/renderer/src/components/Transcript.test.tsx \
        packages/client-electron/src/renderer/src/components/Workbench.tsx \
        packages/client-electron/src/renderer/src/workbench.ts \
        packages/client-electron/src/renderer/src/workbench.test.ts \
        packages/client-electron/src/renderer/src/app.tsx \
        packages/client-electron/smoke/electron.spec.ts
git commit -m "refactor(client-electron): the request's attachments live in the thread"
```

---

### Task 2: 中栏步骤压缩为紧凑行 + 点它定位右栏

**Files:**
- Create: `packages/client-electron/src/renderer/src/components/ToolCard.test.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/ToolCard.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/Transcript.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/Workbench.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.test.tsx`

**Interfaces:**
- Consumes: `TranscriptItem{kind:"tool"}`（`capability`/`state`/`objective`/`stepId`）。
- Produces:
  - `ToolCard` props：`{ item: ToolItem; onLocate(stepId: string): void }`；渲染 `.tool-row`（`capability` + 状态 `text` + `objective`）；**不渲染** `input`、`evidenceSummary`、`requiresConfirmation`；点击调 `onLocate(item.stepId)`。
  - `Transcript` props += `onLocate(stepId: string): void`。
  - `Workbench` props += `focusedStepId: string | null`；`<article className="workbench-step" data-focused={focusedStepId === step.stepId}>`。
  - `app.tsx`：`const [focusedStepId, setFocusedStepId] = useState<string | null>(null)`，传给 `Transcript.onLocate` 与 `Workbench.focusedStepId`。

- [ ] **Step 1: 写失败测试（`ToolCard.test.tsx`）**

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { ToolCard } from "./ToolCard";

const item: Extract<TranscriptItem, { kind: "tool" }> = {
  key: "tool:wf_1:st_1",
  kind: "tool",
  workflowId: "wf_1",
  stepId: "st_1",
  capability: "git.collect_diagnostics",
  objective: "先收集诊断信息",
  input: { maxLines: 200 },
  state: "COMPLETED",
  requiresConfirmation: false,
  evidenceSummary: "git_status: clean",
  evidenceBlob: null,
  text: "完成",
};

describe("the tool row", () => {
  it("shows the capability, state and objective, but not the input or the evidence", () => {
    render(<ToolCard item={item} onLocate={() => {}} />);
    expect(screen.getByText("git.collect_diagnostics")).toBeTruthy();
    expect(screen.getByText("完成")).toBeTruthy();
    expect(screen.getByText("先收集诊断信息")).toBeTruthy();
    expect(screen.queryByText(/maxLines/)).toBeNull();
    expect(screen.queryByText(/git_status/)).toBeNull();
  });

  it("locates the step in the workbench when clicked", async () => {
    const located = vi.fn();
    render(<ToolCard item={item} onLocate={located} />);
    await userEvent.click(screen.getByText("git.collect_diagnostics"));
    expect(located).toHaveBeenCalledWith("st_1");
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- ToolCard.test`
Expected: FAIL——`onLocate` 不被接受，且 `maxLines` 仍被渲染。

- [ ] **Step 3: 实现**

`ToolCard.tsx` 按 Produces 重写（一个可点的 `<button className="tool-row">`）。`Transcript.tsx` 透传 `onLocate`。`app.tsx` 加 `focusedStepId` 并接线。`Workbench.tsx` 给步骤节点加 `data-focused`，并对聚焦节点调用 `scrollIntoView?.({ block: "nearest" })`（jsdom 无此方法，用可选链；用一个 `ref` 回调）。

- [ ] **Step 4: 同步既有断言（`app.test.tsx`）**

「renders the transcript from a snapshot and a stream of events」里：
- 删掉 `expect(thread.getByText(/maxLines/)).toBeTruthy();`（`input` 已迁右栏）。
- 保留 `先收集诊断信息` / `完成` / `Record: rec_1`。
- 追加：`await userEvent.click(thread.getByText("git.collect_diagnostics")); expect(screen.getByTestId("workbench").querySelector('[data-focused="true"]')).toBeTruthy();`

- [ ] **Step 5: 跑绿**

Run: `pnpm -C packages/client-electron test -- ToolCard.test app.test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/client-electron/src/renderer/src/components/ToolCard.tsx \
        packages/client-electron/src/renderer/src/components/ToolCard.test.tsx \
        packages/client-electron/src/renderer/src/components/Transcript.tsx \
        packages/client-electron/src/renderer/src/components/Workbench.tsx \
        packages/client-electron/src/renderer/src/app.tsx \
        packages/client-electron/src/renderer/src/app.test.tsx
git commit -m "refactor(client-electron): the thread's step row points at the workbench"
```

---

### Task 3: 右栏步骤补 `input`（折叠）+ `requiresConfirmation` 标记

**Files:**
- Modify: `packages/client-electron/src/renderer/src/workbench.ts`
- Modify: `packages/client-electron/src/renderer/src/workbench.test.ts`
- Modify: `packages/client-electron/src/renderer/src/components/Workbench.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/Workbench.test.tsx`

**Interfaces:**
- Produces:
  - `WorkbenchStep` += `input: Record<string, unknown>`（来自 `tool.input`）、`requiresConfirmation: boolean`（来自 `tool.requiresConfirmation`）。
  - `Workbench` 节点：非空 `input` 渲染 `<details className="step-input"><summary>输入</summary><pre>{JSON.stringify(input, null, 2)}</pre></details>`；`requiresConfirmation === true` 渲染 `<span className="needs-confirmation">需要人工确认</span>`。

- [ ] **Step 1: 写失败测试（加到 `workbench.test.ts` 与 `Workbench.test.tsx`）**

`workbench.test.ts` 追加：

```ts
it("carries a step's input and its confirmation flag into the model", () => {
  const withInput = { ...tool(), input: { maxLines: 200 }, requiresConfirmation: true };
  const model = deriveWorkbench([withInput], false);
  expect(model.steps[0]!.input).toEqual({ maxLines: 200 });
  expect(model.steps[0]!.requiresConfirmation).toBe(true);
});
```

`Workbench.test.tsx` 追加：

```tsx
it("shows a step's input and that it needs confirmation", () => {
  const withInput: Extract<TranscriptItem, { kind: "tool" }> = {
    ...tool,
    input: { maxLines: 200 },
    requiresConfirmation: true,
  };
  show({ items: [withInput] });
  expect(screen.getByText(/maxLines/)).toBeTruthy();
  expect(screen.getByText("需要人工确认")).toBeTruthy();
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- workbench.test Workbench.test`
Expected: FAIL——`WorkbenchStep` 无 `input`/`requiresConfirmation`，节点不渲染它们。

- [ ] **Step 3: 实现**

`workbench.ts`：`WorkbenchStep` 加两字段并在 `.map()` 里赋值。`Workbench.tsx`：按 Produces 渲染 `<details>` 与标记。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- workbench.test Workbench.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/workbench.ts \
        packages/client-electron/src/renderer/src/workbench.test.ts \
        packages/client-electron/src/renderer/src/components/Workbench.tsx \
        packages/client-electron/src/renderer/src/components/Workbench.test.tsx
git commit -m "feat(client-electron): the workbench carries the step's input and confirmation flag"
```

---

### Task 4: 应用栏内部样式（收 UI-1 deferred minor）+ 修 UI-1 计划算术

**Files:**
- Modify: `packages/client-electron/src/renderer/src/theme.css`
- Modify: `packages/client-electron/src/renderer/src/components/AppBar.tsx`
- Modify: `packages/client-electron/src/renderer/src/theme.test.ts`
- Modify: `docs/superpowers/plans/2026-10-03-client-ui-1-shell.md`（只改 Task 4 的测试数算术）

**Interfaces:**
- Produces：`AppBar` 的连接 span 带 `data-connection={connection}`；`theme.css` 新增 `.app-name` / `.app-connection` / `.app-user` / `.app-settings` 规则（值取自 token）。

- [ ] **Step 1: 写失败测试（追加到 `theme.test.ts`）**

```ts
it("dresses the app bar", () => {
  for (const selector of [".app-name", ".app-connection", ".app-user", ".app-settings"]) {
    expect(css).toContain(selector);
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- theme.test`
Expected: FAIL——`dresses the app bar` 找不到这些选择器。

- [ ] **Step 3: 实现**

`AppBar.tsx` 连接 span 加 `data-connection={connection}`。`theme.css` 追加：`.app-name{font-weight:600;color:var(--color-on-surface)}`；`.app-connection{font-family:var(--font-mono);font-size:var(--text-sm)}`；`.app-connection[data-connection="connected"]{color:var(--color-tertiary)}`；`.app-connection[data-connection="disconnected"]{color:var(--color-warning)}`；`.app-user{font-family:var(--font-mono);font-size:var(--text-sm);color:var(--color-on-surface-variant)}`；`.app-settings{margin-left:auto;font-family:var(--font-sans);font-size:var(--text-sm)}`。

- [ ] **Step 4: 修 UI-1 计划算术**

把 `2026-10-03-client-ui-1-shell.md` 里 `client-electron` 测试数那行改成：`= 既有 132 + 新增（theme 3 + AppBar 3 + app 2 = 8）= 140（评审修复轮再 +3，最终 143）`。

- [ ] **Step 5: 跑绿**

Run: `pnpm -C packages/client-electron test -- theme.test AppBar.test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/client-electron/src/renderer/src/theme.css \
        packages/client-electron/src/renderer/src/theme.test.ts \
        packages/client-electron/src/renderer/src/components/AppBar.tsx \
        docs/superpowers/plans/2026-10-03-client-ui-1-shell.md
git commit -m "style(client-electron): dress the app bar (UI-1 deferred minor)"
```

---

### Task 5: 桌面冒烟与整基验证（本切片出口）

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Consumes: 中栏 `.tool-row`；附件在中栏（Task 1）。
- Produces：冒烟在既有流程里断言附件位于 `main`（已在 Task 1 改），并在工作台看到步骤（既有 `复位测试台` 断言保留）。

- [ ] **Step 1: 复核冒烟中的位置断言**

确认 Task 1 的改动已在位：`note.txt` 断言在 `getByRole("main")` 下、`复位测试台` 仍在 `workbench` 下。

- [ ] **Step 2: 构建并跑冒烟**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron test:e2e`
Expected: build exit 0；冒烟 **3 passed**。

- [ ] **Step 3: 全量验证**

Run: `pnpm -r --if-present test` 与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0；`client-electron` 测试数 = UI-1 的 143 + 本切片新增（Transcript 2 + ToolCard 2 + workbench 1 + Workbench 1 + theme 1 = 7）。

- [ ] **Step 4: 提交**

```bash
git add packages/client-electron/smoke/electron.spec.ts
git commit -m "test(client-electron): the smoke keeps the attachment in the thread"
```

---

## 移交后续计划的待办

- **UI-2b**：§6.3 的「完成候选拆分」（中栏决策卡保留 summary；右栏只放 `evidenceRefs` + 决定状态）与「终态唯一」（中栏 summary 缩成一行、右栏独占 `terminal_state`/`recordId`）。
- **UI-3**：登录 / 设置 / 加载页在 `.app` 之外，不继承深色画布与 `--font-sans`（UI-1 评审 minor）；覆盖层与这两页的正式形态。
- **UI-4**：应用栏 `已断开` 端到端不可达（UI-1 终审 ruling I2）——依赖会话/重连语义。
- **UI-5**：字号 / 对比度 / 三态审计。

## Self-Review

**1. Spec coverage：** §6.2（判定规则：禁止长内容重复、允许导航性镜像）→ Task 2/3；§6.3 的「请求+附件 → 中栏」「步骤能力/状态 → 镜像」「step input → 右栏」「证据全文 → 右栏」→ Task 1/2/3；UI-1 评审 minor（应用栏内部样式）→ Task 4。**刻意不做**：§6.3 的「完成候选拆分」「终态唯一」→ UI-2b；其余按 Global Constraints。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给 props/DOM 契约。

**3. Type consistency：** `Transcript.onPreviewBlob/onSaveBlob`（T1）→ `app.tsx` 接线；`ToolCard.onLocate`（T2）→ `Transcript.onLocate` → `app.focusedStepId` → `Workbench.focusedStepId`；`WorkbenchStep.input/requiresConfirmation`（T3）在 `deriveWorkbench` 与 `Workbench.tsx` 复用；`AppBar` 的 `data-connection`（T4）与 `theme.css` 的 `.app-*` 规则一致。

**4. Review Focus：** 五条分别由 T1（附件右栏消失、blob 动作）、T2/T3（中栏不渲染全文与 input）、T2（定位 `data-focused`，未知 stepId 只是不高亮、不抛错）、T1/T2/T5（断言随迁）钉住。

**5. Proportion：** 计划只钉接口、断言与 DOM 契约；样式细节留给实现。
