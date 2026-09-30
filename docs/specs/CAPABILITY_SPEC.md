# CAPABILITY_SPEC.md

- **Version:** v0.7（登记 `docker.inspect_container` 的 I/O schema；给 `filesystem.read_file` / `git.collect_diagnostics` 的输出命名 `file_content` / `git_status`；注明 MVP 占位能力 `local-agent.diagnose_project` / `browser.open_page` 只声明不实现；取代 v0.6）
- **层级:** Specification — Client 与 Server 共享的 Capability 契约
- **拆分说明:** 原 v0.2 `CLIENT_SPEC.md` §5 与 `SERVER_SPEC.md` §9 分别举例说明了 Capability，但两边使用的命名不一致（例如 `filesystem.read_file` vs `filesystem.read`）。本文件统一命名规范，作为 Client 声明能力、Server 引用能力时共同遵守的唯一定义。

---

## 1. Capability 是什么

Client 应向 Server 声明当前可用的本地能力。Capability 描述的是：

> **Client 能够执行什么。**

Server 根据这些 Capability 决定是否以及如何利用 Client 的本地能力；Planner 生成 Step 时，`Step.capability` 字段必须引用本文件定义的标准名称（见 §2），Planner 的计划必须建立在 Client 实际可用的 Capability 之上。

---

## 2. 命名规范

统一格式：`<domain>.<verb>_<object>`

| 标准名称 | 说明 | side_effect（v0.2 新增） | 废弃/曾用写法 |
|---|---|---|---|
| `filesystem.read_file` | 读取文件内容 | `false` | ~~`filesystem.read`~~（原 SERVER_SPEC v0.2 §9 使用，已收敛为标准名称） |
| `terminal.execute_command` | 执行终端命令 | `true`（可能修改本地状态，具体取决于命令内容，保守声明为需确认） | ~~`terminal.execute`~~（原 SERVER_SPEC v0.2 §9 使用，已收敛） |
| `docker.inspect_container` | 检查容器状态 | `false` | ~~`docker.inspect`~~（原 SERVER_SPEC v0.2 §9 使用，已收敛） |
| `git.collect_diagnostics` | 收集 Git 诊断信息（内部可能是多个本地操作的组合，见 `WORKFLOW_SPEC.md` §6） | `false` | 无（两份原文档命名一致，保留） |
| `browser.open_page` | 打开指定页面 | `false` | 无 |
| `local-agent.diagnose_project` | 调用本地 Agent 做项目诊断 | `false` | 无 |
| `test_rig.read_signal_log`（v0.2 新增） | 读取测试台指定时间窗口的信号/总线日志（如 CAN/LIN 记录） | `false` | 无 |
| `test_rig.query_dut_info`（v0.2 新增） | 查询被测对象（DUT）当前版本与配置信息 | `false` | 无 |
| `test_rig.read_fault_code`（v0.2 新增） | 读取测试台/DUT 当前故障码 | `false` | 无 |
| `test_rig.trigger_reset`（v0.2 新增） | 触发测试台/DUT 重置（示例：一个真正有副作用的 HiL 动作） | `true` | 无 |
| `sim_rig.trigger_reset`（v0.6 新增，**MVP 模拟项**） | 模拟的测试台复位动作：用于在**没有真实硬件**时验证确认 / `UNKNOWN` / 对账 / 幂等台账。`interruptible: false`、`idempotent: false`、`timeout_hint` 可配置 | `true` | 无 |

> `sim_rig.*` 是本 MVP 的**临时登记项**，用于跑通安全机制；真实 `test_rig.*` 能力接入后应逐步取代它（见 MVP 范围说明 §3）。

*（原因说明：v0.2 两份文档的示例是各自独立写的，`SERVER_SPEC.md` 用的是更简短的动词形式，`CLIENT_SPEC.md` 用的是更具体的动词+宾语形式。既然 Capability 名称是 Planner 生成 Step 时唯一能引用的标识符，两边必须使用同一套名称，这里统一采用更具体的 `<verb>_<object>` 形式，因为它在 Capability 数量增多后更不容易产生歧义，例如未来出现 `filesystem.write_file` 时不会和 `filesystem.read_file` 混淆成一个笼统的 `filesystem.access`。）*

新增 Capability 时应遵循同样的命名格式，并在本表中登记，**同时必须登记 side_effect**（见 §3 说明）。

### 2.1 side_effect 声明规则（v0.2 新增）

* `side_effect: false`：只读/无副作用操作。Server 可以直接下发对应 Step，不需要工程师确认即可执行。
* `side_effect: true`：会改变硬件、被测对象或本地环境状态的操作。Server 下发这类 Step 前，必须先让工程师确认（具体确认流程——Step 什么时候进入 WAITING、拒绝时如何处理——由 `WORKFLOW_SPEC.md` 定义，本文件只负责声明这个属性）。
* 声明必须保守：无法确定是否有副作用时，应声明为 `true`，而不是默认 `false`——这条对应 `terminal.execute_command` 的处理方式，因为终端命令内容不可预知,不能假设它总是安全的。

### 2.2 interruptible 声明规则（v0.2 新增）

呼应 `WORKFLOW_SPEC.md` 的 Workflow 取消语义：工程师可以随时表达"取消"意图，但如果当前正在执行一个不可中途打断的物理操作（HiL 场景下很常见，例如测试台正在执行一段不能中途停止的动作），系统不能粗暴地要求 Client 立即中止。

* `interruptible: true`：该 Capability 的执行可以被安全中止，Client 收到取消信号后可以立即停止。
* `interruptible: false`：该 Capability 的执行一旦开始就必须让它自然结束，不能中途打断。
* **未声明时默认视为 `false`**（保守处理），原因和 `side_effect` 未声明时默认 `true` 是同一个原则：宁可让取消晚一点生效，也不要在不确定的情况下贸然打断一个可能造成危害的物理操作。
* 具体的取消流程（Workflow 何时进入 `CANCELLING`、何时最终转为 `CANCELLED`）由 `WORKFLOW_SPEC.md` 定义，本文件只负责声明这个属性。

现有示例的 `interruptible` 取值：`filesystem.read_file` / `docker.inspect_container` / `test_rig.read_signal_log` 等只读操作均为 `true`（读取过程本身很短，也没有半途而废的风险）；`test_rig.trigger_reset` 视为 `false`（一旦触发重置，中途打断可能让被测对象处于不确定状态，比等它跑完更危险）。

### 2.3 idempotent 声明规则（v0.5 新增）

呼应 `WORKFLOW_SPEC.md` §4.3 的"结果未知与对账"：有副作用的 Step 若结果不确定，默认不自动重试，而是进入 `UNKNOWN` 并对账。若某个 Capability 的副作用**本身是幂等**的（重复执行与执行一次效果相同），则允许在结果不确定时携带 `idempotency_key` 重试。

* `idempotent: true`：该 Capability 的副作用可安全重复执行；Server 可在结果不确定时重试（携带同一 `idempotency_key`）。
* `idempotent: false`（缺省）：不可自动重试，结果不确定时走 `UNKNOWN` + 对账。
* **仅对 `side_effect: true` 有意义**；对只读 Capability 该字段可省略（只读操作本就安全可重试）。
* 声明必须保守：无法确定是否幂等时，声明为 `false`。

现有示例中，`test_rig.trigger_reset` 属于 `idempotent: false`（复位是可重复动作，但"重置"的语义不保证重复执行无害，保守声明为否）；`terminal.execute_command` 同样缺省 `false`。

### 2.4 timeout_hint 声明规则（v0.5 新增）

对应 `PROTOCOL_SPEC.md` §9：Server 需要按 Capability 类型决定 Step 超时，但不同的 Capability 合理耗时差异很大。因此：

* `timeout_hint`（可选，毫秒）：该 Capability 的建议超时 / 预期时长。
* Server 可以覆盖它，并对其设硬上限；未声明时使用全局默认。
* 它只是**建议**，不构成安全边界；`step_timeout` 的最终判定权在 Server。

现有一处明显需要它的示例：`test_rig.trigger_reset` 这类物理动作的合理耗时可能远大于一个只读查询，应在登记时给出 `timeout_hint`。

---

## 3. Capability Manifest

Client 通过 Manifest 向 Server 声明当前可用能力。每一项 Capability 声明的字段（v0.5 起完整如下）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | §2 登记的标准名称 |
| `side_effect` | 是 | 见 §2.1；缺失视为 `true`（保守） |
| `interruptible` | 是 | 见 §2.2；缺失视为 `false`（保守） |
| `idempotent` | 否 | 见 §2.3；缺省 `false` |
| `timeout_hint` | 否 | 见 §2.4（毫秒） |
| `input_schema` | 是（v0.5 起新登记） | 见 §5；缺失时 Server 不强校验并告警 |
| `output_schema` | 是（v0.5 起新登记） | 见 §5；缺失时 Server 不强校验并告警 |

```text
Capability Manifest（示例）
├── git
│   └── collect_diagnostics   side_effect: false, interruptible: true,
│                             input_schema: {...}, output_schema: {...}
├── filesystem
│   └── read_file             side_effect: false, interruptible: true, ...
├── terminal
│   └── execute_command       side_effect: true, interruptible: false, idempotent: false, ...
├── docker
│   └── inspect_container     side_effect: false, interruptible: true, ...
├── browser
│   └── open_page             side_effect: false, interruptible: true, ...
├── local-agent
│   └── diagnose_project      side_effect: false, interruptible: true, ...
├── test_rig
│   ├── read_signal_log       side_effect: false, interruptible: true, ...
│   ├── query_dut_info        side_effect: false, interruptible: true, ...
│   ├── read_fault_code       side_effect: false, interruptible: true, ...
│   └── trigger_reset         side_effect: true, interruptible: false, idempotent: false,
│                             timeout_hint: 60000, ...
└── sim_rig（MVP 模拟项）
    └── trigger_reset         side_effect: true, interruptible: false, idempotent: false,
                              timeout_hint: 30000, ...
```

* 具体 schema 内容见 §5（文档权威），Manifest 在运行时携带同一份 schema（自包含）。
* 协议层如何传输上述字段（`capability.sync` payload 结构、`revision`）由 `PROTOCOL_SPEC.md` §6 定义，本文件只定义"必须具备这些字段"。

---

## 4. Capability 的动态更新

Client 的 Capability 可以动态变化：

```text
Capability Available → Local Service Started → Capability Updated
```

Client 应能够向 Server 更新 Capability 状态（对应协议消息 `capability.sync`：`mode: "full"` 用于初次全量声明、`mode: "incremental"` 用于增量更新，具体字段见 `PROTOCOL_SPEC.md` §6）。更新时 `side_effect`、schema 等字段必须一并携带，不能只更新名称。

**声明版本（v0.5 新增）：** 每次能力声明携带一个会话内**单调递增的 `revision`**；首次全量声明（含 `session.hello` 内联能力）为 `revision: 0`。Server 只应用更高 `revision` 的声明，陈旧 / 乱序的声明丢弃并告警——这解决了重连或乱序时"旧声明覆盖新声明"的问题。

**在途规则（v0.5 新增）：** 能力变化**只影响未来的 `step.dispatch`**，不影响已下发的 Step；若 Client 收到引用已不可用能力的 Step，回 `step.status(REJECTED, reject_reason.code = capability_unavailable)`（见 `PROTOCOL_SPEC.md` §8）。

---

## 5. Capability 输入/输出 Schema（v0.5 新增）

### 5.1 声明语言

采用 **JSON Schema 的一个受限子集**：`type` / `properties` / `required` / `enum` / `items` / `description` / `default`；**不引入外部 `$ref` 与复杂组合（`oneOf` / `anyOf` / `allOf` / `not`）**，以保持两端校验器简单、可互操作。

### 5.2 载体与校验职责（双重载体 + 两端校验）

| 载体 | 内容 | 权威性 |
|---|---|---|
| 本文件 §5.3 | 标准 Capability 的 canonical schema | **文档权威** |
| Capability Manifest / `session.hello` | 运行时携带同一份 schema | 自包含 |

* Server 在生成 / 下发 Step 前，用对应 Capability 的 `input_schema` 校验 `step.dispatch.input`；不合 schema 属 Server 侧问题，不应下发。
* Client 收到不合 `input_schema` 的 `input` → `step.status(REJECTED, reject_reason.code = invalid_input)`。
* Client 返回的 `evidence.result` 必须通过对应 `output_schema`；不合 schema 或 `type` 与声明不一致 → Server 记 `FAILED`，`fail_reason.code = invalid_output`，并告警。
* `Step.expected_output` 是 output schema 的**名称引用**（例如 `git_status`），不再是自由文本。

### 5.3 标准 Capability 的 Schema 登记（示例）

```text
filesystem.read_file:
  input:  { type: object, required: [path], properties: { path: {type: string} } }
  output: file_content            # v0.7：补充输出名称
          { type: object, required: [content, encoding],
            properties: { content: {type: string}, encoding: {type: string},
                          path: {type: string} } }

git.collect_diagnostics:
  input:  { type: object, properties: { project_path: {type: string} } }
  output: git_status
          { type: object, required: [branch],
            properties: { branch: {type: string},
                          modified_files: {type: integer},
                          untracked_files: {type: integer} } }

docker.inspect_container:         # v0.7 新增
  input:  { type: object, required: [container], properties: { container: {type: string} } }
  output: container_info
          { type: object, required: [running],
            properties: { running: {type: boolean}, image: {type: string} } }

test_rig.trigger_reset:
  input:  { type: object, properties: { reason: {type: string} } }
  output: { type: object, required: [reset_ack],
            properties: { reset_ack: {type: boolean} } }

sim_rig.trigger_reset:            # MVP 模拟项
  input:  { type: object, properties: { reason: {type: string} } }
  output: { type: object, required: [reset_ack],
            properties: { reset_ack: {type: boolean} } }
```

> 上表给出格式示例，不代表完整清单。新增 Capability 时，**input/output schema 与 `side_effect` 一样是登记的必要项**（见 §2、§3）。

> **MVP 占位能力（v0.7）：** `local-agent.diagnose_project` / `browser.open_page` 在 MVP 中**只声明、不实现**——不携带 schema（按 §5.4，Server 跳过校验并告警），执行时返回 `capability_error`，**不得伪造证据**。

### 5.4 缺失 schema 的兼容处理

尚未补 schema 的旧接入方：Server 不做强校验，记录告警；一旦补齐即恢复校验。这是为平滑迁移保留的过渡口子，不应被当作长期状态。

---

## 6. 保留 Capability 名称（v0.2 新增；v0.5 补充 I/O）

以下名称由本规范保留，具有特殊含义，**所有 Client 隐式支持，不需要在 Manifest 中声明**：

| 保留名称 | 含义 | side_effect | interruptible | idempotent | I/O |
|---|---|---|---|---|---|
| `human.manual_action` | 用于"建议"这种解决方式——Server 生成一条指令性的 Step，Client 只需要把 `input.instruction` 展示给工程师；工程师在系统外自行执行后，把观察到的结果作为反馈传回，Client 将其包装为 Evidence。系统本身不执行任何操作，因此不需要额外的确认流程——工程师本人就是那个"决定要不要做"的人。 | `false`（固定值） | `true`（约定：取消时可立即终止，见 `WORKFLOW_SPEC.md` §6.1） | 不适用 | 见下 |

**`human.manual_action` 的 I/O（v0.5 新增）：**

```text
input:  { type: object, required: [instruction],
          properties: { instruction: {type: string} } }
output: manual_action_result
        { type: object, required: [outcome, observation],
          properties: {
            outcome:     { type: string, enum: [succeeded, failed, partially, unknown] },
            observation: { type: string },
            details:     { type: object }
          } }
```

* `outcome` 供确定性分支与统计使用；`observation` 保留工程师原话供 Planner 消费（见 `WORKFLOW_SPEC.md` §6.1）。
* 完整的建议路径流程与状态转换由 `WORKFLOW_SPEC.md` §6.1 定义；协议层完全复用 `step.dispatch` / `step.status`，见 `PROTOCOL_SPEC.md` §8.2。

---

## 7. 已知待补项（Open Items）

1. ~~**输入/输出 Schema 缺失**~~ **已解决（v0.5）**：见 §5，采用 JSON Schema 受限子集，双重载体 + 两端校验。
2. ~~**Capability 声明的真实性**~~ **已解决（v0.5）**：schema 落地后，声明与实际不符会在运行时被 schema 校验与 `REJECTED` / `FAILED(invalid_output)` 捕获，不再静默（见 §5.2、`PROTOCOL_SPEC.md` §8）。认证授权部分仍留待 Security Spec。
3. **第三方 Knowledge Base 检索不建模为 Capability（v0.2 已决定）**：曾经讨论过是否要把"查询第三方 Knowledge Base"做成一种特殊 Capability（类似 §6 讨论的 `human.manual_action`）。已决定**不这样做**——这个检索完全是 Server 与外部系统之间的事，不经过 Client，不出现在 Capability Manifest 里，也不会生成 Step。详见 `SERVER_SPEC.md` §4。记录于此，避免以后被重新提出、重新讨论。
4. ~~是否需要"可中断（interruptible）"声明~~ **已决定（v0.2）**：见 §2.2。
5. **`evidence.type` 与声明的输出名称暂不校验（v0.7）**：Manifest 目前只携带 `output_schema`、没有输出名称字段，因此 Server 无法核对 `evidence.type` 是否等于该 Capability 登记的 output 名称（§5.2 的这一条尚未落地）；`result` 仍按 schema 校验。需要时再给 Manifest 增一个 output 名称字段。
6. **`human.manual_action` 的 Client 执行（建议路径）尚未实现（v0.7）**：§6 约定该保留能力由所有 Client 隐式支持，但 MVP 的 client-daemon 只实现了只读数据能力；规划器若下发 `human.manual_action`，当前以 `REJECTED(capability_unavailable)` 收场。完整建议路径（展示 `instruction`、等待工程师反馈）见 `WORKFLOW_SPEC.md` §6.1，留待后续版本。
