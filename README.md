# adt_ai_agent_system

HiL 诊断辅助系统。设计文档在 `docs/`（`PRODUCT.md` → `REQUIREMENTS.md` → `architecture/` → `specs/`，架构决策见 `adr/`）。

## 当前状态

**P1（骨架与协议层）已实现**：TypeScript monorepo、协议信封编解码、认证握手、能力同步、应用层心跳与协议错误处置。Workflow 引擎、Client UI、LLM 规划属于后续计划（P2–P4）。

## 结构

```text
packages/
├── shared          # 协议类型、信封编解码、错误处置矩阵、去重窗口
├── server          # Fastify + ws、认证、会话、能力声明、心跳
├── client-daemon   # 认证连接、能力声明、心跳
└── test-support    # 测试用 Server 启动器与 WS 测试客户端
```

## 先决条件

- Node.js LTS（开发环境为 v24）
- pnpm
- Docker（用于 PostgreSQL）

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

## 参考

- 协议契约：`docs/specs/PROTOCOL_SPEC.md`
- 能力契约：`docs/specs/CAPABILITY_SPEC.md`
- 部署与信任模型：`docs/adr/ADR-003-deployment-and-trust-model.md`
- 技术栈：`docs/adr/ADR-004-tech-stack.md`
- MVP 范围：`docs/superpowers/specs/2026-09-29-mvp-scope.md`
- P1 实现计划：`docs/superpowers/plans/2026-09-30-p1-skeleton-and-protocol.md`
