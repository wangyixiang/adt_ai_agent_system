# adt_ai_agent_system

HiL 诊断辅助系统。设计文档在 `docs/`（`PRODUCT.md` → `REQUIREMENTS.md` → `architecture/` → `specs/`，架构决策见 `adr/`）。

## 当前状态

已实现到 **D4+D5（超时语义 + LLM 有界重试）**：

- **P1 骨架与协议层**：TypeScript monorepo、协议信封编解码、认证握手、能力同步、应用层心跳与协议错误处置。
- **P2a Workflow 引擎与持久化**：Step/Workflow 状态机（含 `UNKNOWN` 与终态不可变）、取消与 `CANCELLING` 收敛、终止护栏、`completion_criteria`、PostgreSQL 三表 + `WorkflowStore`、孤儿回收、重启恢复。
- **P2b Record / Report 与协议接线**：Evidence 入事件日志、Record 构建/持久化/查询（按 owner 过滤）、定型服务（先落盘后通知）、Report 生成、`workflow.*` / `step.*` / `record.*` / `report.*` 协议接线。
- **P2c 协议一致性与重连**：`ERROR_DISPOSITION` 驱动错误处置、逻辑会话（去重窗口跨重连、TTL）、`session.resume` + `workflow.state_sync`、孤儿回收接进会话生命周期。
- **P3a 服务端只读闭环**：`LlmProvider` 抽象 + OpenAI 兼容实现 + `LlmPlanner`、受限子集 JSON Schema 校验器、`step.dispatch.input` 与 `evidence.result` 双向校验、规划器产出/修订 `completion_criteria`、`client_request_id` 幂等。
- **P3b client-daemon 只读闭环**：客户端自有的 Capability 声明（`CapabilityRegistry`）、可插拔适配器（`git.collect_diagnostics` / `filesystem.read_file` / `docker.inspect_container` + 占位能力）、工作区约束与子进程超时、`step.dispatch` → `step.status` 执行链路。
- **P4a 受控执行与 `UNKNOWN` 对账**：
  - **受控执行**：`requires_confirmation` 的副作用 Step 绝不自动执行——Client 先 `WAITING(user_confirmation)`，由宿主回调决定，拒绝走 `REJECTED(user_declined)`；`side_effect` 且未要求确认的 Step 仍被本地拦下（防御 Server 漏标）。新增副作用能力 `terminal.execute_command`、`sim_rig.trigger_reset`，以及只读对账伴随能力 `sim_rig.query_state`。
  - **建议路径**：`human.manual_action` 由 daemon 拦截，展示 `instruction` 并把工程师反馈包装为 `evidence(source=user_input, type=manual_action_result)`；Server 侧把该保留能力补进"规划器可选能力"，否则规划器永远不会提议它。
  - **`UNKNOWN` 对账**：Step 超时只读 → `FAILED(timeout)`、副作用 → `UNKNOWN`（人类等待豁免，重复 `RUNNING`/`progress` 视为保活、重置计时器），`StepTimeoutMonitor` 扫描并在超时后推进 Workflow；对账裁定由 Planner 产出（`PlannerDecision.reconcile`，LLM 侧有 `action=reconcile` 工具且必须给出 `evidence_refs`），Engine 只落在确定性规则上。存在未对账 `UNKNOWN` 时**禁止再下发副作用 Step**（`WORKFLOW_SPEC.md` §4.3：规划器连副作用能力都看不到，Engine 再兜一层）。State 机补齐 `WAITING → REJECTED`、`PENDING → UNKNOWN` 两条 spec 边。
  - **幂等台账**：Server 为副作用 Step 生成 Workflow 内稳定 `idempotency_key`；Client 用 `node:sqlite` 持久化「键 → 结果」，重连重发同一 Step 直接回放、不重复执行。
  - **Record 忠实性**：`guardrail_triggered.ref.threshold` 带出配置阈值；工程师输入记为 `user_input` 条目；`reconciliation_resolved.ref.evidence_refs` 落盘。
- **P4b 资源冲突如实上报与终结**：资源是否被占用**只有能力提供方知道**，因此由它判断并如实上报，Server 不仲裁、不排队、不建资源模型。提供方报 `resource_conflict` → 客户端先发 `WAITING`（人类等待，不被 `step_timeout` 杀掉）并问工程师：**能腾出资源就让 Workflow 继续（不留痕）**；**腾不出就报 `REJECTED(resource_conflict)`**，Server 不再重规划，Workflow 终止为 `FAILED` + `terminal_reason = resource_conflict`，Record 用提供方的话说明"设备/资源被占用"。
- **P4c blob 通道**：大体积/二进制证据（日志、截图）不进正文类消息，走**申请制**的独立通道。`blob.allocate_request/response` 换一条带 **HMAC 签名令牌**的 URL（服务端无会话态，重启后旧 URL 仍有效，`BLOB_SECRET` 未配置则每启动随机并告警），`PUT`/`GET /blob/:contentRef` **流式**收发并**边收边校验** size/sha256（不符则失败且不提交）；`LocalBlobStore` 按 sha256 **内容寻址**落本地 FS，元数据在 `blobs` 表；过期**只回收没有被任何 Record 引用的 blob**——Record 不可变，它引用过的证据必须仍能取回。默认：单 blob 512 MiB、令牌 15 分钟、保留期 30 天、白名单 9 种媒体类型；内联阈值 64 KiB **只登记不强制**。
- **P4 收口（重连恢复 + 清单 `output_type` + 墙钟）**——对齐审计补上的三处缺口：
  - **断线恢复（NFR-3 的客户端半边）**：daemon 持久化逻辑会话，重连先试 `session.resume`（被拒则在新连接上回落 `session.hello`），并按 `workflow.state_sync` 的 `pending_step` 继续未完成的 Step；`state_sync` 带回 `heartbeat_interval_ms`。
  - **台账三态**：未见过 / **执行中** / 已完成。重连后重发一个"当时正在执行"的副作用 Step，**不得静默重执行**——报 `UNKNOWN` 等 Server 对账（`WORKFLOW_SPEC.md` §4.3）；台账不持久时**拒绝 resume**（否则会重复执行物理动作）。
  - **`evidence.type` 校验**：Manifest 携带 `output_type`，Server 在**派发时**快照为 Step 的 `expected_output`，`COMPLETED` 时核对；不符或缺失 → `FAILED(invalid_output)`。
  - **时间基准**：会被人读、且跨重启成立的结论性时间（`created_at`/`ended_at`、`duration_ms`、`record.list` 的时间过滤）一律**墙钟**；事件的 `ts` 按 `PROTOCOL_SPEC.md` §2 保持**单调**、排序按插入顺序。
- **D4+D5（超时语义 + LLM 有界重试）**：
  - **超时两端一套词**：副作用超时（服务端 `step_timeout` 到点，或客户端在本地掐掉）一律 `UNKNOWN`——它可能已部分生效；**只读**才是 `FAILED(timeout)`。服务端 `step_timeout` 在能力的 `timeout_hint` 之上叠 **2s 宽限**，让客户端的观察先到。
  - **LLM 有界重试**（`ADR-004` 修订 A2）：只对 429 / 5xx / 网络错误按 500ms→1000ms 退避重试（`LLM_MAX_RETRIES`，默认 2），**不重试**其它 4xx、自身超时与模型语义错误；终局仍是 `planner_error`。
- **P4d KB 导出（`ADR-005` 出站）**：提交人显式把一条 Record（默认）或 Report 投递到**配置的 KB 端点**，同步拿到结论。投递包由纯函数生成（`deposit_version` / 稳定 `deposit_id = hash(record_id, object, content_sha256)` / `content_sha256` / 墙钟 `submitted_at` / `content`）；`object=report` 时**只投 Report、不夹带 Record**。出站是 `KnowledgeDepositor` 接缝 + HTTP 实现：`POST` + 配置的鉴权头 + 超时，**网络错误 / 超时 / 5xx 有限重试（默认 2 次，指数退避），4xx 不重试**；**未配置端点或凭据 → `export_unavailable`**（绝不假装成功）。导出**不改 Record**、**不影响 Workflow 状态**。**blob 引用不随导出解析**（KB 只拿到引用，见 `ADR-005` §7）。

后续：**D7（b）`client-cli`** 控制台客户端（确认 / 建议 / 资源冲突询问 / Record·Report 阅读 / blob 取回 / 触发导出），它同时是手工验收的场所。正式 Client UI 尚未开始。

## 结构

```text
packages/
├── shared          # 协议类型、信封编解码、错误处置矩阵、去重窗口、受限子集 JSON Schema 校验器、blob 协议类型
├── server          # Fastify + ws、认证、会话与重连、Workflow 引擎、Record/Report、LLM 规划器、blob 通道、KB 导出出站
├── client-daemon   # 连接/握手/能力声明/心跳 + 可插拔 Capability 适配器（只读 + 受控副作用）、幂等台账、blob 收发
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
- `LLM_MAX_RETRIES`：默认 `2`（最多 3 次尝试），上限 `10`（超出会**告警**并按默认值处理）。只对 **429 / 5xx / 网络错误**重试，退避 500ms / 1000ms；**不重试**其它 4xx、我们自己的超时、以及模型语义错误（工具调用不合法）。设为 `0` 可关闭。**最坏耗时 = `timeoutMs × (maxRetries + 1)` + 退避总和**（默认约 93s）——每次尝试各有独立的 `timeoutMs` 窗口；而"挂死"（自身超时）不重试，只花一个窗口。

真实 LLM 的集成测试用 `describe.skipIf(!process.env.LLM_API_KEY)` 守卫，默认跳过。

### KB 导出（可选，`ADR-005`）

Server 通过环境变量启用"把 Record/Report 导出到第三方 Knowledge Base"的出站：

- `KB_ENDPOINT_URL`：KB 接收端点；**与 `KB_TOKEN` 任一缺失/为空即导出不可用**（`record.export_result` 回 `export_unavailable`，不会退化成"发到某个默认地址"）。
- `KB_TOKEN`：凭据；**只保存在 Server 端**，不下发 Client、不写入 Record、也不出现在失败信息里。
- `KB_AUTH_HEADER`：默认 `Authorization`。
- `KB_AUTH_SCHEME`：默认 `Bearer`（即 `Authorization: Bearer <token>`）；**置空则发裸 token**，适配 `X-API-Key` 这类自定义头。
- `KB_TIMEOUT_MS`：默认 `10000`。
- `KB_MAX_RETRIES`：默认 `2`，上限 `10`（超出会**告警**并按默认值处理）。只对**网络错误 / 超时 / 5xx**重试，退避 500ms→1000ms；**4xx 不重试**——`ADR-005` §5 只列了 5xx（`429` 也是 4xx，因此**不重试**；这与 LLM 侧的 `ADR-004` 修订 A2 **故意不同**）。**最坏耗时 = `timeoutMs × (maxRetries + 1)` + 退避总和**（默认约 31.5s）——投递是**同步**的，这段时间该客户端连接上的其它消息（**含心跳**）会排队（`ADR-005` §4）。默认心跳判死阈值是 45s（15s × 3），所以默认配置安全；若把 `KB_TIMEOUT_MS` 调大到让最坏耗时逼近该阈值，导出期间的心跳会被饿死、会话可能被判失联——Server 启动时会就此**告警**。

## 参考

- 产品 / 需求：`docs/PRODUCT.md`、`docs/REQUIREMENTS.md`
- 架构：`docs/architecture/ARCHITECTURE.md`、`CLIENT_SPEC.md`、`SERVER_SPEC.md`
- 契约：`docs/specs/`（`WORKFLOW_SPEC.md`、`CAPABILITY_SPEC.md`、`PROTOCOL_SPEC.md`、`RECORD_SPEC.md`、`REPORT_SPEC.md`）
- 架构决策：`docs/adr/ADR-001`~`ADR-005`
- MVP 范围：`docs/superpowers/specs/2026-09-29-mvp-scope.md`
- **阶段推进约定：`docs/superpowers/WORKFLOW.md`（先读它：流程、评审裁决表、验证口径、不 push）**
- 实现计划：`docs/superpowers/plans/`（P1 → P4c）
