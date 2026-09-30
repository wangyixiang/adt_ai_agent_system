# P3b client-daemon 只读闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 client-daemon **真正执行**只读 Capability：处理 `step.dispatch`、在本机跑 `git`/读文件/查容器、把结果作为 Evidence 回传，并用**可插拔适配器层**承载未来（Windows 产品）接入。

**Architecture:** Capability 的 canonical 描述（名称 + 声明 + I/O schema）**归 Client 所有**，放在 `@adt/client-daemon`；Server 始终保持**清单驱动**——它只从 `session.hello`/`capability.sync` 拿到声明，不 import 任何具体能力，从而保住"客户端上报能力、服务端解耦"的设计目标（`@adt/shared` 只保留通用的 `CapabilityDescriptor` 类型）。daemon 侧由三层组成：`CapabilityRegistry`（声明 + 查找）→ `CapabilityAdapter`（执行，注入 `CommandRunner`）→ `StepRunner`（把 `step.dispatch` 翻成 `step.status`）。所有本地执行默认带**工作区约束 + 子进程超时 + 输出上限**。

**Tech Stack:** TypeScript（strict）· Node.js LTS · `node:child_process` · Vitest · pnpm workspace（沿用 P1–P3a 结构）

**Spec:** `docs/specs/CAPABILITY_SPEC.md`（v0.6 §2/§3/§5：命名、声明字段、受限子集 schema、两端校验）、`docs/specs/PROTOCOL_SPEC.md`（v0.7 §8 `step.dispatch`/`step.status`、§5 会话）、`docs/specs/WORKFLOW_SPEC.md`（v0.5 §3 Step、§4 Step 状态机、§5 Evidence、§6.1 建议路径）、`docs/adr/ADR-004-tech-stack.md`（§3 Client 与可插拔 Capability 适配器）、`docs/adr/ADR-003-deployment-and-trust-model.md`（§3 认证、§5 授权）

## Global Constraints

- **只读范围**：只真实执行 `side_effect: false` 的 Capability；不实现受控执行确认、`UNKNOWN`/对账、幂等台账、blob、客户端 `session.resume`（P4/后续）。
- **能力归 Client**：具体 Capability 的名称与 schema **只能在 `@adt/client-daemon` 定义**；`@adt/server` 不得 import 它们（Server 只消费 Manifest，`capability/known.ts` 的名称白名单仅用于 §4 的未登记告警）。`@adt/shared` 只放通用协议类型。
- **schema 语言**：JSON Schema 受限子集（`CAPABILITY_SPEC.md` §5.1：`type`/`properties`/`required`/`enum`/`items`/`description`/`default`，无 `$ref` 与组合关键字）。
- **Evidence 忠实**（`RECORD_SPEC.md` §1、`WORKFLOW_SPEC.md` §5）：`source` 固定 `"capability"`，`type` 用该能力登记的 output 名称，`result` 是**真实观测**，不得编造；执行失败一律 `FAILED`，绝不伪造 `COMPLETED`。
- **安全边界（必做且必测）**：`filesystem.read_file` 只能读配置的**工作区根目录之内**的文件（拒绝 `..`/绝对路径越界），并有大小上限；`git`/`docker` 子进程有**超时**与固定 `cwd`；输出有上限。
- **信任模型**（`ADR-003` §5）：`requires_confirmation: true` 的 Step **绝不由 daemon 自动执行**；本轮返回 `REJECTED(user_declined)` 并置告警（确认交互属 P4）。
- **可测试**：测试不依赖真实 docker / 远程 git——`CommandRunner` 可注入；E2E 用临时工作区与真实 `git`。
- **文档纪律**：改 Spec 要 bump 版本 + 变更说明 + 交叉引用（本阶段涉及 `CAPABILITY_SPEC.md`：登记 `docker.inspect_container` 的 I/O schema 与各只读能力的 output 名称）。

## Review Focus

以下失败模式是 Spec 隐含但容易漏测的，**每条都必须在对应任务里有测试**：

1. **路径越界**：`filesystem.read_file` 收到 `../secret`、绝对路径或指向工作区外的符号链接 → 必须拒绝（不是读出来，也不是静默失败）。
2. **能力不可用**：收到引用 daemon 未注册能力的 `step.dispatch` → 回 `REJECTED(reject_reason.code = capability_unavailable)`，不得静默挂起。
3. **执行失败/超时**：子进程非零退出或超时 → 回 `FAILED(fail_reason.code = capability_error/timeout)`，证据如无则为空；**不得**回 `COMPLETED`。
4. **需确认的副作用 Step**：`requires_confirmation: true` → 绝不执行；本轮 `REJECTED(user_declined)`。
5. **Evidence 形态**：`source = "capability"`、`type` 与登记一致、`result` 与真实输出一致，且能被 Server 的 `output_schema` 校验通过。

---

### Task 1: Client 侧 Capability 描述与注册表

**Files:**
- Create: `packages/client-daemon/src/capability/spec.ts`
- Create: `packages/client-daemon/src/capability/result.ts`
- Create: `packages/client-daemon/src/capability/registry.ts`
- Create: `packages/client-daemon/src/capability/descriptors.ts`（MVP 能力的 canonical 声明）
- Test: `packages/client-daemon/test/capability/registry.test.ts`

**Interfaces:**
- Consumes: `CapabilityDescriptor`（`@adt/shared`）
- Produces:
  - `interface CommandResult { stdout: string; stderr: string; code: number }`
  - `type CommandRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number; maxBytes?: number }) => Promise<CommandResult>`
  - `interface CapabilitySpec { name: string; side_effect: boolean; interruptible: boolean; idempotent?: boolean; timeout_hint?: number; output_type?: string; input_schema?: Record<string, unknown>; output_schema?: Record<string, unknown> }`
  - `type ExecutionResult = { status: "completed"; type: string; result: unknown } | { status: "failed"; code: string; message?: string } | { status: "rejected"; code: string }`
  - `interface ExecutionContext { workspaceRoot: string; run: CommandRunner }`
  - `interface CapabilityAdapter { spec: CapabilitySpec; execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> }`
  - `class CapabilityRegistry { register(a: CapabilityAdapter): void; get(name: string): CapabilityAdapter | undefined; specs(): CapabilitySpec[]; descriptors(): CapabilityDescriptor[] }`
  - `function mvpDescriptors(): CapabilitySpec[]`（`git.collect_diagnostics`、`filesystem.read_file`、`docker.inspect_container`、占位 `local-agent.diagnose_project` / `browser.open_page`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/capability/registry.test.ts
import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../../src/capability/registry";
import type { CapabilityAdapter } from "../../src/capability/result";

const adapter = (name: string, side_effect: boolean): CapabilityAdapter => ({
  spec: { name, side_effect, interruptible: true, input_schema: { type: "object" }, output_schema: { type: "object" } },
  execute: async () => ({ status: "completed", type: "x", result: {} }),
});

describe("CapabilityRegistry", () => {
  it("registers adapters and exposes descriptors for the manifest", () => {
    const registry = new CapabilityRegistry();
    registry.register(adapter("git.collect_diagnostics", false));
    registry.register(adapter("sim_rig.trigger_reset", true));

    expect(registry.get("git.collect_diagnostics")!.spec.side_effect).toBe(false);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.descriptors()).toEqual([
      {
        name: "git.collect_diagnostics", side_effect: false, interruptible: true,
        idempotent: undefined, timeout_hint: undefined,
        input_schema: { type: "object" }, output_schema: { type: "object" },
      },
      {
        name: "sim_rig.trigger_reset", side_effect: true, interruptible: true,
        idempotent: undefined, timeout_hint: undefined,
        input_schema: { type: "object" }, output_schema: { type: "object" },
      },
    ]);
  });
});
```

```ts
// packages/client-daemon/test/capability/descriptors.test.ts
import { describe, it, expect } from "vitest";
import { mvpDescriptors } from "../../src/capability/descriptors";

describe("mvpDescriptors", () => {
  it("declares the read-only MVP capabilities with their schemas", () => {
    const byName = new Map(mvpDescriptors().map((spec) => [spec.name, spec]));
    expect(byName.get("git.collect_diagnostics")!.output_type).toBe("git_status");
    expect(byName.get("git.collect_diagnostics")!.side_effect).toBe(false);
    expect(byName.get("filesystem.read_file")!.output_type).toBe("file_content");
    expect(byName.get("filesystem.read_file")!.input_schema).toEqual({
      type: "object", required: ["path"], properties: { path: { type: "string" } },
    });
    expect(byName.get("docker.inspect_container")!.side_effect).toBe(false);
    // Placeholders are declared but carry no schema (CAPABILITY_SPEC.md §5.4).
    expect(byName.get("local-agent.diagnose_project")!.input_schema).toBeUndefined();
    expect(byName.get("browser.open_page")!.input_schema).toBeUndefined();
    expect(mvpDescriptors().every((spec) => spec.side_effect === false)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/registry.test.ts test/capability/descriptors.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`spec.ts` 只放 `CapabilitySpec`；`result.ts` 放 `CommandResult`/`CommandRunner`/`ExecutionResult`/`ExecutionContext`/`CapabilityAdapter`（`CommandRunner` 的实现留到 Task 2 的 `exec.ts`，此处只定义类型，避免 T1 依赖 T2）。

`registry.ts`：按注册顺序保存适配器；`descriptors()` 把 `spec` 映射成 `CapabilityDescriptor`（原样带 `idempotent`/`timeout_hint`/schemas）。

`descriptors.ts`：`mvpDescriptors()` 返回 §5.3 的 schema（git 的 output 名称 `git_status`；filesystem 的 output 名称 `file_content`；`docker.inspect_container` 用 input `{type:"object", required:["container"], properties:{container:{type:"string"}}}`、output `{type:"object", required:["running"], properties:{running:{type:"boolean"}, image:{type:"string"}}}`）；占位能力 `local-agent.diagnose_project` / `browser.open_page` 只声明 `name`/`side_effect:false`/`interruptible:true`，**不带 schema**。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/registry.test.ts test/capability/descriptors.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/capability packages/client-daemon/test/capability
git commit -m "feat(daemon): client-owned capability specs and registry"
```

---

### Task 2: 本地执行的安全底座（`CommandRunner` + 工作区约束）

**Files:**
- Create: `packages/client-daemon/src/capability/exec.ts`
- Create: `packages/client-daemon/src/capability/workspace.ts`
- Test: `packages/client-daemon/test/capability/workspace.test.ts`、`packages/client-daemon/test/capability/exec.test.ts`

**Interfaces:**
- Consumes: `node:child_process`、`node:path`；Task 1 的 `CommandResult`/`CommandRunner`
- Produces:
  - `function nodeCommandRunner(): CommandRunner`（`execFile`；超时/错误都归一为 `code !== 0` 的结果，不抛）
  - `function resolveWithinWorkspace(root: string, target: string): string | null`（目标解析后必须在 `root` 之内，否则 `null`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/capability/workspace.test.ts
import { describe, it, expect } from "vitest";
import { resolve, sep } from "node:path";
import { resolveWithinWorkspace } from "../../src/capability/workspace";

const root = resolve("/tmp/ws");

describe("resolveWithinWorkspace", () => {
  it("resolves relative paths inside the root", () => {
    expect(resolveWithinWorkspace(root, "logs/app.log")).toBe(resolve(root, "logs/app.log"));
    expect(resolveWithinWorkspace(root, ".")).toBe(root);
  });

  it("rejects escapes", () => {
    expect(resolveWithinWorkspace(root, "../secret")).toBeNull();
    expect(resolveWithinWorkspace(root, "logs/../../secret")).toBeNull();
    expect(resolveWithinWorkspace(root, `/tmp/other${sep}x`)).toBeNull();
  });
});
```

```ts
// packages/client-daemon/test/capability/exec.test.ts
import { describe, it, expect } from "vitest";
import { nodeCommandRunner } from "../../src/capability/exec";

describe("nodeCommandRunner", () => {
  it("captures stdout and the exit code", async () => {
    const result = await nodeCommandRunner()(process.execPath, ["-e", "process.stdout.write('hi')"], {
      cwd: process.cwd(), timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  it("reports a non-zero exit without throwing", async () => {
    const result = await nodeCommandRunner()(process.execPath, ["-e", "process.exit(3)"], {
      cwd: process.cwd(), timeoutMs: 5000,
    });
    expect(result.code).toBe(3);
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await nodeCommandRunner()(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(), timeoutMs: 200,
    });
    expect(result.code).not.toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/workspace.test.ts test/capability/exec.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`resolveWithinWorkspace`：`path.resolve(root)` 与 `path.resolve(root, target)`，比较时用 `resolved === root || resolved.startsWith(root + path.sep)`，否则 `null`（比较前做 `path.normalize`；Windows 大小写差异用 `path.relative` 判定：`const rel = path.relative(root, resolved); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? resolved : null`）。

`nodeCommandRunner`：`execFile(command, args, { cwd, timeout, maxBuffer: maxBytes ?? 1_000_000, windowsHide: true }, (error, stdout, stderr) => ...)`；`code` 取 `error.code` 数值，缺省 `-1`；无错误为 `0`；**永不 reject**（把失败编码进 `code`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/workspace.test.ts test/capability/exec.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/capability/exec.ts packages/client-daemon/src/capability/workspace.ts packages/client-daemon/test/capability/workspace.test.ts packages/client-daemon/test/capability/exec.test.ts
git commit -m "feat(daemon): bounded command runner and workspace confinement"
```

---

### Task 3: `filesystem.read_file` 适配器

**Files:**
- Create: `packages/client-daemon/src/capability/adapters/filesystem.ts`
- Test: `packages/client-daemon/test/capability/filesystem.test.ts`

**Interfaces:**
- Consumes: Task 1 `CapabilityAdapter`/`ExecutionResult`；Task 2 `resolveWithinWorkspace`
- Produces: `function filesystemReadFile(): CapabilityAdapter`（`spec` = `filesystem.read_file`；`execute` 读 UTF-8 文件）

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/capability/filesystem.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemReadFile } from "../../src/capability/adapters/filesystem";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "adt-ws-"));
  await writeFile(join(root, "hello.txt"), "hello", "utf8");
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(tmpdir(), "outside.txt"), "secret", "utf8");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const ctx = () => ({ workspaceRoot: root, run: async () => ({ stdout: "", stderr: "", code: 0 }) });

describe("filesystem.read_file", () => {
  it("reads a file inside the workspace with a faithful result", async () => {
    const result = await filesystemReadFile().execute({ path: "hello.txt" }, ctx());
    expect(result).toEqual({
      status: "completed", type: "file_content",
      result: { content: "hello", encoding: "utf8", path: "hello.txt" },
    });
  });

  it("refuses to escape the workspace", async () => {
    const escape = await filesystemReadFile().execute({ path: "../outside.txt" }, ctx());
    expect(escape.status).toBe("failed");
    expect((escape as { code: string }).code).toBe("invalid_input");
    expect(JSON.stringify(escape)).not.toContain("secret");
  });

  it("fails cleanly for a missing file", async () => {
    const missing = await filesystemReadFile().execute({ path: "nope.txt" }, ctx());
    expect(missing.status).toBe("failed");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/filesystem.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`execute`：`const rel = typeof input.path === "string" ? input.path : null`；无 → `{status:"failed", code:"invalid_input"}`。`resolveWithinWorkspace(workspaceRoot, rel)` 为 `null` → `{status:"failed", code:"invalid_input", message:"path escapes the workspace"}`（**不要**把越界路径内容读出来）。`readFile(abs, "utf8")` 且先 `stat` 判大小：超过上限（默认 256 KiB）→ `{status:"failed", code:"capability_error", message:"file too large"}`；`ENOENT` → `{status:"failed", code:"capability_error", message:"no such file"}`。成功 → `{status:"completed", type:"file_content", result:{content, encoding:"utf8", path: rel}}`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/filesystem.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/capability/adapters/filesystem.ts packages/client-daemon/test/capability/filesystem.test.ts
git commit -m "feat(daemon): filesystem.read_file adapter with workspace confinement"
```

---

### Task 4: `git.collect_diagnostics` 适配器

**Files:**
- Create: `packages/client-daemon/src/capability/adapters/git.ts`
- Test: `packages/client-daemon/test/capability/git.test.ts`

**Interfaces:**
- Consumes: Task 1、Task 2 `CommandRunner`/`resolveWithinWorkspace`
- Produces: `function gitCollectDiagnostics(run?: CommandRunner): CapabilityAdapter`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/capability/git.test.ts
import { describe, it, expect } from "vitest";
import { gitCollectDiagnostics } from "../../src/capability/adapters/git";
import type { CommandRunner } from "../../src/capability/result";

const ctxWith = (run: CommandRunner) => ({ workspaceRoot: "/ws", run });

describe("git.collect_diagnostics", () => {
  it("parses porcelain output into branch/modified/untracked", async () => {
    const run: CommandRunner = async () => ({
      code: 0,
      stdout: "## main...origin/main\n M src/a.ts\n?? new.txt\n?? b.txt\n",
      stderr: "",
    });
    const result = await gitCollectDiagnostics(run).execute({}, ctxWith(run));
    expect(result).toEqual({
      status: "completed", type: "git_status",
      result: { branch: "main", modified_files: 1, untracked_files: 2 },
    });
  });

  it("fails when git exits non-zero", async () => {
    const run: CommandRunner = async () => ({ code: 128, stdout: "", stderr: "not a repo" });
    const result = await gitCollectDiagnostics(run).execute({ project_path: "." }, ctxWith(run));
    expect(result.status).toBe("failed");
    expect((result as { code: string }).code).toBe("capability_error");
  });

  it("refuses a project_path outside the workspace", async () => {
    let called = false;
    const run: CommandRunner = async () => { called = true; return { code: 0, stdout: "", stderr: "" }; };
    const result = await gitCollectDiagnostics(run).execute({ project_path: "../elsewhere" }, ctxWith(run));
    expect(result.status).toBe("failed");
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/git.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`project_path` 缺省为 `"."`；`resolveWithinWorkspace(workspaceRoot, projectPath)` 为 `null` → `{status:"failed", code:"invalid_input"}`（不调用 `run`）。否则 `run("git", ["-C", abs, "status", "--porcelain=v1", "--branch"], { cwd: abs, timeoutMs: spec.timeout_hint ?? 5000 })`。`code !== 0` → `{status:"failed", code:"capability_error", message: stderr.trim() || "git failed"}`。解析：第一行以 `## ` 开头 → `branch = rest.split("...")[0].split(" ")[0]`；其余非空行：`?? ` 开头计入 `untracked`，`## ` 跳过，其余计入 `modified`。成功 → `{status:"completed", type:"git_status", result:{branch, modified_files, untracked_files}}`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/git.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/capability/adapters/git.ts packages/client-daemon/test/capability/git.test.ts
git commit -m "feat(daemon): git.collect_diagnostics adapter"
```

---

### Task 5: `docker.inspect_container` 与占位适配器

**Files:**
- Create: `packages/client-daemon/src/capability/adapters/docker.ts`
- Create: `packages/client-daemon/src/capability/adapters/placeholder.ts`
- Create: `packages/client-daemon/src/capability/defaultRegistry.ts`
- Test: `packages/client-daemon/test/capability/docker.test.ts`、`packages/client-daemon/test/capability/placeholder.test.ts`、`packages/client-daemon/test/capability/defaultRegistry.test.ts`

**Interfaces:**
- Consumes: Task 1、Task 2、Task 3、Task 4
- Produces:
  - `function dockerInspectContainer(run?: CommandRunner): CapabilityAdapter`
  - `function placeholderAdapter(name: string): CapabilityAdapter`（执行恒为 `{status:"failed", code:"capability_error", message:"<name> is not implemented in this MVP"}`）
  - `function defaultRegistry(deps?: { run?: CommandRunner }): CapabilityRegistry`（注册 git / filesystem / docker / 两个占位）

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/capability/docker.test.ts
import { describe, it, expect } from "vitest";
import { dockerInspectContainer } from "../../src/capability/adapters/docker";
import type { CommandRunner } from "../../src/capability/result";

const ctxWith = (run: CommandRunner) => ({ workspaceRoot: "/ws", run });

describe("docker.inspect_container", () => {
  it("maps docker inspect JSON to running/image", async () => {
    const run: CommandRunner = async () => ({
      code: 0, stderr: "",
      stdout: JSON.stringify([{ State: { Running: true }, Config: { Image: "nginx:1.27" } }]),
    });
    const result = await dockerInspectContainer(run).execute({ container: "web" }, ctxWith(run));
    expect(result).toEqual({
      status: "completed", type: "container_info",
      result: { running: true, image: "nginx:1.27" },
    });
  });

  it("fails when docker exits non-zero", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "No such container" });
    const result = await dockerInspectContainer(run).execute({ container: "nope" }, ctxWith(run));
    expect(result.status).toBe("failed");
    expect((result as { code: string }).code).toBe("capability_error");
  });

  it("requires a container name", async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "[]", stderr: "" });
    const result = await dockerInspectContainer(run).execute({}, ctxWith(run));
    expect(result.status).toBe("failed");
    expect((result as { code: string }).code).toBe("invalid_input");
  });
});
```

```ts
// packages/client-daemon/test/capability/placeholder.test.ts
import { describe, it, expect } from "vitest";
import { placeholderAdapter } from "../../src/capability/adapters/placeholder";

describe("placeholderAdapter", () => {
  it("is declared but reports it is not implemented, without fabricating evidence", async () => {
    const adapter = placeholderAdapter("local-agent.diagnose_project");
    expect(adapter.spec.side_effect).toBe(false);
    expect(adapter.spec.input_schema).toBeUndefined();
    expect(
      await adapter.execute({}, { workspaceRoot: "/ws", run: async () => ({ stdout: "", stderr: "", code: 0 }) }),
    ).toEqual({ status: "failed", code: "capability_error", message: "local-agent.diagnose_project is not implemented in this MVP" });
  });
});
```

```ts
// packages/client-daemon/test/capability/defaultRegistry.test.ts
import { describe, it, expect } from "vitest";
import { defaultRegistry } from "../../src/capability/defaultRegistry";

describe("defaultRegistry", () => {
  it("registers every declared MVP capability as an adapter", () => {
    const registry = defaultRegistry();
    const names = registry.specs().map((spec) => spec.name).sort();
    expect(names).toEqual([
      "browser.open_page", "docker.inspect_container", "filesystem.read_file",
      "git.collect_diagnostics", "local-agent.diagnose_project",
    ]);
    expect(registry.descriptors().every((d) => d.side_effect === false)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/docker.test.ts test/capability/placeholder.test.ts test/capability/defaultRegistry.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`docker.ts`：`container` 非字符串或空 → `invalid_input`；`run("docker", ["inspect", container], { cwd: workspaceRoot, timeoutMs: spec.timeout_hint ?? 5000 })`；`code !== 0` → `capability_error`；`JSON.parse(stdout)` 后取 `[0].State.Running`/`[0].Config.Image`；解析失败或首项缺失 → `capability_error`。成功 → `{status:"completed", type:"container_info", result:{running, image}}`（`running` 非布尔 → `capability_error`）。

`placeholder.ts`：`spec` 只有 `name`/`side_effect:false`/`interruptible:true`，`execute` 恒返回 `capability_error`。

`defaultRegistry.ts`：`registry.register(gitCollectDiagnostics(deps?.run))` 等；`mvpDescriptors()` 的每个 `name` 都必须有对应适配器（占位能力用 `placeholderAdapter`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/capability/docker.test.ts test/capability/placeholder.test.ts test/capability/defaultRegistry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/capability/adapters/docker.ts packages/client-daemon/src/capability/adapters/placeholder.ts packages/client-daemon/src/capability/defaultRegistry.ts packages/client-daemon/test/capability
git commit -m "feat(daemon): docker adapter, placeholders and the default registry"
```

---

### Task 6: `StepRunner`（`step.dispatch` → `step.status`）

**Files:**
- Create: `packages/client-daemon/src/stepRunner.ts`
- Test: `packages/client-daemon/test/stepRunner.test.ts`

**Interfaces:**
- Consumes: Task 1 `CapabilityRegistry`/`ExecutionResult`；Task 2 `CommandRunner`；`DaemonConnection`
- Produces:
  - `interface StepDispatcher { on(type: string, handler: (env: { payload: unknown }) => void): void; send(type: string, payload: unknown): void }`
  - `interface StepRunnerDeps { connection: StepDispatcher; registry: CapabilityRegistry; workspaceRoot: string; run?: CommandRunner }`
  - `function attachStepRunner(deps: StepRunnerDeps): void`
  - 行为：注册 `connection.on("step.dispatch", …)`；对每个 dispatch：
    - 未注册的能力 → `step.status(REJECTED, reject_reason={code:"capability_unavailable"})`
    - `requires_confirmation === true` → `step.status(REJECTED, reject_reason={code:"user_declined"})`（P4 的确认流程占位）
    - 否则先 `step.status(RUNNING)`，执行后 `COMPLETED`（`evidence={source:"capability", type, result}`）或 `FAILED`（`fail_reason={code, message}`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/stepRunner.test.ts
import { describe, it, expect } from "vitest";
import { attachStepRunner } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { CapabilityAdapter } from "../src/capability/result";

function harness(adapter: CapabilityAdapter) {
  const sent: Array<{ type: string; payload: any }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  const registry = new CapabilityRegistry();
  registry.register(adapter);
  attachStepRunner({
    connection: {
      on: (type, handler) => { handlers.set(type, handler); },
      send: (type, payload) => { sent.push({ type, payload }); },
    },
    registry,
    workspaceRoot: "/ws",
  });
  const dispatch = (payload: Record<string, unknown>) => handlers.get("step.dispatch")!({ payload });
  return { sent, dispatch };
}

const dispatchPayload = (over: Record<string, unknown> = {}) => ({
  workflow_id: "wf_1", step_id: "step_1", objective: "read", capability: "filesystem.read_file",
  input: { path: "a.txt" }, expected_output: null, requires_confirmation: false, idempotency_key: null, ...over,
});

const completedAdapter: CapabilityAdapter = {
  spec: { name: "filesystem.read_file", side_effect: false, interruptible: true },
  execute: async () => ({ status: "completed", type: "file_content", result: { content: "x" } }),
};

describe("attachStepRunner", () => {
  it("reports RUNNING then COMPLETED with faithful evidence", async () => {
    const { sent, dispatch } = harness(completedAdapter);
    dispatch(dispatchPayload());
    expect(sent[0]).toMatchObject({ type: "step.status", payload: { workflow_id: "wf_1", step_id: "step_1", status: "RUNNING" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[1]).toMatchObject({
      type: "step.status",
      payload: { workflow_id: "wf_1", step_id: "step_1", status: "COMPLETED",
        evidence: { source: "capability", type: "file_content", result: { content: "x" } } },
    });
  });

  it("rejects an unregistered capability", async () => {
    const { sent, dispatch } = harness(completedAdapter);
    dispatch(dispatchPayload({ capability: "not.registered" }));
    expect(sent[0]).toMatchObject({ payload: { status: "REJECTED", reject_reason: { code: "capability_unavailable" } } });
  });

  it("never executes a step that asks for confirmation", async () => {
    let executed = false;
    const { sent, dispatch } = harness({
      spec: { name: "filesystem.read_file", side_effect: false, interruptible: true },
      execute: async () => { executed = true; return { status: "completed", type: "file_content", result: {} }; },
    });
    dispatch(dispatchPayload({ requires_confirmation: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(executed).toBe(false);
    expect(sent[0]).toMatchObject({ payload: { status: "REJECTED", reject_reason: { code: "user_declined" } } });
  });

  it("reports FAILED when the adapter fails", async () => {
    const { sent, dispatch } = harness({
      spec: { name: "filesystem.read_file", side_effect: false, interruptible: true },
      execute: async () => ({ status: "failed", code: "capability_error", message: "boom" }),
    });
    dispatch(dispatchPayload());
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[1]).toMatchObject({ payload: { status: "FAILED", fail_reason: { code: "capability_error", message: "boom" } } });
    expect((sent[1] as { payload: { evidence?: unknown } }).payload.evidence).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`attachStepRunner` 用 `connection.on("step.dispatch", handler)`；handler 内 `const dispatch = payload as StepDispatchPayload`，按上面分支 `connection.send("step.status", { workflow_id, step_id, status, … })`。`RUNNING` 先发，然后 `await adapter.execute(input, { workspaceRoot, run: deps.run ?? nodeCommandRunner() })`；`completed` → `{status:"COMPLETED", evidence:{source:"capability", type, result}}`；`failed` → `{status:"FAILED", fail_reason:{code, message}}`；`rejected` → `{status:"REJECTED", reject_reason:{code}}`。适配器抛异常 → 记 `FAILED(capability_error)`（`message` 取异常文本），绝不静默。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/stepRunner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/stepRunner.ts packages/client-daemon/test/stepRunner.test.ts
git commit -m "feat(daemon): step runner turns step.dispatch into step.status"
```

---

### Task 7: `ClientDaemon`（连接时声明能力 + 启动 StepRunner）

**Files:**
- Create: `packages/client-daemon/src/daemon.ts`
- Modify: `packages/client-daemon/src/index.ts`（导出）
- Test: `packages/client-daemon/test/daemon.test.ts`

**Interfaces:**
- Consumes: `DaemonConnection`、Task 5 `defaultRegistry`、Task 6 `attachStepRunner`
- Produces:
  - `interface ClientDaemonOptions { url: string; credentials: { username: string; secret: string }; clientInfo: { name: string; platform: string }; workspaceRoot: string; registry?: CapabilityRegistry; run?: CommandRunner }`
  - `class ClientDaemon { static connect(opts: ClientDaemonOptions): Promise<ClientDaemon>; readonly connection: DaemonConnection; readonly registry: CapabilityRegistry; close(): Promise<void> }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/daemon.test.ts
import { describe, it, expect } from "vitest";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";

describe("ClientDaemon", () => {
  it("declares the registry's capabilities on the server and runs steps", async () => {
    const srv = await startTestServer({ planner: [] });
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "daemon-test", platform: "test" },
      workspaceRoot: process.cwd(),
    });

    await srv.waitFor(() => srv.capabilities(daemon.connection.sessionId).has("git.collect_diagnostics"));
    const declared = srv.capabilities(daemon.connection.sessionId);
    expect(declared.get("filesystem.read_file")!.side_effect).toBe(false);

    await daemon.close();
    await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/daemon.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`connect`：`const registry = opts.registry ?? defaultRegistry({ run: opts.run })`；`const connection = await DaemonConnection.connect({ url, credentials, clientInfo, capabilities: registry.descriptors() })`；`attachStepRunner({ connection, registry, workspaceRoot, run })`；返回实例。`index.ts` 导出 `ClientDaemon`、`defaultRegistry`、`CapabilityRegistry`、适配器与类型。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/daemon.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/src/daemon.ts packages/client-daemon/src/index.ts packages/client-daemon/test/daemon.test.ts
git commit -m "feat(daemon): ClientDaemon wires declaration, registry and step runner"
```

---

### Task 8: 端到端只读闭环（真实 daemon + 服务端校验）

**Files:**
- Test: `packages/client-daemon/test/readonlyLoop.e2e.test.ts`

**Interfaces:**
- Consumes: Task 7 `ClientDaemon`；`@adt/test-support` `startTestServer`；真实 `git` 与临时文件
- Produces: 验收——daemon 真实执行只读 Step、Evidence 通过服务端 `output_schema` 校验、闭环走到 `COMPLETED` 并保存 Record

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-daemon/test/readonlyLoop.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "adt-e2e-"));
  await writeFile(join(root, "notes.txt"), "svc is down", "utf8");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("read-only closed loop over the real daemon", () => {
  it("executes a read step and reaches COMPLETED with a record", async () => {
    const srv = await startTestServer({
      planner: [
        { kind: "step", step: {
          objective: "read notes", capability: "filesystem.read_file", sideEffect: false, interruptible: true,
          input: { path: "notes.txt" } } },
        { kind: "completion_candidate", summary: "看完了", evidenceRefs: [] },
      ],
    });
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "daemon-e2e", platform: "test" },
      workspaceRoot: root,
    });
    const c = daemon.connection;

    let workflowId = "";
    c.on("workflow.created", (env) => {
      workflowId = (env.payload as { workflow_id: string }).workflow_id;
    });
    c.on("workflow.completion_candidate", () => {
      c.send("workflow.completion_response", { workflow_id: workflowId, resolution: "solved" });
    });

    // The daemon executes step.dispatch on its own; we observe the server.
    const terminated = await new Promise<Record<string, unknown>>((resolve) => {
      c.on("workflow.terminated", (env) => resolve(env.payload as Record<string, unknown>));
      c.send("workflow.request", {
        client_request_id: "req_e2e",
        user_request: { text: "服务起不来", attachments: [], context: {} },
      });
    });
    expect(terminated.terminal_state).toBe("COMPLETED");
    expect(terminated.record_id).toMatch(/^rec_/);

    await daemon.close();
    await srv.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/client-daemon exec vitest run test/readonlyLoop.e2e.test.ts`
Expected: FAIL（daemon 尚未执行 Step / 流程未闭环）

- [ ] **Step 3: 实现（补齐缺口）**

如果测试暴露 daemon 侧缺口（例如 `step.status` 信封缺 `workflow_id`、Evidence 未通过校验），在本任务内修正 `stepRunner.ts`/适配器，直到闭环成立。**不要**为了过测试而放宽服务端校验。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/client-daemon exec vitest run test/readonlyLoop.e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-daemon/test/readonlyLoop.e2e.test.ts packages/client-daemon/src
git commit -m "test(daemon): read-only closed loop over the real daemon"
```

---

### Task 9: 文档同步（CAPABILITY_SPEC / CLIENT_SPEC）

**Files:**
- Modify: `docs/specs/CAPABILITY_SPEC.md`（§5.3 登记 `docker.inspect_container` 的 I/O schema；把 `filesystem.read_file` 与 `git.collect_diagnostics` 的 output 名称写成 `file_content` / `git_status`；注明 MVP 占位能力 `local-agent.diagnose_project` / `browser.open_page` **不携带 schema**（§5.4）且未实现）→ v0.6 → **v0.7**
- Modify: `docs/architecture/CLIENT_SPEC.md`（§3 补一条：Client 通过**可插拔 Capability 适配器**在本机执行只读能力，并受工作区约束）→ v0.8 → **v0.9**
- Modify: `docs/REQUIREMENTS.md` §7 影响表版本引用

**Interfaces:**
- Consumes: Task 1–8 的实现
- Produces: 文档与实现一致

- [ ] **Step 1: 改 `CAPABILITY_SPEC.md`**

页首 `Version` → `v0.7`，变更记录：§5.3 增补 `docker.inspect_container`（input `{container}` / output `container_info {running, image?}`）与 `filesystem.read_file` output 名称 `file_content`；§5.3 注明 MVP 占位能力不带 schema、执行返回 `capability_error`。

- [ ] **Step 2: 改 `CLIENT_SPEC.md`**

页首 `Version` → `v0.9`，§3 加一条（v0.9 新增）：以**可插拔适配器**执行本地只读 Capability；`filesystem` 读取限定在配置的工作区根目录内，子进程带超时。对应 `ADR-004` §3、`CAPABILITY_SPEC.md` §5。

- [ ] **Step 3: 同步交叉引用**

Run: `grep -rn "CAPABILITY_SPEC.md\` v0\.6\|CLIENT_SPEC.md\` v0\.8" docs/ --include=*.md | grep -v superpowers`
更新 `REQUIREMENTS.md` §7 影响表中这两份文档的版本号与新增说明。

- [ ] **Step 4: 验证**

Run: `grep -n "Version:" docs/specs/CAPABILITY_SPEC.md docs/architecture/CLIENT_SPEC.md`
Expected: 分别显示 `v0.7` / `v0.9`

- [ ] **Step 5: 提交**

```bash
git add docs/
git commit -m "docs: register docker schema and the daemon capability adapter layer"
```

---

## Self-Review

**1. Spec coverage：** 客户端能力声明（名称/声明/schema）→ T1/T7；受限子集 schema 落地在 Client → T1；`filesystem.read_file` → T3；`git.collect_diagnostics` → T4；`docker.inspect_container` + 占位 → T5；`step.dispatch`→`step.status` 与 `REJECTED`/`FAILED`/`COMPLETED` 分支 → T6；Evidence envelope（`source`/`type`/`result`）→ T3/T4/T5/T6；端到端只读闭环 → T8；安全边界（工作区/超时/输出上限）→ T2/T3/T4；文档 → T9。**刻意留给后续**：受控执行确认（`requires_confirmation` 的 WAITING/确认交互）、`UNKNOWN`/对账、幂等台账、blob、客户端 `session.resume`、真实 Windows 产品适配器（ADR-004 开放前置项）。

**2. Step scan：** 每步一个动作；实现步给签名、语义与关键分支，不给完整函数体。

**3. Type consistency：** `CapabilitySpec`、`ExecutionResult`、`ExecutionContext`、`CapabilityAdapter`、`CommandRunner`/`CommandResult`、`resolveWithinWorkspace`、`CapabilityRegistry.descriptors()`、`gitCollectDiagnostics`/`filesystemReadFile`/`dockerInspectContainer`/`placeholderAdapter`、`defaultRegistry`、`attachStepRunner`/`StepRunnerDeps`、`ClientDaemon` 在 T1–T7 定义并同名复用。

**4. Review Focus：** 五条风险落到测试——(1) 路径越界 → T3；(2) 未注册能力 → T6；(3) 执行失败/超时 → T2（超时）+ T6（FAILED）；(4) `requires_confirmation` 不执行 → T6；(5) Evidence 形态与服务端校验 → T8。

**5. Proportion：** 计划只描述决策、接口与断言；适配器实现体只写"签名 + 关键分支"。

## 移交后续计划的待办（P4）

1. **受控执行确认**：`requires_confirmation: true` 的 Step 需要 WAITING(user_confirmation) + 本地确认 API（本轮以 `REJECTED(user_declined)` 占位）。
2. **客户端 `session.resume` 与重连**：断线后按 `workflow.state_sync.pending_step` 继续（P2c 已在服务端实现）。
3. **幂等台账**：`idempotency_key` → 结果的本地持久化（副作用 Step 才需要）。
4. **真实 Windows 产品适配器**：等 ADR-004 的接入形式调研结论（CLI/HTTP/DLL-COM/混合）。
5. **`docker.inspect_container` 的 schema** 本轮补登记，若后续接入更多 docker 能力需继续登记。

## 后续

P3b 验收通过后进入 **P4（受控执行 / 对账编排 / blob / KB 导出）**。
