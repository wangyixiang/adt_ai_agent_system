# 客户端分发：NSIS 安装包（P-client-packaging）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出一个能发给工程师安装的 **Windows NSIS 安装包**（图标、开始菜单、可卸载、规范版本号），并保留现有 portable exe。

**Architecture:** 只是**构建配置**与**版本/图标资产**：`electron-builder.yml` 增 `nsis` 目标与图标，`package.json` 给真实版本号与 `dist` 脚本；首次运行设置页（§5，已在 `master`）让装完的用户自己填 Server 地址，所以安装包本身**不内嵌地址**。**不签名、不自动更新**（spec §6）。

**Tech Stack:** electron-builder（NSIS / portable）· electron-vite · Node 24（生成占位图标）· Vitest · Playwright（既有冒烟）

**Spec:** `docs/superpowers/specs/2026-10-01-deployment-and-provisioning-design.md`（**§6 是本计划**；§7 的"客户端安装"半边也在这里落）。

## Global Constraints

- **不签名、不自动更新**（无证书、无更新源；spec §6/§9）。
- **不内嵌 Server 地址**：地址由用户首次运行设置页填（§5 已实现）。
- **保留 portable**：现有 `pack` 出口不退化。
- **`rcedit` 不许静默降级**：若本机写 exe 失败，**要么构建失败（可见）、要么在 `electron-builder.yml` 里显式关掉并写明原因**——不留哑雷。
- 编辑文件用 `edit` 工具（仓库 **LF**）；**不 push**。
- 验证口径：`pnpm -r --if-present test`（串行）+ `typecheck` + `client-electron build` + **桌面冒烟**（既有 3 例必须仍过）；本计划的**出口** = `dist` 产出安装包（Task 3）。
- 本计划**刻意不做**：代码签名、自动更新、多平台（mac/linux）、安装目录选择以外的 NSIS 定制（自定义许可页/脚本）、把 Handler 注册成协议。

## Review Focus

以下失败模式是本 spec 隐含、但默认测试不会覆盖的；**每条都必须在对应任务里有验证**：

1. **产物真的产出**：`dist` 产出 `ADT-0.1.0-setup.exe`（NSIS），且 `pack` 仍产出 portable。见 Task 3。
2. **版本一致**：`package.json` 的 `version` 与产物文件名一致（`0.1.0`）。见 Task 1 / Task 3。
3. **图标是真的、且尺寸合规**：`build/icon.png` 是合法 PNG 且 **256×256**（electron-builder 的底线）。见 Task 1。
4. **既有冒烟不受影响**：`test:e2e` 仍 3/3（它走 `electron .` + `out/`，不依赖安装包）。见 Task 3。
5. **文档与产物对齐**：`docs/DEPLOY.md` 的安装段写的是**真实**文件名/命令（无杜撰）。见 Task 3。

---

### Task 1: 版本号 + 占位图标（256×256）

**Files:**
- Modify: `packages/client-electron/package.json`（`version` → `0.1.0`，新增 `icon` 生成脚本）
- Create: `packages/client-electron/scripts/make-placeholder-icon.mjs`
- Create: `packages/client-electron/build/icon.png`（由脚本生成并提交）
- Test: `packages/client-electron/test/icon.test.ts`

**Interfaces:**
- Produces：`node scripts/make-placeholder-icon.mjs` 写出 `build/icon.png`（256×256、RGBA）。脚本保留，正式图标由提供方替换后重跑或直接覆盖。
- `package.json`：`"version": "0.1.0"`；`"icon": "node scripts/make-placeholder-icon.mjs"`。

- [ ] **Step 1: 写失败测试**（断言图标存在且是 256×256）

```ts
// test/icon.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

describe("the packaging icon", () => {
  it("exists and is a 256x256 PNG (electron-builder's floor)", () => {
    const path = fileURLToPath(new URL("../build/icon.png", import.meta.url));
    const png = readFileSync(path);
    // PNG signature
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR is the first chunk: 4-byte length, "IHDR", width(4), height(4), …
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBe(256);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run test/icon.test.ts`
- [ ] **Step 3: 写生成脚本并生成图标**

```js
// scripts/make-placeholder-icon.mjs — a deterministic 256×256 solid PNG (no deps).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const kind = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 4);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const p = row + 1 + x * 4;
    raw[p] = 0x1f; raw[p + 1] = 0x6f; raw[p + 2] = 0xd4; raw[p + 3] = 0xff;
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(`wrote ${target} (${SIZE}x${SIZE})`);
```

  Run: `pnpm -C packages/client-electron icon`
  Expected: `wrote …/build/icon.png (256x256)`
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `build(electron): a real version and a placeholder app icon`

---

### Task 2: NSIS 目标 + `dist` 脚本

**Files:**
- Modify: `packages/client-electron/electron-builder.yml`
- Modify: `packages/client-electron/package.json`（`"dist"` 脚本）

**Interfaces:**
- Produces：`pnpm -C packages/client-electron run dist` → `release/ADT-0.1.0-setup.exe`（NSIS，per-user）。
- `electron-builder.yml`：
```yaml
win:
  target:
    - nsis
    - portable
  icon: build/icon.png
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  artifactName: ADT-${version}-setup.${ext}
```
- **`rcedit` 处理**：先按上面的默认（`signAndEditExecutable` 未设 = 允许写 exe 元数据/图标）。**若本机 `rcedit` 失败**（会报 `Unable to commit changes` 之类）→ 把 `win.signAndEditExecutable: false` 加回，并在该行注释写明"本机 rcedit 无法提交：安装包仍产出，但 exe 不带自定义图标/元数据"。**不允许**在构建失败时假装成功。
- `package.json`：`"dist": "electron-vite build && electron-builder --win nsis"`。

- [ ] **Step 1: 改 `electron-builder.yml`**（按 Interfaces；保留 `files`/`asar`/`directories`；`portable` 仍在 `win.target` 里）
- [ ] **Step 2: 加 `dist` 脚本**
- [ ] **Step 3: 提交** — `build(electron): an NSIS installer target`

---

### Task 3: 产出安装包 + 文档

**Files:**
- Modify: `docs/DEPLOY.md`（"客户端"一节补安装步骤）
- Modify: `README.md`（`client-electron` 那节补 `dist` 一行，若未提）

**Interfaces:**
- Consumes：Task 2 的 `dist` 脚本、Task 1 的版本/图标。

- [ ] **Step 1: 产出安装包（本计划的出口）**

```bash
pnpm -C packages/client-electron run dist
ls -la packages/client-electron/release/*.exe
```
  Expected: 看到 **`ADT-0.1.0-setup.exe`**（NSIS 安装包）与 portable 产物；安装包大小量级 **≥ 50 MB**（Electron 运行时在里面）。
  **若 `rcedit` 报错**：按 Task 2 的说明**显式**关掉 `signAndEditExecutable` 并在注释里写明，然后重跑——**在计划下方记下这次降级**。

- [ ] **Step 2: 跑既有冒烟，确认没被破坏**

Run: `pnpm -C packages/client-electron test:e2e`
Expected: 3/3（它走 `electron .`，与安装包无关）。

- [ ] **Step 3: 补 `docs/DEPLOY.md` 的"客户端"一节**（把占位的"随客户端分发……"替换成真实步骤）

```markdown
### 安装客户端（Windows）

1. 拿到 `ADT-<版本>-setup.exe`，双击安装（**per-user**，无需管理员）；装完从开始菜单启动 **ADT**。
2. **首次运行会弹设置页**：填 Server 地址（形如 `ws://<server-host>:8080/ws`），工作区可留空；保存后进入登录。
3. 用管理员通过 `adm` 建的账号登录。
4. 之后想改地址：登录界面/应用里的"设置"。
- 安装包**未做代码签名**：Windows 可能弹 SmartScreen 警告——点"更多信息"→"仍要运行"。
- **不含自动更新**：升级请重新安装新版本。
- 卸载：Windows"应用和功能"里的 **ADT**。
```

- [ ] **Step 4: 自检** — 文档里的文件名（`ADT-<版本>-setup.exe`）与 Task 3 Step 1 实际产出一致；README 若有 `dist` 行则与实际脚本名一致。
- [ ] **Step 5: 提交** — `docs: how to install the desktop client`

---

## Self-Review

**1. Spec coverage：** §6（NSIS 目标、图标、版本号、保留 portable、不签名/不自动更新、`rcedit` 风险要解）→ T1/T2/T3；§7 的"客户端安装"半边 → T3。**刻意不做**见 Global Constraints。

**2. Step scan：** 每步一个动作；T1 的"生成图标"给**完整脚本**（是 spec 固定的一份拷贝），T3 给命令 + 期望产出；无占位步。

**3. Type consistency：** 版本号 `0.1.0` 在 `package.json`（T1）与产物名 `ADT-${version}-setup.${ext}`（T2）与文档（T3）三处一致；`build/icon.png` 路径在 T1 生成、T2 引用。

**4. Review Focus：** 五条都落到验证——产物（T3 Step 1）、版本一致（T1/T3）、图标 256×256（T1 测试）、冒烟不破（T3 Step 2）、文档对齐（T3 Step 4）。

**5. Proportion：** 计划只给配置、命令与断言；唯一的大代码块是图标生成脚本（无依赖、必须逐字一致）。
