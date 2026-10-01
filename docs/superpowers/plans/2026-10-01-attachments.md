# 附件与 blob、手工动作 details（S5 + S4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工程师能给一次请求**附文件**（≤ 64 KiB 内联，> 64 KiB 走 blob）与**粘贴文本**，能在**工作台/往期**里**预览/另存**附件与证据 blob，并让**手工动作卡**带上可选的 `details`（说明 + 附件）。

**Architecture:** main 侧决定"内联还是 blob"（`submit` 带 `IncomingAttachment[]`，main 算 `size`/`sha256`、必要时 `uploadBlob`），并新增 `blob_preview` / `blob_save` 两条经 main 的下载命令（`downloadBlob` 已含 sha256 校验）。`client-daemon` 的 `StepStatusUpdate` **增带证据 blob 引用**（仅当证据 `result` 是 `BlobRef`），投影存到 `UiStep.evidenceBlob`。renderer 侧：`Composer` 收附件（选择器/拖拽/粘贴文本）、工作台与往期把附件/证据 blob 渲染成可预览条目。

**Tech Stack:** Electron + electron-vite · React + TS（strict）· Vitest（node + jsdom/RTL）· Playwright Electron · pnpm workspace

**Spec:** `docs/superpowers/specs/2026-10-01-workbench-and-loop-closeout-design.md`（§3 两处修订、§8 S4、§9 S5、§10 IPC、§12 测试、§14 规格影响、§15 拆分）。**本计划是 P-attachments**；S0/S1/S2/S3 已在 `master`。

## Global Constraints

- **`PROTOCOL_SPEC` 的消息面不改**（§7.5 blob 通道与 §7.1 `attachments` 已存在）；本切片只写**客户端的附件形状**。
- **阈值 64 KiB**：`size ≤ 64 KiB` → 内联；`> 64 KiB` → blob（`PROTOCOL_SPEC` §7.5 的建议默认值，本切片**强制**）。
- **限额**：单会话单轮**数量 ≤ 10**、**总量 ≤ 32 MiB**，超限**拒绝并提示**（不静默截断）。
- **类型白名单**（本地预检对齐服务端 `DEFAULT_ALLOWED_MEDIA_TYPES`）；未知类型 → `application/octet-stream`。
- **凭据/token/字节只在 main**：renderer 只拿文本、`data:` URL 或保存结果；**不碰 Node**、`contextIsolation`/`nodeIntegration` 不变。
- **不引入新依赖、不引入 CSS 框架**（renderer 保持 DOM + `className`）。
- 编辑文件用 `edit` 工具（仓库 **LF**）；**不 push**。
- 验证口径：`pnpm -r --if-present test`（**串行**）+ `pnpm -r --if-present typecheck` + `pnpm -C packages/client-electron build` + 桌面冒烟。
- 本计划**刻意不做**：blob 的**分片/断点续传**、blob 的**生命周期管理 UI**、massive-file 优化、`AttachmentsPanel` 独立视图。

## Review Focus

以下失败模式是本 spec 隐含、但默认测试不会覆盖的；**每条都必须在对应任务里有测试**：

1. **阈值纪律**：`≤ 64 KiB` 必须**内联**（不发 `blob.allocate_request`）；`> 64 KiB` 必须**走 blob**（发上传、拿 `content_ref`）、**不内联**。见 Task 3。
2. **限额真的拒绝**：第 11 个附件、或总量超 32 MiB → 明确拒绝，不发出 `workflow.request`、不静默丢附件。见 Task 3 / Task 5。
3. **blob 下载校验**：`downloadBlob` 的 sha256 不符 → 报错，UI **不显示**下载到的字节。见 Task 4。
4. **证据 blob 只在真有引用时带**：`StepStatusUpdate.evidenceRef` 仅当证据 `result` 是 `BlobRef`（有 `content_ref`）；内联证据**不带**。见 Task 2。
5. **`details` 仍是可选的**：手工动作卡不填 `details` 也能提交（沿用既有必填观察）；填了则原样透传到 `user_input`。见 Task 6。

---

### Task 1: 规格落地（附件形状写死 + MVP 范围修订）

**Files:**
- Modify: `docs/specs/RECORD_SPEC.md`（升 v0.10：§4 增"附件的形状"一节）
- Modify: `docs/architecture/CLIENT_SPEC.md`（升 v0.10：补"工作台/附件与 blob/下载预览"）
- Modify: `docs/superpowers/specs/2026-09-29-mvp-scope.md`（§6 删去"blob 通道不在 MVP"，§2 阈值改 64 KiB）
- Modify: `docs/REQUIREMENTS.md`（§7 行同步 `RECORD_SPEC`/`CLIENT_SPEC` 版本）

**Interfaces:**
- 记下这一形状（后续任务据此实现）：`UiAttachment = { name; media_type; size; sha256 } & ({ mode:"inline"; data_base64 } | { mode:"blob"; content_ref })`；它**原样**进 `workflow.request.user_request.attachments`，Record 里保留（`RECORD_SPEC` §3 承诺保留 `content_ref`）。
- 说明：**没有可执行断言**（文档任务），完成标准 = 两处版本号与 `REQUIREMENTS §7` 一致，且 `grep` 不到"blob 不在 MVP"的旧话。

- [ ] **Step 1: 改 `RECORD_SPEC.md`**：页首 Version → v0.10，说明"§4 新增附件的形状"；在 §4 增一节，贴上面的 `UiAttachment`（含 `sha256` 的作用 + 内联/走 blob 的判别）。
- [ ] **Step 2: 改 `CLIENT_SPEC.md`**：页首 Version → v0.10；在 §1/§3 补"提交附件（内联/blob）、工作台/往期预览与另存 blob 证据"。
- [ ] **Step 3: 改 `mvp-scope.md`**：§2 把"小体积内联"改为"≤ 64 KiB 内联、> 64 KiB 走 blob"；§6 删去"大体积附件走 blob 通道的完整实现"这一排除项（blob 进 MVP）。
- [ ] **Step 4: 改 `REQUIREMENTS.md` §7**：`RECORD_SPEC` 行 → v0.10、`CLIENT_SPEC` 行 → v0.10。
- [ ] **Step 5: 自检** — `grep -rn "不在 MVP" docs/superpowers/specs/2026-09-29-mvp-scope.md` 不应再命中 blob 那条；两个版本号与 §7 行一致。
- [ ] **Step 6: 提交** — `docs: pin the attachment shape and bring blob into the MVP`

---

### Task 2: daemon 带证据 blob 引用（`StepStatusUpdate.evidenceRef`）

**Files:**
- Modify: `packages/client-daemon/src/daemon.ts`
- Modify: `packages/client-electron/src/main/core/projection.ts`、`packages/client-electron/src/shared/ui.ts`（`UiStep.evidenceBlob`）
- Test: `packages/client-daemon/test/*`（Create 或 Modify 既有 blob 测试）

**Interfaces:**
- Produces:
```ts
// client-daemon
export interface StepStatusUpdate { workflowId; stepId; state; evidenceSummary?; evidenceRef?: { content_ref: string; media_type: string; size: number; name?: string }; failReason?; }
// client-electron shared/ui.ts
export interface UiEvidenceBlob { content_ref: string; media_type: string; size: number; name?: string }
export interface UiStep { …; evidenceBlob: UiEvidenceBlob | null }
```
- 规则：`toStepStatusUpdate` 里，当 `evidence.result` 是对象且 `typeof result.content_ref === "string"` 时，带 `evidenceRef`（`media_type`/`size`/`name` 有则带）；否则**不带**。投影 `observeStepStatus` 把它存进 `UiStep.evidenceBlob`（无则 `null`）。

- [ ] **Step 1: 写失败测试**（`packages/client-daemon/test/`）

```ts
// 贴身单测 toStepStatusUpdate 的行为：直接构造一条 step.status 的 payload，
// 断言：BlobRef 结果 → 带 evidenceRef；内联结果 → 不带。
// （若该函数未导出，则用一个最小 Connection 驱动 daemon 的 onStepStatus（daemon.ts:140 附近），
//   发送两条 step.status，断言观察到的 StepStatusUpdate。）
```
断言要点：`evidenceRef.content_ref === "blob_x"`；内联那条 `evidenceRef === undefined`。

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-daemon exec vitest run`
- [ ] **Step 3: 实现**（daemon 的 `StepStatusUpdate.evidenceRef` + `toStepStatusUpdate`；`ui.ts` 的 `UiEvidenceBlob`/`UiStep.evidenceBlob`；`projection.ts` 的 `observeStepStatus` 写入；`session.ts` 的 `onStepStatus` 不动——它已把 update 交给投影）
- [ ] **Step 4: 运行确认通过** — `pnpm -C packages/client-daemon exec vitest run` + `pnpm -C packages/client-electron exec vitest run` + `typecheck`
- [ ] **Step 5: 提交** — `feat(daemon): carry an evidence blob reference on step status`

---

### Task 3: 提交附件（内联/blob 分流 + 限额）

**Files:**
- Modify: `packages/client-electron/src/shared/contract.ts`（`IncomingAttachment`、`UiAttachment`、`submit` 变体）
- Create: `packages/client-electron/src/main/core/attachments.ts`（可单测的分流/限额纯函数）
- Modify: `packages/client-electron/src/main/core/session.ts`、`packages/client-electron/src/main/core/bridge.ts`、`packages/client-electron/src/preload/index.ts`、`packages/client-electron/src/main/index.ts`
- Test: `packages/client-electron/src/main/core/attachments.test.ts`（Create）、`packages/client-electron/src/main/core/session.int.test.ts`（Modify）

**Interfaces:**
- Produces:
```ts
// shared/contract.ts（renderer 安全镜像）
export interface IncomingAttachment { name: string; mediaType: string; dataBase64: string }
export type UiAttachment = { name: string; media_type: string; size: number; sha256: string } & (
  | { mode: "inline"; data_base64: string }
  | { mode: "blob"; content_ref: string }
);
// main/core/attachments.ts（纯函数）
export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const INLINE_THRESHOLD_BYTES = 64 * 1024;
export const ALLOWED_MEDIA_TYPES: ReadonlySet<string>; // 对齐服务端 DEFAULT_ALLOWED_MEDIA_TYPES
export function normalizeMediaType(raw: string): string; // 白名单外 → "application/octet-stream"
export function checkAttachments(incoming: IncomingAttachment[]): { ok: true } | { ok: false; code: "too_many" | "too_large"; message: string };
export function planAttachment(bytes: Uint8Array, name: string, mediaType: string): { mode: "inline" } | { mode: "blob" };
```
- `Session.submit(text: string, attachments: IncomingAttachment[]): Promise<string>`：先 `checkAttachments`（不 ok 就抛 `too_many`/`too_large`）；对每个入站附件：`bytes = Buffer.from(dataBase64,"base64")`；`sha256`；`planAttachment` → inline 或 `uploadBlob({connection: daemon.connection}, {name, mediaType, bytes})`；组装 `UiAttachment[]` 放进 `workflow.request.user_request.attachments`。
- `RendererRequest` 的 `submit` 变体 → `{ kind:"submit"; text:string; attachments: IncomingAttachment[] }`；`AdtBridge.submit(text, attachments)`。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/core/attachments.test.ts
expect(normalizeMediaType("application/x-evil")).toBe("application/octet-stream");
expect(normalizeMediaType("text/plain")).toBe("text/plain");
expect(planAttachment(new Uint8Array(64 * 1024), "a.log", "text/plain").mode).toBe("inline");
expect(planAttachment(new Uint8Array(64 * 1024 + 1), "a.log", "text/plain").mode).toBe("blob");
const many = Array.from({ length: 11 }, (_, i) => ({ name: `${i}`, mediaType: "text/plain", dataBase64: "" }));
expect(checkAttachments(many)).toMatchObject({ ok: false, code: "too_many" });
```

```ts
// 追加到 src/main/core/session.int.test.ts
it("carries a small attachment inline and offloads a large one to blob", async () => {
  const f = await fixture([readStep, done]);
  try {
    const small = { name: "note.txt", mediaType: "text/plain", dataBase64: Buffer.from("hi").toString("base64") };
    const big = { name: "trace.log", mediaType: "text/plain", dataBase64: Buffer.alloc(70 * 1024, 65).toString("base64") };
    const workflowId = await f.session.submit("看附件", [small, big]);
    // 断言：workflow.request 的 user_request.attachments 里
    //   小的是 { mode:"inline", size:2 }、大的是 { mode:"blob", content_ref:/^blob_/ }。
    // （通过真 Server 的 Record 取回：完成后 record.get_response.user_request.attachments）
  } finally { await f.close(); }
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/attachments.test.ts src/main/core/session.int.test.ts`
- [ ] **Step 3: 实现**（`attachments.ts`；`session.submit` 组装；`bridge`/`preload`/`main` 接线；`app.test.tsx` 的 `submit` fake 兼容新签名——见裁决）
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `feat(electron): attach files to a request, inline or over blob`

---

### Task 4: blob 预览 / 另存（经 main 的下载）

**Files:**
- Create: `packages/client-electron/src/main/core/blobs.ts`（可单测的类型分流：文本/图片/其它）
- Modify: `packages/client-electron/src/shared/contract.ts`、`session.ts`、`bridge.ts`、`preload/index.ts`、`main/index.ts`
- Test: `packages/client-electron/src/main/core/blobs.test.ts`（Create）、`bridge.test.ts`（Modify）

**Interfaces:**
- Produces:
```ts
export type UiBlobPreview =
  | { kind: "text"; mediaType: string; text: string }
  | { kind: "image"; mediaType: string; dataUrl: string }
  | { kind: "binary"; mediaType: string; size: number };
export function classifyBlob(bytes: Uint8Array, mediaType: string): UiBlobPreview; // text/* & application/json & text/csv/markdown → text（上限内）；image/* → dataUrl；其它 → binary
// Session.blobPreview(contentRef): Promise<UiBlobPreview>   —— downloadBlob → classifyBlob
// Session.blobSave(contentRef, suggestedName): Promise<UiSaveResult> —— downloadBlob 后由 main 的对话框落盘
```
- `RendererRequest` 增 `{ kind:"blob_preview"; contentRef:string }` 与 `{ kind:"blob_save"; contentRef:string; suggestedName?:string }`；`AdtBridge.blobPreview` / `AdtBridge.blobSave`。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/core/blobs.test.ts
expect(classifyBlob(new TextEncoder().encode("hello"), "text/plain")).toEqual({ kind: "text", mediaType: "text/plain", text: "hello" });
expect(classifyBlob(new Uint8Array([137, 80, 78, 71]), "image/png").kind).toBe("image");
expect(classifyBlob(new Uint8Array([1, 2, 3]), "application/zip").kind).toBe("binary");
```
```ts
// bridge.test.ts
it("routes a blob_preview to the session", async () => {
  const bridge = createBridge(deps({ blobPreview: async () => ({ kind: "text", mediaType: "text/plain", text: "x" }) }));
  expect(await bridge.handle({ kind: "blob_preview", contentRef: "blob_1" })).toEqual({ kind: "text", mediaType: "text/plain", text: "x" });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/main/core/blobs.test.ts src/main/core/bridge.test.ts`
- [ ] **Step 3: 实现**（`blobs.ts`；`session.blobPreview/blobSave` 用 `downloadBlob`；`main/index.ts` 的 `blobStats`/对话框落盘；接线）
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `feat(electron): preview or save a blob through main`

---

### Task 5: renderer —— 附件选择与工作台/往期的 blob 呈现

**Files:**
- Create: `packages/client-electron/src/renderer/src/attachments.ts`（把入站 UI 附件/`UiAttachment` 归一成展示模型的纯函数）
- Modify: `packages/client-electron/src/renderer/src/components/Composer.tsx`、`Workbench.tsx`、`app.tsx`
- Test: `packages/client-electron/src/renderer/src/attachments.test.ts`（Create）、`Composer.test.tsx`（Create）、`Workbench.test.tsx`（Modify）、`app.test.tsx`（Modify）

**Interfaces:**
- Produces:
```ts
// renderer/attachments.ts
export interface PendingAttachment { name: string; mediaType: string; size: number; dataBase64: string }
export function fileToIncoming(file: File): Promise<IncomingAttachment>; // renderer 用 web File API 读字节（无 Node）
export function textToIncoming(text: string, name?: string): IncomingAttachment; // 粘贴文本 → text/plain
```
- `Composer`：文件选择（`<input type="file" multiple>`）+ 拖拽 + "粘贴文本"；显示已选列表（名字/大小）+ 移除；`onSubmit(text, attachments)`。
- `Workbench`：在校选中会话的**附件**与**证据 blob**（`UiStep.evidenceBlob`）渲染为可点条目 → `onPreviewBlob(contentRef)` / `onSaveBlob(contentRef, name)`。
- `app.tsx`：`blob_preview` 结果放进一个与 `report` 类似的覆盖层（文本/图片内联；binary 提示另存）；`blob_save` 调 `client.blobSave`。

- [ ] **Step 1: 写失败测试**

```tsx
// Composer.test.tsx：选一个文件 → onSubmit 收到该附件；点移除 → 不再包含
// app.test.tsx：submit 带附件 → client.submit 收到 attachments（含 inline 小文件）
// Workbench.test.tsx：items 里有一个 evidenceBlob 的 step → 出现"预览"按钮，点击调用 onPreviewBlob(contentRef)
// attachments.test.ts: textToIncoming("hi") → { mediaType:"text/plain", dataBase64: base64("hi") }
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/client-electron exec vitest run src/renderer`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/client-electron build`
- [ ] **Step 5: 提交** — `feat(electron): pick attachments and preview blobs in the workbench`

---

### Task 6: 手工动作 `details`（可选说明 + 附件）

**Files:**
- Modify: `packages/client-electron/src/renderer/src/components/AskCard.tsx`、`app.tsx`
- Modify: `packages/shared/src/decisions.ts`（如需在 `validateAnswer` 里接受 `details`）
- Test: `packages/shared/test/decisions.test.ts`（Modify）、`packages/client-electron/src/renderer/src/app.test.tsx`（Modify）

**Interfaces:**
- `Answer`（`manual_action`）的 `details?: { note?: string; attachments?: UiAttachment[] }`；`host.ts` 已透传 `answer.details`（不需改）。
- `AskCard`：手工动作表单加**可选**「补充说明」文本框 + 附件（复用 Task 5 的选择机制）；不填也可提交（观察仍必填）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/test/decisions.test.ts
expect(validateAnswer("manual_action", { kind:"manual_action", outcome:"succeeded", observation:"好了", details:{ note:"换了线" } }).ok).toBe(true);
```
```tsx
// app.test.tsx：手工卡填说明 + 附件 → answer 收到 details（note 原样、attachments 非空）
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/shared exec vitest run test/decisions.test.ts` + `pnpm -C packages/client-electron exec vitest run src/renderer`
- [ ] **Step 3: 实现**（`validateAnswer` 放行 `details`；`AskCard` 收集；`app` 用 Task 5 的附件机制把 `UiAttachment` 放进 `details.attachments`）
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `feat(electron): optional details on a manual-action card`

---

### Task 7: 桌面冒烟扩展

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`

- [ ] **Step 1: 加一条断言**：提交时附上一个小文件，断言它在工作台里出现（`data-testid="workbench"` 下的附件条目）。
- [ ] **Step 2: 跑桌面冒烟** — `pnpm -C packages/client-electron test:e2e`；Expected: 全过。
- [ ] **Step 3: 提交** — `test(electron): the smoke submits an attachment`

---

## Self-Review

**1. Spec coverage：** §3 修订（阈值/blob 进 MVP）→ T1；§8（手工 `details`）→ T6；§9（附件、内联/blob、预览/另存、往期渲染、live 证据 blob 前提）→ T2/T3/T4/T5；§10（IPC）→ T3/T4；§12（测试）→ 各任务；§14（规格影响）→ T1。**刻意不做**见 Global Constraints。

**2. Step scan：** 每步一个动作；T1 是文档任务（无可执行断言，完成标准给定）；其余每步有断言或命令。

**3. Type consistency：** `UiAttachment`/`IncomingAttachment`（T3）在 T5/T6 复用；`UiBlobPreview`/`classifyBlob`（T4）在 T5 复用；`UiStep.evidenceBlob`（T2）在 T5 渲染；`fileToIncoming`/`textToIncoming`（T5）在 T6 复用。

**4. Review Focus：** 五条都落到测试——阈值纪律（T3 单测 + 集成）、限额拒绝（T3 单测 + T5 组件）、blob 校验（T4 复用 `downloadBlob` 的 sha256；T4 单测覆盖类型分流）、证据引用只在 BlobRef 时带（T2）、`details` 可选（T6）。

**5. Proportion：** 计划只钉接口、阈值与断言；上传/下载的变量名与 UI 细节留给实现。
