# REQUIREMENTS.md

**Version:** v0.1（首次编写）
**层级:** Requirements — 必须做什么
**关联:** 承接 `PRODUCT.md`。本文件中的场景与约束会反过来要求 `WORKFLOW_SPEC.md` / `CAPABILITY_SPEC.md` / `PROTOCOL_SPEC.md` 做相应扩展，具体在各节末尾标注"待补"。

---

## 1. 核心用户场景（Primary Flow）

1. 工程师通过 Client 提交自然语言描述的问题（对应 `workflow.request`）。
2. Server 创建 Workflow，开始规划信息收集类 Step。
3. Client 执行 Step（读取测试日志、查询测试台当前状态等），返回 Evidence。
4. Server 基于 Evidence 反复 Re-plan，逐步缩小根因范围。
5. Server 判断达到 Completion Candidate；若诊断指向需要执行修复动作，先生成一个"提议修复方案"的 Step。
6. 分两种路径：
   * **建议类**：工程师阅读建议，自行离线执行，之后回来告知系统"已解决"。
   * **执行类**：Step 携带明确的"需要人工确认"标记，Client 展示给工程师；确认后才真正执行，拒绝则视为 `REJECTED`，Server 重新规划。
7. 工程师最终确认问题解决（`workflow.completion_response(solved)`）。
8. 系统自动把整个 Workflow 归档为 Audit Record（新流程，当前 Spec 未定义，见 §5）。
9. 工程师或审核人员可随时基于 Audit Record 生成报告（新流程，见 §6）。

---

## 2. 功能需求（Functional Requirements）

| 编号 | 需求 | 现状 |
|---|---|---|
| FR-1 | 支持以自然语言提交问题 | 已被 `workflow.request` 覆盖 |
| FR-2 | 诊断过程中动态生成信息收集类 Step，无需预先固定诊断脚本 | 已被 One-Step Planning（`ADR-002`）覆盖 |
| FR-3 | Capability 需要区分"只读/无副作用"与"有副作用/需人工确认" | **待补**：`CAPABILITY_SPEC.md` 需新增分类字段 |
| FR-4 | 有副作用的 Capability，在工程师明确确认之前不得执行 | **待补**：需要定义"确认"这个动作本身如何建模——是否复用 `WORKFLOW_SPEC.md` 的 `WAITING` 状态，还是需要专门的确认机制，目前未设计 |
| FR-5 | Workflow 进入 `COMPLETED` 后自动生成 Audit Record | **待补**：全新概念，见 §5，建议独立输出 `AUDIT_SPEC.md` |
| FR-6 | Audit Record 一旦生成不可被篡改（含全部 Evidence 和人工确认记录） | **待补**：涉及存储层设计，见 §3 NFR-1 |
| FR-7 | 支持基于 Audit Record 按需生成人类可读报告 | **待补**：全新，见 §6 |
| FR-8 | 工程师可在诊断进行中查看当前已收集的证据和进展，不必等到 Completion | **待补**：当前协议只有 Server 主动推送 Step，没有"中途查询已有 Evidence"的读接口 |
| FR-9 | Capability 集合可插拔，不同 HiL 测试环境可注册各自的 Capability 而不改动核心 Workflow 逻辑 | 命名规范已被 `CAPABILITY_SPEC.md` 覆盖，但"注册/发现机制"目前只有 `capability.sync`，缺少更完整的领域包管理设计 |

---

## 3. 非功能需求（NFR）

* **NFR-1 完整性/不可篡改性**：Audit Record 一旦生成，任何后续修改必须留痕而不是覆盖。具体机制（Hash Chain、Append-only 存储、外部时间戳服务等）留给后续技术选型，本文件只确认"必须保证"这个要求本身。
* **NFR-2 记录保留期限**：取决于具体行业的合规要求，本版本未定，见 §7 开放问题。
* **NFR-3 并发性**：`PROTOCOL_SPEC.md` 已支持同一工程师在一个 session 内并行多个 Workflow；但多个工程师是否可能针对**同一套物理测试硬件**同时报告问题、Workflow 之间要不要感知彼此以避免冲突的修复动作，目前完全没有考虑，见 §7 开放问题。
* **NFR-4 时延**：诊断辅助是工程师现场实时交互场景，Step 往返延迟需要控制在可接受范围内；具体阈值取决于 Capability 本身的执行耗时（"查询状态"和"重新烧录固件"的耗时数量级完全不同），本版本不设统一数值。
* **NFR-5 弱网/离线容忍度**：测试现场网络可能不稳定。`PROTOCOL_SPEC.md` 的 `session.resume` 提供了断线重连的基础支持，但"诊断过程中长时间离线，Client 能否继续本地执行、事后同步"尚未定义。

---

## 4. Completion Criteria 由谁定义

`WORKFLOW_SPEC.md` §8 提到"可形式化 Request"需要 Completion Criteria（例如 `health_check == OK`），但没有说明这些标准从哪里来、由谁定义。

**建议**：Completion Criteria 应作为 Capability 的一部分声明（例如一个"健康检查"类 Capability 自带判定规则），而不是每次由 Planner 临时决定，也不是每次由工程师手动约定。这样能保证同类问题的判定标准一致、可复用，直接支持 `PRODUCT.md` §7 "团队诊断知识可复用"这条成功标准。此建议需反馈回 `CAPABILITY_SPEC.md` 做扩展。

---

## 5. 新概念：Audit Record（需要独立 Spec）

Audit Record 应至少包含：

```text
Audit Record
├── original_user_request     原始自然语言问题
├── workflow_id / 时间范围
├── steps[]                   每个 Step 的 objective / capability / input
├── evidence[]                 每个 Step 产生的 Evidence
├── human_actions[]            每一次人工确认/拒绝，含操作人身份、时间戳
└── final_resolution           最终结论（问题是什么、如何解决的）
```

Audit Record **不是** Evidence 的另一个名字：Evidence 是诊断过程中的临时依据（`WORKFLOW_SPEC.md` 里定位为 Re-plan 的输入），Audit Record 是 Workflow 结束后对整个生命周期的完整封存，两者的可变性、保留策略、访问权限都应该不同。具体 Schema 本文件不展开，建议单独输出 `AUDIT_SPEC.md`。

---

## 6. 新概念：Report（需要独立 Spec 或功能规格）

报告的受众、格式、模板化程度目前都是开放问题（见 §7）。本文件只确认这是一个必须支持的功能：基于 Audit Record 按需生成，不需要重新收集数据。

---

## 7. 开放问题（Open Questions）

1. 报告的受众/格式：面向内部工程师的简报，还是要满足特定认证机构的格式要求？两者对模板设计的要求差异很大。
2. 谁有权限确认执行有副作用的修复动作：报告问题的工程师本人，还是需要更高权限的审批？
3. Audit Record 的访问权限模型：谁能查看/导出，是否需要脱敏？
4. 记录保留期限的具体要求（取决于最终落地的具体行业/客户）。
5. 多工程师是否可能针对同一套物理测试硬件同时报告问题？如果可能，Workflow 之间要不要感知彼此，避免同时对同一硬件执行冲突的修复动作？

这五个问题目前都没有足够信息回答，不建议在没有真实客户/场景输入的情况下臆测答案——建议保留为开放问题，等第一个具体落地场景明确后再补齐，而不是现在就假设一个答案写死进 Spec。

---

## 8. 非目标（承接 `PRODUCT.md`，具体化）

* 不在 v0.1 定义具体的报告模板格式。
* 不在 v0.1 解决多工程师并发操作同一物理硬件的冲突问题（见 §7-5，作为开放问题保留）。
* 不在 v0.1 选型具体的不可篡改存储技术方案（见 NFR-1）。