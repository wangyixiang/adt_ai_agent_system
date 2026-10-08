# adt_ai_agent_system

HiL 诊断辅助系统。设计文档在 `docs/`（`PRODUCT.md` → `REQUIREMENTS.md` → `architecture/` → `specs/`，架构决策见 `adr/`）。

## 状态

**已实现**：P1 → P4d 的完整闭环，外加桌面客户端（`ADR-006`）与部署分发。

- **协议与引擎**：TypeScript monorepo；信封编解码、认证握手、能力同步、心跳与错误处置；Step/Workflow 状态机（含 `UNKNOWN`、终态不可变、取消 `CANCELLING` 收敛、终止护栏、`completion_criteria`）；PostgreSQL 三表 + `WorkflowStore`、孤儿回收、重启恢复。
- **Record / Report**：Evidence 入事件日志，Record 构建/持久化/按 owner 查询、先落盘后通知、Report 生成；`workflow.*` / `step.*` / `record.*` / `report.*` 协议接线。
- **协议一致性与重连**：`ERROR_DISPOSITION` 驱动错误处置、逻辑会话（跨重连去重窗口 + TTL）、`session.resume` + `workflow.state_sync`。
- **LLM 规划（P3a）**：`LlmProvider` 抽象 + OpenAI 兼容实现 + `LlmPlanner`、受限子集 JSON Schema 校验、`client_request_id` 幂等。
- **client-daemon（P3b）**：客户端自有 Capability 声明（`CapabilityRegistry`）+ 可插拔适配器（`git.collect_diagnostics` / `filesystem.read_file` / `docker.inspect_container` + 占位能力）、工作区约束、子进程超时、`step.dispatch → step.status`。
- **受控执行与对账（P4a）**：`requires_confirmation` 的副作用 Step 绝不自动执行（拒绝走 `REJECTED(user_declined)`）；`UNKNOWN` 对账（只读超时 → `FAILED(timeout)`、副作用 → `UNKNOWN`），存在未对账 `UNKNOWN` 时禁止再下发副作用；`node:sqlite` 幂等台账（键 → 结果，重连回放不重执行）。
- **资源冲突（P4b）**：由能力提供方判断并如实上报，Server 不仲裁、不排队；腾不出资源报 `REJECTED(resource_conflict)` → `FAILED` + `terminal_reason`。
- **blob 通道（P4c）**：申请制独立通道，HMAC 签名 URL、流式收发、边收边校验 size/sha256、按 sha256 内容寻址落盘；过期只回收未被任何 Record 引用的 blob。
- **收口**：客户端断线恢复（先 `resume`、被拒回落握手，三态幂等台账）；清单 `output_type` 派发时快照为 Step 的 `expected_output` 并在 `COMPLETED` 核对；结论性时间用墙钟、事件 `ts` 单调；副作用超时两端一致走 `UNKNOWN`；LLM 有界重试（`ADR-004` A2）。
- **KB 导出出站（P4d，`ADR-005`）**：提交人显式投递 Record（默认）/ Report 到配置端点；未配置 → `export_unavailable`；不改 Record、不影响 Workflow。
- **控制台客户端（D7(b)，`client-cli`）**：`client-daemon` 的人类前端（提交请求、回答四类决策、读 Record·Report、取 blob、触发导出）。
- **桌面客户端（`ADR-006`，`client-electron`）**：单体 Electron（daemon 内嵌 main、renderer 经 preload IPC）。三栏工作台、会话历史（live + 往期 Record 重建，不新增存储）、闭环末端（Report / KB 导出 / 取消）、附件与 blob（≤ 64 KiB 内联 / > 64 KiB 走 blob、预览/另存）、断线恢复与自动重连、首次运行设置页。契约见 `RECORD_SPEC` v0.11、`CLIENT_SPEC` v0.10。
- **部署（`docs/DEPLOY.md`）**：Server 用 `docker compose` 常驻、运维 CLI `adm`、客户端 NSIS 安装包。

**未实现 / 后续**：

- **D6（a）** 真实 Windows 适配器调研简报；**B1** Electron 安全硬化（CSP / `setWindowOpenHandler` / `sender` 校验）；**D2** token 流式；**A5** 多条 Workflow 并行。
- 打包增强：代码签名 / 自动更新（现为不签名、不自动更新，`ADR-003`）。
- KB 侧检索（FR-23，在第三方系统内）；安全规格（沙箱 / 多租户 / 审计 / 完整角色体系 / TLS 启用）。
- 桌面 UI **视觉还原**（对着参考稿逐栏）仍在进行中。

**关键契约版本**：`RECORD_SPEC` v0.11 · `PROTOCOL_SPEC` v0.12 · `SERVER_SPEC` v0.13 · `CLIENT_SPEC` v0.10 · `CAPABILITY_SPEC` v0.11 · `WORKFLOW_SPEC` v0.7 · `REPORT_SPEC` v0.4。

## 结构

```text
packages/
├── shared          # 协议类型、信封编解码、错误处置矩阵、去重窗口、受限子集 JSON Schema 校验器、blob 协议类型
├── server          # Fastify + ws、认证、会话与重连、Workflow 引擎、Record/Report、LLM 规划器、blob 通道、KB 导出出站
├── client-daemon   # 连接/握手/能力声明/心跳 + 可插拔 Capability 适配器（只读 + 受控副作用）、幂等台账、blob 收发
├── client-cli      # 控制台客户端：client-daemon 的人类前端（确认 / 建议 / 资源冲突 / 读 Record·Report / 取 blob / 触发导出）
├── client-electron # 单体 Electron 桌面应用（`ADR-006`）：daemon 内嵌 main，renderer 经 preload/IPC
└── test-support    # 测试用 Server 启动器、WS 测试客户端、脚本化 LLM provider
```

## 先决条件

- Node.js LTS（开发环境为 v24）
- pnpm
- Docker（用于 PostgreSQL）
- 可选：`git` / `docker` CLI（`client-daemon` 的对应 Capability 执行时才会用到）

## 运行

```bash
pnpm install

# 启动开发/测试用 PostgreSQL（端口 55432）
docker compose up -d db

# 全部测试（根脚本强制串行：各包共享 adt_test，不能并行）
pnpm test

# 类型检查
pnpm -r --if-present typecheck
```

数据库连接串默认 `postgres://adt:adt@localhost:55432/adt_test`（测试）与 `.../adt`（开发），可用 `TEST_DATABASE_URL` / `DATABASE_URL` 覆盖。

Server 监听端口默认 `8080`，可用 `PORT` 覆盖；非法值（`abc` / `0` / `70000`）会**告警并回落默认**。

**正式运行（部署到内网一台机器）**见 **[`docs/DEPLOY.md`](docs/DEPLOY.md)**：管理员用 `docker compose` 把 Server 常驻（数据持久化、`/health`、优雅退出）、用 `adm` 建账号；工程师装 **`ADT-<版本>-setup.exe`**、首次运行填 Server 地址后登录。

## 桌面客户端（`client-electron`，`ADR-006`）

`packages/client-electron` 是**单体 Electron 应用**：**daemon 跑在 Electron 的 main 进程里**（`ClientDaemon.connect`，与 `client-cli` 同一套库），界面是 renderer，两者之间只走 **preload 的 `contextBridge` IPC**——没有独立进程、没有本地 HTTP、没有令牌/cookie。

```bash
pnpm -C packages/client-electron dev       # 开发（electron-vite 热更）
pnpm -C packages/client-electron build     # 构建 out/{main,preload,renderer}
pnpm -C packages/client-electron smoke     # 探针：Electron 里的 node:sqlite 台账
pnpm -C packages/client-electron run pack  # 打包成单个 Windows portable exe（release/）
pnpm -C packages/client-electron run dist  # 打包成 NSIS 安装包（release/ADT-<版本>-setup.exe）
pnpm -C packages/client-electron test:e2e  # 桌面冒烟：真 Electron + 真 Server，走完一条人在回路
```

- **它做什么**：登录（Server 地址是 `ADT_SERVER_URL`，默认 `ws://127.0.0.1:8080/ws`；工作区 `ADT_WORKSPACE`）→ 提交一次请求 → 看步骤卡 → **四种决策都在卡片上回答**（确认 / 手工动作 / 资源冲突 / 完成候选）→ 看到 `Record`。**关窗 = 最小化到托盘、运行继续**；只有托盘里的"退出"才真正收尾（`ADR-006` §Decision 4）。
- **左栏会话历史**：列出本次会话跑过的对话 **加上** Server 上你**过去的所有 Record**；点开往期对话，用该 Record **重建**出过程（条目时间线）与结论——**不新增存储**（往期是重建，不是当时的可交互界面）。见 `docs/superpowers/specs/2026-10-01-conversation-history-design.md`。
- 台账 / 会话落在 Electron 的 `userData` 目录；**`node:sqlite`** 是唯一实现（Electron 44 = Node 24，内置可用，无需原生模块）。

## 控制台客户端（`client-cli`）

`packages/client-cli` 是 `client-daemon` 的**人类前端**：连着 Server 跑真实 Workflow——收到派发、被问确认 / 建议 / 资源冲突、读 Record·Report、取回 blob、触发 KB 导出。它是 P4 系列人工路径的**手工验收场所**；正式产品 UI 见上面的 `client-electron`。

```bash
# 需要先有一个跑起来的 Server
pnpm -C packages/client-cli start -- --user alice --url ws://127.0.0.1:8080/ws
```

密码优先取 `--secret` 或环境变量 `ADT_SECRET`；都没有时会**不回显**地提示输入——不要把密码写进命令行，`ps` 看得见。

| 命令 | 作用 |
|---|---|
| `:ask <文本>` | 提交一次诊断请求（开始一个 Workflow） |
| `:records` | 列出自己的 Record |
| `:show <record_id>` | 看一条 Record 的完整内容 |
| `:report <record_id> [summary\|full]` | 生成 Report（默认 `full`） |
| `:export <record_id> [record\|report]` | 导出到 KB（默认 `record`） |
| `:blob <content_ref> <path>` | 取回 blob 并写到本地文件（校验 sha256） |
| `:help` / `:quit` | |

**它会执行真实能力**：daemon 的默认注册表全开——`git` / `docker` / `filesystem` / `terminal.execute_command` / `sim_rig.*` 都会在本机真的跑起来（副作用能力仍会先问人）。工作区默认是当前目录，`--workspace` 覆盖。

**安全语义**：确认**绝不默认同意**——解析不出的回答会**重问**，`EOF`（管道结束、没人在键盘前）一律落到**安全默认**（拒绝副作用、资源冲突停下、完成候选不算已解决）。幂等台账与会话默认落在 `.adt/client-cli/`（文件后端），这样断线才能 `resume` 而不重复执行物理动作。

## 可选配置

完整配置项与排障见 **`docs/DEPLOY.md`**；下面是速览。

**LLM 规划（`ADR-004` §2，OpenAI 兼容）**：`LLM_API_KEY` 设置后才启用（未设置回退 no-op 规划器，Workflow 不产生 Step、直接给完成候选）；`LLM_BASE_URL` 默认 `https://api.deepseek.com/v1`；`LLM_MODEL` 默认 `deepseek-flash`；`LLM_MAX_RETRIES` 默认 `2`（上限 `10`，设为 `0` 关闭）。只对 **429 / 5xx / 网络错误**按 500ms→1000ms 退避重试，不重试其它 4xx、自身超时与模型语义错误。

> **思考模式与强制工具调用（`ADR-004` 修订 A3）**：`deepseek-flash` 默认就是思考模式，而思考模式**不接受**强制 `tool_choice`（官方返回 **400**），所以 provider 一律显式发 `thinking:{type:"disabled"}`。换模型/网关后若遇 **`LLM HTTP 400`**，先查这条。真实 LLM 的集成测试用 `describe.skipIf(!process.env.LLM_API_KEY)` 守卫，默认跳过。

**Blob 通道（`PROTOCOL_SPEC.md` §7.5）**：`BLOB_SECRET`（未配置则每次启动随机生成并告警，旧 URL 重启后失效）、`BLOB_BASE_URL`、`BLOB_DATA_DIR`（默认 `.adt/blobs`）、`BLOB_TOKEN_TTL_MS`（默认 15 分钟）、`BLOB_RETENTION_MS`（默认 30 天）、`BLOB_MAX_BYTES`（默认 512 MiB）。数值必须是**整数**，越界会告警并回落默认。

**KB 导出（`ADR-005`）**：`KB_ENDPOINT_URL` / `KB_TOKEN`（**任一缺失即 `export_unavailable`**，绝不假装成功）、`KB_AUTH_HEADER`（默认 `Authorization`）、`KB_AUTH_SCHEME`（默认 `Bearer`，置空则发裸 token）、`KB_TIMEOUT_MS`（默认 `10000`）、`KB_MAX_RETRIES`（默认 `2`）。只对**网络错误 / 超时 / 5xx** 重试，**4xx 不重试**。投递是**同步**的（默认最坏约 31.5s），若其最坏耗时逼近心跳判死阈值（45s），Server 启动时会**告警**。

## 参考

- 产品 / 需求：`docs/PRODUCT.md`、`docs/REQUIREMENTS.md`
- 架构：`docs/architecture/ARCHITECTURE.md`、`CLIENT_SPEC.md`、`SERVER_SPEC.md`
- 契约：`docs/specs/`（`WORKFLOW_SPEC.md`、`CAPABILITY_SPEC.md`、`PROTOCOL_SPEC.md`、`RECORD_SPEC.md`、`REPORT_SPEC.md`）
- 部署与使用：`docs/DEPLOY.md`
- 架构决策：`docs/adr/ADR-001`~`ADR-006`
- MVP 范围：`docs/superpowers/specs/2026-09-29-mvp-scope.md`
- **阶段推进约定：`docs/superpowers/WORKFLOW.md`（先读它：流程、评审裁决表、验证口径、不 push）**
- 实现计划：`docs/superpowers/plans/`（P1 → P4d、单体 Electron）
