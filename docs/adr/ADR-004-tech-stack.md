# ADR-004: 技术栈选型

- **Status:** ACCEPTED
- **日期:** 2026-09-30
- **关联:** `ADR-001`（状态权威）、`ADR-003`（部署与信任模型）、`PROTOCOL_SPEC.md`、`CAPABILITY_SPEC.md`、`REQUIREMENTS.md` NFR-7、MVP 范围说明（`docs/superpowers/specs/2026-09-29-mvp-scope.md`）
- **来源:** 基础产品启动前的技术栈决策

---

## Context

`ADR-003` 定下"多用户共享 Server、每位工程师独占自己的测试台"，MVP 范围也已确定。此时需要选定技术栈，且选型必须承接已经锁死的约束：

* **协议是自定义的**（`PROTOCOL_SPEC.md` 的信封、`in_reply_to`、去重窗口、重连语义、`UNKNOWN`/对账、心跳）——不能使用会强加自己信封或重连模型的框架；
* **Client 必须在工程师本机执行**本地命令 / 文件 / git / docker / 设备，并**持久化幂等台账**（`WORKFLOW_SPEC.md` §4.3）；
* **Server 必须支持长连接、有状态**（`ADR-002` One-Step Planning、`PROTOCOL_SPEC.md` §1），且 Workflow Engine 是状态唯一权威（`ADR-001`）；
* **Record 不可变、可检索**（`PROTOCOL_SPEC.md` §10）；blob 独立传输（§7.5）；
* **多用户共享**（`NFR-7`）：身份、Record 隔离、按用户过滤；
* 团队主力语言是 **TypeScript / Node**。

此外有一个已知的不确定项：团队有**多个既有 Windows 产品**希望接入 Client 使用，但**它们对外提供能力的形式尚未调研**（CLI / HTTP / DLL-COM / 混合未知）。

---

## Decision

### 1. 总体

* **语言：TypeScript / Node 同栈**，Client 与 Server 均为 TS/Node。
* **仓库：pnpm workspaces monorepo**：

```text
packages/
├── server           # Fastify + ws + Workflow Engine + 持久化 + LLM
├── client-daemon    # 本地执行 + 连接 + 台账 + blob + 本地 API
├── client-ui        # React 浏览器 UI（未来也跑在 Electron 里）
└── shared           # 协议类型、Capability 类型、schema 工具
```

* **共享类型由 Spec 派生**：`CAPABILITY_SPEC.md` 的 JSON Schema 用 `json-schema-to-typescript` 生成 TS 类型，使 Spec 成为唯一事实源。
* **测试：Vitest**；端到端直接执行 MVP 范围 §5 的主路径与三条异常路径脚本。

### 2. Server

| 项 | 选型 |
|---|---|
| 运行时 | Node.js LTS + TypeScript |
| HTTP / WebSocket | **Fastify + `ws`** |
| 进程模型 | MVP **单实例**；Workflow Engine 为进程内模块（`ADR-001` 权威） |
| 持久化 | **PostgreSQL**（Workflow 状态事务一致性；Record 全文检索用 `tsvector` / `pg_trgm`） |
| blob | **本地文件系统**，通过 `BlobStore` 抽象隔离（未来可换 MinIO / S3）。**P4c 已落地**：`LocalBlobStore` 按 sha256 内容寻址、流式写入并边写边校验；元数据在 `blobs` 表；过期**只回收未被任何 Record 引用的 blob**（保住 Record 的可回溯性） |
| LLM | **Provider 抽象层** + MVP 先接云端商用 API（要求可靠的结构化输出 / 函数调用） |
| 认证 | 本地账号（密码哈希 + 令牌）；`user_id` 握手后必填并校验 |

### 3. Client

| 项 | 选型 |
|---|---|
| 形态 | **本地 Node daemon + 浏览器 UI**（localhost）；**预留打包为 Electron / Windows exe 的路径** |
| daemon 职责 | 本地执行（`child_process` / fs / git / docker）、WS 连接、**SQLite 幂等台账**、blob 上传下载、对 UI 暴露本地 API |
| 幂等台账 | **SQLite**，跨进程重启保留。实现取 **Node 内置 `node:sqlite`**（见下方修订），而非 `better-sqlite3` |
| **Capability 适配器层** | **可插拔**：CLI / HTTP / 原生桥 / MCP 都能挂接；核心保持 TS |
| UI | **React + TypeScript**，由 daemon 托管静态资源；**与宿主无关**（浏览器能跑，Electron 也能跑） |

### 4. 工程约定

* 单仓库、pnpm、TS 严格模式；协议/Capability 类型不手写，由 Schema 生成。
* 本地开发提供 `docker-compose`（PostgreSQL）作为最小运行依赖。

---

## Rejected Alternatives

* **Client 直接用 Electron 单应用**：体验最好、单一可分发包，但 UI 与执行耦合、体积大、打包/签名/自动更新成本高；且不利于"UI 关闭后长任务继续"。本决定选择 daemon + 浏览器 UI，**Electron 作为后续打包壳保留**。
* **Client 用 Tauri（Rust 壳）**：体积小、安全，但引入 Rust，与"TS 同栈"冲突。
* **Client 先做 CLI**：最快，但人在回路体验差，无法验证确认/证据/Record 浏览。
* **Server 用 Socket.IO**：自带重连/房间/心跳，开发快，但会强加自己的信封与重连模型，与自定义 `PROTOCOL_SPEC` 冲突。
* **Server 用 NestJS**：结构化好，但对 MVP 偏重、样板多。
* **Server 用 Bun / Deno**：TS 原生、性能好，但生态与稳定性风险，长连接/持久化库支持需验证。
* **Server 用 SQLite（WAL）+ 文件系统**：零运维、MVP 最快，但既然已定"多用户共享 Server"，并发写与查询演进是真需求，**Postgres 可避免一次迁移**；SQLite 的运维优势在此场景收益很小。
* **Server 用 MongoDB**：Record 文档模型贴合，但事务/一致性弱于关系型，而 Workflow 状态需要强一致。
* **直接上 PostgreSQL + Redis + 对象存储**：面向大规模，MVP 明显偏重。
* **UI 用 Vue / Svelte**：均可，但 React 生态最大、Electron 场景最成熟。
* **LLM 直接用本地部署模型**：数据不出网，但需要 GPU 资源、规划质量与结构化输出稳定性待验证；本决定用抽象层 + 云端 API，本地模型作为后续可切换项。

---

## Consequences

**正面：**

* 同栈 TS/Node 降低协作与共享类型成本；Spec（JSON Schema）成为类型的唯一事实源。
* daemon + 浏览器 UI 的分离，使长任务不依赖 UI 存活，并为 Electron 打包预留了干净的路径。
* Postgres 避免了后续从 SQLite 迁移的返工；`BlobStore` 抽象为 MinIO/S3 预留了位置。

**需要落实：**

* 提供 PostgreSQL 的本地开发与部署方式（`docker-compose`）。
* 建立 monorepo 与 `JSON Schema → TS 类型` 的生成流程。
* UI 必须保持**宿主无关**，否则未来套 Electron 需要重写。
* LLM 调用的**数据出网**需要在实现时明确（`ADR-003` 未禁止，但属于需要显式接受的风险）。
* Client 的 Capability 适配器层必须先定义接口，再填具体实现。

**开放前置项（阻塞适配器实现，不阻塞其它）：**

* **Windows 产品接入形式调研**：现有产品以 CLI / HTTP / DLL-COM / 混合哪种形式提供能力？结论决定适配器实现方式，并且是**"纯 TS 同栈"唯一可能被打破的地方**（若需原生桥接，可能引入 C#/.NET 辅助进程或原生插件）。调研结论应补一份 ADR。

**明确延后：**

* TLS（`ADR-003` §4）、多实例/水平扩展与 Redis、MinIO/S3 实装、原生桥接实现。

---

## 修订（Amendments）

### A1. 幂等台账改用 Node 内置 `node:sqlite`（2026-09-30，P4a 实现时）

§3 原选型为 `better-sqlite3`。实现 P4a 的幂等台账时改为 **Node 内置 `node:sqlite`**（`DatabaseSync`），理由：

* 免原生构建：`better-sqlite3` 是原生模块，需要在 pnpm 的 `onlyBuiltDependencies` 里放行构建，并随平台/Node ABI 变化；
* 运行环境已满足：开发与部署基线为 Node LTS ≥ 22.13 / 24，`node:sqlite` 无需实验性开关；
* 台账的访问面很小（`key → {type, result}` 的读写），不依赖 `better-sqlite3` 的额外能力。

实现上有一个已知坑：Vite 5 从 `module.builtinModules` 中过滤掉任何含 `:` 的项，而 Node 只在 `node:sqlite` 前缀下暴露该模块，因此**静态 `import` 会让测试 runner 解析失败**（会去找名为 `sqlite` 的文件）；`packages/client-daemon/src/ledger.ts` 用 `createRequire` 运行时加载以绕开静态解析，生产产物（tsc 输出 ESM）同样成立。

若未来需要 SQLite 的高级能力（WAL 调优、扩展、同步 API 的成熟度保障），可回到 `better-sqlite3`——本修订只改选型实现，不改"SQLite + 跨进程保留"这一决定。
