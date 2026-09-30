# ARCHITECTURE.md

- **Version:** v0.7（部署/信任模型：新增 §6 部署视图（多用户共享 Server、本地账号、按用户隔离、TLS 延后）；依据 `ADR-003`，取代 v0.6）
- **层级:** Architecture — 系统应该由什么构成
- **拆分说明:** 本文件从原 `CLIENT_SPEC.md` / `SERVER_SPEC.md` v0.2 中抽取系统级架构内容整合而成。组件各自的角色定位见 `CLIENT_SPEC.md` / `SERVER_SPEC.md`；Step/Workflow/Evidence 的具体契约见 `../specs/WORKFLOW_SPEC.md`。

---

## 1. System Overview

```text
                    USER
                     │
                     ▼
                  CLIENT
                     │
              User Request
                     │
                     ▼
              ┌─────────────┐
              │   SERVER    │
              │             │
              │   Context   │
              │   Knowledge │ ←── 第三方 Knowledge Base（检索，见 §1.1）
              │   Workflow  │
              │   Planner   │
              └──────┬──────┘
                     │
                  One Step
                     │
                     ▼
                  CLIENT
                     │
              Local Execution
                     │
                     ▼
                 Evidence
                     │
                     ▼
                  SERVER
                     │
                   Re-plan
                     │
                    ...
                     │
                     ▼
            Completion Candidate
                     │
                     ▼
                  CLIENT
                     │
                     ▼
                   USER
                ↙         ↘
            Solved       Not Solved
               │             │
               ▼             ▼
          COMPLETED       Re-plan
               │
               ▼
             Record
```

*（原 SERVER_SPEC.md §21 "Core Architecture"、§12 "Execution Loop" 已统一术语后合并于此；原图中 §12 使用的 "Done Candidate" 与其余各处 "Completion Candidate" 不一致，本文件统一采用 "Completion Candidate"，"Done Candidate" 视为废弃写法。）*

**说明（v0.4 新增）：**

* `COMPLETED` 之后补充了 `Record` 一步，表示 Workflow 结束时保存完整记录。这不只发生在 `Solved` 分支——另外两种终止状态（`FAILED`、`CANCELLED`）同样会保存 Record（这些终止状态的完整定义见 `../specs/WORKFLOW_SPEC.md`，本图只画主循环，不是完整状态机）。
* `Not Solved` 分支指向 `Re-plan`，代表"工程师认为还没解决，继续排查"这条**非终止**路径；工程师主动放弃/取消 Workflow 是另一条独立的终止路径，同样会导向 `Record`，具体状态区分见 `WORKFLOW_SPEC.md`，本图不重复展开。
* **（v0.6 新增）** Workflow 的终止除上述路径外，还受两类**确定性规则**影响：终止护栏触顶（`step_limit` / `retry_limit` / `user_round_limit` / `time_budget`）与失联后的孤儿回收（`client_unreachable`），见 `WORKFLOW_SPEC.md` §2.2、§13。
* **（v0.6 新增；v0.7 更正后半句）** Step 层新增终态 `UNKNOWN`（副作用结果未知，需对账，见 `WORKFLOW_SPEC.md` §4.3）；资源占用改为由能力提供方判断并如实上报，Server 不仲裁（见 §4.4）。这两条不改变本图的主循环形状，故不展开。

### 1.1 关于 Knowledge：第三方系统，不是本系统自建

`Knowledge` 在图上是 Server 组合 Context 时的一个输入来源，具体含义是：

> **Server 通过集成/查询的方式，从一个第三方 Knowledge Base 系统里检索相关知识，作为 Planner 的输入之一。检索逻辑、知识库的构建和维护都在第三方系统内，本系统不实现自己的检索引擎，也不在内部做历史案例的相似度匹配。**

这与 `PRODUCT.md` D-5（"不在本系统内建设知识库或历史案例检索能力"）是一致的：D-5 排除的是"自己造一个检索引擎/知识库"，不是"完全不能查任何知识库"。

一个相关但**明确不在本版本范围内**的问题：本系统产生的 Record，未来是否会被沉淀/导出到这个第三方 Knowledge Base，供后续检索复用？——产品侧已经确认这是未来方向，但本版本不实现任何主动推送机制。这意味着 Record 的结构设计需要考虑"以后可能要被导出"——`RECORD_SPEC.md` §8 已按此给出约束（结构化字段自足、`narrative` 用领域语言书写等），但不需要现在就构建导出通道。具体的第三方系统接口形态，留给后续架构决策（建议后续单独出一条 ADR，而不是散落在本文件里）。

---

## 2. Core Components

| 组件 | 职责 | 详见 |
|---|---|---|
| **Client** | User Interaction + Local Execution Runtime | `CLIENT_SPEC.md` |
| **Server** | AI Brain + Context Engine + Knowledge Engine（对接第三方 Knowledge Base，见 §1.1） + Workflow Orchestrator | `SERVER_SPEC.md` |
| **Workflow Engine**（Server 内部） | Workflow / Step 状态的唯一权威 | `SERVER_SPEC.md`, ADR-001 |
| **Local Capability / Agent**（Client 内部） | 实际执行本地操作、产生 Evidence | `CLIENT_SPEC.md`, `../specs/CAPABILITY_SPEC.md` |

---

## 3. 核心边界原则

系统只有一条最根本的边界：

> **Server 决定"要做什么"，Client 决定"本地是否允许执行"。**

```text
Server
  │
  │ What to do
  ▼
Client
  │
  │ Can / How to execute locally
  ▼
Local Capability
```

延伸原则：

* Server 不需要知道 Client 内部具体如何实现某个 Capability。
* Client 不需要知道 Server 内部如何做 Planning、如何组织 Context —— 这条边界对内部实现细节同样成立，任何一侧的架构图都不应该把对方的内部组件（例如 Server 的 LLM）直接画进自己的流程里，否则会隐性泄露不该依赖的实现细节。

---

## 4. 系统级 MUST NOT（负面约束清单）

按照"负面约束比正面指令更重要"的原则，把两份组件文档中的 MUST NOT 合并列在这里，作为系统级红线：

**Client MUST NOT：**

* 自己决定整个 Workflow 的执行计划
* 自己决定下一个 Step
* 修改 Server 维护的 Workflow 状态
* 在 Server 未要求的情况下自主创建新的全局 Workflow
* 将本地 Agent 的判断直接作为 Workflow 最终状态

**Server MUST NOT：**

* 直接执行 Client 本地操作
* 绕过 Client 访问本地资源
* 让 LLM 直接修改 Workflow authoritative state
* 一次向 Client 下发完整的未来执行计划
* **自行构建历史案例检索/相似问题匹配逻辑**（v0.4 新增）：历史 Record 的沉淀与检索交由第三方 Knowledge Base 承担，不在本系统内实现（对齐 `PRODUCT.md` D-5、§1.1）

---

## 5. 文档地图

| 内容 | 文件 |
|---|---|
| Client 角色定位与职责边界 | `architecture/CLIENT_SPEC.md` |
| Server 角色定位与职责边界 | `architecture/SERVER_SPEC.md` |
| Step / Workflow / Evidence / Completion / 完成条件 / 终止护栏的具体契约（唯一权威定义） | `specs/WORKFLOW_SPEC.md` |
| Capability 命名规范与 Manifest 格式 | `specs/CAPABILITY_SPEC.md` |
| 消息 Schema、通信机制 | `specs/PROTOCOL_SPEC.md` |
| Record 的结构与保存时机 | `specs/RECORD_SPEC.md` |
| Report 的触发与内容约束 | `specs/REPORT_SPEC.md` |
| 关键架构决策及其被否决的替代方案 | `adr/` |

---

## 6. 部署视图与信任边界（v0.7 新增）

> 完整决策与被否决的替代方案见 `../adr/ADR-003-deployment-and-trust-model.md`。本节只画形态。

```text
   工程师 A                工程师 B                工程师 C
   ┌────────┐              ┌────────┐              ┌────────┐
   │ Client │              │ Client │              │ Client │
   │  +测试台│              │  +测试台│              │  +测试台│
   └───┬────┘              └───┬────┘              └───┬────┘
       │                       │                       │
       └───────────┬───────────┴───────────┬───────────┘
                   ▼                       ▼
             ┌───────────────────────────────────┐
             │             Server                │
             │  （实验室内网；长连接；本地账号）    │
             └───────────────────────────────────┘
                          │
                          ▼
                 第三方 Knowledge Base
                 （出站导出半边；审核在对方系统内）
```

**要点：**

* **一个 Server 服务多位工程师的 Client**（`NFR-7`）；一个 Client 对应一个 `session`，`session` 归属某个 `user_id`。
* **每位工程师独占自己的测试台**（`A-2` 澄清）→ **不引入硬件资源 / 目标模型**；资源占用由能力提供方判断并如实上报，Server 不仲裁（`WORKFLOW_SPEC.md` §4.4）。
* **身份与隔离**：Server 本地账号认证；`user_id` 必填；Record **仅提交人可见**；副作用确认**仅限提交人本人**（`ADR-003` §3/§5/§6）。
* **传输加密（TLS）v0.1 不强制**：属传输层关注点，后加不改应用层协议（`ADR-003` §4）。
* **出站**：提交人可按需把 Record/Report 导出到第三方 KB（导出半边）；KB 的接收与审核不在本系统内（`PROTOCOL_SPEC.md` §10.3）。
