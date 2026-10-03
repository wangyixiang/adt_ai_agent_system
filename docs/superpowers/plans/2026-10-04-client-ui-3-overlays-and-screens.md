# UI-3 覆盖层与登录/设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Report 查看器与 blob 预览/另存做成正式的**模态覆盖层**，并让**登录 / 设置 / 加载态**进入主题外壳（深色画布 + `--font-sans`），不再是裸浏览器默认样式。

**Architecture:** 纯 renderer + CSS。`app.tsx` 的三个早退分支包进 `.screen`；覆盖层规则从只含 overlay 的 `styles.css` 迁进 `theme.css` 并 token 化，`styles.css` 删除。组件 DOM 契约（testid、label、aria）不动。

**Tech Stack:** React 18 + TS（strict）· Vitest（jsdom + Testing Library）· Playwright Electron（桌面冒烟）

**Spec:** `docs/superpowers/specs/2026-10-03-client-ui-design.md`（§5 token、§6.1 屏幕清单、§10 组件规格、§12 覆盖层为正式模态）。计划是 spec 的论证，冲突以 spec 为准。

## Global Constraints

- 只用 `theme.css` 变量与纯 `className`；**不引入新依赖 / CSS 框架 / CSS-in-JS**。
- **一个数据一个家**：不改数据；本切片只改外观与包裹。
- 不改协议；`shared/` 不动。
- **最小字号 11px**；颜色 + 图标 + 文字。
- **DOM 契约不回归**：`data-testid="settings"`、`data-testid="report-viewer"`、`data-testid="blob-viewer"`、label（用户名 / 密码 / Server 地址 / 工作区）、按钮（登录 / 保存 / 取消 / 关闭 / 复制 / 另存为 .md）；覆盖层保留 `role="dialog" aria-modal="true"`。
- renderer 不 import `@adt/server`；编辑文件用 `edit`（**LF**）；**不 push**。
- 验证：`pnpm -r --if-present test`（串行）+ `typecheck` + `pnpm -C packages/client-electron build` + **桌面冒烟**（本切片出口）。
- **刻意不做**：中/右栏组件样式遍与无障碍（UI-5）、断线恢复（UI-4）、record 的 `requiresConfirmation`（单独切片）。

## Review Focus

1. **既有 testid / label 不回归**：首启设置、登录、Report、blob 的既有查询全部仍可用。见 Task 1/2/3。
2. **覆盖层仍可关闭**：Report 与 blob 的关闭按钮有效，`role="dialog"` 保留。见 Task 2。
3. **登录/设置继承主题**：不再落在裸画布；`--font-sans` 生效（用 `theme.css` 的 `.screen` 规则钉住）。见 Task 1。
4. **blob 三形态不回归**：text / image / binary 渲染不变。见 Task 2/3。
5. **首启强制**：`configured === false` 时设置页不可跳过。见 Task 1/3。

---

### Task 1: 非外壳屏幕进入主题外壳（`.screen`）

**Files:**
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Modify: `packages/client-electron/src/renderer/src/theme.css`
- Modify: `packages/client-electron/src/renderer/src/theme.test.ts`
- Modify: `packages/client-electron/src/renderer/src/app.test.tsx`

**Interfaces:**
- Produces：`app.tsx` 的四个早退分支（加载、config 未就绪/失败、设置、登录）各自包进 `<div className="screen" data-testid="app-screen">…</div>`；`theme.css` 新增 `.screen` 与 `.screen .login`/`.screen .settings` 规则（居中卡片、深色画布、`--font-sans`）。

- [ ] **Step 1: 写失败测试**

`theme.test.ts` 追加：

```ts
it("themes the pre-shell screens", () => {
  expect(css).toMatch(/\.screen\s*\{[^}]*background:\s*var\(--color-bg\)/);
  expect(css).toContain(".screen .login");
  expect(css).toContain(".screen .settings");
});
```

`app.test.tsx` 追加：

```tsx
it("wraps the login screen in the themed shell", async () => {
  const client = fakeClient({ snapshot: async () => disconnected });
  render(<App client={client} />);
  expect(await screen.findByTestId("app-screen")).toBeTruthy();
  expect(screen.getByLabelText("用户名")).toBeTruthy();
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- theme.test app.test`
Expected: FAIL——没有 `.screen` 规则，也没有 `app-screen`。

- [ ] **Step 3: 实现**

`app.tsx`：把 `!loaded`、`config === null`、`!config.configured || settingsOpen`、`!signedIn` 四处返回各自包进 `.screen`（保留内部的 `role="alert"` / `role="status"` / 组件）。`theme.css` 追加：

```css
.screen {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: var(--color-bg);
  color: var(--color-on-surface);
  font-family: var(--font-sans);
  font-size: var(--text-body);
}

.screen .login,
.screen .settings {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 360px;
  max-width: 100%;
  padding: 1.5rem;
  background: var(--color-surface-low);
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius);
}
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- theme.test app.test`
Expected: PASS（既有设置/登录用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/app.tsx \
        packages/client-electron/src/renderer/src/theme.css \
        packages/client-electron/src/renderer/src/theme.test.ts \
        packages/client-electron/src/renderer/src/app.test.tsx
git commit -m "style(client-electron): the login and settings screens get the themed shell"
```

---

### Task 2: 覆盖层主题化（Report + blob），`styles.css` 并入 `theme.css`

**Files:**
- Modify: `packages/client-electron/src/renderer/src/theme.css`
- Modify: `packages/client-electron/src/renderer/src/theme.test.ts`
- Modify: `packages/client-electron/src/renderer/src/main.tsx`
- Delete: `packages/client-electron/src/renderer/src/styles.css`

**Interfaces:**
- Consumes：现有 DOM 类名 `.report-viewer` / `.report-content` / `.report-actions` / `.blob-viewer` / `.blob-text` / `.blob-image`（`ReportViewer.tsx` 与 `app.tsx`）。
- Produces：`theme.css` 内含这些覆盖层规则（token 化：深色遮罩 + 面板 + 等宽正文）；`main.tsx` 不再 `import "./styles.css"`；`styles.css` 删除。

- [ ] **Step 1: 写失败测试（`theme.test.ts`）**

```ts
it("themes the overlays", () => {
  expect(css).toMatch(/\.report-viewer[^{]*\{[^}]*position:\s*fixed/);
  expect(css).toContain(".blob-viewer");
  expect(css).toContain(".report-content");
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- theme.test`
Expected: FAIL——`theme.css` 目前没有覆盖层规则（在 `styles.css`）。

- [ ] **Step 3: 实现**

把 `styles.css` 的覆盖层规则**迁进 `theme.css` 并 token 化**（`.report-viewer, .blob-viewer` 用 `background: color-mix(in srgb, var(--color-bg) 80%, transparent)`、`color: var(--color-on-surface)`、`font-family: var(--font-sans)`；`.report-content, .blob-text` 用 `--font-mono`/`--text-mono`、`--color-surface-lowest`、边框 `--color-outline-variant`）。改 `main.tsx` 去掉 `import "./styles.css";`；删除 `styles.css`。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- theme.test ReportViewer.test app.test`
Expected: PASS（`report-viewer`/`blob-viewer` testid 与关闭按钮不回归）。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/theme.css \
        packages/client-electron/src/renderer/src/theme.test.ts \
        packages/client-electron/src/renderer/src/main.tsx
git rm packages/client-electron/src/renderer/src/styles.css
git commit -m "style(client-electron): token the overlays; fold styles.css into theme.css"
```

---

### Task 3: 桌面冒烟与整基验证（本切片出口）

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Consumes: `data-testid="app-screen"`（Task 1）；既有 `settings`/`report-viewer` testid。
- Produces：冒烟在"首启设置"用例里断言 `app-screen` 可见（主题外壳在），接续既有流程。

- [ ] **Step 1: 加冒烟断言**

在第三个用例 `await expect(page.getByTestId("settings")).toBeVisible(...)` 之前追加：

```ts
await expect(page.getByTestId("app-screen")).toBeVisible({ timeout: 20_000 });
```

- [ ] **Step 2: 构建并跑冒烟**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron test:e2e`
Expected: build exit 0；冒烟 **3 passed**。

- [ ] **Step 3: 全量验证**

Run: `pnpm -r --if-present test` 与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0；`client-electron` 测试数 = 160 + 本切片新增（theme 2 + app 1 = 3）。

- [ ] **Step 4: 提交**

```bash
git add packages/client-electron/smoke/electron.spec.ts
git commit -m "test(client-electron): the smoke sees the themed pre-shell screen"
```

---

## 移交后续计划的待办

- **UI-5**：中/右栏组件样式遍（`.tool-row`/`.bubble*`/`.step-input`/`.completion-*`/`.workbench-*`/`.transcript`/`.ask-card` 等）与无障碍（最小字号、对比度、颜色+图标+文字）。
- **UI-4**：断线恢复 + `已断开` 端到端。
- **record 切片**：`step_dispatched` 带 `requiresConfirmation`。
- **单独 bounded**：server 两个时序 flake。

## Self-Review

**1. Spec coverage：** §10（Report 查看器 / blob 覆盖层 / 登录 / 设置）→ Task 1/2；§12（覆盖层为正式模态）→ Task 2；UI-1 路由来的"非外壳屏幕未继承主题" → Task 1。**刻意不做**见 Global Constraints 与移交清单。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给 CSS 规则/包裹契约。

**3. Type consistency：** `data-testid="app-screen"`（T1）在 T3 复用；覆盖层类名（T2）与 `ReportViewer.tsx`/`app.tsx` 现有 DOM 一致；`main.tsx` 去掉 `styles.css` import 后只剩 `theme.css`。

**4. Review Focus：** 五条分别由 T1（`app-screen`、`--font-sans`、首启强制既有用例）、T2（覆盖层规则与 testid）、T3（smoke + 全量）钉住。

**5. Proportion：** 计划只钉包裹契约与 CSS 选择器；具体视觉留给实现。
