# ADR-005: 第三方 Knowledge Base 集成契约（导出半边）

- **Status:** ACCEPTED
- **日期:** 2026-09-30
- **关联:** `ADR-003` §6、`REQUIREMENTS.md` FR-23 / FR-24、`PROTOCOL_SPEC.md` §10.3、`RECORD_SPEC.md` §8、`REPORT_SPEC.md`、`SERVER_SPEC.md` §4、`CAPABILITY_SPEC.md` §7-3、MVP 范围说明 §4
- **来源:** MVP 设计前置之一——定义与第三方 Knowledge Base 的集成契约

---

## Context

`ADR-003` §6 与 MVP 范围 §4 已定：提交人可显式把 **Record（默认）或 Report** 导出/沉淀到第三方 Knowledge Base；**KB 的接收与审核在对方系统内**，本系统**不追踪审核状态**。`PROTOCOL_SPEC.md` §10.3 已经固定了 Client-Server 这一侧的最小协议面（`record.export_request` / `record.export_result`）。

但还缺**出站这一半的契约**：Server 究竟往 KB 发什么、怎么发、怎么鉴权、失败了怎么办。同时 `FR-23`（把 KB 检索作为诊断辅助输入，P1）尚未设计，但需要一个明确的接口位置，避免以后和导出混在一起。

目标 KB 系统**尚未确定**，因此本 ADR 的目标是**定契约**，不是对接某个具体后端。这与 Windows 产品接入（`ADR-004` 开放前置项）的处理方式一致。

---

## Decision

### 1. 范围

* 本版本实现**导出半边**（本系统 → KB）。
* **实现状态（2026-09-30；同日 P4d 更新）：** 出站半边**已实现**。`record.export_request` 由 Server 处理：按 `object` 取 Record（可见性同 `PROTOCOL_SPEC.md` §10）或据其生成 Report，构造 §3 的投递包，向配置的 KB 端点 `POST`，把结果映射回 `record.export_result`。配置见 §2，失败与重试见 §5，**本阶段明确不做**的事见 §7。
* 只定义**投递契约**与抽象接口；具体 KB 后端在确定后按其接口补充一份 KB 集成 Spec。
* `FR-23`（KB 检索）只做**接口预留**，不在本版本实现。

### 2. 传输与鉴权

* Server 向**配置的 KB 接收端点**发起 `POST`（HTTP/HTTPS）。
* 鉴权方式由配置决定，至少支持：`Authorization: Bearer <token>` 或自定义 API key header。
* **凭据只保存在 Server 端**，不下发到 Client，也不写入 Record。
* KB 端点与凭据通过 Server 配置（环境变量 / 配置文件）；**未配置时导出不可用**（返回 `export_unavailable`）。

### 3. 投递包（deposit payload）

```text
deposit
├── deposit_version   "1"
├── deposit_id        稳定去重键 = hash(record_id, object, content_sha256)
├── source            "adt_ai_agent_system"
├── record_id
├── workflow_id
├── owner_user_id
├── object            "record" | "report"
├── spec_versions     仅 object=record 时携带（见 RECORD_SPEC.md §6）
├── content_sha256    内容摘要，供 KB 去重与校验
├── submitted_at      UTC
└── content           object=record → RECORD_SPEC.md §3 的成品文档
                      object=report → { "format": "markdown", "content": "..." }
```

* **严格按用户选择**：`object=report` 时**只**投递 Report，**不**附带 Record——用户选择导出 Report 可能是刻意不暴露原始 Evidence（日志）。
* `deposit_id` 稳定生成，KB 可据此去重；**重复导出允许**（Record 只读，内容不变则 `deposit_id` 不变）。

### 4. 投递语义

* **同步投递**：Server 在 `record.export_request` 的处理过程中完成出站。
* `ok` 的含义是"**KB 接收端点已成功接收（2xx）**"，**不等于已被收录**——收录与否由其审核人员决定，本系统不追踪。
* 超时可配置（建议默认 10s）。

### 5. 失败与重试

| 情况 | `error_code` | 是否重试 |
|---|---|---|
| 未配置端点 / 凭据 | `export_unavailable` | 否 |
| 网络错误 / 超时 / 5xx | `export_failed` | 是（有限重试：2 次，指数退避） |
| 4xx（鉴权失败 / 格式不被接受） | `export_failed`（`message` 说明） | **否** |
| `object` 非法 | `invalid_object` | 否（协议层应已拦截，防御性保留） |

* 导出失败**不影响** Workflow 状态（此时 Workflow 早已终止）。
* 导出**不修改** Record（`RECORD_SPEC.md` 原则 7）。

### 6. 检索接口预留（FR-23，P1）

* 定义独立的 `KnowledgeProvider` 接口：`query(context) → relevant knowledge`，作为 Planner 的输入之一。
* 与投递端**分开**，互不复用；MVP 不实现，仅占位。
* 保持 `SERVER_SPEC.md` §4 与 `CAPABILITY_SPEC.md` §7-3 的既有结论：**检索逻辑在第三方系统内，Server 只消费；且不把检索建模为 Capability**（不经过 Client，不生成 Step）。

### 7. 本阶段明确不做（P4d 记录）

* **blob 引用不随导出解析**：投递包的 `content` 里若含 `content_ref`（大体积证据走 blob 通道，见 `PROTOCOL_SPEC.md` §7.5），KB 拿到的**只是引用，不是字节**。要把大体积证据真正交给 KB，需按其存储接口在"上传字节 / 内联小文件 / 只给引用"之间做一次决定——这属于将来那份 KB 集成 Spec，不在本阶段。
* **FR-23 检索**：只保留 §6 的接口位置，不实现。
* **审核状态回读**：本系统不追踪（§4）。
* **异步投递 / 多 KB 路由**：见 Rejected Alternatives 与 Consequences。

---

## Rejected Alternatives

* **异步投递（accepted + 回调）**：更适合慢的 KB，但需要新增消息与状态机；MVP 的 KB 接收端点可以做到快速 ack，同步更简单。
* **离线导出（只落盘投递包，人工搬运）**：最省事，但不自动化，不符合"提交人在系统内一键导出"的体验。
* **投递包总是附带结构化 Record**：检索质量最好，但违背"导出 Report 即不暴露原始日志"的意图。
* **本系统追踪 KB 审核状态（待审 / 已收录 / 被拒）**：需要与 KB 双向集成并依赖外部团队；审核在对方系统内，本系统不应耦合。
* **Client 直连 KB**：会让凭据落到 Client、绕过 Server 的边界与审计；`PROTOCOL_SPEC.md` §16 已明确 KB 集成不经过 Client-Server 协议。
* **把"查询 KB"建模为 Capability**：`CAPABILITY_SPEC.md` §7-3 已明确否决——检索是 Server 与外部系统之间的事，不生成 Step。
* **把导出做成 Workflow 的一步**：导出发生在 Record 定型之后，与诊断过程无关；不应污染 Workflow 状态机。

---

## Consequences

**正面：**

* 导出半边有了明确、可实现的契约；`PROTOCOL_SPEC.md` §10.3 的协议面与出站契约对齐。
* `deposit_id` 让 KB 侧可以去重，避免了"重复导出导致重复收录"。
* 检索接口单独预留，避免了导出与检索混成一个耦合面。

**需要落实：**

* **已实现（P4d）**：Server 配置项（KB 端点、凭据、超时、重试）——`KB_ENDPOINT_URL` / `KB_AUTH_HEADER`（默认 `Authorization`）/ `KB_AUTH_SCHEME`（默认 `Bearer`，置空即裸 token）/ `KB_TOKEN` / `KB_TIMEOUT_MS`（默认 10s）/ `KB_MAX_RETRIES`（默认 2）；端点或凭据缺失即 `export_unavailable`。
* `PROTOCOL_SPEC.md` §10.3 的 `error_code` 取值与本 ADR 对齐（已一致：`export_unavailable` / `export_failed` / `invalid_object`）。
* 目标 KB 确定后，据其真实接口补一份 **KB 集成 Spec**（含检索实现，若届时 `FR-23` 进入排期；并一并决定 §7 的 blob 交付方式）。

**仍然延后：**

* KB 检索实现（FR-23）、审核状态回读、多 KB 路由、KB 侧的数据治理与权限；以及 §7 的 blob 引用解析。
