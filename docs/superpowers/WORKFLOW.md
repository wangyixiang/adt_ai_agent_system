# WORKFLOW.md — 本仓库的阶段推进约定

> 这不是规格，而是**我们实际怎么推进这个项目**的记录。新会话或新 agent 先读它，可以不必把已经付出过代价的教训再买一遍。
>
> 本文件与 superpowers 技能（`using-superpowers` 目录）对齐；**有意偏离**技能默认的地方（集成方式、默认执行方式、裁决表落点）在各节以"覆盖 / 有意选择"标注。

## 1. 从想法到计划

- **新子系统/新接口先 `brainstorming`**：先分类（spike / bounded / architectural）。architectural 产物是 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`，**人审阅通过后**才进 `writing-plans`；spike 只交结论、bounded 只给聊天内短设计（都须人点头，不落计划文件）。跨多个独立子系统的，先在 brainstorming 拆成子项目，各自 spec→plan→实现。
- 计划落在 `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`，用 `writing-plans` 写。
- **计划头是强制的**（`writing-plans` 模板）：标题 + `> For agentic workers:` 那行 + `Goal` / `Architecture` / `Tech Stack` / `Spec`（它实现的 spec 路径）。执行者**计划与 spec 两处都读**。
- 计划必须含 `## Global Constraints`、`## Review Focus`，并写明**刻意不做**的部分（避免"没做"和"忘了"看起来一样）。
- **spec 是约束，计划是它对 spec 的论证**；两者冲突时以 spec 为准，并按 §4 记裁决。
- 写完计划做 `writing-plans` 的**自审**：spec 逐条覆盖、每个步骤只决定一件事、类型/签名前后一致、`Review Focus` 每条都落到某个任务的测试、计划篇幅不喧宾夺主。发现即改，不另开一轮。
- 计划**入库**：它是被执行的契约，不是草稿；执行中若发现计划有错，**改计划并一起提交**，而不是只在代码里默默偏离。
- 规格若覆盖多个相互独立的子系统，拆成多份计划（P4a/P4b/P4c/P4d 就是这么来的）；**一次只做一份**，做完合并再写下一份。

## 2. 执行：隔离工作区、逐任务、TDD、带台账

- **隔离**：用 `using-git-worktrees` 建隔离工作区（或确认已在其中一个——worktree 或 harness 原生隔离）；退而求其次至少开**特性分支**，绝不在 `master` 上直接开做。项目内建 worktree 目录须先确认已 gitignore。
- 先把计划提交上去；建**进度台账** `.superpowers/sdd/<plan-basename>/progress.md`（首行写计划路径，目录由 `subagent-driven-development/scripts/sdd-workspace` 产出）。每个任务一行 `Task N: complete (commits a..b, tests: <cmd> → <result>)`。压缩或换会话后**以台账与 `git log` 为准**，不凭记忆重做。
- 执行用 `executing-plans`（本仓库默认**内联执行**；`subagent-driven-development` 是备选，见 §10）。不要跳任务顺序，计划里的"执行顺序依赖"是有原因的。
- `executing-plans` 要求**先加载 `test-driven-development`**：按任务**先写失败测试、跑红（对照计划里的 `Expected:`）、再实现、跑绿、单独提交**。每一步命令都读真实输出，不靠看 diff 猜。
- **连续执行、边做边裁决**：不在任务之间停下问"要不要继续"；冲突、歧义、计划缺陷自己裁决并记台账（`Ruling: <决定> — <理由> — <错了的代价>`）。**只有四种情况停**：不可逆/破坏性操作、安全敏感动作、worktree 外的副作用（merge / push / publish）、计划坏到每条路都是猜。
- **代码错了**（不是计划错）→ 转 `systematic-debugging`：先查根因，不补症状。
- 任务粒度：一个任务 = 一个可独立验收、可独立提交的交付物。
- 每个任务收尾按 `verification-before-completion` 的完成契约办：该任务涉及的测试现场跑过、输出读过、每个 `Expected:` 都对照过，才算完成。

## 3. 一次整分支 review，然后一轮修复

- 分支做完跑**一次** fresh 的整分支 review（用 `requesting-code-review` 的模板派 subagent；模型由人指定，本项目历史用 `opencode-go/deepseek-v4.1-flash`）。
- review 产出分三类：**阻塞项 / 非阻塞项 / 规格漂移**。
- **按实际影响重新分级**，不照抄评审标签：标准是"合进去后一个正常用户会遭遇什么"，而不是"spec 提没提这个输入"。评审里"不予判断"的每一条也要自己裁决。
- 修复用**一轮**集中提交，不逐条来回拉扯：**每个 Critical/Important 修复先写复现测试（RED）再改（GREEN），然后跑全量套件**。
- Minor 不进修复轮，按 §4 记为"延后"。
- 修复轮本身也会引入回归（P4a 出现过"把并发抢占误判成 `planner_error`"），所以修完要**再确认关键路径**。

## 4. 评审项裁决表（硬规则）

§2 的台账在阶段收尾汇总成这张表。每份计划收尾**必须**有一张表，覆盖评审提出的**每一项**——包括"代码对了但没测试"这类：

| 裁决 | 含义 |
|---|---|
| 已修 | 当轮改掉，并写明落点（文件 / 测试） |
| 已记录（规格） | 行为或边界写进规格与计划，它不是待办 |
| 延后 | **必须写理由与触发条件**，并汇总进该阶段 handoff |

**不允许只在对话里判断。** 教训来源：P4c 漏了 2 项（配置无测试；新加的校验没写进规格）、P4a 漏了 3 项（代码修了、测试没补）、P4b 其实没有延后项但没写明"无延后项"，读起来和"忘了清点"一样。

裁决表落进**计划文件并提交**（技能默认把裁决留在会被删掉的 workspace 台账里，这里是有意加强）。整分支 review 干净、修复提交后，删除该计划的 `.superpowers/sdd/<plan-basename>/` 工作区——git 历史即记录；其它计划的目录不要动。

## 5. 文档交叉检查

- 代码改完 `grep` 一遍规范类文档，确认没有"旧规则"残留（P4a/P4b 都出现过 `SERVER_SPEC` / `PROTOCOL_SPEC` 仍在描述被取代的行为）。
- 规范类文档一改就同步：页首 `Version`、`docs/REQUIREMENTS.md` §7 的版本行、以及被它引用的其它文档。
- **改文案用 `edit` 工具**，不要用会做换行转换的脚本写回文件：仓库一律 LF，脚本在 Windows 上会写成 CRLF，让提交变成整文件改动（P4b 发生过一次，事后单独提交修回）。

## 6. 合并与提交纪律

- 收尾按 `finishing-a-development-branch` 的**精神**办：先确认全量测试绿，再谈集成。**本仓库的集成方式已锁定，覆盖该技能的"合并 / PR / 保留"三选一菜单。**
- 合并顺序：**在合并结果上再跑一次全量测试** → 本地 `ff-merge` 到 `master` → 删除分支。
- **不 push**，除非人明确要求（本地一直领先远端）。
- 一个任务一个提交；合并后的零散小修（换行符、deferred minors）可直接提交。
- `.superpowers/` 与 `docs/superpowers/handoffs/` 是本地工作产物（已 gitignore），不推。

## 7. 验证口径

- **证据先于声明**（`verification-before-completion`）：没有在本条消息里现场跑过的命令，不能说"通过"；刚跑过也不算，要跑全、读输出、核退出码。
- 改代码必须跑：`pnpm test`（根脚本，内部 `--workspace-concurrency=1` **强制串行**）与 `pnpm -r --if-present typecheck`（**全部 package**；`--if-present` 已排除没有该脚本的）。
- **两个 package 的测试不能并行跑**：它们共享 `adt_test` 且会 `TRUNCATE`，并行会互相打架（根 `test` 脚本用 `--workspace-concurrency=1` 强制串行；`typecheck` 可并行）。
- Postgres 由 `docker compose` 提供（`localhost:55432`）。Docker 掉线时表现为测试挂住（P4c 遇到过），**先确认 `docker compose ps` 健康再下"失败"的结论**。
- **各产品线自己的"出口"在它自己的计划里写明**。例如桌面产品线的出口是"`client-electron` 能**打包并启动**"（打包冒烟）；用了原生模块则需 `@electron/rebuild`。
- 评审/实现若由 subagent 承担：**不采信它的"成功"报告**，以 git diff 与现场重跑为准。

## 8. 延后项

- 延后项写在对应计划的「移交后续计划的待办」与阶段 handoff 里；跨阶段的开放项（例如"时间预算护栏的单调钟""客户端与服务端超时同值"）按阶段记录，接手时先扫一遍。

## 9. ADR（架构决策）

- `docs/adr/ADR-NNN-*.md` 记录**不可轻易更改的架构决策**；**正文不改**。
- 推翻某条决定：写一份**新 ADR 取代它**，并在被取代的 ADR 头部加一行"被取代"指向新 ADR（**不在旧正文里改决定**）。
- `Status` 走 **`PROPOSED`（评审中）→ `ACCEPTED`**；未 `ACCEPTED` 的 ADR 不作为实现依据。
- ADR 落地后照 §1 写实现计划（计划里写明它依据哪份 ADR）。

## 10. 执行方式与技能对照

- 本仓库默认**内联执行**（`executing-plans`）：设计已由计划承载，成本最低，收尾仍有一次整分支 fresh review。这是对 `writing-plans` 交接菜单的**有意选择**。
- 需要**逐任务评审门**时（计划较长、上下文会被压缩，或想每个任务都有独立的实现者 + 规格/质量双评审），改用 `subagent-driven-development`：交接时给出选择。两种方式共用同一个 `.superpowers/sdd/<plan>/` 工作区与台账，可在中途换执行者并从台账续接。
- 技能对照：新东西 → `brainstorming`；写计划 → `writing-plans`；执行 → `executing-plans`（或 `subagent-driven-development`）+ `test-driven-development`；卡住 → `systematic-debugging`；提评审/收评审 → `requesting-code-review` / `receiving-code-review`；声明完成前 → `verification-before-completion`；隔离 → `using-git-worktrees`；收尾 → `finishing-a-development-branch`（本仓库集成方式见 §6）；阶段交接 → `handoff`。
