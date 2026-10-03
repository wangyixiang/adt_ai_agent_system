# UI-2b 完成候选与终态的单一归属 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落定 spec §6.3 的最后两行——**完成候选**与**终态**的单一归属：完成候选的 `summary` 只在中栏决策卡（live 与往期都显），右栏只放 `evidenceRefs`（点回步骤）与决定状态；终态与 `recordId` 只归右栏，中栏只留一行"已收敛 · 见右栏结论"。

**Architecture:** 全在 renderer。`Summary` 收敛为一行；`AskCard` 的完成形态无论是否作答都显示 `summary`；`WorkbenchCompletion` 从 `{summary, evidenceRefs}` 改为 `{evidenceRefs, decision}`；`recordTranscript` 从 Record 的 `completion_candidate`/`completion_response` 重建完成候选（含 summary 与 refs），使往期与 live 同形。不改协议/record。

**Tech Stack:** React 18 + TS（strict）· Vitest（jsdom + Testing Library）· Playwright Electron（桌面冒烟）

**Spec:** `docs/superpowers/specs/2026-10-03-client-ui-design.md`（本计划实现 §6.3 的**完成候选**与**终态**两行；§2.8 live 与往期同形）。计划是 spec 的论证，冲突以 spec 为准。

## Global Constraints

- **一个数据一个家**：`summary` 只在中栏决策卡；`terminal_state`/`terminalReason`/`recordId` 只在右栏；右栏完成候选只放 refs + 决定状态。
- **不引入新依赖 / CSS 框架 / CSS-in-JS**；沿用 `theme.css` 变量与纯 `className`。
- **不动协议**；`shared/` 本切片不改。Record 已带 `completion_candidate.ref.{summary,evidence_refs}` 与 `completion_response.ref.resolution`（`packages/server/src/record/builder.ts:194-199`、`docs/specs/RECORD_SPEC.md:138-139`），重建只用既有数据。
- **live 与往期同形**（spec §2.8）：完成候选与终态在两种来源下渲染一致。
- renderer 不 import `@adt/server`；编辑文件用 `edit`（**LF**）；**不 push**。
- 验证：`pnpm -r --if-present test`（串行）+ `typecheck` + `pnpm -C packages/client-electron build` + **桌面冒烟**（本切片出口）。
- **刻意不做**：`requiresConfirmation` 进 Record（spec/record 级，单列）；安全硬化（UI-4 前置）、断线恢复（UI-4）、组件样式遍与无障碍（UI-5）。

## Review Focus

以下失败模式 spec 隐含、默认测试不覆盖；**每条都要在对应任务里钉住**：

1. **终态不再在中栏重复 `recordId`**：中栏只剩一行，`recordId` 只在右栏。见 Task 1。
2. **完成候选的 `summary` 不两处显示**：右栏不得再渲染 `summary`（live 与往期都不得）。见 Task 2/3。
3. **决定状态不丢**：已答的完成候选在右栏显示"已解决/没解决"，未答显示"待你决定"。见 Task 2。
4. **往期同形**：从 Record 打开一条已完成的运行，右栏能看到完成候选的 refs 与决定（不能只有 live 有）。见 Task 3。
5. **既有断言随迁**：`app.test` 与 `smoke` 里 `main` 中的 `Record: rec_*` 改为 `workbench` 中的断言。见 Task 1/4。

---

### Task 1: 中栏终态收敛为一行

**Files:**
- Modify: `packages/client-electron/src/renderer/src/components/Summary.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.test.tsx`
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Produces：`Summary` 渲染 `.summary`（`data-terminal-state`）内**一行**文本，形如 `会话已结束（<terminalState>） · 见右栏结论`；**不再**渲染 `item.recordId`。
- Consumes：`TranscriptItem{kind:"summary"}`（`terminalState`/`terminalReason`/`recordId`/`text`）。

- [ ] **Step 1: 写失败测试（加到 `app.test.tsx`）**

```tsx
it("keeps the Record id out of the thread (the workbench owns it)", async () => {
  let push!: (e: MainEvent) => void;
  const client = fakeClient({ onEvent: (l) => { push = l; return () => undefined; } });
  render(<App client={client} />);
  await screen.findByTestId("app");
  act(() => {
    pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "x" } });
    pushUi(push, { id: 2, type: "workflow.terminated", workflowId: "wf_1", terminalState: "COMPLETED", terminalReason: null, recordId: "rec_1" });
  });
  const thread = within(screen.getByRole("main"));
  expect(await thread.findByText(/已结束/)).toBeTruthy();
  expect(thread.queryByText(/Record: rec_1/)).toBeNull();
  expect(within(screen.getByTestId("workbench")).getByText(/Record: rec_1/)).toBeTruthy();
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- app.test`
Expected: FAIL——中栏仍渲染 `Record: rec_1`，且无"已结束"。

- [ ] **Step 3: 实现 `Summary.tsx`**

渲染一行：`会话已结束（{item.terminalState}）{item.terminalReason === null ? "" : ` · ${item.terminalReason}`} · 见右栏结论`；删掉 `recordId` 那段。

- [ ] **Step 4: 同步既有断言**

`app.test.tsx` 里两处 `thread.getByText(/Record: rec_*/)` 改为 workbench 断言（`within(screen.getByTestId("workbench")).getByText(/Record: rec_*/)`）。`smoke/electron.spec.ts` 里 `page.getByRole("main").getByText(/Record: rec_/)` 改为 `page.getByTestId("workbench").getByText(/Record: rec_/)`。

- [ ] **Step 5: 跑绿**

Run: `pnpm -C packages/client-electron test -- app.test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/client-electron/src/renderer/src/components/Summary.tsx \
        packages/client-electron/src/renderer/src/app.test.tsx \
        packages/client-electron/smoke/electron.spec.ts
git commit -m "refactor(client-electron): the terminal line lives in the thread, the record id in the workbench"
```

---

### Task 2: 完成候选拆分（summary 归中栏，refs+决定归右栏）

**Files:**
- Modify: `packages/client-electron/src/renderer/src/components/AskCard.tsx`
- Modify: `packages/client-electron/src/renderer/src/workbench.ts`
- Modify: `packages/client-electron/src/renderer/src/workbench.test.ts`
- Modify: `packages/client-electron/src/renderer/src/components/Workbench.tsx`
- Modify: `packages/client-electron/src/renderer/src/components/Workbench.test.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.tsx`
- Modify: `packages/client-electron/src/renderer/src/app.test.tsx`

**Interfaces:**
- Produces:
  - `AskCard`：`kind === "completion"` 时**无论是否作答**都渲染 `<p className="completion-summary">{ask.summary}</p>`。
  - `workbench.ts`：`WorkbenchCompletion` 改为 `{ evidenceRefs: string[]; decision: string | null }`（`decision`＝已答的 `item.text`，未答 `null`）；`deriveWorkbench` 从完成 ask 计算。
  - `Workbench` props += `onLocate(stepId: string): void`；完成候选段渲染 refs 为按钮（`onClick={() => onLocate(ref)}`）与决定文案（`decision ?? "待你决定"`）；**不渲染** `summary`。
  - `app.tsx`：`<Workbench ... onLocate={setFocusedStepId} />`。

- [ ] **Step 1: 写失败测试**

`workbench.test.ts`：

```ts
it("carries the completion's refs and its decision, not its summary", () => {
  const candidate: TranscriptItem = {
    key: "ask:wf_1:ask_c", kind: "ask", workflowId: "wf_1", askId: "ask_c",
    ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "看起来好了", evidenceRefs: ["st_1"] },
    askKind: "completion", answered: false, stepId: null, text: "有一个完成候选在等你判断",
  };
  const answered: TranscriptItem = { ...candidate, answered: true, text: "认为已解决" };
  expect(deriveWorkbench([tool(), candidate], false).completion).toEqual({ evidenceRefs: ["st_1"], decision: null });
  expect(deriveWorkbench([tool(), answered], false).completion).toEqual({ evidenceRefs: ["st_1"], decision: "认为已解决" });
});
```

`Workbench.test.tsx`：把「shows the completion candidate and a step's decision」里的 `expect(screen.getByText(/看起来好了/)).toBeTruthy();` 改成断言右栏**没有** `看起来好了`、且有"待你决定"：

```tsx
    expect(screen.getByText("已确认")).toBeTruthy();
    expect(screen.queryByText(/看起来好了/)).toBeNull();
    expect(screen.getByText("待你决定")).toBeTruthy();
```

并在同一文件加一条：点击 ref 触发 `onLocate`：

```tsx
  it("locates the step behind a completion ref", async () => {
    const located: string[] = [];
    const candidate: TranscriptItem = {
      key: "ask:wf_1:ask_c", kind: "ask", workflowId: "wf_1", askId: "ask_c",
      ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "s", evidenceRefs: ["st_1"] },
      askKind: "completion", answered: false, stepId: null, text: "t",
    };
    show({ items: [tool, candidate], onLocate: (id) => located.push(id) });
    await userEvent.click(screen.getByRole("button", { name: "st_1" }));
    expect(located).toEqual(["st_1"]);
  });
```

`app.test.tsx` 加一条：完成卡在中栏显示 `summary`，右栏不显示：

```tsx
  it("keeps the completion summary in the thread, not the workbench", async () => {
    let push!: (e: MainEvent) => void;
    const client = fakeClient({ onEvent: (l) => { push = l; return () => undefined; } });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, { id: 1, type: "ask", workflowId: "wf_1", ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "看起来好了", evidenceRefs: ["st_1"] } });
    });
    expect(await within(screen.getByRole("main")).findByText("看起来好了")).toBeTruthy();
    expect(within(screen.getByTestId("workbench")).queryByText("看起来好了")).toBeNull();
  });
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- workbench.test Workbench.test app.test`
Expected: FAIL——`completion` 仍是 `{summary,evidenceRefs}`、右栏仍显示 summary、`onLocate` 未接。

- [ ] **Step 3: 实现**

`AskCard.tsx`：在 answered 分支之外，为 completion 渲染 `ask.summary`（pending 与 answered 都渲染）。`workbench.ts`：改 `WorkbenchCompletion` 与 `deriveWorkbench`。`Workbench.tsx`：props 加 `onLocate`，完成段改为 refs 按钮 + 决定文案。`app.tsx`：传 `onLocate`。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- workbench.test Workbench.test app.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/components/AskCard.tsx \
        packages/client-electron/src/renderer/src/workbench.ts \
        packages/client-electron/src/renderer/src/workbench.test.ts \
        packages/client-electron/src/renderer/src/components/Workbench.tsx \
        packages/client-electron/src/renderer/src/components/Workbench.test.tsx \
        packages/client-electron/src/renderer/src/app.tsx \
        packages/client-electron/src/renderer/src/app.test.tsx
git commit -m "refactor(client-electron): the completion summary stays in the thread"
```

---

### Task 3: 往期完成候选重建（live 与往期同形）

**Files:**
- Modify: `packages/client-electron/src/renderer/src/recordTranscript.ts`
- Modify: `packages/client-electron/src/renderer/src/recordTranscript.test.ts`

**Interfaces:**
- Consumes：Record 的 `completion_candidate.ref.{summary,evidence_refs}` 与 `completion_response.ref.{resolution,feedback}`（`RECORD_SPEC.md:138-139`）。
- Produces：`transcriptFromRecord` 产出的完成 `AskItem` 带**非空** `ask`：`{ askId:"hist:completion", kind:"completion", workflowId, summary, evidenceRefs }`；`answered` 与 `text` 由 `completion_response` 决定（与 live 同形）。

- [ ] **Step 1: 写失败测试（改 `recordTranscript.test.ts`）**

把「maps a run into…」里对完成项的断言补上 summary 与 refs：

```ts
    expect(ask(items)).toMatchObject({ askKind: "completion", answered: true, text: "认为已解决" });
    expect((ask(items).ask as { summary?: string; evidenceRefs?: string[] })).toMatchObject({
      summary: "看起来好了",
      evidenceRefs: ["st_1"],
    });
```

（该用例的 entries 已含 `completion_candidate {summary:"看起来好了", evidence_refs:["st_1"]}` 与 `completion_response`。）

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- recordTranscript.test`
Expected: FAIL——完成 ask 的 `ask` 目前是 `null`。

- [ ] **Step 3: 实现**

`recordTranscript.ts`：用一个局部 `completion: { summary: string; evidenceRefs: string[] } | null` 记住 `completion_candidate` 的字段；`completion_candidate` 与 `completion_response` 两处 `upsertAsk` 都据此构造 `ask`（仍是 `"hist:ask:completion"` 同一个 key，后者覆盖前者时保留字段）。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- recordTranscript.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/recordTranscript.ts \
        packages/client-electron/src/renderer/src/recordTranscript.test.ts
git commit -m "feat(client-electron): reconstruct a past completion candidate from its record"
```

---

### Task 4: 桌面冒烟与整基验证（本切片出口）

**Files:**
- Modify: `packages/client-electron/smoke/electron.spec.ts`

**Interfaces:**
- Consumes: 右栏完成候选的 refs/决定；`Record:` 在右栏（Task 1）。
- Produces：冒烟在既有的"登录→诊断→已解决"流程后，`workbench` 里能看到完成候选的**决定**（"认为已解决"）。

- [ ] **Step 1: 加冒烟断言**

在第一个用例点完「已解决」之后追加：

```ts
await expect(page.getByTestId("workbench").getByText("认为已解决")).toBeVisible({ timeout: 20_000 });
```

- [ ] **Step 2: 构建并跑冒烟**

Run: `pnpm -C packages/client-electron build && pnpm -C packages/client-electron test:e2e`
Expected: build exit 0；冒烟 **3 passed**。

- [ ] **Step 3: 全量验证**

Run: `pnpm -r --if-present test` 与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0；`client-electron` 测试数 = UI-2a 后 154 + 本切片新增（app 2 + workbench 1 + Workbench 1 = 4）。

- [ ] **Step 4: 提交**

```bash
git add packages/client-electron/smoke/electron.spec.ts
git commit -m "test(client-electron): the smoke sees the completion decision in the workbench"
```

---

## 移交后续计划的待办

- **record 切片**：`step_dispatched` 不带 `requiresConfirmation`，故右栏该标记只对 live 生效（"live 与往期同形"缺口）——需改 `RECORD_SPEC` + server record builder + 客户端解析，单列。
- **UI-5**：组件样式遍（`.tool-row`/`.bubble*`/`.step-input`/`.needs-confirmation`/`.bubble`/`.workbench-step`）与无障碍。
- **UI-3**：登录/设置/加载页在 `.app` 之外；覆盖层正式化。
- **UI-4**：`已断开` 端到端（依赖会话/重连）。
- **单独 bounded**：server 两个时序 flake（`recordProtocol` ordering clock、`stepTimeout.int`）。

## Self-Review

**1. Spec coverage：** §6.3 的「完成候选 → 拆分」与「终态/recordId → 右栏」→ Task 1/2/3；§2.8（live 与往期同形）→ Task 3。**刻意不做**：见 Global Constraints 与移交清单。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给 props/DOM 契约。

**3. Type consistency：** `WorkbenchCompletion{evidenceRefs,decision}`（T2）在 `workbench.ts` 与 `Workbench.tsx` 一致；`Workbench.onLocate`（T2）→ `app.tsx` 传 `setFocusedStepId`（与 UI-2a 的 `Transcript.onLocate` 同一个 state）；完成 `Ask` 的 `summary`/`evidenceRefs`（T3）与 live 的 `Ask`（`@adt/shared`）同形。

**4. Review Focus：** 五条分别由 T1（中栏无 recordId）、T2（右栏无 summary、有决定）、T3（往期同形）、T1/T4（断言随迁）钉住。

**5. Proportion：** 计划只钉接口、断言与 DOM 契约；样式留给 UI-5。
