# client-cli（控制台客户端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"人能坐在键盘前用起来"这件事做出来：一个**控制台客户端**，连着 Server 跑真实 Workflow——收到派发、被问确认、被问建议、被问资源冲突、读 Record/Report、取回 blob、触发导出。它同时是 P4 系列所有人工路径的**手工验收场所**（在此之前只有自动化测试碰过这些路径）。

**Architecture:** 它**不是**一个新的协议实现，而是 `@adt/client-daemon` 的一层**人类前端**。daemon 已经把这几个接缝留好了：`ClientDaemon.connect()` 接受三个宿主回调（`onConfirmationRequired` / `onUserInput` / `onResourceConflict`），并把 `connection`（`on(type, handler)` / `send(type, payload)`）暴露出来。于是本包分两层：

- **纯层**（无 TTY、可单测）：`render.ts` 把收到的协议消息渲染成人读的文本；`answers.ts` 把一行输入解析成决策/命令。所有"怎么显示、怎么理解人话"的规则都住在这里。
- **I/O 层**（薄）：`console.ts` 提供 `Prompter` 接缝（真实实现用 `node:readline`，测试注入脚本化实现），并用一条**串行队列**保证"任何时候只有一个问题在等人回答"；`main.ts` 解析参数、建 daemon、跑命令循环。

**关键约束**：daemon 的派发是**异步**的，而人的命令循环是**同步交互**的。两者共用同一个 stdin，所以提示必须串行化——否则"你在问确认"和"你在敲 `:records`"会互相吃掉对方的输入。

**Tech Stack:** TypeScript（strict）· Node.js LTS（开发环境 v24）· Vitest · pnpm workspace（沿用 P1–P4d 结构）· `ws`（经由 daemon）

**Spec:** `docs/specs/PROTOCOL_SPEC.md`（§5 会话/§7 派发与状态/§10 Record 可见性/§10.3 导出/§11 Report/§7.5 blob）、`docs/specs/WORKFLOW_SPEC.md`（§4.3 幂等与 `UNKNOWN`、§4.4 资源冲突）、`docs/specs/CAPABILITY_SPEC.md`（§6 `human.manual_action`）、`docs/specs/REPORT_SPEC.md`（§3 `detail_level`）、`docs/specs/RECORD_SPEC.md`（§10 可见性）、`docs/architecture/CLIENT_SPEC.md`（§4 收集职责、§5 人工介入角色）、`docs/adr/ADR-005-kb-integration-contract.md`

## 开工前请确认（三处）

1. **形态**：本计划把 client-cli 做成 daemon 的**控制台宿主**——它会**真的执行能力注册表**（`git` / `docker` / `filesystem` / `terminal.execute_command` / `sim_rig.*`）。这是"手工验收场所"的应有之义，但意味着**跑它就会在本机执行真实命令**（副作用能力仍会先问人）。如果你想要的是一个**只读检查器**（不执行任何能力，只读 Record/Report、取 blob、触发导出），请先说——那会换掉 Task 3/4 的接缝（用 `DaemonConnection` 直连而不是 `ClientDaemon`）。
2. **新增一个 dev 依赖 `tsx`**：仓库里没有构建步骤（各包 `main` 直接指向 `src/index.ts`），而 Node 的 ESM 不做无扩展名解析，所以"能被人跑起来"需要一个 TS 运行器。计划用 `tsx`（dev-only，仅 `client-cli` 的 `start` 脚本用）。如果你不想引入它，替代是给本包加一个 `tsc` 构建步骤（更重）或把本包的相对 import 写成 `.ts` 扩展名（与仓库其余部分不一致）。
3. **范围**：六件事（确认 / 建议 / 资源冲突 / Record·Report 阅读 / blob 取回 / 触发导出）**一次做全**，但每件都做薄。若你只要其中几件，说一声我砍。

## Global Constraints

- **确认绝不默认同意**（`WORKFLOW_SPEC.md` §4.3 / `ADR-003` §5）：解析不出来的回答**重问**；`EOF`（管道结束）时**拒绝**——安全默认永远是"不做"。daemon 的默认也是 decline，CLI 不得把它悄悄变成 yes。
- **不发明事实**：渲染层只显示消息里有的东西（`RECORD_SPEC.md` 原则：Report/Record 是唯一事实来源）。确认提示必须给出 `objective` + `capability` + `input`，让人**有依据**地决定。
- **提示串行**：任何时刻只有一个问题在等人回答；daemon 的异步回调与命令循环共用 stdin，靠一条 promise 队列排队。入站的打印不得与待答问题交错。
- **持久化默认打开**：`--ledger` / `--session` 默认落在 `.adt/client-cli/`（文件后端）。**理由**：daemon 只有在台账**持久**时才允许 `resume`（否则重连后重发一个"执行中"的副作用 Step 会重复执行物理动作）；内存台账会让 resume 被拒。CLI 是给人长期用的，默认必须是持久的。
- **只读的消息直接发**：`record.*` / `report.*` / `blob.allocate_request` 由 CLI 自己在 `daemon.connection` 上发（daemon 不代劳）。
- **工作区**：默认 `process.cwd()`，`--workspace` 覆盖；它是 `filesystem.*` 能力的边界（`resolveWithinWorkspace`）。
- **凭据不强制走 argv**：`--secret` 会被 `ps` 看见。`--secret` / `ADT_SECRET` 都没有时，`main.ts` 用**不回显**的提示读取（`readline` 的 `output` 置空或用 mute 手法），绝不把"把密码写在命令行里"变成唯一途径。
- **不 push**；合并用本地 `ff-merge`（`docs/superpowers/WORKFLOW.md`）。
- **文档纪律**：`README.md` 增"控制台客户端"一节（怎么跑、有哪些命令、**它会执行真实能力**这句必须写）；`docs/architecture/CLIENT_SPEC.md` 若有"客户端形态"清单则补一条；两者都要**同步**（`CLIENT_SPEC` 有 `Version` 行）。

## Review Focus

以下失败模式默认的测试不会覆盖，**每条都必须在对应任务里有测试**：

1. **确认不能默认同意**：解析不出的输入要**重问**而不是当成 yes；EOF 要**拒绝**；拒绝真的走 `REJECTED(user_declined)`（见 Task 2/4）。
2. **提示不得交错**：一个待答问题期间收到派发/打印，输入不能被命令循环吃掉（见 Task 3）。
3. **不发明事实**：渲染函数对缺字段的消息不得编造（例如 `export_result` 的 `message` 为 `null` 时不能凭空写"已收录"——`ok` 只表示端点已接收，`ADR-005` §4）（见 Task 1）。
4. **导出/失败如实透出**：`export_unavailable` / `export_failed` / `invalid_object` 与 `report` 的 `invalid_option` 都要原样显示，不得显示成成功（见 Task 1/4）。
5. **blob 取回要校验**：下载必须验 sha256/size（daemon 的 `downloadBlob` 已做），CLI 不得绕过它自己写文件（见 Task 4）。

---

### Task 1: 包骨架 + 纯渲染层

**Files:**
- Create: `packages/client-cli/package.json`、`packages/client-cli/tsconfig.json`
- Create: `packages/client-cli/src/render.ts`
- Test: `packages/client-cli/test/render.test.ts`

**Interfaces:**
- Produces:
  - `renderDispatch(step: StepDispatchPayload): string`（含 `objective`/`capability`/`expected_output`/`requires_confirmation`；`input` 用稳定键序 JSON）
  - `renderTerminated(payload: { workflow_id: string; terminal_state: string; terminal_reason?: string | null; record_id: string | null; record_persistence_failed?: boolean }): string`
  - `renderRecordList(payload: { records: Array<{ record_id: string; workflow_id: string; summary: { problem_short: string; terminal_state: string; result_short: string; duration_ms: number } }>; next_cursor: string | null }): string`
  - `renderRecord(record: RecordDocument): string`、`renderReport(payload: { status: string; report: { format: string; content: string } | null; error_code: string | null; message: string | null }): string`
  - `renderExport(payload: { record_id: string; object: string; status: string; error_code: string | null; message: string | null }): string`
  - `renderAllocation(payload: { content_ref: string; url: string; expires_at: string; media_type: string; size: number; sha256: string }): string`（`direction` 在**请求**里，响应没有；后三个字段是回显，见 `PROTOCOL_SPEC.md` §7.5）
  - `renderProtocolError(code: string, message: string | null): string`
- 约定：`ok` 的导出**只**说"KB 端点已接收（2xx），不表示已被收录"；`message` 为 `null` 时不补话。

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-cli/test/render.test.ts
import { describe, it, expect } from "vitest";
import { renderDispatch, renderExport, renderReport } from "../src/render";

describe("renderDispatch", () => {
  it("shows why the human is being asked, not just that they are", () => {
    const text = renderDispatch({
      workflow_id: "wf_1",
      step_id: "st_1",
      objective: "复位测试台",
      capability: "sim_rig.trigger_reset",
      input: { rig: "A" },
      expected_output: "rig_state",
      requires_confirmation: true,
      idempotency_key: "idem_1",
    });

    expect(text).toContain("复位测试台");
    expect(text).toContain("sim_rig.trigger_reset");
    expect(text).toContain("rig");
  });
});

describe("renderExport", () => {
  it("does not claim the KB filed it", () => {
    const text = renderExport({
      record_id: "rec_1",
      object: "record",
      status: "ok",
      error_code: null,
      message: null,
    });

    expect(text).toContain("已接收");
    expect(text).toContain("不表示");
  });

  it("shows a failure as a failure, with the reason", () => {
    const text = renderExport({
      record_id: "rec_1",
      object: "report",
      status: "failed",
      error_code: "export_unavailable",
      message: "no knowledge base endpoint is configured",
    });

    expect(text).toContain("export_unavailable");
    expect(text).toContain("no knowledge base endpoint is configured");
    expect(text).not.toContain("已接收");
  });
});

describe("renderReport", () => {
  it("prints the markdown body when it succeeded", () => {
    const text = renderReport({
      status: "ok",
      report: { format: "markdown", content: "# 诊断报告：x" },
      error_code: null,
      message: null,
    });

    expect(text).toContain("# 诊断报告：x");
  });

  it("prints the error code when it failed", () => {
    const text = renderReport({
      status: "failed",
      report: null,
      error_code: "invalid_option",
      message: "unknown detail_level",
    });

    expect(text).toContain("invalid_option");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-cli exec vitest run test/render.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 建包骨架并实现**

`package.json`：`{ name: "@adt/client-cli", private: true, type: "module", main: "src/index.ts", scripts: { test: "vitest run", typecheck: "tsc --noEmit", start: "tsx src/main.ts" }, dependencies: { "@adt/client-daemon": "workspace:*", "@adt/shared": "workspace:*" }, devDependencies: { "@adt/server": "workspace:*", "@adt/test-support": "workspace:*", tsx, typescript, vitest, @types/node } }`。`tsconfig.json` 仿 `packages/client-daemon/tsconfig.json`（`include: ["src", "test"]`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-cli exec vitest run test/render.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-cli/package.json packages/client-cli/tsconfig.json packages/client-cli/src/render.ts packages/client-cli/test/render.test.ts pnpm-lock.yaml
git commit -m "feat(cli): a package and a renderer that never invents facts"
```

---

### Task 2: 纯应答层（人话 → 决策）

**Files:**
- Create: `packages/client-cli/src/answers.ts`
- Test: `packages/client-cli/test/answers.test.ts`

**Interfaces:**
- Produces:
  - `parseConfirmation(line: string): boolean | null`（`y`/`yes`/`是` → true；`n`/`no`/`否` → false；其它 → `null`，调用方**重问**）
  - `parseResourceConflict(line: string): "wait" | "stop" | null`
  - `parseManualFeedback(line: string): ManualActionFeedback | null`（`succeeded`/`failed`/`partially`/`unknown` + 观察文本；空行 → `null`）
  - `parseCommand(line: string): Command | null`，其中 `type Command = { kind: "records" } | { kind: "show"; recordId: string } | { kind: "report"; recordId: string; detailLevel: "summary" | "full" } | { kind: "export"; recordId: string; object: "record" | "report" } | { kind: "blob"; contentRef: string; path: string } | { kind: "help" } | { kind: "quit" }`；`detailLevel` 缺省 `full`（`REPORT_SPEC` §3）、`object` 缺省 `record`（`PROTOCOL_SPEC` §10.3）

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-cli/test/answers.test.ts
import { describe, it, expect } from "vitest";
import { parseConfirmation, parseCommand, parseResourceConflict } from "../src/answers";

describe("parseConfirmation", () => {
  it("accepts only an explicit yes", () => {
    expect(parseConfirmation("y")).toBe(true);
    expect(parseConfirmation(" yes ")).toBe(true);
    expect(parseConfirmation("是")).toBe(true);
  });

  it("treats an explicit no as a no", () => {
    expect(parseConfirmation("n")).toBe(false);
    expect(parseConfirmation("NO")).toBe(false);
  });

  it("refuses to guess anything else", () => {
    // An unparseable answer must not become a yes — nor a silent no.
    for (const line of ["", "maybe", "?", "yolo", "1"]) {
      expect(parseConfirmation(line)).toBeNull();
    }
  });
});

describe("parseResourceConflict", () => {
  it("maps only the two real answers", () => {
    expect(parseResourceConflict("wait")).toBe("wait");
    expect(parseResourceConflict("等")).toBe("wait");
    expect(parseResourceConflict("stop")).toBe("stop");
    expect(parseResourceConflict("停")).toBe("stop");
    expect(parseResourceConflict("whatever")).toBeNull();
  });
});

describe("parseCommand", () => {
  it("parses the read/export/blob commands with their defaults", () => {
    expect(parseCommand(":records")).toEqual({ kind: "records" });
    expect(parseCommand(":show rec_1")).toEqual({ kind: "show", recordId: "rec_1" });
    expect(parseCommand(":report rec_1")).toEqual({
      kind: "report",
      recordId: "rec_1",
      detailLevel: "full",
    });
    expect(parseCommand(":report rec_1 summary")).toEqual({
      kind: "report",
      recordId: "rec_1",
      detailLevel: "summary",
    });
    expect(parseCommand(":export rec_1")).toEqual({
      kind: "export",
      recordId: "rec_1",
      object: "record",
    });
    expect(parseCommand(":export rec_1 report")).toEqual({
      kind: "export",
      recordId: "rec_1",
      object: "report",
    });
    expect(parseCommand(":blob blob_abc out.log")).toEqual({
      kind: "blob",
      contentRef: "blob_abc",
      path: "out.log",
    });
  });

  it("rejects a command missing its argument instead of guessing", () => {
    expect(parseCommand(":show")).toBeNull();
    expect(parseCommand(":blob blob_abc")).toBeNull();
    expect(parseCommand(":report rec_1 verbose")).toBeNull();
    expect(parseCommand(":export rec_1 reportx")).toBeNull();
  });

  it("does not treat an ordinary line as a command", () => {
    expect(parseCommand("hello")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-cli exec vitest run test/answers.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

按 Interfaces 实现；解析要**宽进严出**：允许前后空白与大小写，但**不认识就返回 `null`**（由调用方决定重问），绝不猜。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-cli exec vitest run test/answers.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-cli/src/answers.ts packages/client-cli/test/answers.test.ts
git commit -m "feat(cli): parse the human's answers, and refuse to guess"
```

---

### Task 3: 提示串行化 + 命令循环

**Files:**
- Create: `packages/client-cli/src/console.ts`、`packages/client-cli/src/main.ts`
- Test: `packages/client-cli/test/console.test.ts`

**Interfaces:**
- Produces:
  - `interface Prompter { ask(question: string): Promise<string>; print(line: string): void }`
  - `createPromptQueue(prompter: Prompter): { ask(question: string): Promise<string> }`——同一队列内**串行**（后来的问题等前面的答完）
  - `readlinePrompter(input, output): Prompter & { close(): void }`（真实实现，基于 `node:readline`）
  - `parseArgs(argv: string[]): { url: string; username: string; secret: string | null; workspaceRoot: string; ledgerPath: string; sessionPath: string }`（`--url/--user/--secret/--workspace/--ledger/--session`；`--secret` 缺省读 `ADT_SECRET`，仍缺则返回 `null`，由 `main.ts` **不回显地**提示读取——见 Global Constraints）
  - `runCli(deps: { daemon: ClientDaemon; prompts: { ask(q: string): Promise<string> }; print(line: string): void }): Promise<void>`
  - `buildHostCallbacks(prompts): Pick<ClientDaemonOptions, "onConfirmationRequired" | "onUserInput" | "onResourceConflict">`——**EOF/异常一律落到安全默认**（确认 → 拒绝；资源冲突 → `stop`）
- Consumes: Task 1/2 的渲染与解析；`@adt/client-daemon` 的 `ClientDaemon`、`openLedger`、`openSessionStore`、`downloadBlob`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-cli/test/console.test.ts
import { describe, it, expect } from "vitest";
import { createPromptQueue, buildHostCallbacks } from "../src/console";

function scripted(lines: string[]) {
  const asked: string[] = [];
  const printed: string[] = [];
  const prompter = {
    ask: async (q: string) => {
      asked.push(q);
      return lines.shift() ?? "";
    },
    print: (l: string) => void printed.push(l),
  };
  return { prompter, asked, printed };
}

describe("createPromptQueue", () => {
  it("never lets two questions be pending at once", async () => {
    const { prompter, asked } = scripted(["first", "second"]);
    const queue = createPromptQueue(prompter);

    const [a, b] = await Promise.all([queue.ask("q1? "), queue.ask("q2? ")]);
    expect([a, b]).toEqual(["first", "second"]);
    expect(asked).toEqual(["q1? ", "q2? "]);
  });
});

describe("buildHostCallbacks", () => {
  it("re-asks an unparseable confirmation instead of assuming yes", async () => {
    const { prompter, asked, printed } = scripted(["maybe", "y"]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), (l) => void printed.push(l));

    const approved = await callbacks.onConfirmationRequired!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位",
      input: {},
    });

    expect(approved).toBe(true);
    expect(asked).toHaveLength(2); // asked once, refused to guess, asked again
  });

  it("declines on EOF rather than approving", async () => {
    const { prompter } = scripted([]); // immediately empty ⇒ EOF
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    const approved = await callbacks.onConfirmationRequired!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位",
      input: {},
    });

    expect(approved).toBe(false);
  });

  it("defaults a resource conflict to stop", async () => {
    const { prompter } = scripted([]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    const answer = await callbacks.onResourceConflict!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位",
    });

    expect(answer).toBe("stop");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-cli exec vitest run test/console.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`console.ts` 按 Interfaces 实现：队列是一条 `previous.then(...)` 链（与 `packages/server/src/ws/messageRouter.ts` 同一手法）；`buildHostCallbacks` 里，确认提示用 `renderDispatch` 给足依据，解析不出就**再问**，`ask` 抛错或返回空（EOF）就落到安全默认。`main.ts` 解析参数、`openLedger`/`openSessionStore`（默认 `.adt/client-cli/ledger.db` 与 `.adt/client-cli/session.json`）、`ClientDaemon.connect`、注册 `daemon.connection.on(...)` 把入站消息渲染出来，然后跑命令循环直到 `:quit`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-cli exec vitest run test/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-cli/src/console.ts packages/client-cli/src/main.ts packages/client-cli/src/index.ts packages/client-cli/test/console.test.ts
git commit -m "feat(cli): one question at a time, and a safe default when nobody answers"
```

---

### Task 4: 端到端——真人路径全部走一遍

**Files:**
- Test: `packages/client-cli/test/cli.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1–3；`@adt/test-support` 的 `startTestServer`（含 `knowledgeDepositor` 注入点）与 `TestClient`；`@adt/client-daemon` 的 `ClientDaemon`
- Produces: 验收——① 确认**同意**时 Step 真的执行并回到 Server；② 确认**拒绝**时 Server 收到 `REJECTED(user_declined)`；③ 资源冲突答 `stop` → Workflow `FAILED(resource_conflict)`；④ `:records` / `:show` 打印自己的 Record；⑤ `:report` 打印 markdown；⑥ `:export` 走到假 KB 端点并打印"已接收"；未配置 KB 时打印 `export_unavailable`；⑦ `:blob` 把字节落到文件且 sha256 对得上

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-cli/test/cli.e2e.test.ts
// 起 startTestServer（脚本化 planner），用 ClientDaemon.connect 接上 Task 3 的宿主回调
// （应答来自脚本），再用 runCli 驱动命令循环；断言：
// 1) 派发被打印（含 objective/capability）
// 2) 同意 → 该 Step 的 status 到达 Server（用 record.get 事后核对 entries）
// 3) 拒绝 → Record 里有 step_rejected（kind）且 Workflow 仍能收敛
// 4) 资源冲突 stop → workflow.terminated 的 terminal_state/terminal_reason
// 5) :report → 打印体含 "# 诊断报告"
// 6) :export → 假 KB 端点收到 POST；未配置时打印 export_unavailable
// 7) :blob → 文件内容与 sha256 一致
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-cli exec vitest run test/cli.e2e.test.ts`
Expected: FAIL（`runCli` 尚未把命令接上）

- [ ] **Step 3: 实现（补齐缺口）**

修正暴露的缺口直到闭环成立；**不得**为过测试把"确认默认同意"或"把失败显示成成功"写进去。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-cli exec vitest run test/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-cli/test/cli.e2e.test.ts packages/client-cli/src
git commit -m "test(cli): the human paths, end to end"
```

---

### Task 5: 文档

**Files:**
- Modify: `README.md`（新增"控制台客户端（`client-cli`）"一节：怎么跑、命令表、**它会执行真实能力注册表**这句安全说明、`--ledger/--session` 默认持久）
- Modify: `docs/architecture/CLIENT_SPEC.md`（若 §3/§4 有"客户端形态"清单，补一条"控制台客户端（`client-cli`）：daemon 的人类前端，用于手工验收"；按仓库纪律**推进它自己的 `Version`** 并同步 `docs/REQUIREMENTS.md` §7 那一行）

**Interfaces:**
- Consumes: Task 1–4
- Produces: 文档与实现一致

- [ ] **Step 1: 改两份文档**

README 一节写清：`pnpm -C packages/client-cli start -- --url ws://127.0.0.1:8080/ws --user alice`；命令表（`:records` / `:show` / `:report` / `:export` / `:blob` / `:help` / `:quit`）；以及"确认默认拒绝、EOF 即拒绝"这条安全语义。

- [ ] **Step 2: 验证版本一致性**

Run: `for f in WORKFLOW_SPEC CAPABILITY_SPEC PROTOCOL_SPEC RECORD_SPEC SERVER_SPEC CLIENT_SPEC; do …比较自身版本与 REQUIREMENTS §7 引用…; done`
Expected: 全部 `OK`（若改了 `CLIENT_SPEC`）

- [ ] **Step 3: 提交**

```bash
git add README.md docs/
git commit -m "docs: how to run the console client, and what running it does"
```

---

## Self-Review

**1. Spec coverage：** `CLIENT_SPEC.md` §4/§5（收集职责与人工介入角色）→ T3/T4；`PROTOCOL_SPEC.md` §10/§10.3/§11（Record 可见性、导出、Report）→ T1/T4；§7.5 blob → T4；`WORKFLOW_SPEC.md` §4.3（确认与 `REJECTED`）/§4.4（资源冲突）→ T2/T4；`CAPABILITY_SPEC.md` §6（`human.manual_action` 建议路径）→ T2/T4；`REPORT_SPEC.md` §3（`detail_level`）→ T2；`ADR-005` §4（`ok` 的诚实含义）→ T1。**刻意不做**：Client 正式 UI、多会话、脚本/非交互模式（`--yes` 之类的自动化开关——那会让"确认"形同虚设，属于另一个决策）、上传 blob（大体积证据来自能力，不由人手填）、`session.resume` 的手工触发（daemon 自动做）。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支。

**3. Type consistency：** `Prompter`/`createPromptQueue`/`buildHostCallbacks`/`parseArgs`/`runCli`（T3）在 T4 同名复用；`render*`（T1）与 `parse*`（T2）在 T3 被消费；`Command` 的字段与 T3 的命令分发一致；`ManualActionFeedback` 直接复用 daemon 的类型（不另造一个）。

**4. Review Focus：** 五条风险落到测试——不默认同意（T2 + T3 两例）、提示不交错（T3 队列例）、不发明事实（T1 导出例）、失败如实透出（T1 + T4）、blob 校验（T4 第 7 例）。

**5. Proportion：** 计划只描述决策、接口与断言；T4 的测试写"断言清单"（夹具复用 `startTestServer` + `TestClient` 与 `recordProtocol.test.ts` 的完成流程写法）。

**6. 执行顺序依赖：** T1 → T2 → T3 → T4（渲染 → 解析 → 循环 → 端到端）；T5 最后。T1/T2 互不依赖，可换序。

## 移交后续计划的待办

1. **D6（a）**：真实 Windows 适配器的**调研简报**（问题清单 + 结论要落成什么 ADR），不写代码——本阶段之后。
2. **正式 Client UI**：`client-cli` 是手工验收场所，不是产品形态；UI 另行立项。
3. **非交互/脚本模式**：如果要让 CI 跑"无人工"的验收，需要显式设计（且必须解决"确认"如何被代表）——不是加一个 `--yes` 就完事。
4. 其余延后项见前几份计划的裁决表。

---

## Review 修复轮（Review fix pass）

整体评审：`opencode-go/deepseek-v4.1-flash`，整分支 `b4af71b..725b135`。**1 Critical + 4 Important**，全部修复；评审独立复现了其中两条（密码被回显、下一行被吃掉），并确认 e2e 连跑多次稳定、`typecheck`/文档一致性检查干净、diff 没有碰其它包。修复后 **462 passed / 1 skipped**，typecheck 干净。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **C1（阻塞）**"不回显"的密码提示**形同虚设**：`main.ts` 先建了终端 readline（output = 真实 stdout），`askSecretWithoutEcho()` 又在**同一个 stdin** 上建了第二个——密码被第一个接口回显，且用户键入的**下一行会被第一个接口吃掉**（评审用独立脚本复现了两条） | **已修** | 改成**只有一个 readline**：`readlinePrompter` 的 output 经过一个可静音的 `Writable` 闸门，新增 `askHidden()` 临时静音该接口的回显；`main.ts` 删掉第二个接口。两例 RED→GREEN（隐藏问题不回显、普通问题照常回显） |
| **I2（重要）**入站打印会插进**待答问题的中间**（计划的 Review Focus #2 明说了这条；输入没被吃掉，但屏幕被搅乱） | **已修** | `createPromptQueue` 现在**同时拥有打印**：有待答问题时入站行先入队，答完再 flush。一例 RED→GREEN。`CliIo` 随之改为只收队列（不再单独收 `print`），免得有人传一个"不延迟的 print"进来 |
| **I3（重要）**仓库里混进了**运行时产物** `packages/client-cli/.adt/client-cli/{ledger.db,session.json}`（手工冒烟跑 `start` 时生成的，未被 ignore 就被 `git add -A` 带上了） | **已修** | `git rm --cached` 并删除这两个文件，`.gitignore` 增 `.adt/`；`git ls-files \| grep .adt` 为空 |
| **I4（重要）**`onUserInput` 对**看不懂的非空输入**直接返回 `undefined`——用户的真实观察被静默丢掉，daemon 还会当成"拒绝"（确认路径会重问，反馈路径不会） | **已修** | 与确认路径一致：非空但解析不出 → **重问**（空行仍是"不回报"）。一例 RED→GREEN |
| **N5**`renderReport` 信任 `status`、忽略 `report` 为 `null` 的畸形回复 | **不改（已诚实）** | 会落到失败分支并打印 `（未给出 error_code）`，不崩溃也不编造；评审自己标注"acceptable" |
| **M1**宿主回调的提示用裸 `JSON.stringify`，而 `render.ts` 有键序稳定的 `stableJson` | **延后（理由）** | 同一个 Step 的两处提示键序可能不同；wire JSON 不会抛（无循环引用 / BigInt），属可读性一致性。等两处提示合并时一起收 |
| **M2**`renderDispatch` 直接插值 `objective`（wire 类型必填，daemon 自己的类型可缺） | **延后（理由）** | 监听器只收 wire 信封，今天安全；加 `?? "（未给出目标）"` 更贴合"不发明 / 不打印 undefined"，属打磨 |
| **M3**`parseArgs` 不处理"末位缺值的 flag"、重复 flag 静默覆盖、未知 flag 静默忽略 | **延后（理由）** | 前两种都可辩护（缺值→用默认、重复→后者胜）；未知 flag 的提示值得加，但不是缺陷 |
| **M4**完成候选的 IIFE 是 fire-and-forget，快速关闭时可能与 `daemon.close()` 竞争 | **延后（理由）** | 测试稳定；要在 `main` 的 `finally` 等它，需把在途 promise 提出来。等有真实的快速退出场景再收 |
| **M5**`readlinePrompter.ask` 每次挂一个 `close` 监听器 | **不改** | 队列保证同时只有一个 ask 在飞，泄漏有界；评审自己标"cosmetic" |

**评审"Declined to judge"各行**：**维持**——README 的 Task 5 文案、`CLIENT_SPEC` 不改（其 §2 明确把实现拆分留给实现阶段）、骨架与 `vitest.config.ts` 提前创建、`@adt/server` 的 type-only 依赖、`parseArgs` 的 `--` 跳过、两参 `buildHostCallbacks`、`:ask` + 完成候选两处新增、中文提示串。

**本阶段刻意不做**：正式 Client UI、非交互/脚本模式（`--yes` 会让"确认"形同虚设，属另一个决策）、上传 blob、手工触发 `session.resume`。
