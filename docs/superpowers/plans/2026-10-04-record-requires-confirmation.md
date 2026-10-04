# record 携带 requiresConfirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Record 的 `step_dispatched` 条目带上 `requires_confirmation`，使 UI-2a 加到右栏步骤节点的"需要人工确认"标记在**往期**也能显示（收掉"live 与往期同形"的最后一个已知缺口）。

**Architecture:** `server` 的 record builder 从 `StepSnapshot.sideEffect` 写 `requires_confirmation`（事件 payload 不动）；`RECORD_SPEC` 升版；`client-electron` 的 `recordTranscript` 读回该字段。不改协议、不改事件。

**Tech Stack:** TypeScript（strict）· Vitest（server/client-electron）

**Spec:** `docs/specs/RECORD_SPEC.md`（§3 条目表，本计划升到 v0.11）、`docs/REQUIREMENTS.md` §7 版本行、`docs/superpowers/specs/2026-10-03-client-ui-design.md` §2.8（live 与往期同形）。

## Global Constraints

- **不动协议**：`step.dispatch.requires_confirmation` 已有；只是把 `StepSnapshot.sideEffect` 写进 Record。
- 编辑文件用 `edit`（**LF**）；**不 push**；规范类文档一改同步页首 `Version` 与 `REQUIREMENTS §7`。
- 验证：`pnpm -r --if-present test`（串行）+ `typecheck`。
- **刻意不做**：时序 flake（计划 C）。

## Review Focus

1. **往期同形**：从 Record 打开一条含副作用步骤的运行，右栏显示"需要人工确认"。见 Task 1/3。
2. **既有 Record 兼容**：旧 Record（无该字段）解析为 `false`，不抛错。见 Task 3。
3. **规格同步**：`RECORD_SPEC` 版本行与 `REQUIREMENTS §7` 一致。见 Task 2。

---

### Task 1: server 写入 requires_confirmation

**Files:**
- Modify: `packages/server/src/record/builder.ts`
- Test: `packages/server/test/protocol/recordProtocol.test.ts`

**Interfaces:**
- Produces：`step_dispatched` 条目 ref += `requires_confirmation: boolean`（来自 `stepsById.get(stepId)?.sideEffect ?? false`）。

- [ ] **Step 1: 写失败测试**

在 `recordProtocol.test.ts` 里，对一条**副作用步骤**的运行（planner 用 `sideEffect: true` 的 step），断言其 `step_dispatched` 条目 `ref.requires_confirmation === true`；对只读步骤断言 `false`。

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/server test -- recordProtocol`
Expected: FAIL——ref 无该字段。

- [ ] **Step 3: 实现**

`builder.ts` 的 `step_dispatched` 分支 ref 加 `requires_confirmation: step?.sideEffect ?? false`。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/server test -- recordProtocol`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/record/builder.ts packages/server/test/protocol/recordProtocol.test.ts
git commit -m "feat(server): the record carries a step's requires_confirmation"
```

---

### Task 2: 规格同步

**Files:**
- Modify: `docs/specs/RECORD_SPEC.md`
- Modify: `docs/REQUIREMENTS.md`

**Interfaces:**
- Produces：`RECORD_SPEC` 页首 `Version` → **v0.11**；§3 的 `step_dispatched` 行加 `requires_confirmation`（v0.11 新增）；`REQUIREMENTS §7` 的 `RECORD_SPEC` 行同步版本与一句话描述。

- [ ] **Step 1: 改 `RECORD_SPEC.md`**

页首 Version 行改成 v0.11（一句话：`step_dispatched` 增 `requires_confirmation`）；§3 条目表 `step_dispatched` 行补 `requires_confirmation`。

- [ ] **Step 2: 改 `REQUIREMENTS.md` §7**

`RECORD_SPEC` 行的版本与描述同步（"`step_dispatched` 带 `requires_confirmation`（v0.11）"）。

- [ ] **Step 3: 提交**

```bash
git add docs/specs/RECORD_SPEC.md docs/REQUIREMENTS.md
git commit -m "docs(record): step_dispatched carries requires_confirmation (v0.11)"
```

---

### Task 3: client 读回 requires_confirmation

**Files:**
- Modify: `packages/client-electron/src/renderer/src/recordTranscript.ts`
- Test: `packages/client-electron/src/renderer/src/recordTranscript.test.ts`
- Test: `packages/client-electron/src/renderer/src/components/Workbench.test.tsx`

**Interfaces:**
- Produces：`transcriptFromRecord` 的 `step_dispatched` 分支把 `ref.requires_confirmation` 读进 `putTool({ …, requiresConfirmation })`；缺省 `false`。

- [ ] **Step 1: 写失败测试**

`recordTranscript.test.ts`：在 `step_dispatched` 的 ref 里加 `requires_confirmation: true`，断言该 tool 的 `requiresConfirmation === true`；再断言缺字段时为 `false`。

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/client-electron test -- recordTranscript.test`
Expected: FAIL。

- [ ] **Step 3: 实现**

`recordTranscript.ts` 的 `step_dispatched` 分支：`putTool({ stepId, capability, objective, input, requiresConfirmation: ref.requires_confirmation === true })`。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/client-electron test -- recordTranscript.test Workbench.test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client-electron/src/renderer/src/recordTranscript.ts \
        packages/client-electron/src/renderer/src/recordTranscript.test.ts
git commit -m "feat(client-electron): a past step keeps its requires_confirmation"
```

---

### Task 4: 整基验证（本切片出口）

- [ ] **Step 1: 全量验证**

Run: `pnpm -r --if-present test` 与 `pnpm -r --if-present typecheck`
Expected: 两个都 exit 0。

---

## 移交后续计划的待办

- **计划 C**：时序 flake 稳化。

## Self-Review

**1. Spec coverage：** §2.8（live 与往期同形）→ Task 1/3；`RECORD_SPEC` §3 + `REQUIREMENTS §7` → Task 2。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给 ref 字段。

**3. Type consistency：** `requires_confirmation`（T1 写入）→（T3 读回）；`ToolItem.requiresConfirmation` 既有字段不变。

**4. Review Focus：** 三条分别由 T1/T3（往期同形）、T3（旧 Record 缺省 false）、T2（规格同步）钉住。

**5. Proportion：** 计划只钉字段、断言与版本行。
