# REPORT_SPEC.md

- **Version:** v0.3（部署/信任模型落地：Report 仅提交人可生成 / 查看；Report 可作为 KB 导出对象；依据 `ADR-003`、`PROTOCOL_SPEC.md` v0.5，取代 v0.2）
- **层级:** Specification — Report 的触发、内容约束与输出形式
- **拆分说明:** `REQUIREMENTS.md` FR-17~FR-20 定义了 Report 必须满足的产品要求（按需生成、事实可追溯、不修改 Record、至少一种人类可读形式），`PROTOCOL_SPEC.md` §11 已经在协议层留了 `report.generate_request/result` 的字段位置（`options.detail_level`、`report.format`），但两边都没有定义这些字段具体取什么值、Report 的内容该怎么组织。本文件补上这一环，承接 `RECORD_SPEC.md` 定义的 Record 结构。

---

## 0. 定位：Report 是 Record 的呈现形式，不是独立的事实来源

呼应 `PRODUCT.md` 产品原则3："报告只基于记录生成，不引入记录之外的事实。"

> **Report 不产生新的事实，只对已经存在的 Record（`RECORD_SPEC.md`）做裁剪、排版、按可读性重新组织。生成 Report 这个动作本身不触发任何诊断、不读取任何新的 Evidence。**

如果读者从 Report 里看到一句话，这句话必须能在对应的 Record 里找到出处——不管是 `entries` 里的某一条，还是 `final_result`。这条约束在 §5 会转成具体的生成规则,不只是原则性的话。

---

## 1. 核心原则（对齐 `REQUIREMENTS.md` FR-17~FR-20）

1. **按需生成，不自动生成**（FR-17）：只有工程师主动发起 `report.generate_request` 才会生成，Workflow 终止本身不触发。
2. **事实可追溯**（FR-18）：Report 中每一条事实性陈述，都能定位回 Record 的某个 `entry_id` 或 `final_result` 字段（见 §5.3）。
3. **不修改 Record，可重复生成**（FR-19）：生成 Report 是纯读取操作；同一份 Record 可以用不同 `detail_level` 生成多次，互不影响，也不影响 Record 本身。
4. **至少一种人类可读输出形式**（FR-20）：本版本选定 Markdown（见 §4），预留扩展其他格式的空间，但不在本版本设计。
5. **仅提交人可用，且可作为导出对象（v0.3 新增）**：只有 Record 的提交人（`owner_user_id`）可以生成与查看该 Record 的 Report（`ADR-003` §6）；Report 也可以作为 KB 导出的对象（`PROTOCOL_SPEC.md` §10.3），导出同样不修改 Record。

---

## 2. 触发方式

复用 `PROTOCOL_SPEC.md` §11 已经定义的消息：

```json
{ "type": "report.generate_request", "payload": { "record_id": "rec_001", "options": { "detail_level": "full" } } }
```

```json
{
  "type": "report.generate_result",
  "payload": {
    "record_id": "rec_001",
    "status": "ok",
    "report": { "format": "markdown", "content": "..." },
    "error_code": null,
    "message": null
  }
}
```

本文件的任务是把 `options.detail_level`、`report.format` 这两个此前留白的字段定下来，并（v0.2）定义 `status` / `error_code` 的失败形态（见 §6）。

---

## 3. detail_level（本版本定案两档，非最终枚举）

| 取值 | 内容范围 | 适用场景 |
|---|---|---|
| `summary` | 只用 Record 的 `summary` + `final_result`（见 `RECORD_SPEC.md` §5、§3） | 只需要一个结论性的简短说明,例如口头汇报前快速看一眼 |
| `full` | 展开完整 `entries`，按时间顺序呈现整个诊断过程 | 需要完整留档、给同事复盘、或者要说明"为什么排除了某些方向" |

未指定 `detail_level` 时默认按 `full` 处理——理由：Report 的价值主张之一是"不需要事后靠回忆补记"（`PRODUCT.md` §9 成功标准），默认给更完整的版本比默认给摘要更符合这个目标，工程师需要简短版本时可以显式要求 `summary`。

是否需要更多档位（例如只到"结论"不含过程细节的中间档），留作 §7 待补项，本版本先给这两档能覆盖大部分场景。

---

## 4. 输出格式

本版本只支持 `format: "markdown"`——理由：Markdown 本身就是人类可读的纯文本，不需要额外的渲染环境就能满足 FR-20 的"至少一种人类可读形式"，同时结构清晰，方便工程师直接复制到工单系统、邮件或聊天工具里。

未来是否需要 `html` / `pdf` 等格式，留作 §7 待补项——这属于"报告读者具体要什么"这个还没有答案的开放问题（`REQUIREMENTS.md` Q-4），本版本不预判。

---

## 5. 内容结构（Markdown 模板骨架）

### 5.1 `summary` 档

```markdown
# 诊断报告：{problem_short}

- Record ID: {record_id}
- 状态：{terminal_state}
- 耗时：{duration}

## 结论

{result_short（来自 final_result 的摘要）}
```

### 5.2 `full` 档

```markdown
# 诊断报告：{problem_short}

- Record ID: {record_id}
- 状态：{terminal_state}
- 起止时间：{created_at} ~ {ended_at}

## 问题描述

{user_request.text}

## 诊断过程

{按时间顺序列出 entries，每条渲染为一行，直接复用 RECORD_SPEC.md 里已经生成好的 narrative，不重新组织语言}

- {entries[0].ts} {entries[0].narrative}
- {entries[1].ts} {entries[1].narrative}
- ...

## 结论

{final_result 按 terminal_state 分别渲染：
  COMPLETED → root_cause + resolution_summary
  FAILED → failure_summary
  CANCELLED → cancelled_summary（如有）}

{所有终止态通用（v0.2 新增）：若 final_result 含 unresolved_side_effects，
 追加一段醒目提示：
   "以下副作用动作在 Workflow 结束时未被对账，可能已执行："
 逐条列出 step_id / capability / last_known_state，
 不推断其成功或失败（忠实原则，见 RECORD_SPEC.md §3）。}
```

`summary` 档（§5.1）同样必须体现未对账事实（若存在）：`result_short` 应包含"存在未对账的副作用动作"这一事实，不允许只给一个看起来已解决的结论。

### 5.3 可追溯性的具体做法

生成逻辑在拼装每一段内容时，必须维护一份"这段文字来自 Record 里的哪个字段/哪条 entry"的映射（内部使用，不强制展示给读者，但必须能在需要时被追溯出来，例如用于排查"报告是不是编造了内容"这类问题）。这条规则的检验方式很直接：**Report 里出现的每一句话，删掉它之后，Record 里对应的原始字段应该依然存在且内容一致；反过来，Report 不应该出现任何在 Record 里找不到来源的内容。**

---

## 6. 与 Record 的边界

* **Record 不存在** → 协议层错误：走 `PROTOCOL_SPEC.md` §12 的 `protocol.error`（code=`unknown_record`），不是 Report 内容层面的问题。
* **生成过程失败**（v0.2 新增）：Record 存在但生成不成功时，返回 `report.generate_result`，`status: "failed"`，`error_code` 取值 `generation_failed` / `insufficient_content` / `invalid_option` / `timeout`，并给出 `message`。Client 可重试；失败**不写 Record**、不产生副作用。
* **可见性（v0.3 新增）**：只有 Record 的提交人可生成 / 查看其 Report；请求他人 Record 的 Report 走 `protocol.error`（code=`unknown_record`），不泄露存在性。
* **导出（v0.3 新增）**：Report 可作为 KB 导出对象（`record.export_request(object="report")`）；导出不修改 Record、也不持久化 Report。
* Report 一旦生成并返回给 Client，之后不会被 Server 主动追踪或更新——如果 Record 后续有任何变化（正常情况下不会，Record 只读，见 `RECORD_SPEC.md` §1），已经生成的 Report 也不会跟着变。
* Report 本身**不持久化在 Server 端**（本版本假设）——每次 `report.generate_request` 都是重新生成，Client 端如果需要保留副本，由 Client 自行决定是否本地保存。这一点如果需要改变（例如以后想让 Server 缓存生成过的 Report），是个待决项，见 §7。

---

## 7. 已知待补项（Open Items）

1. **报告读者是谁、模板要不要按读者定制**（`REQUIREMENTS.md` Q-4 仍未解决）：本文件给的是一个最小可用的默认模板，不代表最终设计——如果确定了报告主要给"主管"看还是"同事复盘"看，模板的详略、语气可能需要调整。
2. **是否需要更多输出格式**（HTML/PDF 等）：本版本只做 Markdown，见 §4。
3. **`detail_level` 是否需要更多档位**：本版本只给 `summary`/`full` 两档，见 §3。
4. **Report 是否需要持久化/缓存**：见 §6，本版本假设每次都重新生成，不缓存。
5. **"生成人" / "确认人"**：v0.3 起已有最小身份（`user_id` 必填并由 Server 校验，见 `ADR-003` §3），但 `RECORD_SPEC.md` §4 的 `actor` 仍为预留，Report 模板仍未展示"生成人"。待身份体系完善（`REQUIREMENTS.md` Q-5 的剩余部分）后再填充。
