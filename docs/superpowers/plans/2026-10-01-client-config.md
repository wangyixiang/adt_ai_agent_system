# 客户端配置：首次运行设置页（P-client-config）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让装好（或 `pnpm dev` 起）的客户端能由用户填 **Server 地址**（和可选工作区），并把它**持久化**——首次运行弹设置页，之后可改；不再只靠环境变量。

**Architecture:** main 侧新增 `src/main/core/config.ts`（读/写 `userData/config.json`、算"有效配置"，**纯逻辑可单测**），并把它接进 `main/index.ts`：配置变更时**重建 session**（未连接时廉价）。新增 IPC `config_get` / `config_set`。renderer 侧新增 `Settings` 组件，并在 `App` 里加一道**首启门**（未配置 → 设置页，而不是登录页），登录后也可从"设置"改。

**Tech Stack:** Electron + electron-vite · React + TS（strict）· Vitest（node + jsdom/RTL）· Playwright Electron · pnpm workspace

**Spec:** `docs/superpowers/specs/2026-10-01-deployment-and-provisioning-design.md`（**§5 是本计划**；§4 已在 `master`，§6 是下一份）。

## Global Constraints

- **renderer 不碰 Node/文件系统**：读写 `userData/config.json` 只在 main；renderer 只经 IPC。
- **优先级**：文件里的 `serverUrl` **优先于** `ADT_SERVER_URL`；都没有才算"未配置"。`workspaceRoot` 同理（`ADT_WORKSPACE` 兜底，最后 `process.cwd()`）。
- **不引新依赖、不引 CSS 框架**（沿用现有 DOM + `className`，可复用 `styles.css`）。
- **不改协议面**；`client-daemon` 不变。
- 编辑文件用 `edit` 工具（仓库 **LF**）；**不 push**。
- 验证口径：`pnpm -r --if-present test`（串行）+ `typecheck` + `client-electron build` + **桌面冒烟**。
- 本计划**刻意不做**：登录后"边跑边改地址"的无缝切换（改地址 = 重建 session，**需重新登录**，UI 如实回到登录页）；多 Server 配置档；代理/证书设置；NSIS 打包（§6）。

## Review Focus

以下失败模式是本 spec 隐含、但默认测试不会覆盖的；**每条都必须在对应任务里有测试**：

1. **首启门**：没有任何 `serverUrl` 来源时必须显示**设置页**，**不能**显示登录页、更不能偷偷连默认地址。见 Task 1 / Task 3。
2. **优先级正确**：文件值 **优先于** 环境变量；两者都无 → 未配置。见 Task 1。
3. **保存即生效**：`config_set` 之后重建的 session 用的是**新地址**（不是启动时那个）。见 Task 2。
4. **改地址后不残留旧连接**：重存地址会关闭旧 session；若此前已登录，UI 回到登录页（如实）。见 Task 2 / Task 3。
5. **工作区可选**：只填 Server 地址也能保存并进入登录。见 Task 3。

---

### Task 1: main 侧配置存储（纯逻辑）

**Files:**
- Create: `packages/client-electron/src/main/core/config.ts`
- Test: `packages/client-electron/src/main/core/config.test.ts`

**Interfaces:**
- Produces:
```ts
export const DEFAULT_SERVER_URL = "ws://127.0.0.1:8080/ws";
/** What the config file may contain (all optional). */
export interface StoredConfig { serverUrl?: string; workspaceRoot?: string }
/** The effective settings the app runs with. */
export interface AppConfig { serverUrl: string; workspaceRoot: string; configured: boolean }
export function readConfig(path: string): StoredConfig | null;         // 缺失/坏 JSON → null
export function writeConfig(path: string, config: StoredConfig): void; // 原子写（先写临时文件再 rename）
export function effectiveConfig(
  stored: StoredConfig | null,
  env: Record<string, string | undefined>,
  cwd: string,
): AppConfig;
```
- `effectiveConfig` 规则：`serverUrl = stored.serverUrl?.trim() || env.ADT_SERVER_URL || ""`；`configured = serverUrl !== ""`；**只有都空时**才回退 `DEFAULT_SERVER_URL`，但此时 `configured` 仍为 `false`。`workspaceRoot = stored.workspaceRoot?.trim() || env.ADT_WORKSPACE || cwd`。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/core/config.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { DEFAULT_SERVER_URL, effectiveConfig, readConfig, writeConfig } from "./config";

describe("config", () => {
  it("prefers the stored value over the environment", () => {
    const config = effectiveConfig({ serverUrl: "ws://stored:1/ws" }, { ADT_SERVER_URL: "ws://env:2/ws" }, "C:/w");
    expect(config).toEqual({ serverUrl: "ws://stored:1/ws", workspaceRoot: "C:/w", configured: true });
  });

  it("falls back to the environment when the file has no address", () => {
    expect(effectiveConfig(null, { ADT_SERVER_URL: "ws://env:2/ws" }, "C:/w").serverUrl).toBe("ws://env:2/ws");
  });

  it("is not configured when neither is set, and does not silently pick a real server", () => {
    const config = effectiveConfig(null, {}, "C:/w");
    expect(config.configured).toBe(false);
    expect(config.serverUrl).toBe(DEFAULT_SERVER_URL); // a shown default, not a connection
  });

  it("round-trips through the file, and tolerates a missing or broken one", () => {
    const dir = mkdtempSync(join(tmpdir(), "adt-cfg-"));
    try {
      const path = join(dir, "config.json");
      expect(readConfig(path)).toBeNull();
      writeConfig(path, { serverUrl: "ws://x/ws", workspaceRoot: "/w" });
      expect(readConfig(path)).toEqual({ serverUrl: "ws://x/ws", workspaceRoot: "/w" });
      writeFileSync(path, "{ not json");
      expect(readConfig(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/config.test.ts`
- [ ] **Step 3: 实现**（`readConfig` 用 `try/catch`；`writeConfig` 写 `path.tmp` 再 `renameSync`，避免半截文件）
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `feat(electron): a config store for the server address and workspace`

---

### Task 2: IPC `config_get` / `config_set` + main 重建 session

**Files:**
- Modify: `packages/client-electron/src/shared/contract.ts`
- Modify: `packages/client-electron/src/main/core/bridge.ts`
- Modify: `packages/client-electron/src/preload/index.ts`
- Modify: `packages/client-electron/src/main/index.ts`
- Test: `packages/client-electron/src/main/core/bridge.test.ts`（Modify）

**Interfaces:**
- Produces:
```ts
export interface UiConfig { serverUrl: string; workspaceRoot: string; configured: boolean }
// RendererRequest:
| { kind: "config_get" }
| { kind: "config_set"; serverUrl: string; workspaceRoot?: string }
// AdtBridge / BridgeDeps:
configGet(): UiConfig | Promise<UiConfig>;
configSet(serverUrl: string, workspaceRoot?: string): Promise<UiConfig>;
```
- `main/index.ts`：
  - `configPath = join(userData, "config.json")`；启动时 `effectiveConfig(readConfig(configPath), process.env, process.cwd())`。
  - 把 `createSession({...})` 抽成 `newSession(config)`；`let session = newSession(current)`；bridge 的依赖一律用 `() => session.xxx()`（读当前实例）。
  - `configGet: () => currentConfig`（转成 `UiConfig`）。
  - `configSet: async (serverUrl, workspaceRoot) => { writeConfig(configPath, { serverUrl, workspaceRoot }); await session.close(); currentConfig = effectiveConfig({serverUrl, workspaceRoot}, process.env, process.cwd()); session = newSession(currentConfig); broadcast({type:"state", snapshot: session.snapshot()}); return currentConfig; }`——**先关旧、再建新**。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/main/core/bridge.test.ts
it("routes config_get and config_set", async () => {
  const seen: string[] = [];
  const bridge = createBridge(
    deps({
      configGet: () => ({ serverUrl: "ws://a/ws", workspaceRoot: "/w", configured: true }),
      configSet: async (serverUrl) => {
        seen.push(serverUrl);
        return { serverUrl, workspaceRoot: "/w", configured: true };
      },
    }),
  );
  expect(await bridge.handle({ kind: "config_get" })).toMatchObject({ configured: true });
  expect(await bridge.handle({ kind: "config_set", serverUrl: "ws://b/ws" })).toMatchObject({ serverUrl: "ws://b/ws" });
  expect(seen).toEqual(["ws://b/ws"]);
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/bridge.test.ts`
- [ ] **Step 3: 实现**（契约 + bridge 两个 case + preload 两个方法 + `main/index.ts` 的 `newSession`/重建；`deps()` 默认加 `configGet`/`configSet`）
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `feat(electron): expose the config over IPC and rebuild the session on change`

---

### Task 3: `Settings` 组件 + 首启门 + 设置入口

**Files:**
- Create: `packages/client-electron/src/renderer/src/components/Settings.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Test: `packages/client-electron/src/renderer/src/components/Settings.test.tsx`（Create）、`packages/client-electron/src/renderer/src/app.test.tsx`（Modify）

**Interfaces:**
- Produces:
```ts
export interface SettingsProps {
  initial: { serverUrl: string; workspaceRoot: string };
  onSave(serverUrl: string, workspaceRoot: string): void;
  /** 首启（未配置）时不给取消；已配置时给。 */
  onCancel?: () => void;
}
// 根节点 data-testid="settings"。
```
- `app.tsx`：
  - 新状态：`config: UiConfig | null`、`settingsOpen: boolean`。
  - 挂载时 `client.configGet().then(setConfig)`。
  - 门（在现有 `if (!loaded)` 之后、`if (!signedIn)` **之前**）：
    `if (config === null) return <div className="loading">加载中…</div>;`
    `if (!config.configured || settingsOpen) return <Settings initial={config} onSave={handleSaveConfig} {...(config.configured ? { onCancel: () => setSettingsOpen(false) } : {})} />;`
  - `handleSaveConfig(serverUrl, workspaceRoot)`：`client.configSet(serverUrl, workspaceRoot).then((next) => { setConfig(next); setSettingsOpen(false); }).catch((c) => setError(messageOf(c)))`。
  - 已登录界面加一个"设置"按钮（`setSettingsOpen(true)`）。

- [ ] **Step 1: 写失败测试**

```tsx
// src/renderer/src/components/Settings.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Settings } from "./Settings";

describe("settings", () => {
  it("saves the server address, and the workspace when given", async () => {
    const saved: Array<[string, string]> = [];
    render(
      <Settings
        initial={{ serverUrl: "ws://old/ws", workspaceRoot: "" }}
        onSave={(serverUrl, workspaceRoot) => saved.push([serverUrl, workspaceRoot])}
      />,
    );
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/Server 地址/));
    await user.type(screen.getByLabelText(/Server 地址/), "ws://new/ws");
    await user.type(screen.getByLabelText(/工作区/), "C:/proj");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(saved).toEqual([["ws://new/ws", "C:/proj"]]);
  });

  it("will not save an empty address", async () => {
    const saved: unknown[] = [];
    render(<Settings initial={{ serverUrl: "", workspaceRoot: "" }} onSave={(a, b) => saved.push([a, b])} />);
    expect((screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it("offers a cancel only when one is given", () => {
    const { rerender } = render(<Settings initial={{ serverUrl: "", workspaceRoot: "" }} onSave={() => undefined} />);
    expect(screen.queryByRole("button", { name: /取消|返回/ })).toBeNull();
    rerender(
      <Settings initial={{ serverUrl: "ws://x/ws", workspaceRoot: "" }} onSave={() => undefined} onCancel={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: /取消|返回/ })).toBeTruthy();
  });
});
```

```tsx
// 追加到 src/renderer/src/app.test.tsx（fakeClient 增默认 configGet → configured:true）
it("shows the settings page on first run instead of the login page", async () => {
  const client = fakeClient({
    configGet: async () => ({ serverUrl: "ws://127.0.0.1:8080/ws", workspaceRoot: "", configured: false }),
  });
  render(<App client={client} />);
  expect(await screen.findByTestId("settings")).toBeTruthy();
  expect(screen.queryByLabelText("用户名")).toBeNull();
});

it("saves from the settings page and then shows the login", async () => {
  const saved: string[] = [];
  const client = fakeClient({
    configGet: async () => ({ serverUrl: "", workspaceRoot: "", configured: false }),
    configSet: async (serverUrl) => {
      saved.push(serverUrl);
      return { serverUrl, workspaceRoot: "", configured: true };
    },
  });
  render(<App client={client} />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/Server 地址/), "ws://127.0.0.1:8080/ws");
  await user.click(screen.getByRole("button", { name: /保存/ }));
  expect(await screen.findByLabelText("用户名")).toBeTruthy();
  expect(saved).toEqual(["ws://127.0.0.1:8080/ws"]);
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/renderer`
- [ ] **Step 3: 实现**（`Settings.tsx`；`app.tsx` 的门/状态/入口；**`app.test.tsx` 的 `fakeClient` 默认加 `configGet`（configured:true）**，否则既有用例会被门挡住）
- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/client-electron build`
- [ ] **Step 5: 提交** — `feat(electron): a first-run settings page for the server address`

---

### Task 4: 桌面冒烟扩展

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Consumes：`data-testid="settings"`（Task 3）；现有 `launchApp()`（可传 env）。

- [ ] **Step 1: 加一个"首启"用例**（**不设** `ADT_SERVER_URL`、用全新 userData）：

```ts
test("a fresh install asks for the server address first", async () => {
  const userData = mkdtempSync(join(tmpdir(), "adt-e2e-"));
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: packageDir });
  const page = await app.firstWindow();
  try {
    const settings = page.getByTestId("settings");
    await expect(settings).toBeVisible({ timeout: 20_000 });
    await page.getByLabel(/Server 地址/).fill(serverUrl);
    await page.getByRole("button", { name: /保存/ }).click();
    await expect(page.getByLabel("用户名")).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: 跑桌面冒烟** — `pnpm -C packages/client-electron test:e2e`
  Expected: 既有 2 例 + 新例全过（既有例设了 `ADT_SERVER_URL`，因此仍是"已配置 → 登录"）。
- [ ] **Step 3: 提交** — `test(electron): the smoke covers a fresh install's first run`

---

## Self-Review

**1. Spec coverage：** §5（首次运行设置页：Server 地址 + 可选工作区、持久化 `userData/config.json`、`config_get`/`config_set`、优先于 env、可再改）→ T1–T3；§8（客户端配置的测试策略）→ 各任务。**刻意不做**见 Global Constraints（无缝改地址、多配置档、证书、打包）。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给签名与优先级规则；T4 给一条真 Electron 用例。

**3. Type consistency：** `AppConfig`（T1）与 `UiConfig`（T2）字段同名（`serverUrl`/`workspaceRoot`/`configured`）；`configGet`/`configSet`（T2）在 T3 的 `app` 与 `fakeClient` 中同名消费；`data-testid="settings"`（T3）在 T4 复用。

**4. Review Focus：** 五条都落到测试——首启门（T3 第 1 例 + T4）、优先级（T1 第 1/2/3 例）、保存即生效（T2 bridge 例 + T3 第 2 例）、改地址重建（T2 实现：先关旧再建新；T3 保存后回到登录）、工作区可选（T3 第 1 例只填地址也应可保存——实现里 `workspaceRoot` 为空即不再必填）。

**5. Proportion：** 计划只钉接口、优先级与断言；组件长相与文案留给实现。
