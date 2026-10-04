# UI-5 状态与无障碍收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把中/右栏的组件真正"穿上"设计 token（对话流、步骤行、ask 卡、工作台、完成候选、恢复提示），统一**空/加载/错误态**，并收口**无障碍**：最小字号 11px、状态"颜色+图标+文字"、两个模态**可 Esc 关闭且初始焦点在对话框内**。

**Architecture:** 几乎全是 `theme.css` 的规则（用既有 token），加两个模态的无障碍行为（`ReportViewer`/`BlobViewer` 加 Esc 监听 + 关闭按钮初始焦点）。不改数据、不改 DOM 契约。

**Tech Stack:** React 18 + TS（strict）· Vitest（jsdom + Testing Library）· Playwright Electron

**Spec:** `docs/superpowers/specs/2026-10-03-client-ui-design.md`（§5 token/密度、§10 组件规格、§12 测试策略；§6 一个数据一个家不动）。

## Global Constraints

- 只用 `theme.css` 变量与纯 `className`；**无新依赖 / CSS 框架 / CSS-in-JS**。
- **最小字号 11px**（`theme.css` 不得出现 `font-size: 9px|10px`）；正文 13px；等宽 12px。
- **状态用颜色 + 图标 + 文字**（既有徽章已有文字；`data-state`/`data-connection` 提供颜色）。
- 不改数据/协议；**DOM 契约不回归**（testid/label/按钮/`role="dialog"`/`aria-modal`）。
- renderer 不 import `@adt/server`；编辑文件用 `edit`（**LF**）；**不 push**。
- 验证：`pnpm -r --if-present test`（串行）+ `typecheck` + `pnpm -C packages/client-electron build` + **桌面冒烟**。
- **刻意不做**：过期提示误报的 daemon 终态对账、`requiresConfirmation` 进 Record、时序 flake 稳化——见移交清单。

## Review Focus

1. **最小字号 11px 全站**：`theme.css` 无 9/10px；组件字号走 `--text-*`。见 Task 1/2。
2. **状态不只靠颜色**：徽章/连接态都有文字（既有），并有 `data-*` 提供颜色。见 Task 1/2。
3. **模态可 Esc 关闭且初始焦点在对话框内**：Report 与 blob 两个覆盖层。见 Task 3。
4. **空/加载/错误态不白屏**：有明确样式。见 Task 2。
5. **既有 testid/label/行为不回归**：全部既有组件/冒烟用例。见 Task 1/2/3/4。

---

### Task 1: 对话流与工作台组件样式

**Files:**
- Modify: `packages/client-electron/src/renderer/src/theme.css`
- Modify: `packages/client-electron/src/renderer/src/theme.test.ts`

**Interfaces:**
- Consumes：既有类名——`.transcript`、`.bubble`（`.user`）、`.bubble-text`、`.bubble-attachments`、`.bubble-attachment`、`.tool-row`、`.ask-card`、`.notice`、`.summary`、`.progress`、`.workbench`、`.workbench-header`、`.workbench-step`、`.step-input`、`.needs-confirmation`、`.completion-decision`、`.completion-refs`、`.reconnect-note`、`.composer`。
- Produces：`theme.css` 中这些类名的规则（token 化：面板/卡片底色、1px 结构线、4px 圆角、`--text-*` 字号、`--font-mono` 用于能力/id）。

- [ ] **Step 1: 写失败测试（`theme.test.ts`）**

```ts
it("dresses the thread and the workbench", () => {
  for (const selector of [
    ".transcript", ".bubble", ".tool-row", ".ask-card", ".notice", ".summary",
    ".workbench-step", ".step-input", ".needs-confirmation", ".completion-decision",
    ".completion-refs", ".reconnect-note", ".progress", ".composer",
  ]) {
    expect(css).toContain(selector);
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- theme.test`
Expected: FAIL——多数选择器不在 `theme.css`。

- [ ] **Step 3: 实现**

在 `theme.css` 追加规则：`.transcript`（纵向流、间距）、`.bubble`（卡片、`.user` 靠右/主色描边）、`.tool-row`（`font: inherit; text-align: left; width: 100%`，能力用 `--font-mono`、`data-state` 给状态点颜色）、`.ask-card`（高亮卡片）、`.notice`/`.summary`（次要/终态）、`.progress`（顶栏）、`.composer`（底部输入）、`.workbench-*`（面板/节点）、`.step-input`（折叠区）、`.needs-confirmation`（警示色）、`.completion-*`、`.reconnect-note`（警示/进行色）。全部用 `--color-*`/`--text-*`/`--font-*`/`--radius`。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- theme.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/theme.css packages/client-electron/src/renderer/src/theme.test.ts
git commit -m "style(client-electron): dress the thread and the workbench"
```

---

### Task 2: 状态与空态样式（空 / 加载 / 错误 / 通知）

**Files:**
- Modify: `packages/client-electron/src/renderer/src/theme.css`
- Modify: `packages/client-electron/src/renderer/src/theme.test.ts`

**Interfaces:**
- Consumes：`.empty`、`.loading`、`[role="alert"]`、`.notice`、`.hint`。
- Produces：`theme.css` 的 `.empty` / `.loading` / `.screen [role="alert"]` / `.notice` 规则；`.empty`/`.loading` 用次要色居中，错误用 `--color-error`。

- [ ] **Step 1: 写失败测试**

```ts
it("styles the empty, loading and error states", () => {
  expect(css).toContain(".empty");
  expect(css).toContain(".loading");
  expect(css).toMatch(/\[role="alert"\]/);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- theme.test`
Expected: FAIL。

- [ ] **Step 3: 实现**

追加：`.empty`、`.loading`（居中、`--color-on-surface-variant`、`--text-body`）、`[role="alert"]`（`--color-error`）、`.notice`（info 用 `--color-on-surface-variant`，warn 用 `--color-warning`——用 `.notice[data-level="warn"]`，需 `Notice.tsx` 已输出 `data-level`；若无则加）。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- theme.test app.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/theme.css packages/client-electron/src/renderer/src/theme.test.ts packages/client-electron/src/renderer/src/components/Notice.tsx
git commit -m "style(client-electron): the empty, loading and error states"
```

---

### Task 3: 模态无障碍（Esc 关闭 + 初始焦点）

**Files:**
- Modify: `packages/client-electron/src/renderer/src/components/ReportViewer.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/BlobViewer.tsx`
- Test: `packages/client-electron/src/renderer/src/components/ReportViewer.test.tsx`
- Test: `packages/client-electron/src/renderer/src/components/BlobViewer.test.tsx`

**Interfaces:**
- Produces：两个模态在挂载时监听 window `keydown`，`Escape` 调 `onClose`；关闭按钮 `autoFocus`（初始焦点在对话框内）。

- [ ] **Step 1: 写失败测试**

`ReportViewer.test.tsx` 追加：

```tsx
it("closes on Escape and focuses the close button", async () => {
  const onClose = vi.fn();
  render(<ReportViewer markdown="# r" onCopy={() => {}} onSave={() => {}} onClose={onClose} />);
  expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});
```

`BlobViewer.test.tsx` 追加：同样的 Esc + 焦点断言（preview 用 `{kind:"text",…}`）。

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- ReportViewer.test BlobViewer.test`
Expected: FAIL——无 Esc 监听，关闭按钮无初始焦点。

- [ ] **Step 3: 实现**

两个组件加 `useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);`；关闭按钮加 `autoFocus`。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- ReportViewer.test BlobViewer.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/components/ReportViewer.tsx \
        packages/client-electron/src/renderer/src/components/BlobViewer.tsx \
        packages/client-electron/src/renderer/src/components/ReportViewer.test.tsx \
        packages/client-electron/src/renderer/src/components/BlobViewer.test.tsx
git commit -m "feat(client-electron): the modals close on Escape and take initial focus"
```

---

### Task 4: 桌面冒烟与整基验证（本切片出口）

**Files:** 无新增（只跑）。

- [ ] **Step 1: 构建与冒烟**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron test:e2e`
Expected: build exit 0；冒烟 **3 passed**。

- [ ] **Step 2: 全量验证**

Run: `pnpm -r --if-present test` 与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0。

- [ ] **Step 3: 最小字号审计**

Run: `grep -nE "font-size:\s*(9|10)px" packages/client-electron/src/renderer/src/theme.css`
Expected: 无输出（`theme.test` 已有断言）。

---

## 移交后续计划的待办

- **断线终态对账切片**：`state_sync` 的终态 workflow 未进投影，导致"会话已过期"提示可能误报（断线期间已完成的运行）——需 daemon 侧对账 + 投影收敛。
- **record 切片**：`step_dispatched` 带 `requiresConfirmation`；播种的 resume step 也因此缺该标记。
- **单独 bounded**：时序 flake 家族（server `recordProtocol`/`stepTimeout.int`、daemon `controlledExecution`）——已确认文件并行 + 计时所致，`--no-file-parallelism` 必绿。
- `login` 握手成功到 `subscribe` 之间的窄竞态（漏观察一次断线）。

## Self-Review

**1. Spec coverage：** §5（token/密度/最小字号）→ Task 1/2 + 既有断言；§10（组件规格：对话流/工作台/覆盖层）→ Task 1/3；§12（测试）→ 各任务；§9 的 `.reconnect-note` → Task 1。**刻意不做**见 Global Constraints/移交。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给选择器/行为契约。

**3. Type consistency：** 类名与既有组件一致（`.tool-row`/`.workbench-step`/`.reconnect-note` 等来自 UI-2/UI-4）；`.notice[data-level]` 需 `Notice.tsx` 输出 `data-level`（Task 2 若无则补）。

**4. Review Focus：** 五条分别由 T1/T2（字号/状态）、T3（Esc/焦点）、T2（空/加载/错误）、T4（冒烟 + 全量）钉住。

**5. Proportion：** 计划只钉选择器与行为断言；具体视觉留给实现。
