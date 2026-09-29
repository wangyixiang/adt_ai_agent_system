# RECORD_SPEC.md

- **Version:** v0.5（字段澄清：`summary.duration` → `summary.duration_ms`（毫秒整数），与实现和 `PROTOCOL_SPEC.md` v0.6 对齐；取代 v0.4）
- **层级:** Specification — Record 的结构、生成方式与版本追踪
- **拆分说明:** `PRODUCT.md`/`REQUIREMENTS.md` 定义了 Record 必须存在（FR-12~FR-14）、必须忠实（FR-13）、必须可追溯（NFR-1）；`WORKFLOW_SPEC.md` §12 定义了 Record 的触发时机（Workflow 进入任一终止状态时）。本文件补上中间缺的一环：**Record 到底是什么结构，谁在什么时候把它拼出来**。设计方向（"方向三"：Workflow 结束时一次性生成定型的成品文档，不做协议消息重放）是在对齐 `PROTOCOL_SPEC.md` 时讨论出来的，本文件是这个决定的具体落地。

---

## 0. 设计方向：写入时定型，不是事件回放

Record **不是**"把这次会话收发过的协议消息存一份，读的时候再解析"。理由：

* `PROTOCOL_SPEC.md` 管的是传输层（握手、心跳、断线重连、消息信封），这些和"这次诊断实际发生了什么"无关，Record 不应该因为协议版本升级（比如改了心跳间隔）就需要跟着换一套读取逻辑。
* 如果按协议消息原样存储，读取时必须维护"每个历史协议版本对应一份 parser"，这是一笔要长期背着、只会越滚越大的维护成本（协议演进越活跃，这笔账越重——这个项目目前每次评审都在改协议，这笔账现在就已经不便宜）。
* 未来打算把 Record 沉淀到第三方 Knowledge Base（`REQUIREMENTS.md` FR-24）；大多数知识库系统本来就是摄入"一段可读文档"，不是摄入协议事件流。

> **Record 在 Workflow 终止的那一刻生成一次，是一份定型的成品文档；此后不会因为协议或实现细节变化而需要"重新解析"。**

但纯叙事文本会丢结构化信息，将来喂知识库或者做统计都不够用——所以 Record 采用**混合体**：既有结构化字段，也有对应的人类可读描述，二者一一对应，不是二选一（详见 §3、§4）。

---

## 1. 核心原则

1. **忠实（对齐 `REQUIREMENTS.md` FR-13）**：Record 只包含实际发生的 Step、实际获得的 Evidence、实际发生的人工决定。不允许出现"推测应该发生但没发生"的内容。
2. **只读**：Record 生成后不提供编辑功能（`REQUIREMENTS.md` 假设 A-3）。如果后续需要纠错机制，应该是显式的"追加修订记录"，不是覆盖原内容——这属于后续版本，本文件不设计。
3. **可追溯（对齐 NFR-1）**：Record 里每一条结构化事实都能标明来源（哪个 Capability、哪个 Evidence、还是工程师的直接输入）和发生时间。
4. **结构化 + 叙事并存**：见 §0，这是本文件和"方向三"讨论的核心结论，不是可选项。
5. **不依赖协议版本**：Record 的版本追踪跟 `WORKFLOW_SPEC.md`（+ `CAPABILITY_SPEC.md`）走，不跟 `PROTOCOL_SPEC.md` 走（见 §6）。
6. **归属与可见性（v0.4 新增）**：Record 归属于提交该 Workflow 的工程师（`owner_user_id`）；**只有该用户可查看**（`ADR-003` §6）。Server 必须按 `user_id` 过滤查询，不得返回他人的 Record。
7. **导出不改写 Record（v0.4 新增）**：导出到第三方 KB 发生在 Record 定型之后，是纯读取操作；Record 已只读（原则 2），因此**导出动作不写入 Record**。如需留痕，记在服务端日志，而不是 Record 内容里。

---

## 2. 触发时机

沿用 `WORKFLOW_SPEC.md` §12 的定义：

> Workflow 进入任一终止状态（`COMPLETED` / `FAILED` / `CANCELLED`）时，触发 Record 生成。

`CANCELLING` 是过渡态，不触发生成——生成动作发生在它最终落到 `CANCELLED` 的那一刻。

生成时机是**一次性**的：Record 在这一刻被完整拼出来、落盘，之后不再修改（呼应 §1 原则2）。

---

## 3. Record 整体结构

```text
Record
├── record_id             唯一标识
├── workflow_id            对应的 Workflow
├── owner_user_id          v0.4 新增：提交该 Workflow 的工程师（Record 归属与可见性依据）
├── spec_versions          生成时依据的领域模型版本（见 §6）
├── created_at             Workflow 创建时间
├── ended_at               Workflow 终止时间
├── terminal_state         COMPLETED | FAILED | CANCELLED
├── terminal_reason        可选。CANCELLED 时区分"取消"/"放弃"等意图；FAILED 时区分失败原因（v0.3 扩展，取值见 WORKFLOW_SPEC.md §2）
├── completion_criteria    v0.3 新增：Request 级完成条件及其修订历史（见 WORKFLOW_SPEC.md §8.1）
├── user_request           原始问题描述（含附件/环境信息引用）
├── summary                列表视图用的最小摘要（见 §5）
├── entries[]              详情视图：按时间顺序排列的完整过程（见 §4）
└── final_result           最终结论（结构因 terminal_state 而不同，见下）
```

`final_result` 按 `terminal_state` 分别约定：

```text
terminal_state = COMPLETED:
  final_result:
    root_cause: <如果诊断给出了明确原因，否则为 null>
    resolution: <采用的解决方式：advisory | controlled_execution>
    resolution_summary: <一句话描述最终怎么解决的>

terminal_state = FAILED:
  final_result:
    failure_summary: <系统判定"无法继续"的原因概述>

terminal_state = CANCELLED:
  final_result:
    cancelled_summary: <可选，工程师取消/放弃时留下的说明，没有则为 null>
```

**跨终止态的可选字段：未对账副作用（v0.3 新增）：**

```text
final_result:
  ...
  unresolved_side_effects:      # 可选；存在未对账的副作用 Step 时必填
    - step_id: step_007
      capability: test_rig.trigger_reset
      idempotency_key: idem_9
      last_known_state: UNKNOWN
```

当 Workflow 终止时仍有未对账的 `UNKNOWN` 副作用 Step（工程师取消、或 Server 判定无法继续），必须在 `final_result` 中标注"存在未对账的副作用动作（可能已执行）"，既不谎称成功也不谎称失败。这是"忠实"原则（§1）在 `UNKNOWN` 上的落地（见 `WORKFLOW_SPEC.md` §4.3）。

---

## 4. Entry 的结构（详情视图的主体）

`entries` 是一个有序列表，每一条对应"发生的一件事"，**结构化字段和人类可读描述并存**：

```text
Entry
├── entry_id
├── ts                    发生时间（Server 权威时间，v0.3）
├── kind                  事件类型（见下）
├── ref                   结构化引用（因 kind 而不同，见下）
├── actor                 可选。做出该人工决定的人（v0.3 预留，见 §9-5）
└── narrative              一句人类可读的描述
```

`kind` 的取值和对应的 `ref`：

| kind | 说明 | ref 包含 |
|---|---|---|
| `step_dispatched` | Server 下发了一个 Step | `step_id`, `capability`, `objective` |
| `evidence_received` | 某个 Step 产生了 Evidence | `step_id`, `evidence`（沿用 `WORKFLOW_SPEC.md` §5 的 envelope 结构） |
| `user_confirmation` | 工程师对一个有副作用的动作做了确认/拒绝（对齐 `WORKFLOW_SPEC.md` §4.2） | `step_id`, `decision`（confirmed \| declined） |
| `user_input` | 工程师补充信息或反馈"建议"的执行结果（包括 `human.manual_action` 的反馈，见 `WORKFLOW_SPEC.md` §6.1） | `step_id`（如适用）, `content` |
| `completion_candidate` | Server 提出"可能已解决" | `summary`, `evidence_refs` |
| `completion_response` | 工程师对 Completion Candidate 的回应 | `resolution`（solved \| not_solved）, `feedback` |
| `cancellation_requested` | 工程师表达了取消意图（对齐 `WORKFLOW_SPEC.md` §2.1） | 无（时间点本身就是信息） |
| `step_outcome_unknown`（v0.3 新增） | 某副作用 Step 被判为结果未知（对齐 `WORKFLOW_SPEC.md` §4.3） | `step_id`, `capability`, `idempotency_key` |
| `reconciliation_resolved`（v0.3 新增） | 对账把原 `UNKNOWN` 裁定为某个终态 | `step_id`, `resolved_to`（`COMPLETED` \| `FAILED`）, `evidence_refs` |
| `guardrail_triggered`（v0.3 新增） | 终止护栏触顶导致 Workflow 失败（对齐 `WORKFLOW_SPEC.md` §13） | `guardrail`, `threshold` |

> 大体积 Evidence（日志、截图）在 `ref.evidence` 中以 `content_ref` 引用（见 `PROTOCOL_SPEC.md` §7.5），Record 保留该引用；`narrative` 仍只描述领域事实，不描述存储细节。

示例：

```text
entry:
  ts: 2026-09-28T10:12:03Z
  kind: evidence_received
  ref:
    step_id: step_009
    evidence:
      source: test_rig
      type: signal_log
      result: { channel: CAN2, anomaly: "帧丢失", window: "10:11:50-10:12:00" }
  narrative: "读取了测试台 CAN2 通道的信号日志，发现 10:11:50-10:12:00 时间窗口内有帧丢失。"
```

**`narrative` 的生成方式（v0.3 定案，关闭原 §9-1）：**

* 结构化字段（`ref` / `summary` 等）一律由**确定性代码**生成，不依赖 LLM。
* `narrative` **优先用确定性模板**（基于 `kind` + `ref` 拼接）；仅当涉及无法模板化的自然语言时（例如 `user_input` 反馈的原话复述），才用 **LLM 润色**。
* 无论哪种方式，生成后必须做**一致性校验**：`narrative` 不得引入 `ref` 之外的实体、数值或结论。
* 校验失败 → 回退为最小模板句。
* **`narrative` 生成失败绝不阻塞 Record 落盘**（Record 必须一次性写出，见 §2）。

本文件只规定：**每条 entry 必须有 narrative，且 narrative 的内容不能超出 `ref` 里的结构化事实**（呼应 §1 原则1，"忠实"这条对 narrative 同样适用，不能借着"叙事"的名义添油加醋）。

---

## 5. Summary 字段（列表视图用）

`REQUIREMENTS.md` FR-14 要求工程师能看"历史 Record 列表"。列表视图不应该为了显示一行摘要就去解析每条 Record 的全部 `entries`，所以 `summary` 单独存一份精简版：

```text
summary
├── problem_short         问题的一句话摘要（来自 user_request，可裁剪）
├── terminal_state         COMPLETED | FAILED | CANCELLED
├── result_short           最终结论的一句话摘要（来自 final_result）
└── duration_ms            从 created_at 到 ended_at 的耗时（毫秒，整数）
```

列表视图只读取每条 Record 的 `summary`，详情视图才展开 `entries`。

---

## 6. 版本追踪：跟 WORKFLOW_SPEC 走，不跟 PROTOCOL_SPEC 走

```text
spec_versions
├── workflow_spec      生成时 WORKFLOW_SPEC.md 的版本号（例如 "0.2"）
└── capability_spec    生成时 CAPABILITY_SPEC.md 的版本号（例如 "0.3"）
```

原因（对齐此前讨论）：`entries` 里出现的概念（Step 状态、Evidence 结构、终止状态、`side_effect`/`interruptible` 声明）都来自这两份文档，不是 `PROTOCOL_SPEC.md`——协议层的改动（心跳间隔、重连机制）不影响 Record 的内容含义，不需要跟着记录版本。如果未来 `WORKFLOW_SPEC.md` 或 `CAPABILITY_SPEC.md` 的领域概念发生不兼容变化（例如又调整了终止状态的分类），读取旧 Record 时可以依据 `spec_versions` 判断该用哪套语义去理解 `entries` 里的内容——但因为 Record 是"写入时定型的成品文档"（§0），这种情况下通常只影响**如何解释**历史 entry 的 `kind`/`ref` 含义，不需要重新解析或转换格式，`narrative` 始终可以直接展示。

---

## 7. 与 Report 的关系

对齐 `REQUIREMENTS.md` FR-17~FR-19：

* Report 由指定的一份 Record 生成，只在工程师明确请求时触发。
* Report 的事实性内容必须能追溯到该 Record 的 `entries` 或 `final_result`——不能引入 Record 之外的信息。
* 生成 Report 不修改 Record；同一份 Record 可以生成多次 Report（例如不同详略程度）。
* 因为 Record 本身已经是结构化 + 叙事并存的成品文档（§0、§3），Report 生成本质上是对 `summary` / `entries` / `final_result` 的**裁剪、重新排版**，不需要重新理解协议或重新推断事实——具体的裁剪规则与模板见 `REPORT_SPEC.md` §3、§5。
* **导出对象（v0.4 新增）**：提交人可选择导出 **Record（默认）** 或基于该 Record 生成的 **Report** 到第三方 KB（`PROTOCOL_SPEC.md` §10.3）。两种导出都**不修改** Record。

---

## 8. 面向未来知识库导出的设计要求（呼应 FR-24）

`REQUIREMENTS.md` FR-24：本系统产生的 Record，未来可能被沉淀/导出到第三方 Knowledge Base，但本版本不实现导出机制。即便如此，本文件的结构设计必须满足：

> **`entries` 的结构化字段（`ref`）必须保留足够的信息，使得未来无论第三方知识库要什么摄入格式（纯文本 chunk、结构化字段 + 向量、还是别的），都能从现有 Record 派生出来，不需要回头重新解析协议日志或重新执行诊断。**

具体要求：

* `ref` 里的引用（`step_id`、`capability`、`evidence`）必须是自足的——不依赖"当时还活着的会话状态"才能理解。
* `narrative` 用领域语言书写（问题、诊断、证据、结论），不夹带协议层的内部术语（消息类型名、字段名），因为这部分文字很可能被直接用作知识库的检索文本。
* `summary` 和 `entries` 都要保留，不能只留其中一个——`summary` 服务于"列表/粗粒度检索"，`entries` 服务于"详情/细粒度检索"，两种知识库摄入策略都可能需要。

---

## 9. 已知待补项（Open Items）

1. ~~**`narrative` 的具体生成方式**~~ **已解决（v0.3）**：模板优先 + LLM 润色 + 一致性校验 + 失败回退，见 §4。
2. **Record 的存储介质与查询方式**：本文件只定义结构，不定义存在哪（关系型 / 文档型 / 对象存储）。查询的**条件语义**已在 `PROTOCOL_SPEC.md` §10 明确（时间区间、关键字匹配范围、分页上限、排序）；具体实现仍留给实现阶段。
3. **修订机制**：§1 提到"只读，如需纠错应该是显式追加修订"，具体怎么设计（是否需要 `revisions[]` 字段）留给后续版本，本版本不支持修改已生成的 Record。
4. ~~**`terminal_reason` 的取值枚举**~~ **已解决（v0.3）**：`CANCELLED` 与 `FAILED` 的取值统一列在 `WORKFLOW_SPEC.md` §2。
5. **`actor` 的实际填充**：§4 的条目已预留可选 `actor`；v0.4 起系统已有最小身份（`user_id` 必填，见 `ADR-003` §3），但 `actor` 的填充规则（记提交人还是实际操作人）待身份体系完善（`REQUIREMENTS.md` Q-5 的剩余部分）后确定；本版本允许为 `null`。
