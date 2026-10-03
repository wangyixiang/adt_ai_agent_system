# UI-1 基石 + 外壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给单体 Electron 客户端装上设计 token、本地字体、顶部应用栏，并把当前"堆叠 div"变成真正的三栏外壳（左会话 / 中对话 / 右工作台），设置入口迁到应用栏。

**Architecture:** 全部在 renderer 内。新增一个 `theme.css`（`:root` 设计变量 + 字体 `@font-face`）驱动视觉；新增纯展示组件 `AppBar`；`app.tsx` 在既有三块之上加应用栏并用 `.app-body` 包住三栏。不改协议、不改 `shared/` 模型（`connection` 仍是 `connected|disconnected`，三态留给 UI-4）。

**Tech Stack:** Electron + electron-vite · React 18 + TypeScript（strict）· Vitest（jsdom + Testing Library）· Playwright Electron（桌面冒烟）· pnpm workspace

**Spec:** `docs/superpowers/specs/2026-10-03-client-ui-design.md`（本计划实现其 §4 / §5 / §6.1 / §7；§9 由 UI-4、§10 其余组件由 UI-2/UI-3 落地）。参考稿 `docs/superpowers/reference/2026-10-03-client-ui-mockup/`。

## Global Constraints

- **现实绑定**：本切片新增的 UI 元素都在 spec §11 数据绑定表内（应用栏 = `UiSnapshot.connection` / `userId` / 设置入口）。
- **不动协议**；`shared/ui.ts` 本切片不改。
- **无新依赖**（本地打包字体是静态资产，不是依赖）；只有一个 `renderer/src/theme.css` + 纯 `className`，不搭组件库、不引 CSS 框架。
- **最小字号 11px**；正文 13px；等宽 12px。
- **颜色 + 图标 + 文字**（本切片先保证连接态有文字，不靠颜色单表意）。
- **renderer 不 import `@adt/server`、不碰 Node**（`ADR-006`）。
- 编辑文件用 `edit`（仓库 **LF**）；**不 push**。
- 验证口径：`pnpm -r --if-present test`（**串行**）+ `pnpm -r --if-present typecheck` + `pnpm -C packages/client-electron build`；**本切片出口含桌面冒烟**（`packages/client-electron` 的 `test:e2e`）。
- 本计划**刻意不做**：中/右去重（UI-2）、覆盖层与登录/设置页（UI-3）、断线恢复/三态连接（UI-4）、无障碍收口（UI-5）；不改任何现有组件的行为，只改外壳与样式。

## Review Focus

以下失败模式 spec 隐含、但默认测试不会覆盖；**每条都要在对应任务的测试里钉住**：

1. **字体缺失/离线**：字体资产没拿到或加载失败时，界面必须仍可用（回退 `Segoe UI`/`Cascadia Mono`），不能白屏、不能出现空白字形。见 Task 1。
2. **连接态误报**：`disconnected` 时应用栏必须明说"已断开"，不能仍显示"已连接"。见 Task 2。
3. **设置入口不唯一/不可达**：迁移后既不能出现两个"设置"按钮，也不能两个都没有。见 Task 3。
4. **三栏/既有 testid 回归**：`main`(对话)、`workbench`、`app`、`settings`、`report-viewer` 仍在，桌面冒烟不回归。见 Task 3 / Task 4。
5. **加载态不白屏**：`config` 未就绪 / 未登录时不渲染应用栏也不能抛错。见 Task 3。

---

### Task 1: 设计 token 与本地字体

**Files:**
- Create: `packages/client-electron/src/renderer/src/theme.css`
- Test: `packages/client-electron/src/renderer/src/theme.test.ts`
- Create: `packages/client-electron/src/renderer/src/assets/fonts/inter-latin-400-normal.woff2`
- Create: `packages/client-electron/src/renderer/src/assets/fonts/inter-latin-500-normal.woff2`
- Create: `packages/client-electron/src/renderer/src/assets/fonts/inter-latin-600-normal.woff2`
- Create: `packages/client-electron/src/renderer/src/assets/fonts/jetbrains-mono-latin-400-normal.woff2`
- Create: `packages/client-electron/src/renderer/src/assets/fonts/jetbrains-mono-latin-500-normal.woff2`
- Modify: `packages/client-electron/src/renderer/src/main.tsx`（在 `import "./styles.css";` **之前**加 `import "./theme.css";`）

**Interfaces:**
- Produces（CSS `:root` 变量，供后续所有组件与 UI-2..5 引用）：
  - 颜色：`--color-bg`(#0b1326) / `--color-surface-lowest`(#060e20) / `--color-surface-low`(#131b2e) / `--color-surface`(#171f33) / `--color-surface-high`(#222a3d) / `--color-surface-highest`(#2d3449) / `--color-on-surface`(#dae2fd) / `--color-on-surface-variant`(#bfc7d2) / `--color-outline-variant`(#3f4850) / `--color-primary`(#93ccff) / `--color-primary-container`(#3198dc) / `--color-on-primary`(#003351) / `--color-secondary`(#c0c1ff) / `--color-tertiary`(#4edea3) / `--color-error`(#ffb4ab) / `--color-warning`(#fbbf24)
  - 字体：`--font-sans: "Inter", "Segoe UI", system-ui, sans-serif`；`--font-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace`
  - 字号：`--text-sm: 11px` / `--text-body: 13px` / `--text-mono: 12px`；圆角 `--radius: 4px`
- Produces：`@font-face` 家族名 `Inter`（400/500/600）与 `JetBrains Mono`（400/500），`src` 指向 `./assets/fonts/*.woff2`。
- Consumes：无。

- [ ] **Step 1: 写失败测试（token 契约 + 字体资产 + 最小字号）**

```ts
// packages/client-electron/src/renderer/src/theme.test.ts
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

const REQUIRED_VARS = [
  "--color-bg", "--color-surface-lowest", "--color-surface-low", "--color-surface",
  "--color-surface-high", "--color-surface-highest", "--color-on-surface",
  "--color-on-surface-variant", "--color-outline-variant", "--color-primary",
  "--color-primary-container", "--color-on-primary", "--color-secondary",
  "--color-tertiary", "--color-error", "--color-warning", "--font-sans", "--font-mono",
];

const FONT_FILES = [
  "inter-latin-400-normal.woff2", "inter-latin-500-normal.woff2", "inter-latin-600-normal.woff2",
  "jetbrains-mono-latin-400-normal.woff2", "jetbrains-mono-latin-500-normal.woff2",
];

describe("the design tokens", () => {
  it("declares every spec token", () => {
    for (const name of REQUIRED_VARS) expect(css).toContain(`${name}:`);
  });

  it("vendors the two font families locally", () => {
    for (const file of FONT_FILES) {
      expect(existsSync(new URL(`./assets/fonts/${file}`, import.meta.url))).toBe(true);
    }
    expect(css).toContain('font-family: "Inter"');
    expect(css).toContain('font-family: "JetBrains Mono"');
  });

  it("keeps the smallest type at 11px", () => {
    expect(css).not.toMatch(/font-size:\s*(9|10)px/);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- theme.test`
Expected: FAIL——`ENOENT`（`theme.css` 不存在）。

- [ ] **Step 3: 建 `theme.css`（token + `@font-face`）**

一个 `:root` 块声明上面 Interfaces 里的全部变量（值照抄），随后 5 个 `@font-face`（Inter 400/500/600、JetBrains Mono 400/500），每个 `src: url("./assets/fonts/<file>") format("woff2"); font-display: swap;`。

- [ ] **Step 4: 下载字体资产**

```bash
cd packages/client-electron/src/renderer/src/assets/fonts
base=https://cdn.jsdelivr.net/npm/@fontsource
curl -fsSL -o inter-latin-400-normal.woff2              $base/inter@5.1.0/files/inter-latin-400-normal.woff2
curl -fsSL -o inter-latin-500-normal.woff2              $base/inter@5.1.0/files/inter-latin-500-normal.woff2
curl -fsSL -o inter-latin-600-normal.woff2              $base/inter@5.1.0/files/inter-latin-600-normal.woff2
curl -fsSL -o jetbrains-mono-latin-400-normal.woff2     $base/jetbrains-mono@5.1.0/files/jetbrains-mono-latin-400-normal.woff2
curl -fsSL -o jetbrains-mono-latin-500-normal.woff2     $base/jetbrains-mono@5.1.0/files/jetbrains-mono-latin-500-normal.woff2
```

（这 5 个 URL 已实测 200。若离线，`theme.css` 仍必须写好，`--font-*` 的回退栈保证界面可用；把"资产未入库"记进本轮裁决表。）

- [ ] **Step 5: `main.tsx` 引入**

在 `import "./styles.css";` 之前加一行 `import "./theme.css";`。

- [ ] **Step 6: 跑绿**

Run: `pnpm -C packages/client-electron test -- theme.test`
Expected: PASS（3/3）。

- [ ] **Step 7: 提交**

```bash
git add packages/client-electron/src/renderer/src/theme.css \
        packages/client-electron/src/renderer/src/theme.test.ts \
        packages/client-electron/src/renderer/src/assets/fonts \
        packages/client-electron/src/renderer/src/main.tsx
git commit -m "feat(client-electron): design tokens and locally bundled fonts"
```

---

### Task 2: `AppBar` 组件

**Files:**
- Create: `packages/client-electron/src/renderer/src/components/AppBar.tsx`
- Test: `packages/client-electron/src/renderer/src/components/AppBar.test.tsx`

**Interfaces:**
- Consumes: `UiSnapshot["connection"]`、`UiSnapshot["userId"]`（`../../shared/contract`）。
- Produces:
  ```ts
  export function AppBar(props: {
    connection: import("../../../shared/contract").UiSnapshot["connection"];
    userId: string | null;
    onOpenSettings(): void;
  }): JSX.Element;
  ```
  DOM 契约：`<header className="app-bar" data-testid="app-bar">`；应用名文本 `ADT`；连接文案 `connected → "已连接"`、`disconnected → "已断开"`；`userId !== null` 时显示其文本；一个 `<button type="button">设置</button>`，`onClick` 调 `onOpenSettings`。

- [ ] **Step 1: 写失败测试**

```tsx
// packages/client-electron/src/renderer/src/components/AppBar.test.tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppBar } from "./AppBar";

describe("the app bar", () => {
  it("says 已连接 and shows the user when connected", () => {
    render(<AppBar connection="connected" userId="usr_1" onOpenSettings={() => {}} />);
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("usr_1")).toBeTruthy();
  });

  it("says 已断开 when disconnected", () => {
    render(<AppBar connection="disconnected" userId={null} onOpenSettings={() => {}} />);
    expect(screen.getByText("已断开")).toBeTruthy();
  });

  it("opens settings from the app bar", async () => {
    const onOpenSettings = vi.fn();
    render(<AppBar connection="connected" userId="usr_1" onOpenSettings={onOpenSettings} />);
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- AppBar.test`
Expected: FAIL——找不到模块 `./AppBar`。

- [ ] **Step 3: 实现 `AppBar.tsx`**

按下述 DOM 契约实现（连接文案用一个 `connection === "connected" ? "已连接" : "已断开"` 的映射；不要引入图标库）。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- AppBar.test`
Expected: PASS（3/3）。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/components/AppBar.tsx \
        packages/client-electron/src/renderer/src/components/AppBar.test.tsx
git commit -m "feat(client-electron): the app bar"
```

---

### Task 3: 外壳接线、三栏布局、设置入口迁移

**Files:**
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/ConversationList.tsx`
- Modify: `packages/client-electron/src/renderer/src/theme.css`
- Test: `packages/client-electron/src/renderer/src/app.test.tsx`

**Interfaces:**
- Consumes: `AppBar`（Task 2）；`UiSnapshot.connection` / `.userId`。
- Produces（DOM）：
  - `.app > header[data-testid="app-bar"] + div.app-body`
  - `.app-body > nav.conversations / p.empty[data-testid="conversation-list"]`、`main.thread`、`aside.workbench[data-testid="workbench"]`
  - 迁走后：中栏 `<main className="thread">` 内**不再**有 `button.open-settings`；全局**恰好一个** `<button>设置</button>`（在应用栏）。
- Consumes（既有）：`ConversationList` 的 props 不变。

- [ ] **Step 1: 写失败测试（加到 `app.test.tsx` 的 `describe("the app", ...)` 内）**

```tsx
it("shows the app bar and opens settings from it", async () => {
  render(<App client={fakeClient()} />);
  expect(await screen.findByTestId("app-bar")).toBeTruthy();
  expect(screen.getByText("已连接")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(await screen.findByTestId("settings")).toBeTruthy();
});

it("has exactly one settings button and a three-pane body", async () => {
  render(<App client={fakeClient()} />);
  await screen.findByTestId("app-bar");
  expect(screen.getAllByRole("button", { name: "设置" })).toHaveLength(1);
  expect(screen.getByTestId("conversation-list")).toBeTruthy();
  expect(screen.getByRole("main")).toBeTruthy();
  expect(screen.getByTestId("workbench")).toBeTruthy();
});
```

（`render`/`screen`/`userEvent`/`fakeClient` 都是该文件已有的导入与 helper，直接用。）

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- app.test`
Expected: FAIL——`app-bar` / `conversation-list` 不存在（新用例）。

- [ ] **Step 3: 改 `app.tsx`**

删掉中栏里的 `<button type="button" className="open-settings" ...>设置</button>`；把返回改成：

```tsx
<div className="app" data-testid="app">
  <AppBar
    connection={ui.snapshot.connection}
    userId={ui.snapshot.userId}
    onOpenSettings={() => setSettingsOpen(true)}
  />
  <div className="app-body">
    <ConversationList ... />
    <main className="thread"> ... </main>
    <Workbench ... />
  </div>
  {blob !== null && ( ... )}
  {report !== null && ( ... )}
</div>
```

（三块内部的 JSX 原样不动。）

- [ ] **Step 4: `ConversationList` 加 testid**

空态 `<p className="empty">` 与列表 `<nav className="conversations">` **两处**都加 `data-testid="conversation-list"`。

- [ ] **Step 5: `theme.css` 加布局规则**

追加：`html, body, #root { height: 100%; margin: 0; }`；`.app { display:flex; flex-direction:column; height:100%; background:var(--color-bg); color:var(--color-on-surface); font-family:var(--font-sans); font-size:var(--text-body); }`；`.app-bar { display:flex; align-items:center; gap:.75rem; height:2.25rem; padding:0 .75rem; background:var(--color-surface-lowest); border-bottom:1px solid var(--color-outline-variant); }`；`.app-body { flex:1; display:flex; min-height:0; }`；`.conversations { width:280px; flex-shrink:0; overflow-y:auto; background:var(--color-surface-low); border-right:1px solid var(--color-outline-variant); }`；`.thread { flex:1; min-width:0; display:flex; flex-direction:column; }`；`.workbench { width:380px; flex-shrink:0; overflow-y:auto; background:var(--color-surface-low); }`。

- [ ] **Step 6: 跑绿**

Run: `pnpm -C packages/client-electron test -- app.test`
Expected: PASS（含新增 2 条；既有 35 条不回归）。

- [ ] **Step 7: 提交**

```bash
git add packages/client-electron/src/renderer/src/app.tsx \
        packages/client-electron/src/renderer/src/app.test.tsx \
        packages/client-electron/src/renderer/src/components/ConversationList.tsx \
        packages/client-electron/src/renderer/src/theme.css
git commit -m "feat(client-electron): the app bar shell and three-pane layout"
```

---

### Task 4: 桌面冒烟与整包验证（本切片出口）

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Consumes: `data-testid="app-bar"`（Task 2/3）。
- Produces：冒烟新增断言——登录后应用栏可见，且其连接文案为"已连接"。

- [ ] **Step 1: 加冒烟断言**

在第一个用例 `login(page)` 之后、发送请求之前插入：

```ts
await expect(page.getByTestId("app-bar")).toBeVisible({ timeout: 20_000 });
await expect(page.getByTestId("app-bar").getByText("已连接")).toBeVisible();
```

- [ ] **Step 2: 构建并跑冒烟**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron test:e2e`
Expected: build exit 0；冒烟 **3 passed**（第一条含新断言）。

- [ ] **Step 3: 全量验证**

Run: `pnpm -r --if-present test`（串行）与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0；`client-electron` 测试数 = 既有 132 + 新增（AppBar 3 + app 2 = 5）。

- [ ] **Step 4: 提交**

```bash
git add packages/client-electron/smoke/electron.spec.ts
git commit -m "test(client-electron): the smoke asserts the app bar"
```

---

## Self-Review

**1. Spec coverage：** spec §4（约束）→ Global Constraints；§5（token/字体/密度）→ Task 1；§6.1（三栏职责）→ Task 3；§7（应用栏）→ Task 2/3。**刻意不做**已列明（§9 断线恢复 → UI-4；§10 其余组件 → UI-2/UI-3；§12 无障碍 → UI-5）。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给签名/值或 DOM 契约。

**3. Type consistency：** `AppBar`（T2）在 T3 被消费；`data-testid="app-bar"`（T2）在 T3/T4 复用；`--color-*`/`--font-*`（T1）在 T3 的布局里被引用；`data-testid="conversation-list"`（T3）在 T3 断言。

**4. Review Focus：** 五条都落到测试——字体资产 + 回退栈（T1）、连接态（T2）、设置唯一/可达（T3）、三栏与既有 testid（T3/T4）、加载态不白屏（T3 既有用例覆盖 `config === null` 分支，本切片不新增早退分支）。

**5. Proportion：** 计划只钉接口、断言与关键样式骨架；组件长相细节留给实现。
