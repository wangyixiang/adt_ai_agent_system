# adt_ai_agent_system

HiL 诊断辅助系统。设计文档在 `docs/`（`PRODUCT.md` → `REQUIREMENTS.md` → `architecture/` → `specs/`，架构决策见 `adr/`）。

## 当前状态

已实现到 **P3b（client-daemon 只读闭环）**：

- **P1 骨架与协议层**：TypeScript monorepo、协议信封编解码、认证握手、能力同步、应用层心跳与协议错误处置。
- **P2a Workflow 引擎与持久化**：Step/Workflow 状态机（含 `UNKNOWN` 与终态不可变）、取消与 `CANCELLING` 收敛、终止护栏、`completion_criteria`、PostgreSQL 三表 + `WorkflowStore`、孤儿回收、重启恢复。
- **P2b Record / Report 与协议接线**：Evidence 入事件日志、Record 构建/持久化/查询（按 owner 过滤）、定型服务（先落盘后通知）、Report 生成、`workflow.*` / `step.*` / `record.*` / `report.*` 协议接线。
- **P2c 协议一致性与重连**：`ERROR_DISPOSITION` 驱动错误处置、逻辑会话（去重窗口跨重连、TTL）、`session.resume` + `workflow.state_sync`、孤儿回收接进会话生命周期。
- **P3a 服务端只读闭环**：`LlmProvider` 抽象 + OpenAI 兼容实现 + `LlmPlanner`、受限子集 JSON Schema 校验器、`step.dispatch.input` 与 `evidence.result` 双向校验、规划器产出/修订 `completion_criteria`、`client_request_id` 幂等。
- **P3b client-daemon 只读闭环**：客户端自有的 Capability 声明（`CapabilityRegistry`）、可插拔适配器（`git.collect_diagnostics` / `filesystem.read_file` / `docker.inspect_container` + 占位能力）、工作区约束与子进程超时、`step.dispatch` → `step.status` 执行链路。

后续：**P4**（受控执行确认 / `UNKNOWN` 对账编排 / blob 通道 / KB 导出）。Client UI 尚未开始。

## 结构

```text
packages/
├── shared          # 协议类型、信封编解码、错误处置矩阵、去重窗口、受限子集 JSON Schema 校验器
├── server          # Fastify + ws、认证、会话与重连、Workflow 引擎、Record/Report、LLM 规划器
├── client-daemon   # 连接/握手/能力声明/心跳 + 可插拔 Capability 适配器（只读执行）
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

# 全部测试
pnpm -r --if-present test

# 类型检查
pnpm -r --if-present typecheck
```

数据库连接串默认 `postgres://adt:adt@localhost:55432/adt_test`（测试）与 `.../adt`（开发），可用 `TEST_DATABASE_URL` / `DATABASE_URL` 覆盖。

### LLM 规划（可选）

Server 通过环境变量启用真实的 LLM 规划器（`ADR-004` §2，OpenAI 兼容）：

- `LLM_API_KEY`：设置后才启用；未设置时回退为 no-op 规划器（Workflow 不会产生 Step，直接给完成候选）。
- `LLM_BASE_URL`：默认 `https://api.deepseek.com/v1`。
- `LLM_MODEL`：默认 `deepseek-v4.1-flash`。

真实 LLM 的集成测试用 `describe.skipIf(!process.env.LLM_API_KEY)` 守卫，默认跳过。

## 参考

- 产品 / 需求：`docs/PRODUCT.md`、`docs/REQUIREMENTS.md`
- 架构：`docs/architecture/ARCHITECTURE.md`、`CLIENT_SPEC.md`、`SERVER_SPEC.md`
- 契约：`docs/specs/`（`WORKFLOW_SPEC.md`、`CAPABILITY_SPEC.md`、`PROTOCOL_SPEC.md`、`RECORD_SPEC.md`、`REPORT_SPEC.md`）
- 架构决策：`docs/adr/ADR-001`~`ADR-005`
- MVP 范围：`docs/superpowers/specs/2026-09-29-mvp-scope.md`
- 实现计划：`docs/superpowers/plans/`（P1 → P3b）
