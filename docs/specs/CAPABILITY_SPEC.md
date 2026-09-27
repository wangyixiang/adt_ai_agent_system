# CAPABILITY_SPEC.md

- **Version:** v0.1
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

| 标准名称 | 说明 | 废弃/曾用写法 |
|---|---|---|
| `filesystem.read_file` | 读取文件内容 | ~~`filesystem.read`~~（原 SERVER_SPEC v0.2 §9 使用，已收敛为标准名称） |
| `terminal.execute_command` | 执行终端命令 | ~~`terminal.execute`~~（原 SERVER_SPEC v0.2 §9 使用，已收敛） |
| `docker.inspect_container` | 检查容器状态 | ~~`docker.inspect`~~（原 SERVER_SPEC v0.2 §9 使用，已收敛） |
| `git.collect_diagnostics` | 收集 Git 诊断信息（内部可能是多个本地操作的组合，见 `WORKFLOW_SPEC.md` §6） | 无（两份原文档命名一致，保留） |
| `browser.open_page` | 打开指定页面 | 无 |
| `local-agent.diagnose_project` | 调用本地 Agent 做项目诊断 | 无 |

*（原因说明：v0.2 两份文档的示例是各自独立写的，`SERVER_SPEC.md` 用的是更简短的动词形式，`CLIENT_SPEC.md` 用的是更具体的动词+宾语形式。既然 Capability 名称是 Planner 生成 Step 时唯一能引用的标识符，两边必须使用同一套名称，这里统一采用更具体的 `<verb>_<object>` 形式，因为它在 Capability 数量增多后更不容易产生歧义，例如未来出现 `filesystem.write_file` 时不会和 `filesystem.read_file` 混淆成一个笼统的 `filesystem.access`。）*

新增 Capability 时应遵循同样的命名格式，并在本表中登记。

---

## 3. Capability Manifest

Client 通过 Manifest 向 Server 声明当前可用能力：

```text
Capability Manifest（示例）
├── git
│   └── collect_diagnostics
├── filesystem
│   └── read_file
├── terminal
│   └── execute_command
├── docker
│   └── inspect_container
├── browser
│   └── open_page
└── local-agent
    └── diagnose_project
```

---

## 4. Capability 的动态更新

Client 的 Capability 可以动态变化：

```text
Capability Available → Local Service Started → Capability Updated
```

Client 应能够向 Server 更新 Capability 状态（对应协议消息 `capability.manifest` 初次声明、`capability.updated` 增量更新，具体字段见 `PROTOCOL_SPEC.md`，待写）。

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