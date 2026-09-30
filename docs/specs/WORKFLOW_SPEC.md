# WORKFLOW_SPEC.md

- **Version:** v0.7（§4.3 明确"副作用超时两端一致走 `UNKNOWN`，只有只读才是 `FAILED(timeout)`"；取代 v0.6）
- **层级:** Specification — Client 与 Server 共享的行为契约
- **拆分说明:** 原 v0.2 的 `CLIENT_SPEC.md` 和 `SERVER_SPEC.md` 里，Step 状态机、Evidence 结构、Completion 判定流程被各自定义了一遍，且已经出现细节漂移（例如 Evidence 两种不同的示例结构、Execution Loop 图里 "Done Candidate" 与其余各处 "Completion Candidate" 不一致）。本文件把这些内容整合为唯一权威定义，`architecture/CLIENT_SPEC.md` 与 `architecture/SERVER_SPEC.md` 均应引用本文件，不再各自维护副本。

---

## 0. 本文件的定位

Server 决定"要做什么"，Client 决定"本地是否允许执行"——但双方对话所依赖的**共同语言**（Step 长什么样、Evidence 长什么样、什么时候算完成）必须只有一份定义。本文件就是这份定义。

---

## 1. 核心概念

```text
User Request ──▶ Workflow ──▶ Step ──▶ Evidence
```

* **User Request**：User 想解决的问题。
* **Workflow**：Server 为解决这个 Request 而运行的过程。
* **Step**：Workflow 当前需要执行的具体动作。
* **Evidence**：Step 实际执行后得到的结果。

---

## 2. Workflow 状态机

```text
CREATED ──▶ RUNNING ──▶ COMPLETED
    │           │
    │           ├──────────────▶ FAILED
    │           │
    │           └──▶ CANCELLING ──▶ CANCELLED
    │                                  ▲
    └──────────────────────────────────┘
      （尚未开始执行时也可以直接取消）
```

* `CREATED`：Workflow 已创建，尚未开始执行
* `RUNNING`：Workflow 正在推进
* `CANCELLING`（v0.2 新增，**过渡态，不是终止态**）：工程师已表达取消意图，但当前有一个不可中断的 Step 在执行，Server 不再下发新 Step，等待该 Step 自然结束后终止
* `COMPLETED`：Request 已完成最终确认（见 §9）——**终止态**
* `FAILED`：Server 判定 Workflow 无法继续完成——**终止态**。v0.4 起，判定不再只依赖 LLM 判断：至少还包括 §13 的终止护栏触发、以及 §2.2 的孤儿回收；v0.5 起还包括规划与证据校验失败（`planner_error`：LLM 不可用或输出不可解析；`invalid_input`：Planner 产出的 Step `input` 不合 Capability 的 `input_schema`，不下发；`invalid_output`：Evidence `result` 不合 `output_schema`）。可携带可选的 `terminal_reason`，取值见下。
* `CANCELLED`（v0.2 新增）：工程师主动终止（无论理由是"取消"还是"放弃"）——**终止态**。可携带一个可选的 `terminal_reason`（例如 `user_cancelled` / `abandoned` / `superseded` 等），用于区分终止的具体意图，但这只是元数据，不影响状态机的转换逻辑。（`workflow.cancel_request` 的**输入字段**名为 `reason`；写入 Workflow 状态后即 `terminal_reason`，见 `PROTOCOL_SPEC.md` §7.3、§7.4。）

**`terminal_reason` 枚举（v0.4 扩展，原先只用于 `CANCELLED`）：**

| 终止态 | `terminal_reason` 取值 |
|---|---|
| `COMPLETED` | 恒为 `null` |
| `FAILED` | `client_unreachable`（§2.2 孤儿回收）/ `step_limit` / `retry_limit` / `user_round_limit` / `time_budget`（§13 护栏）/ `planner_error` / `invalid_input` / `invalid_output`（v0.5 规划与校验失败）/ `resource_conflict`（v0.6：能力提供方报告资源被占用，见 §4.4）；其他系统判定原因预留为自由字符串 |
| `CANCELLED` | `user_cancelled` / `abandoned` / `superseded` 等（§2.1） |

> `PROTOCOL_SPEC.md` 的 `workflow.terminated.terminal_reason`、`RECORD_SPEC.md` 的 `terminal_reason` 与本节使用同一套取值。

Step 的状态独立于 Workflow 状态（见 §4）。

### 2.1 取消语义（v0.2 新增；v0.4 扩展判定与收敛）

工程师可以在 `CREATED` / `RUNNING` / `CANCELLING` 期间的**任意时刻**表达取消意图（这一点不受限制）。但"表达意图"和"立即生效"是两件事。

**判定依据（v0.4：从"Step 处于 RUNNING"推广为"活跃 Step"）：**

"活跃 Step"指已下发且未到达终态的 Step（`PENDING` / `RUNNING` / `WAITING`）。

```text
工程师表达取消意图
        │
        ▼
   是否存在活跃 Step？
   ├── 否，或活跃 Step 仅为 PENDING（尚未执行）
   │        → 立即终止为 CANCELLED
   │
   ├── 是，且属于人类等待（user_input / user_confirmation / 人工对账）
   │        → 视为可中断，立即终止为 CANCELLED
   │
   └── 是，且为 RUNNING 或执行类 WAITING
            ├── Capability interruptible=true  → 立即终止为 CANCELLED
            └── Capability interruptible=false → 转为 CANCELLING
```

**`CANCELLING` 的收敛（v0.4 新增）：**

```text
转为 CANCELLING
    │ Server 不再下发新 Step
    │ 当前不可中断 Step 继续跑到它自己的结局
    ▼
该 Step 到达任一终态（COMPLETED / FAILED / UNKNOWN）
    │
    ▼
Workflow 终止为 CANCELLED
（不触发 Re-plan；因工程师已取消，即使该 Step 是 UNKNOWN 也不对账，
 Record 如实记录 UNKNOWN，见 RECORD_SPEC.md）
```

**取消意图优先（v0.4 新增）：** 若 `CANCELLING` 期间 Client 失联，Workflow 仍终止为 `CANCELLED`（保留 `terminal_reason`），**不**按 §2.2 的孤儿回收判 `FAILED`。因此 `CANCELLING` 不可能无限悬挂。

判断"是否可中断"依据 `CAPABILITY_SPEC.md` §2.2 的 `interruptible` 声明；未声明时按该文件的规定默认视为不可中断（保守处理）。

这个设计的核心考虑：HiL 场景下很多 Step 对应的是测试台/被测对象上的物理操作，中途打断可能比等它跑完更危险，所以"取消"不能被理解为"立即停止"，而应该理解为"停止规划新的动作，但不粗暴打断正在发生的物理过程"。

### 2.2 孤儿回收（v0.4 新增）

对应 `REQUIREMENTS.md` NFR-3 的范围澄清（v0.9）：断线恢复只覆盖**同一逻辑会话内的网络中断**。会话过期或 Server 重启后，Client 按 `PROTOCOL_SPEC.md` §5.2 重新握手并把未完成工作作为新 `workflow.request` 提交；Server 侧原有的 Workflow 不会被静默遗弃，而是按下述规则回收：

```text
Client 失联 / 会话失效
        │
        ▼
进入可配置宽限期（建议与 session TTL 一致）
        │
   ├── 期间重连并恢复 → 继续原 Workflow
   │
   └── 逾期仍无重连
            ├── 此前未表达取消意图 → 终止为 FAILED（terminal_reason=client_unreachable）
            └── 此前已表达取消意图 → 终止为 CANCELLED（取消意图优先，见 §2.1）
        │
        ▼
   照常保存 Record（见 §12）
```

宽限期具体时长由 Server 配置，本文件不固定数值。

---

## 3. Step Schema

一个 Step 至少描述：

```text
Step
├── objective        做什么
├── capability        使用哪个 Capability（见 CAPABILITY_SPEC.md）
├── input             传给 Capability 的参数（v0.4：须符合该 Capability 的 input schema）
└── expected_output   期望得到的结果类型（v0.4：output schema 的名称引用）
```

示例：

```text
objective: 检查项目为什么无法启动
capability: project.diagnose
input:
  project_path: /workspace/app
expected_output: diagnostic_result
```

Step 描述的是**做什么**，不是**整个问题应该如何解决**——Server 不应该把完整解决方案编码进单个 Step 的 objective 里。

---

## 4. Step 状态机

```text
PENDING → RUNNING → COMPLETED
              │
              ├──▶ WAITING ──▶ RUNNING（继续）
              │        │
              │        ▼
              │     FAILED
              │
              └──▶ FAILED

（受副作用确认约束的 Step，见 §4.2）
PENDING → WAITING(user_confirmation) ──▶ RUNNING → ...
              │
              ▼
           REJECTED(user_declined)

（副作用且结果不确定的 Step，见 §4.3）
PENDING / RUNNING → UNKNOWN ──（对账）──▶ COMPLETED / FAILED
```

* **PENDING**：Step 已收到/已创建，但尚未开始执行。
* **RUNNING**：Step 正在执行（Client 视角）/ Client 正在执行（Server 视角）。
* **WAITING**：Step 无法继续，需要外部条件（User 输入、User 确认、本地服务响应、设备响应、外部资源准备完成）。
* **COMPLETED**：Step 成功完成，并产生 Evidence。
* **FAILED**：Step 执行失败，返回失败信息和已有 Evidence。失败不一定意味着 Workflow 立即失败——Server 可以根据失败 Evidence 选择 Retry / Change Approach / Generate Another Step / 判断无法继续。
* **REJECTED**：Client 从未真正尝试执行就主动拒绝（例如工程师拒绝确认一个有副作用的动作）。
* **UNKNOWN**（v0.4 新增）：Step 引用的 Capability `side_effect: true`，但 Server 无法确认它是否真正执行、结果是否生效（例如超时、断连导致回包丢失）。这是**终态**，但可被对账收敛为 `COMPLETED` / `FAILED`（见 §4.3）。

> **终态不可变（v0.4 新增）：** `COMPLETED` / `FAILED` / `REJECTED` / `UNKNOWN` 均为 Step 终态。到达终态后，同一 `step_id` 的后续状态更新一律忽略并告警（迟到的只读证据可由 Server 选择性并入 Context，但不改变 Step 状态）；终态之间不互相覆盖，先到者为准。唯一例外是 `UNKNOWN` 可通过对账收敛。同一 `(step_id, 终态)` 只接受一次，避免重连补报在 Record 中产生重复条目。（协议层落实见 `PROTOCOL_SPEC.md` §8。）

### 4.1 WAITING 的两种解决路径（务必区分，不要混用）

系统里有两处看起来都是"等 User"，但语义完全不同：

```text
路径 A — Execution-time WAITING（发生在单个 Step 内部）
  Step(RUNNING) → WAITING → User Input → 同一个 Step 恢复 RUNNING → COMPLETED/FAILED

路径 B — Request-level "Not Solved"（发生在 Completion Candidate 之后）
  Completion Candidate → User: Not Solved → User Feedback → Server Re-plan → 生成全新的 Step
```

路径 A 是"这一步做到一半，需要补充信息才能做完"，恢复后**还是原来那个 Step**。
路径 B 是"整个结果被 User 判定为没解决"，触发的**不是恢复某个 Step，而是重新规划、产生新 Step**。

Client 和 Server 在实现时都不应该把这两种情况用同一套状态处理逻辑合并，否则会分不清"继续做同一件事"和"重新做一件事"。

### 4.2 受控执行的确认规则（v0.2 新增）

呼应 `PRODUCT.md` 产品原则1（"工程师始终掌控"）与 `REQUIREMENTS.md` FR-7：

> **如果一个 Step 引用的 Capability 声明 `side_effect: true`（见 `CAPABILITY_SPEC.md` §2.1），该 Step 在进入 `RUNNING` 之前，必须先进入 `WAITING`（`wait_reason = user_confirmation`），等待工程师明确确认。**

后续走向只有两种：

* 工程师确认 → Step 从 `WAITING` 转为 `RUNNING`，按正常流程执行。
* 工程师拒绝 → Step 转为 `REJECTED`（`reject_reason = user_declined`），**不会**进入 `RUNNING`，Server 据此重新规划（换 Capability，或生成一个请求人工授权/换一种方式的新 Step）。

这条规则不需要 Server 在每次下发 Step 时重新判断——`side_effect` 是 Capability 的静态声明，Server 生成 Step 时按声明直接决定要不要先过这一道 WAITING。（是否要在 `step.dispatch` 里再显式携带一份 `requires_confirmation` 标记，作为运行时的自包含信息、并允许 Server 针对个别 Step 临时提高确认要求，这是协议层的实现细节，由 `PROTOCOL_SPEC.md` 决定，本文件只规定"什么条件下必须确认"这条业务规则本身。）

### 4.3 结果未知（UNKNOWN）与对账（v0.4 新增）

呼应 `PRODUCT.md` 产品原则1（"工程师始终掌控"）与 `REQUIREMENTS.md` FR-7：有副作用的动作一旦执行，就可能在现实世界产生后果。Server 必须区分"动作没执行"与"动作可能已执行但结果丢失"，后者不能简单重试。

**触发 `UNKNOWN` 的典型场景：** Client 已执行一个有副作用的 Step，但 `step.status(COMPLETED, evidence)` 在回传前丢失（断连、超时）。Server 无法区分"执行了但回包丢了"和"根本没收到/没执行"，因此把该 Step 判为 `UNKNOWN` 而非 `FAILED`。

**谁发现的都一样（v0.7 明确）：** 副作用的超时**两端一致**——服务端的 `step_timeout` 到点判 `UNKNOWN`，客户端自己在本地掐掉（命令超过 `timeout_hint`）也报 `UNKNOWN`；**只有只读**超时才是 `FAILED(timeout)`。被掐掉的副作用可能已部分生效，它的不确定性与"回包丢失"是同一种，不因为是谁先发现而给出不同结论。

**副作用阻塞规则：** 当一个 Workflow 内存在未对账的 `UNKNOWN` 时，Server **禁止再下发其它副作用 Step**（只读 Step 与对账 Step 允许）。这条与 §4.4 是两件不同的事：这里管的是"我们自己的知识状态残缺"（动作可能已发生），§4.4 管的是"提供方报告资源此刻不可用"。

**对账流程：** 优先由 Server 生成只读对账 Step 取客观证据，由 Workflow Engine 据此把原 `UNKNOWN` 裁定为 `COMPLETED` 或 `FAILED`；证据不足时退回工程师确认（属于人类等待，见 `PROTOCOL_SPEC.md` §9）。

**若在完成对账前 Workflow 就终止**（工程师取消，或 Server 判定无法继续）：允许终止，Record 如实记录该 Step 为 `UNKNOWN`，并在 `final_result` 中标注"存在未对账的副作用动作（可能已执行）"（见 `RECORD_SPEC.md` §3）。

**幂等重试（白名单）：** Capability 可声明 `idempotent: true`（见 `CAPABILITY_SPEC.md` §2.3）。只有这类 Capability 允许在结果不确定时携带 `idempotency_key` 重试；Server 为同一意图生成 Workflow 内稳定的 `idempotency_key`，Client 必须持久化"键 → 结果"台账，命中台账直接返回缓存证据而不重新执行；Client 无法确认台账时不得静默重执行，应回报 `UNKNOWN` 待对账。`message_id` 去重（挡消息重传）与 `idempotency_key`（挡同意图语义重复）职责不同，不可互相替代。

> **MVP 实现口径（v0.7 补注，消除文档与实现的出入）：** 当前实现的键**按 Step 稳定**——在派发时生成、随 Step 持久化，因此**重连后重发同一个 Step 会复用同一个键**（这正是台账能挡住"重复执行物理动作"的场景）。而"同一**意图**跨多次重试保持稳定"这一更强的语义尚未实现：规划器目前不表达"意图"，每次重新规划都是一个新 Step、新键。要落地它需要 Planner 显式给出意图标识（或等价的重试标记），列为后续项。

### 4.4 资源占用（v0.4 新增，v0.6 重写）

`REQUIREMENTS.md` NFR-4 允许同一工程师并发多个 Workflow，而假设 A-2 只声明了"一套硬件同时只由一位工程师操作"。两个 Workflow 的副作用可能同时落到同一套硬件上——但**"谁被占用了"只有能力提供方知道**（硬件、被测对象、本地环境、外部锁……本系统不建模这些），因此：

> **资源占用由能力提供方自行判断；发现冲突时如实上报，由 Server 转达工程师决定。Server 不做资源仲裁、不排队、不建资源模型。**

* **能解决 → 继续**：提供方报 `WAITING(wait_reason.code = resource_conflict)` 把 Step 停住（人类等待，不受 `step_timeout` 约束，见 `PROTOCOL_SPEC.md` §9），并向工程师询问；工程师腾出资源后提供方继续执行，Step 正常 `COMPLETED`。**这一路不落 Record 条目**——Record 记的是问题与结局，不是过程中的磕碰。
* **不能解决 → 结束**：提供方报 `REJECTED(reject_reason.code = resource_conflict, message = ...)`；Server **不再重规划**（不允许换一个能力把问题绕过去），Workflow 终止为 `FAILED`，`terminal_reason = resource_conflict`，Record 如实记下"设备/资源被占用"（见 `RECORD_SPEC.md` §3/§4）。
* Server 侧只做两件事：认这个码是**人类等待**（不许被超时杀掉），以及认这个码是**终结信号**。
* 取消意图仍然优先：`CANCELLING` 中触发该终结，仍收敛为 `CANCELLED`（§2.1）。

> 之前版本的表述是"同一 `session` 内最多一个副作用 Step 活跃，Server 负责保证（例如排队）"。v0.6 放弃这条：`session` 只是本地环境的一个粗糙替身（同一个 daemon 换个连接就是一个新 session），既会挡住本不冲突的动作，也拦不住真正共享的硬件；而判断"是否冲突"所需的信息只有提供方有。§4.3（同一 Workflow 内 `UNKNOWN` 未对账时禁止再下发副作用）不受影响——那不是资源问题，而是"我方知识状态"问题。

---

## 5. Evidence Schema

**唯一权威结构（envelope 格式）：**

```text
Evidence:
  source: capability | user_input | system   # 受控词表，见下（v0.4）
  type: <string>                              # 与 Capability 的 output schema 名称绑定
  result:
    <该 source/type 特有的字段，须通过对应 output schema 校验>
```

示例 1（诊断类）：

```text
Evidence:
  source: capability
  type: diagnostic_result
  result:
    root_cause: missing_dependency
    confidence: 0.91
```

示例 2（原 CLIENT_SPEC v0.2 §6 的 git 状态示例，统一到 envelope 格式后）：

```text
Evidence:
  source: capability
  type: git_status
  result:
    branch: main
    modified_files: 7
    untracked_files: 2
```

*（v0.2 两份文档里分别出现过"平铺字段 + 顶层 status"和"envelope + result"两种不同示例，未说明何时用哪种。现在统一为：`result` 内部字段可以自由定义，但顶层必须是 `source` / `type` / `result` 三段式，不再允许业务字段直接出现在顶层。）*

**v0.4：`source` 与 `type` 是受控词表，不再是自由字符串**（对齐 `CAPABILITY_SPEC.md` §5）：

* `source` 限定为来源类别：`capability`（由某个 Capability 产生）/ `user_input`（工程师输入或反馈）/ `system`（系统自身产生，例如超时、护栏触发）。具体是哪个 Capability，通过该 Evidence 所属的 `step_id` 与 `type` 确定。
* `type` 与对应 Capability 的 output schema 名称绑定并登记；`result` 必须通过该 schema 校验。
* `expected_output` 的语义改为 **output schema 的名称引用**，不再是自由文本。
* 校验失败：Client 返回的 `result` 不合 schema，或 `type` 与声明不一致 → Server 记 `FAILED`，`fail_reason.code = invalid_output`，并告警（见 `PROTOCOL_SPEC.md` §8）。

Client 应尽可能返回实际观察结果，而不是自行推测整个问题是否已经解决；Server 不应只依赖 LLM 的推测，而应尽可能使用实际 Evidence 作为 Re-plan 的输入。

---

## 6. Composite Capability 的结果约束

一个 Capability 可以在 Client 内部包含多个本地操作（例如 `git.collect_diagnostics` 内部可能依次执行 `git status` / `git diff` / `git log` / `git branch`），但对 Server 而言，它必须始终呈现为：

```text
一个 Capability + 一个 Step + 一个 Evidence 结果
```

Client 不应把一个完整 Workflow（多个有先后依赖的决策点）隐藏在单个 Capability 的内部实现里——如果一个"能力"内部需要根据中间结果做分支决策，这本身就是 Server 该做的 Planning，应该拆成多个 Step，而不是让 Client 在本地悄悄替 Server 做了规划。

### 6.1 建议路径（Advisory Path，v0.2 新增）

呼应 `PRODUCT.md` §5 场景描述与 `REQUIREMENTS.md` FR-6/FR-8："建议"这种解决问题的方式——系统给出修复建议，工程师自行执行，并把结果反馈回来——**复用同一套 Step/Capability/Evidence 机制**，不引入新的 Step 类型：

```text
Server 生成 Step：
  capability: human.manual_action（CAPABILITY_SPEC.md §6 保留名称）
  input: { instruction: "请重新连接 CAN 总线适配器并重启测试台" }
  expected_output: manual_action_result
        │
        ▼
Client 展示 instruction 给工程师，Step 进入 WAITING(wait_reason=user_input)
        │
        ▼
工程师在系统外自行执行，回来反馈观察到的结果
        │
        ▼
Client 包装为 Evidence(source=user_input, type=manual_action_result,
                     result={outcome, observation, details?})
        │
        ▼
Step 转为 COMPLETED，走回正常的 Re-plan 流程
```

`human.manual_action` 的 `side_effect` 固定为 `false`——系统本身没有执行任何操作，真正有副作用的动作是工程师在现实世界中完成的，工程师本人就是那个决定"要不要做"的人，不需要 §4.2 的确认规则再加一层。`interruptible` 对这个 Capability没有实际意义（它不是一个可以被"中止"的执行过程，本质是等待工程师反馈），约定视为 `true`（即：取消 Workflow 时，如果当前正停在这一步，可以立即终止，不需要走 CANCELLING）。

---

## 7. Execution Loop

```text
Plan → Execute → Observe → Re-plan
```

完整过程：

```text
User Request → Context → LLM → Step → Client → Local Execution → Evidence
    → Context Update → LLM ──┬── Continue ──▶ 下一个 Step
                              └── Completion Candidate ──▶ Client → User
```

*（原 SERVER_SPEC v0.2 §12 图中此处标注为 "Done Candidate"，与文档其余各处使用的 "Completion Candidate" 不一致，本文件统一为 "Completion Candidate"，"Done Candidate" 视为已废弃的历史写法，不应再使用。）*

---

## 8. Completion 判定

### 8.1 完成条件（completion_criteria，v0.4 新增）

完成条件是 **Request 级**的，不由 Capability 声明（据此明确关闭 `REQUIREMENTS.md` §7 中"完成条件是否随 Capability 声明"的待办）：

```text
completion_criteria:
  mode: formal | open
  assertions: <mode=formal 时，一组可由 Evidence 判定的断言>
  description: <一句话说明"怎样算解决">
  revision: <每次修订递增>
```

* Planner 在创建 / 推进 Workflow 时产出并显式记录 `completion_criteria`，由 Workflow Engine 纳入 Workflow 状态持久化。
* 可被修订；每次修订写入 Record，使"为什么判定完成"可追溯（见 `RECORD_SPEC.md` §3）。
* `mode=open` 时没有可判定断言，走下方 §8.2 的开放式判定路径。

### 8.2 判定

Server 根据完成条件和当前 Evidence 判断"是否达到系统可以判断的完成条件"：

**可形式化的 Request：**

```text
Evidence → Completion Criteria → Workflow Engine → Completion Candidate
```

例如：`service.status == running` 且 `health_check == OK`。

**开放式 Request：**

```text
Evidence → LLM → Completion Proposal → Workflow Engine
```

LLM 可以提出"当前证据表明 Request 可能已经解决"，但 **LLM 不直接决定最终 Workflow State**——最终仍由 Workflow Engine 确认为 Completion Candidate（呼应 `ADR-001`）。

---

## 9. User Final Confirmation

达到 Completion Candidate 后，不立即把 User Request 视为最终解决：

```text
Server → Completion Candidate → Client → User
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                                ▼
                       Solved                          Not Solved
                          │                                │
                          ▼                                ▼
                      COMPLETED              User Feedback → Server → Re-plan
```

> **Server 判断"是否达到系统完成条件"，User 判断"是否真正解决了自己的 Request"。**

**说明（v0.2 新增）**：上图是"系统认为可能解决了"这条路径的确认流程，不是取消/放弃的唯一入口。工程师放弃或取消一个 Workflow，可以在 §2.1 描述的任意时刻独立发生，不需要等到系统提出 Completion Candidate。

---

## 10. Human-in-the-loop 的两个阶段

User 参与系统的方式只有两种，分别对应 §4.1 的路径 A 和路径 B：

| 阶段 | 触发点 | 对应状态变化 |
|---|---|---|
| **Execution-time** | Step 处于 WAITING | User Input → 同一 Step Continue |
| **Request-level** | Completion Candidate | User Confirmation → Completed / Re-plan |

User 不直接修改 Workflow State；User 的输入始终通过 Client 返回 Server，由 Server（的 Workflow Engine）决定后续 Workflow 行为。

---

## 11. 已知待补项（Open Items）

以下几点在 v0.1 尚未定义，标记出来供后续版本 / `PROTOCOL_SPEC.md` 补充，不应被忽略：

1. **Step ID / Workflow ID**：本文件尚未定义唯一标识符贯穿一个 Step 或 Workflow 生命周期内的所有消息。没有 ID，Server 在网络重试、Step 超时重发、Client 短暂离线重连等场景下无法确定"这条 Evidence 对应哪一个 Step"。这是协议能否工作的前提，需要在 `PROTOCOL_SPEC.md` 里最先解决。（**已由 `PROTOCOL_SPEC.md` §2、§3 解决**）
2. **Capability 输入/输出 Schema**：Step 的 `input` 字段该填什么结构，取决于对应 Capability 的参数声明，目前只有名字没有 Schema，见 `CAPABILITY_SPEC.md` §5。（**已由 `CAPABILITY_SPEC.md` v0.5 §5 与 `PROTOCOL_SPEC.md` v0.4 §6 解决**：采用 JSON Schema 受限子集，`step.dispatch.input` / `evidence.result` 按 schema 校验）
3. **"Client 拒绝执行" 与 "execution.failed" 的区分**：Client 有权拒绝执行某个 Step（架构层面的权利，见 `architecture/CLIENT_SPEC.md` §7），但这应该是一种独立于"尝试执行但失败了"的信号——"拒绝"通常意味着 Server 应该换一个 Capability 或换一种方式，而"失败"更可能意味着换个参数重试。（**已由 `PROTOCOL_SPEC.md` §8 解决**：`REJECTED` 与 `FAILED` 完全分开）
4. **Step 超时 / Liveness**：Step 处于 RUNNING 却长时间无响应时 Server 该怎么办（等待、超时转 FAILED、主动查询 Client 状态），目前未定义。（**已由 `PROTOCOL_SPEC.md` §9 解决**）

> **v0.4 说明：** 以上四项均已解决（分别见 `PROTOCOL_SPEC.md` §2/§3、`CAPABILITY_SPEC.md` §5、`PROTOCOL_SPEC.md` §8、`PROTOCOL_SPEC.md` §9）。本节保留编号仅作历史追溯，不再是待办。

---

## 12. Record 保存时机（v0.2 新增）

> **Workflow 进入任一终止状态（`COMPLETED` / `FAILED` / `CANCELLED`）时，触发 Record 保存。**

`CANCELLING` 是过渡态，不触发保存——保存动作发生在它最终落到 `CANCELLED` 的那一刻。Record 具体包含哪些字段、如何与 Evidence/Step 关联，由 `RECORD_SPEC.md` §3 定义；本节只规定"触发时机"这一条属于 Workflow 状态机的自然延伸的规则。

---

## 13. 终止护栏（防无穷循环，v0.4 新增）

`FAILED` 的判定不能只交给 LLM。以下护栏由 **Workflow Engine 确定性强制执行**（不依赖 LLM 自觉，呼应 `ADR-001`），全部可配置：

| 护栏 | 建议默认 | 触顶后 |
|---|---|---|
| `max_steps_per_workflow` | 50 | `FAILED`，`terminal_reason = step_limit` |
| 同一 Capability 连续重试上限（仅只读） | 2 次重试（共 3 次尝试） | `FAILED`，`terminal_reason = retry_limit` |
| `max_not_solved_rounds` | 5 | `FAILED`，`terminal_reason = user_round_limit` |
| Workflow 总时长预算 | 默认不限（可配置） | `FAILED`，`terminal_reason = time_budget` |

* 有副作用的 Step **不适用**"连续重试"护栏：其结果不确定时走 §4.3 的 `UNKNOWN` + 对账。
* 任一护栏触顶时，Workflow 进入 `FAILED`，并照常保存 Record（见 §12）。
* 具体数值由 Server 配置；本文件给出的默认值用于给实现一个可用起点。
