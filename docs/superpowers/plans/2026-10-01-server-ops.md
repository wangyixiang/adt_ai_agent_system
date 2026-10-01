# Server 供给与运维（P-server-ops）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Server 能"正式"搭起来：`.env` 配置装载、优雅退出、**运维 CLI 建账号**（`adm`）、一套 `docker compose` 常驻（app + Postgres，数据持久化），并配上部署文档。

**Architecture:** 新增 `src/config.ts`（用 Node 24 内置 `process.loadEnvFile`，**真实 env 优先**，不引 dotenv）；新增 `src/shutdown.ts`（信号 → `close()` → 退出，可单测）；新增 `src/cli/adm.ts`（账号子命令，逻辑与 IO/仓库解耦、可单测）并给 `UserRepository` 补 `list`/`setDisabled`/`changePassword`；新增 `docker/server.Dockerfile` 与 compose 的 `server` 服务 + `db` 的 `pgdata` 卷；新增 `docs/DEPLOY.md`。

**Tech Stack:** TypeScript · Node 24（`process.loadEnvFile`、`node:readline`）· tsx · `pg` · Docker / docker compose · Vitest

**Spec:** `docs/superpowers/specs/2026-10-01-deployment-and-provisioning-design.md`（§4 是本计划；§5/§6 是后两份计划）。

## Global Constraints

- **不触协议面**：不改 `specs/*`、不改 WS/HTTP 消息；本计划只在 Server 的运行/运维层加东西。
- **`.env` 语义**：**真实环境变量优先**（Node `loadEnvFile` 保证；本计划用测试钉住）。`.env` 只填补未设置的值。
- **口令安全**：绝不打印 hash/口令；`adm` 的交互输入**不回显**；口令不进 argv（除显式 `--secret`，且文档劝阻）、不进日志。
- **不改 `ADR-003` 的决定**：内网、本地账号、无自助注册、TLS 延后。
- **不签名、不自动更新**（那是 §6/后续）。
- 编辑文件用 `edit` 工具（仓库 **LF**）；**不 push**。
- 验证口径：`pnpm -r --if-present test`（**串行**）+ `pnpm -r --if-present typecheck`；Docker 的验收是**文档化的手工步骤**（不在 CI 跑）。
- 本计划**刻意不做**：把 Server 编译成产物（继续 `tsx` 运行）、TLS、代码签名、自动更新、客户端设置页与打包（§5/§6）。

## Review Focus

以下失败模式是本 spec 隐含、但默认测试不会覆盖的；**每条都必须在对应任务里有测试**：

1. **真实 env 优先于 `.env`**：容器注入的 `DATABASE_URL`/密钥**不得**被仓库里的 `.env` 覆盖。见 Task 1。
2. **`adm` 不泄露口令**：`user list` 的输出**不含 hash**；`user add`/`passwd` **不把口令写进 stdout/stderr**。见 Task 2。
3. **`disable` 真的挡住登录**：停用后 `verifyCredentials` 必须返回 `null`（而不是"仅标记"）。见 Task 2。
4. **优雅退出不挂死**：`SIGTERM` → `close()` → `exit(0)`；**`close()` 抛错也必须退出**；第二次信号立即 `exit(1)`。见 Task 3。
5. **compose 数据持久化**：`db` 挂命名卷；`docker compose down`（**不带 `-v`**）后重起，数据仍在。见 Task 4（手工验收）。

---

### Task 1: `.env` 装载（真实 env 优先）

**Files:**
- Create: `packages/server/src/config.ts`
- Test: `packages/server/test/config.test.ts`

**Interfaces:**
- Produces:
```ts
/** Best-effort load of a `.env` file into process.env. Missing file = no-op. */
export function loadEnvFile(path: string): void;
/** Loads `<cwd>/.env` (the repo root when run from there). */
export function loadServerEnv(cwd?: string): void;
```
- 语义：文件存在 → `process.loadEnvFile(path)`（Node 24 内置，**已实测**：不覆盖既有变量）；文件不存在 → 静默跳过；解析失败 → `console.warn` 后继续。**绝不抛**。

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/config.test.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { loadEnvFile } from "../src/config";

const touched: string[] = [];
afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
});

describe("loadEnvFile", () => {
  it("lets the real environment win over the file", () => {
    process.env.ADT_PROBE_A = "from-real-env";
    touched.push("ADT_PROBE_A", "ADT_PROBE_B");
    const dir = mkdtempSync(join(tmpdir(), "adt-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "ADT_PROBE_A=from-dotenv\nADT_PROBE_B=only-dotenv\n");
      loadEnvFile(file);
      expect(process.env.ADT_PROBE_A).toBe("from-real-env");
      expect(process.env.ADT_PROBE_B).toBe("only-dotenv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a silent no-op when the file is missing", () => {
    expect(() => loadEnvFile(join(tmpdir(), "adt-nope", ".env"))).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/server exec vitest run test/config.test.ts`
- [ ] **Step 3: 实现** `src/config.ts`（`existsSync` 守卫 + `try { process.loadEnvFile } catch { console.warn }`；`loadServerEnv` 用 `join(cwd ?? process.cwd(), ".env")`）
- [ ] **Step 4: 运行确认通过** — 同上 + `pnpm -C packages/server typecheck`
- [ ] **Step 5: 提交** — `feat(server): load a .env file, with the real environment winning`

---

### Task 2: 账号运维 CLI（`adm`）

**Files:**
- Modify: `packages/server/src/auth/userRepository.ts`（`list` / `setDisabled` / `changePassword`）
- Create: `packages/server/src/cli/adm.ts`
- Modify: `packages/server/package.json`（`"adm": "tsx src/cli/adm.ts"`）
- Test: `packages/server/test/auth.test.ts`（Modify：仓库新方法，真 DB）、`packages/server/test/cli/adm.test.ts`（Create：CLI 逻辑，假仓库）

**Interfaces:**
- Produces:
```ts
// UserRepository 追加
list(): Promise<Array<{ username: string; disabled: boolean }>>;
setDisabled(username: string, disabled: boolean): Promise<boolean>;   // true=有行被改
changePassword(username: string, secret: string): Promise<boolean>;   // true=有行被改

// cli/adm.ts（逻辑与 IO/仓库解耦，可单测）
export interface AdmUsers {
  create(username: string, secret: string): Promise<unknown>;
  list(): Promise<Array<{ username: string; disabled: boolean }>>;
  setDisabled(username: string, disabled: boolean): Promise<boolean>;
  changePassword(username: string, secret: string): Promise<boolean>;
}
export interface AdmIo { out(line: string): void; err(line: string): void }
/** Returns the process exit code. `fallbackSecret` = --secret 之外的来源（ADT_SECRET / 交互输入）。 */
export async function runAdm(argv: string[], users: AdmUsers, io: AdmIo, fallbackSecret?: string): Promise<number>;
export async function main(argv?: string[]): Promise<number>; // 组装真 pool + UserRepository + 不回显读入口令
```
- 子命令与退出码：`user add <name>` / `user list` / `user passwd <name>` / `user disable <name>` / `user enable <name>`；成功 `0`、用法错 `2`、运行错 `1`。
- `--secret <s>` 覆盖 `fallbackSecret`；两者都没有 → `2` 并提示。`user add` 已存在 → 报错 `1`（不静默重置）；`--force` 时改为重置口令（等价 `passwd`）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/cli/adm.test.ts —— 假仓库，不碰 DB
import { describe, it, expect } from "vitest";
import { runAdm, type AdmUsers } from "../../src/cli/adm";

function fakeUsers(): AdmUsers & { rows: Map<string, { disabled: boolean; secret: string }> } {
  const rows = new Map<string, { disabled: boolean; secret: string }>();
  return {
    rows,
    create: async (username, secret) => {
      if (rows.has(username)) throw new Error("exists");
      rows.set(username, { disabled: false, secret });
    },
    list: async () => [...rows].map(([username, r]) => ({ username, disabled: r.disabled })),
    setDisabled: async (username, disabled) => {
      const r = rows.get(username);
      if (!r) return false;
      r.disabled = disabled;
      return true;
    },
    changePassword: async (username, secret) => {
      const r = rows.get(username);
      if (!r) return false;
      r.secret = secret;
      return true;
    },
  };
}

const lines = (): { io: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
};

describe("adm", () => {
  it("adds an account, then lists it", async () => {
    const users = fakeUsers();
    const { io, out } = lines();
    expect(await runAdm(["user", "add", "alice"], users, io, "pw-alice")).toBe(0);
    expect(await runAdm(["user", "list"], users, io)).toBe(0);
    expect(out.join("\n")).toContain("alice");
  });

  it("never prints the secret or a hash", async () => {
    const users = fakeUsers();
    const { io, out, err } = lines();
    await runAdm(["user", "add", "alice", "--secret", "s3cr3t"], users, io);
    await runAdm(["user", "list"], users, io);
    expect([...out, ...err].join("\n")).not.toContain("s3cr3t");
    expect([...out, ...err].join("\n")).not.toContain("hash");
  });

  it("disables and enables an account", async () => {
    const users = fakeUsers();
    const { io } = lines();
    await runAdm(["user", "add", "alice", "--secret", "x"], users, io);
    expect(await runAdm(["user", "disable", "alice"], users, io)).toBe(0);
    expect(users.rows.get("alice")!.disabled).toBe(true);
    expect(await runAdm(["user", "enable", "alice"], users, io)).toBe(0);
    expect(users.rows.get("alice")!.disabled).toBe(false);
  });

  it("returns 2 on usage errors (unknown command, missing secret)", async () => {
    const users = fakeUsers();
    const { io } = lines();
    expect(await runAdm(["user", "frobnicate"], users, io)).toBe(2);
    expect(await runAdm(["user", "add", "bob"], users, io)).toBe(2); // no secret anywhere
  });

  it("refuses to silently overwrite an existing account", async () => {
    const users = fakeUsers();
    const { io } = lines();
    await runAdm(["user", "add", "alice", "--secret", "one"], users, io);
    expect(await runAdm(["user", "add", "alice", "--secret", "two"], users, io)).toBe(1);
    expect(users.rows.get("alice")!.secret).toBe("one");
  });
});
```

```ts
// 追加到 packages/server/test/auth.test.ts（真 DB；沿用该文件既有 pool/仓库写法）
it("lists users without hashes, and a disabled user cannot log in", async () => {
  const repo = new UserRepository(pool);
  await repo.create("adm_probe", "pw-old");
  const listed = await repo.list();
  expect(listed.find((u) => u.username === "adm_probe")).toEqual({ username: "adm_probe", disabled: false });
  expect(Object.keys(listed[0]!)).toEqual(["username", "disabled"]); // 没有 hash 字段

  expect(await repo.setDisabled("adm_probe", true)).toBe(true);
  expect(await repo.verifyCredentials("adm_probe", "pw-old")).toBeNull();
  await repo.setDisabled("adm_probe", false);

  expect(await repo.changePassword("adm_probe", "pw-new")).toBe(true);
  expect(await repo.verifyCredentials("adm_probe", "pw-old")).toBeNull();
  expect(await repo.verifyCredentials("adm_probe", "pw-new")).not.toBeNull();
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/server exec vitest run test/cli/adm.test.ts test/auth.test.ts`
- [ ] **Step 3: 实现**（仓库三方法；`runAdm` 分派 + 退出码；`main` 组装 `createPool(loadServerEnv() 后的 DATABASE_URL)` + 不回显读入——**参照 `packages/client-cli/src/main.ts` 的不回显实现**）
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 手工冒烟（对真库）** — 起本地 Postgres 后：
  `pnpm --silent -C packages/server adm user add ops-smoke --secret x && pnpm --silent -C packages/server adm user list`
  Expected: 建号成功、列表里有 `ops-smoke`、**看不到任何 hash/明文**。（`--silent` 关掉 pnpm 的命令回显，否则 `--secret` 的值会进终端。）
- [ ] **Step 6: 提交** — `feat(server): an adm CLI to provision accounts`

---

### Task 3: 优雅退出

**Files:**
- Create: `packages/server/src/shutdown.ts`
- Modify: `packages/server/src/index.ts`（`isMain` 分支接线）
- Test: `packages/server/test/shutdown.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ShutdownTarget {
  close(): Promise<void>;
  on(signal: "SIGTERM" | "SIGINT", handler: () => void): void;
}
export interface ShutdownDeps {
  target: ShutdownTarget;
  exit(code: number): void;
  error(message: string): void;
}
/** First signal: close() then exit(0). A second signal: exit(1) at once. close() failing still exits. */
export function installGracefulShutdown(deps: ShutdownDeps): void;
```
- `index.ts` 的 `isMain`：`start()` 成功后 `installGracefulShutdown({ target: running, exit: process.exit, error: (m) => console.error(m) })`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/shutdown.test.ts
import { describe, it, expect } from "vitest";

import { installGracefulShutdown } from "../src/shutdown";

interface Harness {
  fire(signal: "SIGTERM" | "SIGINT"): void;
  readonly closes: number;
  readonly exits: number[];
  readonly errors: string[];
  resolveClose(): void;
  rejectClose(error: Error): void;
}

function harness(): Harness {
  const handlers = new Map<string, () => void>();
  let resolveClose!: () => void;
  let rejectClose!: (error: unknown) => void;
  let closes = 0;
  const exits: number[] = [];
  const errors: string[] = [];

  installGracefulShutdown({
    target: {
      close: () => {
        closes++;
        return new Promise<void>((resolve, reject) => {
          resolveClose = resolve;
          rejectClose = reject;
        });
      },
      on: (signal, handler) => handlers.set(signal, handler),
    },
    exit: (code) => exits.push(code),
    error: (message) => errors.push(message),
  });

  return {
    fire: (signal) => handlers.get(signal)?.(),
    get closes() {
      return closes;
    },
    exits,
    errors,
    resolveClose: () => resolveClose(),
    rejectClose: (error) => rejectClose(error),
  };
}

describe("installGracefulShutdown", () => {
  it("closes then exits 0 on the first signal", async () => {
    const h = harness();
    h.fire("SIGTERM");
    expect(h.closes).toBe(1);
    h.resolveClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.exits).toEqual([0]);
  });

  it("exits 1 immediately on a second signal", () => {
    const h = harness();
    h.fire("SIGTERM");
    h.fire("SIGINT");
    expect(h.exits).toEqual([1]);
  });

  it("still exits when close() rejects", async () => {
    const h = harness();
    h.fire("SIGTERM");
    h.rejectClose(new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.errors.join("\n")).toContain("boom");
    expect(h.exits).toEqual([1]);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm -C packages/server exec vitest run test/shutdown.test.ts`
- [ ] **Step 3: 实现** `shutdown.ts`（`let closing = false`：首个信号置位并 `void target.close().then(exit(0), (e) => { error(...); exit(1) })`；后续信号 `exit(1)`）；`index.ts` 接线。
- [ ] **Step 4: 运行确认通过** — 同上 + `typecheck`
- [ ] **Step 5: 提交** — `feat(server): shut down gracefully on SIGTERM/SIGINT`

---

### Task 4: Docker 常驻（Dockerfile + compose + `.env.example`）

**Files:**
- Create: `docker/server.Dockerfile`、`.env.example`、`.dockerignore`
- Modify: `docker-compose.yml`（`server` 服务 + `db` 的 `pgdata` 卷）、`.gitignore`（若无 `.env` 则加）

**Interfaces:**
- Produces：`docker compose up -d` 后 `server` 在 `8080` 就绪（`/health` 200）；`docker compose exec server pnpm -C packages/server adm user add <name>` 可建号；`db` 有命名卷 `pgdata`。
- Dockerfile 要点：`WORKDIR /app`、先拷 `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` + 各包的 `package.json` 以吃缓存、`pnpm install --frozen-lockfile`、再拷源码、`CMD ["pnpm", "-C", "packages/server", "exec", "tsx", "src/index.ts"]`。**含 devDependencies**（`tsx` 在 devDeps，见 spec §11）。
- compose `server`：`build: { context: ., dockerfile: docker/server.Dockerfile }`、`depends_on: db: { condition: service_healthy }`、`env_file: .env`、`ports: ["8080:8080"]`、`restart: unless-stopped`、blob 目录命名卷、`healthcheck`（用 node 内置 fetch 打 `http://127.0.0.1:8080/health`）。
- compose `db`：加 `volumes: [pgdata:/var/lib/postgresql/data]`；文件末尾声明 `volumes: { pgdata, blobs }`。

- [ ] **Step 1: 写 Dockerfile / compose / `.env.example` / `.dockerignore`**（按上面的 Interfaces）
- [ ] **Step 2: 手工验收（文档化的出口）**

```bash
cp .env.example .env            # 按需填入 LLM_API_KEY 等
docker compose up -d --build
curl -i http://127.0.0.1:8080/health          # 期望 200
docker compose exec -T server pnpm --silent -C packages/server adm user add ops --secret pw
docker compose exec -T server pnpm --silent -C packages/server adm user list   # 期望看到 ops
docker compose down                            # 不带 -v：保留数据
docker compose up -d && docker compose exec -T server pnpm --silent -C packages/server adm user list
# 期望：ops 仍在（证明 pgdata 持久化）
```
  Expected: 每条如上；`/health` 200；`down` 后重起数据仍在。
- [ ] **Step 3: 提交** — `build(server): a docker image and a compose stack that persists its database`

---

### Task 5: 部署文档

**Files:**
- Create: `docs/DEPLOY.md`
- Modify: `README.md`（"正式运行"小节，指向 `docs/DEPLOY.md`）

**Interfaces:**
- `docs/DEPLOY.md` 覆盖：先决条件（Docker）；`.env` 各项含义与**真实 env 优先**；`docker compose up -d`；用 `adm` 建号/改口令/停用；`docker logs` / `/health` / 优雅退出；**内网里 `BLOB_BASE_URL` 必须配成别的机器可达的地址**（否则取不回 blob）；client 连接（下一步 P-client-config 之前，用 `ADT_SERVER_URL` + `pnpm dev` 或 `client-cli`）；未签名/未自动更新的说明（§6 落地后补安装段）。

- [ ] **Step 1: 写 `docs/DEPLOY.md`**（按上面清单）
- [ ] **Step 2: README 加"正式运行"小节**（3–5 行 + 指向）
- [ ] **Step 3: 自检** — 文档里的每条命令都能在 Task 4 的验收里对上（无杜撰的脚本名/端口）。
- [ ] **Step 4: 提交** — `docs: a deployment guide for the server`

---

## Self-Review

**1. Spec coverage：** spec §4.1 → T1；§4.3 → T2；§4.2 → T3；§4.4 → T4；§4.5 → T4（healthcheck）；§7（Server 半边）→ T5；§8 测试策略 → 各任务。**刻意不做**见 Global Constraints（TLS/签名/自动更新/编译产物/客户端 §5-§6）。

**2. Step scan：** 每步一个动作；测试步给断言，实现步给签名；T4/T5 是配置与文档任务，出口是**明确的手工命令 + 期望**。

**3. Type consistency：** `AdmUsers`/`AdmIo`/`runAdm`（T2）与 `UserRepository` 新方法同名；`ShutdownTarget`/`installGracefulShutdown`（T3）在 `index.ts` 消费；`loadEnvFile`（T1）在 `adm` 的 `main`（T2）里用。

**4. Review Focus：** 五条都落到测试——env 优先级（T1 第 1 例）、不泄露口令（T2 第 2 例 + `list` 无 hash）、disable 挡登录（T2 的 auth 例）、退出不挂死（T3 三例）、数据持久化（T4 手工验收）。

**5. Proportion：** 计划只钉接口、命令与断言；Dockerfile 行文以要点给，不贴整份文件。

---

## 评审裁决表（整分支评审）

评审：`opencode-go/deepseek-v4.1-flash`，范围 `c6108a8..ff1cfd8`（6 提交）。结论 **With fixes**（**1 Critical / 5 Important / 若干 Minor**）。一轮修复（提交 `b265bea`）后全绿：`client-electron` 外整仓 `pnpm -r --if-present test` exit 0（server 347+1skip）、`typecheck` exit 0；Docker 手工验收重跑通过（`/health` 200；`adm user add` 重建镜像后**对已存在账号回 exit 1**）。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **C1（Critical）** `adm user add` 对已存在账号**静默重置口令**并报成功：`UserRepository.create` 是 upsert、**从不抛异常**，所以"已存在 → 报错 1（除非 `--force`）"的 `catch` 分支用真仓库**根本走不到**（假仓库的 `create` 会抛，掩盖了它） | **已修** | 新增 `UserRepository.exists()`；`runAdm` **显式先查存在**再决定（存在且无 `--force` → 1；有 `--force` → `changePassword`）；假仓库改成**镜像真实现（upsert 不抛）**；新增 `auth.test.ts`「adm user add refuses an existing account, against the real repository」（真 DB 回归）。容器内实测 `adm exit=1` |
| **I2（Important）** `--secret` 的值被 **pnpm 命令回显**到 stderr（`$ tsx src/cli/adm.ts … --secret X`） | **已修** | 文档一律用 `pnpm --silent -C packages/server adm …`（实测无回显）；`DEPLOY.md` 更正"口令不会出现在任何输出/日志"的说法并推荐 `ADT_SECRET`；计划里的手工验收命令同步加 `--silent` |
| **I3（Important）** 仓库根 `.env` **从未被加载**：所有命令都在 `pnpm -C packages/server` 下跑（cwd 变成 packages/server），`loadServerEnv` 找的是 `packages/server/.env` | **已修** | `config.ts` 用**模块 URL** 解析仓库根（`REPO_ROOT`），`loadServerEnv(root = REPO_ROOT)`；新增测试（`REPO_ROOT/package.json` 名字、`loadServerEnv(root)` 生效）；`DEPLOY.md` 说明"compose 用 `db`、宿主用 `localhost`，别混用同一份 `.env`"。实测：`adm` 现在真的读到了仓库根 `.env` |
| **I4（Important）** 不回显提示在 **EOF / 非 TTY 下永久挂死**（`rl.question` 回调不触发） | **已修** | `promptSecret` 在 `rl.on("close")` 时也 resolve（返回 `""` → 视作缺口令 → 退出码 2），不再挂死 |
| **I5（Important）** spec §4.1 要求的**启动脱敏摘要缺失**，而 `DEPLOY.md` 声称有 | **已修** | `config.ts` 新增 `formatStartupSummary()`（db 主机:端口 / 端口 / LLM 是否启用 / KB 是否配置 / blob 目录，**绝不含 secret**）；`index.ts` 的 `isMain` 打印；新增测试断言不含各类 secret |
| **M1** blob 落盘目录取决于环境（不设 `BLOB_DATA_DIR` 会落到卷外） | **已修** | compose 的 `server.environment` 固定 `BLOB_DATA_DIR: /app/.adt/blobs` |
| **M2** `.env.example` 不全（缺 `BLOB_TOKEN_TTL_MS`/`BLOB_RETENTION_MS`/`BLOB_MAX_BYTES`/`KB_TIMEOUT_MS`/`KB_MAX_RETRIES`）；`BLOB_BASE_URL` 是可被照抄的活动占位值 | **已修** | 补齐这些变量；`BLOB_BASE_URL` 改为**注释**并注明必须内网可达 |
| **M3** 不支持 `--secret=<值>`；空 `--secret ""` 会建出空口令账号；`create` 的失败被一律报成"已存在" | **已修** | `secretFrom` 支持两种形式；空口令视作缺口令（退出码 2）；存在性改为显式查询后，`create` 的异常不再被误报 |
| **M4** `adm` 测试用假仓库（`create` 会抛），正是它掩盖了 C1 | **已修** | 假仓库改为镜像真实现；另加真 DB 回归（见 C1） |
| **M5** `main()` 在校验命令前就提示口令（`adm add alice` 会先问口令再报用法错） | **已修** | 仅当 `argv[0]==="user"` 且 `add|passwd` 且无 `--secret*` 才提示 |
| **M6** CLI 失败时原样打印错误文本，极端情况下可能回显 `DATABASE_URL` | **延后** | 触发条件窄（连接串被拼进 pg 错误）；记录在案，后续统一做错误脱敏 |

**评审"Declined to judge"各行：维持**——客户端设置页（§5）、NSIS 打包（§6）、TLS/签名/自动更新（§9）、多租户/审计/SSO、把 Server 编译成产物、`ARCHITECTURE.md §6` 同步（核对后无需改）、`REQUIREMENTS.md §7`（无该行）、镜像含 devDeps（§11 有意）、容器以 root 运行、`55432` 端口暴露策略——均在本切片范围之外或已由 spec 有意接受。

**RED 证据（如实）**：C1（真 DB 拒绝已存在）与 I3/I5（`REPO_ROOT`/`formatStartupSummary`）为**先写出的回归测试**（先红后绿）；I2/I4 为手动复现后修复（I4 用 `< /dev/null` 复现挂死，I2 用 `--secret` 观察到回显）。
