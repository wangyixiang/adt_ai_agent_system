# WORKFLOW_SPEC.md

- **Version:** v0.3（§12 引用状态同步：`RECORD_SPEC.md` 已建成，取代 v0.2）
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
* `FAILED`：Server 判定 Workflow 无法继续完成——**终止态**
* `CANCELLED`（v0.2 新增）：工程师主动终止（无论理由是"取消"还是"放弃"）——**终止态**。可携带一个可选的 `reason` 字段（例如 `user_cancelled` / `abandoned` / `superseded` 等），用于区分终止的具体意图，但这只是元数据，不影响状态机的转换逻辑。

Step 的状态独立于 Workflow 状态（见 §4）。

### 2.1 取消语义（v0.2 新增）

工程师可以在 `CREATED` 或 `RUNNING` 期间的**任意时刻**表达取消意图（这一点不受限制）。但"表达意图"和"立即生效"是两件事：

```text
工程师表达取消意图
        │
        ▼
   当前有 Step 正在 RUNNING？
   ├── 否，或该 Step 的 Capability interruptible=true
   │        │
   │        ▼
   │   立即终止为 CANCELLED
   │
   └── 是，且该 Capability interruptible=false
            │
            ▼
       转为 CANCELLING
            │
            │ Server 不再下发新 Step
            │ 当前 Step 继续跑到它自己的结局
            ▼
       该 Step 到达 COMPLETED 或 FAILED
            │
            ▼
       Workflow 终止为 CANCELLED
       （不触发 Re-plan，即使该 Step 最终是 COMPLETED 也不会继续推进）
```

判断"是否可中断"依据 `CAPABILITY_SPEC.md` §2.2 的 `interruptible` 声明；未声明时按该文件的规定默认视为不可中断（保守处理）。

这个设计的核心考虑：HiL 场景下很多 Step 对应的是测试台/被测对象上的物理操作，中途打断可能比等它跑完更危险，所以"取消"不能被理解为"立即停止"，而应该理解为"停止规划新的动作，但不粗暴打断正在发生的物理过程"。

---

## 3. Step Schema

一个 Step 至少描述：

```text
Step
├── objective        做什么
├── capability        使用哪个 Capability（见 CAPABILITY_SPEC.md）
├── input             传给 Capability 的参数
└── expected_output   期望得到的结果类型
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
              ▼
           WAITING ──▶ RUNNING（继续）
              │
              ▼
            FAILED

（受副作用确认约束的 Step，见 §4.2）
PENDING → WAITING(user_confirmation) ──▶ RUNNING → ...
              │
              ▼
           REJECTED(user_declined)
```

* **PENDING**：Step 已收到/已创建，但尚未开始执行。
* **RUNNING**：Step 正在执行（Client 视角）/ Client 正在执行（Server 视角）。
* **WAITING**：Step 无法继续，需要外部条件（User 输入、User 确认、本地服务响应、设备响应、外部资源准备完成）。
* **COMPLETED**：Step 成功完成，并产生 Evidence。
* **FAILED**：Step 执行失败，返回失败信息和已有 Evidence。失败不一定意味着 Workflow 立即失败——Server 可以根据失败 Evidence 选择 Retry / Change Approach / Generate Another Step / 判断无法继续。
* **REJECTED**：Client 从未真正尝试执行就主动拒绝（例如工程师拒绝确认一个有副作用的动作）。

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

---

## 5. Evidence Schema

**唯一权威结构（envelope 格式）：**

```text
Evidence:
  source: <string>     # 例如 local_agent / git / terminal / user_input / test_runner
  type: <string>        # 例如 diagnostic_result / git_status / user_confirmation
  result:
    <该 source/type 特有的字段>
```

示例 1（诊断类）：

```text
Evidence:
  source: local_agent
  type: diagnostic_result
  result:
    root_cause: missing_dependency
    confidence: 0.91
```

示例 2（原 CLIENT_SPEC v0.2 §6 的 git 状态示例，统一到 envelope 格式后）：

```text
Evidence:
  source: git
  type: git_status
  result:
    branch: main
    modified_files: 7
    untracked_files: 2
```

*（v0.2 两份文档里分别出现过"平铺字段 + 顶层 status"和"envelope + result"两种不同示例，未说明何时用哪种。现在统一为：`result` 内部字段可以自由定义，但顶层必须是 `source` / `type` / `result` 三段式，不再允许业务字段直接出现在顶层。）*

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
Client 包装为 Evidence(source=user_input, type=manual_action_result, result={...})
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

Server 根据 Workflow 的完成条件和当前 Evidence 判断"是否达到系统可以判断的完成条件"：

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
2. **Capability 输入/输出 Schema**：Step 的 `input` 字段该填什么结构，取决于对应 Capability 的参数声明，目前只有名字没有 Schema，见 `CAPABILITY_SPEC.md` §5。（仍未解决）
3. **"Client 拒绝执行" 与 "execution.failed" 的区分**：Client 有权拒绝执行某个 Step（架构层面的权利，见 `architecture/CLIENT_SPEC.md` §7），但这应该是一种独立于"尝试执行但失败了"的信号——"拒绝"通常意味着 Server 应该换一个 Capability 或换一种方式，而"失败"更可能意味着换个参数重试。（**已由 `PROTOCOL_SPEC.md` §8 解决**：`REJECTED` 与 `FAILED` 完全分开）
4. **Step 超时 / Liveness**：Step 处于 RUNNING 却长时间无响应时 Server 该怎么办（等待、超时转 FAILED、主动查询 Client 状态），目前未定义。（**已由 `PROTOCOL_SPEC.md` §9 解决**）

---

## 12. Record 保存时机（v0.2 新增）

> **Workflow 进入任一终止状态（`COMPLETED` / `FAILED` / `CANCELLED`）时，触发 Record 保存。**

`CANCELLING` 是过渡态，不触发保存——保存动作发生在它最终落到 `CANCELLED` 的那一刻。Record 具体包含哪些字段、如何与 Evidence/Step 关联，由 `RECORD_SPEC.md` §3 定义；本节只规定"触发时机"这一条属于 Workflow 状态机的自然延伸的规则。
