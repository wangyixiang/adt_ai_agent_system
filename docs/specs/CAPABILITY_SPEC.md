# CAPABILITY_SPEC.md

- **Version:** v0.2（对齐 HiL 场景与 side_effect 声明，取代 v0.1）
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

*（原因说明：v0.2 两份文档的示例是各自独立写的，`SERVER_SPEC.md` 用的是更简短的动词形式，`CLIENT_SPEC.md` 用的是更具体的动词+宾语形式。既然 Capability 名称是 Planner 生成 Step 时唯一能引用的标识符，两边必须使用同一套名称，这里统一采用更具体的 `<verb>_<object>` 形式，因为它在 Capability 数量增多后更不容易产生歧义，例如未来出现 `filesystem.write_file` 时不会和 `filesystem.read_file` 混淆成一个笼统的 `filesystem.access`。）*

新增 Capability 时应遵循同样的命名格式，并在本表中登记，**同时必须登记 side_effect**（见 §3 说明）。

### 2.1 side_effect 声明规则（v0.2 新增）

* `side_effect: false`：只读/无副作用操作。Server 可以直接下发对应 Step，不需要工程师确认即可执行。
* `side_effect: true`：会改变硬件、被测对象或本地环境状态的操作。Server 下发这类 Step 前，必须先让工程师确认（具体确认流程——Step 什么时候进入 WAITING、拒绝时如何处理——由 `WORKFLOW_SPEC.md` 定义，本文件只负责声明这个属性）。
* 声明必须保守：无法确定是否有副作用时，应声明为 `true`，而不是默认 `false`——这条对应 `terminal.execute_command` 的处理方式，因为终端命令内容不可预知,不能假设它总是安全的。

---

## 3. Capability Manifest

Client 通过 Manifest 向 Server 声明当前可用能力，**每一项都必须携带 side_effect**（v0.2 新增要求）：

```text
Capability Manifest（示例）
├── git
│   └── collect_diagnostics        side_effect: false
├── filesystem
│   └── read_file                  side_effect: false
├── terminal
│   └── execute_command            side_effect: true
├── docker
│   └── inspect_container          side_effect: false
├── browser
│   └── open_page                  side_effect: false
├── local-agent
│   └── diagnose_project           side_effect: false
└── test_rig
    ├── read_signal_log            side_effect: false
    ├── query_dut_info             side_effect: false
    ├── read_fault_code            side_effect: false
    └── trigger_reset              side_effect: true
```

具体在协议层如何传输 side_effect 字段（`capability.sync` payload 的结构调整），留给 `PROTOCOL_SPEC.md` 处理，本文件只定义"必须有这个字段"。

---

## 4. Capability 的动态更新

Client 的 Capability 可以动态变化：

```text
Capability Available → Local Service Started → Capability Updated
```

Client 应能够向 Server 更新 Capability 状态（对应协议消息 `capability.manifest` 初次声明、`capability.updated` 增量更新，具体字段见 `PROTOCOL_SPEC.md`，待写）。更新时 side_effect 声明必须一并携带，不能只更新名称。

---

## 5. 已知待补项（Open Items）

1. **输入/输出 Schema 缺失**：目前每个 Capability 只有一个名字，没有声明它接受什么参数、返回什么结构。Planner 生成 `Step.input` 时缺乏依据。建议后续版本给每个 Capability 补充最小的字段声明，例如：

   ```text
   filesystem.read_file:
     input:
       path: string
     output:
       content: string
       encoding: string
   ```

2. **Capability 声明的真实性**：Client 自主上报"我有什么能力"，Server 直接采信。除了后续 Security Spec 要处理的认证授权问题之外，即使排除恶意场景，"声明与实际实现不一致"也是一个工程问题——建议约定：声明的 Capability 在实际调用时若无法执行，应作为 `execution.failed`（或 `WORKFLOW_SPEC.md` §11 提到的"拒绝执行"信号）处理，而不是静默失败。

3. **第三方 Knowledge Base 检索不建模为 Capability（v0.2 已决定）**：曾经讨论过是否要把"查询第三方 Knowledge Base"做成一种特殊 Capability（类似 §6 讨论的 `human.manual_action`）。已决定**不这样做**——这个检索完全是 Server 与外部系统之间的事，不经过 Client，不出现在 Capability Manifest 里，也不会生成 Step。详见 `SERVER_SPEC.md` v0.4 §4。记录于此，避免以后被重新提出、重新讨论。

4. **是否需要"可中断（interruptible）"声明（v0.2 新增，待决）**：`WORKFLOW_SPEC.md` 关于 Workflow 取消语义的讨论中提出——如果一个 Step 正在执行不可打断的物理操作（例如测试台正在执行一个不能中途停止的动作），取消 Workflow 时不能粗暴地要求 Client 立即中止。这可能需要类似 `side_effect` 的声明，例如 `interruptible: true/false`，但这个字段该怎么定、由谁在什么时候使用，还没有定案，标记为待决项，不在本版本加。

---

## 6. 保留 Capability 名称（v0.2 新增）

以下名称由本规范保留，具有特殊含义，**所有 Client 隐式支持，不需要在 Manifest 中声明**：

| 保留名称 | 含义 | side_effect |
|---|---|---|
| `human.manual_action` | 用于"建议"这种解决方式——Server 生成一条指令性的 Step，Client 只需要把 `input.instruction` 展示给工程师；工程师在系统外自行执行后，把观察到的结果作为反馈传回，Client 将其包装为 Evidence。系统本身不执行任何操作，因此不需要额外的确认流程——工程师本人就是那个"决定要不要做"的人。 | `false`（固定值，不需要声明） |

这个设计的完整流程和状态转换，由 `WORKFLOW_SPEC.md` 定义（讨论已经定下方向，具体条文尚未落笔，见变更记录）。
