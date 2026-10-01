# 部署与使用（正式化：搭建 / 供给 / 分发）设计

- **日期:** 2026-10-01
- **状态:** 待评审（批准后据此写实施计划）
- **层级:** Design — 产品的**部署形态**与**运维供给**（Server + Client），跨 `packages/server` / `packages/client-electron` / 仓库根
- **关联:** `ADR-003`（部署与信任模型：实验室内网、Server 自建本地账号、**无自助注册**、TLS 延后）、`ADR-006`（单体 Electron）、`ADR-004`（技术栈）、`docs/architecture/ARCHITECTURE.md` §6（部署视图）、`WORKFLOW.md`（一阶段一份计划）、`packages/server` 与 `packages/client-electron` 现状

---

## 1. 目标与判断标准

把"能跑"变成"能**正式**搭起来、发出去、长期用"：一位管理员能在一台内网机器上**按文档**把 Server 起成常驻服务并**建账号**；一位工程师能**装一个安装包**、在首次运行时填好 Server 地址，然后登录使用。

判断标准：
- **Server**：`docker compose up -d` 之后，`GET /health` 通、`adm user add alice` 建号成功、`docker compose down` 能优雅退出、重启后数据还在。
- **Client**：产出一个 **NSIS 安装包**，装完后**首次运行弹出设置页**填 Server 地址，填对即能登录；地址可再次修改。
- **全程不需要**任何"临时文件塞数据库"式的权宜手段。

## 2. 已锁定的决定（本轮讨论）

1. **形态 = A + B + C**：命令式搭建 **+** 可分发安装包 **+** Docker Compose 常驻。
2. **账号供给 = 运维 CLI**（`adm user add/list/passwd/disable/enable`）；**无自助注册**（`ADR-003`）。
3. **Server 常驻 = 整套 Docker Compose**（`app` + `Postgres`，`restart: unless-stopped`，日志走 `docker logs`）。
4. **客户端分发 = NSIS 安装包**（图标/开始菜单/卸载）；**不签名、不自动更新**（文档说明 SmartScreen）。
5. **客户端连哪里 = 首次运行设置页**（记住 Server 地址 + 可选工作区，之后可改）。
6. **Docker 里跑源码 `tsx`**（Server 目前无 build 步骤，加编译属另一件事）。
7. **NSIS 默认 per-user 安装**（无需管理员）。
8. **`adm` 口令默认交互式不回显**（`--secret` / `ADT_SECRET` 可注入，不鼓励写进 argv）。

## 3. 范围

三块**相互独立**的子系统，按 `WORKFLOW.md §1` 各自成计划：

| 计划 | 内容 |
|---|---|
| **P-server-ops** | Server 配置装载 + 优雅退出 + `adm` 账号 CLI + `docs/DEPLOY.md` 的 Server 半边 |
| **P-client-config** | 首次运行设置页 + 配置持久化（在 dev 下即可用） |
| **P-client-packaging** | NSIS 安装包 + 图标/版本（依赖 P-client-config 才有"装给人用"的完整闭环）+ 安装文档 |

## 4. Server 供给与运维（P-server-ops）

### 4.1 配置装载

- 新增 `packages/server/src/config.ts`：一份**解析后的配置**，覆盖 port/host/databaseUrl/LLM/blob/KB/心跳等现有 `*FromEnv` 输入。
- **`.env` 支持**：用 Node 24 内置的 `process.loadEnvFile(path)` **尽力加载**仓库根 `.env`（文件不存在就跳过），**不引入 `dotenv`**。语义：**真实环境变量优先**，`.env` 只填补未设置的值（容器里由 `environment`/`env_file` 注入，行为一致）。
- `start()` 与 `adm` 共用该配置（同一套默认值，避免"CLI 与 Server 连的库不一致"）。
- 启动时打印**脱敏摘要**（数据库主机、端口、LLM 是否启用、KB 是否配置、blob 目录）——**绝不打印 secret**。

### 4.2 优雅退出

- `packages/server/src/index.ts` 的 `isMain` 分支注册 `SIGTERM` / `SIGINT`：`await running.close()` 后 `process.exit(0)`；**第二次信号**立即强退（防止挂死）。`close()` 已停 `StepTimeoutMonitor` / `SessionLifecycle`、关 http、`pool.end()`。
- 这不是"锦上添花"：Docker `stop` 发 `SIGTERM`，没有它就只能等 `SIGKILL`。

### 4.3 账号运维 CLI（`adm`）

- 新增 `packages/server/src/cli/adm.ts` + `packages/server/package.json` 的 `"adm": "tsx src/cli/adm.ts"`。
- 子命令与行为：
  - `user add <username> [--secret <s>]`：建号；缺 `--secret`/`ADT_SECRET` 时**不回显提示**输入。幂等 upsert（已存在则报"已存在"，除非 `--force` 重置口令——最终形态由计划定）。
  - `user list`：列出用户名与 `disabled` 状态（**不含 hash**）。
  - `user passwd <username> [--secret <s>]`：改口令。
  - `user disable|enable <username>`：启停账号（登录被拒）。
- 退出码：成功 `0`、用法错 `2`、运行错 `1`。
- 依赖 `UserRepository` 补方法：`list()`、`setDisabled(username, disabled)`、`changePassword(username, secret)`（`create` 的 upsert 已可复用）。
- **不用 SQL 手工建号**：口令是 argon2，SQL 里写不出来——这正是本 CLI 存在的理由。

### 4.4 Docker Compose（常驻）

- 新增 `docker/server.Dockerfile`：Node 24 基础镜像 + pnpm，安装依赖后运行 `tsx src/index.ts`（**含 devDependencies**——`tsx` 在 devDeps；这是一处**刻意的取舍**，见 §11 风险）。
- `docker-compose.yml` 增 `server` 服务：`build` 指向该 Dockerfile、`depends_on: db (healthy)`、`env_file: .env`、`ports: "8080:8080"`、`restart: unless-stopped`、blob 目录用命名卷、`healthcheck` 打 `GET /health`。
- **给 `db` 补 `pgdata` 命名卷**：现状只有 `initdb` 只读挂载，**数据是易失的**——正式部署必须持久化。
- 附 `.env.example`（列出所有可配变量与用途，**不含真实密钥**）。

### 4.5 健康与迁移

- `/health` 已存在（`http/app.ts`）；compose 的 `healthcheck` 与文档都用它。
- 迁移仍在 `start()` 里自动跑（保持现状；幂等）。

## 5. 客户端配置（P-client-config）

- **首次运行设置页**：登录前，若 `userData/config.json` 不存在或 `serverUrl` 为空 → 显示设置页。字段：
  - `Server 地址`（默认 `ws://127.0.0.1:8080/ws`；**必填**、需通过基本格式校验）。
  - `工作区`（可选；作为 `workspaceRoot` 传给 daemon 的能力执行）。
- **持久化**：main 侧读写 `join(app.getPath("userData"), "config.json")`；新增 IPC `config_get` / `config_set`（renderer 不碰文件系统）。
- **生效**：`session` 用配置里的 `serverUrl` / `workspaceRoot`（**优先于** `ADT_SERVER_URL` / `ADT_WORKSPACE` 环境变量；env 作为未配置时的兜底，便于开发）。
- **可改**：登录后从"设置"入口再次修改；改地址后需重新登录（连接按新地址重建）。
- 设置页与既有"登录页"同风格（DOM + className，不引样式框架）。

## 6. 客户端分发（P-client-packaging）

- `electron-builder.yml` 增 `nsis` target（`oneClick: false` 否由计划定；默认 **per-user** 安装）、开始菜单项、卸载入口、`win.icon`。
- `packages/client-electron/package.json` 给一个**真实版本**（如 `0.1.0`），产物按 `ADT-<version>-setup.exe` 命名。
- 保留 `pack`（portable）；新增 `dist`（NSIS）脚本。
- **图标**：先放入一个占位 `build/icon.ico`（正式图标由提供方替换）。
- **不签名、不自动更新**（`ADR-006` §Consequences 里列过，本次明确不做）；文档说明未签名会被 SmartScreen 警告、如何继续。
- **历史风险**：本机 `rcedit` 曾写 exe 失败 → `signAndEditExecutable:false`。要让图标/元数据真正写进 exe，计划里必须**先解决/绕过它**（若环境确实不行，退路是：安装包仍产出，但 exe 不带自定义图标——作为**明确记录的降级**，不留哑雷）。

## 7. 文档

- 新增 **`docs/DEPLOY.md`**：Server 部署（`docker compose up -d` + `.env` + `adm` 建号 + `docker logs`/`/health` 排障）、Client 安装（NSIS + 首次设置页 + 未签名提示 + 卸载）、常见问题（`BLOB_SECRET` 未配置、LLM 未配置 → no-op 规划器）。
- `README.md` 增"正式运行"小节，指向 `docs/DEPLOY.md`；保留现有"开发运行"。
- 若 `ARCHITECTURE.md` §6 与实现有出入，同步之。

## 8. 测试策略

- **P-server-ops**：
  - `config.ts` 单测：`.env` 填补、**真实 env 优先**、缺文件不报错、默认值正确。
  - `adm`：`user add/list/passwd/disable` 对**真实 DB** 的行为（真 `UserRepository`；`list` 不含 hash；`disable` 后 `verifyCredentials` 拒绝）；用法错退出码 2。
  - 优雅退出：`start()` 后触发关闭路径，断言 `pool` 已关、监听已停（可在 Node 层直接调 `close()` 断言幂等）。
  - compose：**不在 CI 跑**，用文档化的手工验收（`docker compose up -d` → `/health` → `adm user add` → `docker compose down` 后数据仍在）。
- **P-client-config**：`config` 读写纯逻辑单测；设置页组件测（填地址→保存→`config_set` 被调用）；renderer 首启门（未配置显示设置页）；session 使用配置值（main 层单测）。
- **P-client-packaging**：**出口 = 打包冒烟**（同 `client-electron` 现有出口）：`pnpm -C packages/client-electron run dist` 产出 `ADT-*-setup.exe`，启动它（或解出的 portable）能起来。
- **验证口径**：`pnpm -r --if-present test`（串行）+ `typecheck` + `client-electron build`；打包冒烟按各计划写明的出口。

## 9. 明确不做（本设计范围外）

- **TLS**（`ADR-003` 延后；传输加密属传输层，后加不改应用层协议）。
- **代码签名 / 自动更新**（需证书与更新源，`ADR-006` 已列）。
- **多租户 / 审计 / 完整角色 / SSO 联邦**（`ADR-003` §Rejected）。
- **跨网 / 云部署**、**自助注册**、**共享测试台资源模型**。
- 把 Server 编译成产物（保持 `tsx` 运行）。

## 10. 规格影响

| 文档 | 需要的变化 |
|---|---|
| `ARCHITECTURE.md` §6（部署视图） | 若与"compose 常驻 + `adm` 建号"的实际形态有出入则同步（预计小改） |
| `ADR-003` | **不改**（本设计与之一致：内网、本地账号、无自助注册、TLS 延后） |
| `REQUIREMENTS.md` §7 | 预计只需在"待建文档"表里把 `docs/DEPLOY.md` 记为已产出（若有该行） |
| `specs/*`（协议/能力/Record/Report） | **不改**（本设计不触协议面） |

## 11. 依赖、风险与取舍

- **Docker 镜像含 devDependencies**：为了跑 `tsx`。取舍：镜像更大、依赖面更宽；换来"不加 build 步骤"。**若日后要瘦身**，再为 Server 加 `tsc` 编译产物——那是独立的一件事。
- **`rcedit` 环境问题**（§6）：可能挡住图标写入，需要计划内先验证；退路已写明。
- **`.env` 语义**：必须"真实 env 优先"，否则容器注入会被仓库里的 `.env` 覆盖——这是个**安全相关**的默认，计划里要有测试钉住。
- **IP/端口**：`ADR-003` 决定内网；`BLOB_BASE_URL` 在容器里要配成**其它机器可达**的地址，否则别的工程师取不回 blob（文档要写清）。
- **账号口令**：CLI 不回显、不进 argv（可被 `ps` 看见）、不进日志。
