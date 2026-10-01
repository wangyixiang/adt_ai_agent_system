# DEPLOY.md — 部署与运维（Server）

面向**实验室内网的一台机器**：用 Docker Compose 把 Server 常驻起来、建好账号，供多位工程师的 Client 连接。
架构与信任模型见 `adr/ADR-003-deployment-and-trust-model.md`；本设计见 `superpowers/specs/2026-10-01-deployment-and-provisioning-design.md`。

## 先决条件

- Docker（含 `docker compose`）。
- 一个**内网可达**的地址（其它工程师能访问这台机器），例如 `192.168.0.10`。

## 快速开始

```bash
# 1) 配置：真实环境变量优先于 .env；.env 只填补未设置的值。
cp .env.example .env
#    至少要改：
#      BLOB_SECRET      —— 一段长随机串（否则每次重启随机生成、旧 blob URL 失效）
#      BLOB_BASE_URL    —— 改成这台机器的内网地址，例如 http://192.168.0.10:8080
#    按需：
#      LLM_API_KEY      —— 不设则用 no-op 规划器（Workflow 不产出 Step，只给完成候选）
#      KB_ENDPOINT_URL / KB_TOKEN —— 都设才启用 KB 导出

# 2) 起服务（首次会构建镜像，较慢）
docker compose up -d --build

# 3) 健康检查
curl -i http://127.0.0.1:8080/health        # 期望 200

# 4) 建第一个账号（口令交互输入、不回显）
docker compose exec server pnpm --silent -C packages/server adm user add alice
```

`.env` 里的 `DATABASE_URL` 默认是 `postgres://adt:adt@db:5432/adt`——**容器网络里数据库的主机名是 compose 服务名 `db`**，不是 `localhost`。

> 仓库根的 `.env` 会被 **Server 与 `adm` 都读取**（真实环境变量优先）。这带来一个必须注意的差别：**compose 用 `db`，宿主上用 `localhost`**。同一份 `.env` 两者不能通用——在宿主上开发时不要 `cp` 这份 compose 版 `.env`（或把 `DATABASE_URL` 改成 `postgres://adt:adt@localhost:55432/adt`）。

## 账号管理（`adm`）

在宿主上跑 `docker compose exec server pnpm --silent -C packages/server adm <子命令>`（`--silent` 很关键：否则 pnpm 会把整条命令——包括 `--secret` 的值——回显到 stderr）：

| 命令 | 作用 |
|---|---|
| `user add <name> [--secret <s>] [--force]` | 建号。已存在会报错（不静默重置）；`--force` 或 `user passwd` 才改口令 |
| `user list` | 列出用户名与状态（**不含口令哈希**） |
| `user passwd <name> [--secret <s>]` | 改口令 |
| `user disable <name>` / `user enable <name>` | 停用/启用（停用后无法登录） |

**口令安全**：默认**交互式不回显**读入；`ADT_SECRET` 或 `--secret` 可注入。用 `--secret` 时**务必配合 `--silent`**（pnpm 会把命令行回显，`--secret` 的值因此可能进终端/日志）；更稳妥的是用 `ADT_SECRET`。口令**不会**出现在 Server 的任何输出或日志里。直接往库里写 SQL 是行不通的——口令是 argon2 哈希，这正是 `adm` 存在的理由。

## 配置项（`.env`）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 容器内用 `...@db:5432/adt`；宿主开发用 `...@localhost:55432/adt` |
| `PORT` | 监听端口，默认 `8080` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_MAX_RETRIES` | 真实 LLM 规划；未设 `LLM_API_KEY` 即 no-op 规划器 |
| `BLOB_SECRET` | blob 签名密钥；未设则每次启动随机并告警 |
| `BLOB_BASE_URL` | 签名 URL 的基地址；**必须内网可达**，否则别的工程师取不回 blob |
| `BLOB_DATA_DIR` | blob 落盘目录（compose 里挂到命名卷 `blobs`） |
| `KB_ENDPOINT_URL` / `KB_TOKEN` / `KB_AUTH_HEADER` / `KB_AUTH_SCHEME` | KB 导出；前两者缺一即导出不可用 |

数值类变量（`PORT`、`BLOB_*`、`KB_*`、`LLM_MAX_RETRIES` 等）必须是整数；不可用或超上限的值会**告警并回落默认**。

## 运维

```bash
docker compose logs -f server          # 日志（含启动时的脱敏配置摘要）
docker compose restart server          # 重启
docker compose down                    # 停止（保留数据卷）
docker compose down -v                 # 停止并删除数据卷（会丢库与 blob，慎用）
docker compose up -d --build           # 升级：重建镜像并滚动重启
```

- **数据持久化**：Postgres 数据在命名卷 `pgdata`，blob 在 `blobs`。`docker compose down`（**不带 `-v`**）不会删。
- **迁移**：Server 启动时自动跑（幂等）；无需手工步骤，`pnpm -C packages/server migrate` 亦可。
- **优雅退出**：`docker compose stop`/`down` 发 `SIGTERM`，Server 会关闭监听、停后台任务、关连接池再退出。
- **备份**：`docker compose exec -T db pg_dump -U adt adt > backup.sql`。

## 排障

| 现象 | 处理 |
|---|---|
| 客户端连不上 | `curl http://<host>:8080/health`；确认 `BLOB_BASE_URL`/防火墙/端口映射 |
| Workflow 没有 Step、直接给完成候选 | 正常——没配 `LLM_API_KEY`，用的是 no-op 规划器 |
| 启动日志提示 `BLOB_SECRET is not set` | 配一个稳定的 `BLOB_SECRET`，否则重启后旧 blob URL 失效 |
| 别的工程师取不回附件/证据 blob | `BLOB_BASE_URL` 还指向 `127.0.0.1`——改成这台机器的内网地址 |
| 导出回 `export_unavailable` | 未配 `KB_ENDPOINT_URL`/`KB_TOKEN`，或只配了其一 |

## 客户端

Server 就绪后，工程师侧的 Client 连接方式：

- **开发/自用**：`ADT_SERVER_URL=ws://<host>:8080/ws pnpm -C packages/client-electron dev`（或 `pnpm -C packages/client-cli start -- --user <name> --url ws://<host>:8080/ws`）。
- **安装包**：随客户端分发（NSIS）与首次运行设置页一起落地后，这里补"安装 → 首次填 Server 地址 → 登录"的完整步骤。

## 安全说明

- Server 面向**实验室内网**、**不暴露公网**；**传输加密（TLS）本版本未启用**（`ADR-003` §4）——内网受信是前提。
- 账号是 Server **自建本地账号**，**无自助注册**；建号走 `adm`。
- 客户端安装包**未做代码签名**（Windows 可能弹 SmartScreen 警告，选"仍要运行"）；也**不含自动更新**。
