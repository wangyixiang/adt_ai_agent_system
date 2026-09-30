# client-cli 的延后项（bounded 补丁记录）

> 这不是阶段计划，而是一次 **bounded 变更**的记录：收掉 `client-cli` 整分支 review 里被延后的四条 minor（`docs/superpowers/plans/2026-09-30-client-cli.md` 的 M1–M4）。设计在对话中定稿，这里留的是**决策与裁决表**。

- **分支：** `cli-minors`（基于 `master` @ `6f06be7`）
- **来源：** `2026-09-30-client-cli.md`「Review 修复轮」的 M1–M4

---

## 决议（定稿于对话）

| # | 原延后项 | 决议 |
|---|---|---|
| **F1** | 宿主回调的提示用裸 `JSON.stringify`，而 `render.ts` 有键序稳定的 `stableJson` | **修**：`stableJson` 改为导出，两个会打印 `input` 的提示构造器改用它——同一个 Step 的两处提示读起来一致 |
| **F2** | `renderDispatch` 直接插值 `objective`（wire 必填、daemon 类型可缺） | **修**：加 `?? "（未给出目标）"`，与"不发明 / 不打印 `undefined`"的口径一致 |
| **F3** | `parseArgs` 静默忽略未知 flag；末位缺值的 flag 静默消失 | **修**：`parseArgs` 多返回 `unknownFlags` / `valuelessFlags`（纯函数，可测），`main.ts` 在**建 readline 之前**往 stderr 各打一行——**只告警不退出**（你批准的选择） |
| **F4** | 完成候选的 IIFE 是 fire-and-forget，快速关闭可能与 `daemon.close()` 竞争 | **修**：抽 `createInFlight()`（`track` / `drain`），`runCli` 在**每条退出路径**上 `drain()` 后再返回 |

---

## Review 修复轮（Review fix pass）

整体评审：`opencode-go/deepseek-v4.1-flash`，范围 `6f06be7..175bd9f`。**无 Critical**；评审逐条确认 F1/F2/F3 在关键路径上正确且测试是真的（F3 的 `--usr alice --user bob` 这种"未知 flag 后面跟值"的难例也处理对了），并独立复现 `createInFlight` 无未处理拒绝、无死循环。修复后 **470 passed / 1 skipped**，typecheck 干净。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **I1（重要）** F4 把 `:quit` 变成"先回答一个你没问的问题再退"：`drain()` 会等那个完成候选的提问，而该提问排在命令提示之后——于是 `:quit` 之后还会弹出"接受这个结论吗？"，且"再见。"被推迟 | **已修（比评审建议更进一步）** | ① `runCli` 增 `quitting` 标志，退出时置位；② 队列新增 `askUnless(skip, q)`：**轮到它时**再判一次，退出则跳过（返回 `null`）——这样"排队时还没轮到"的那一问也会被跳过，而不只是"不再问新的"；③ 被跳过时不发 `workflow.completion_response`（会话要结束了，交给 Server 回收）。两例 RED→GREEN：候选在退出后到达、候选在回答 `:quit` 期间到达（评审的原始复现） |
| **I2（重要）** F2 的守卫只加在 `renderDispatch` 上，而它刚被 F1 对齐的那两个提示构造器仍在裸插值 `objective`——`buildHostCallbacks` 是公开接缝，任何没带 `objective` 的调用方都会看到 `undefined` | **已修** | `renderConfirmationPrompt` 与 `renderUserInputPrompt` 都加 `?? "（未给出目标）"`；一例 RED→GREEN 断言提示里不出现 `undefined` |
| **M4** `valuelessFlags` 的文案无条件说"已用默认值"，但 `--user` 没有可用的默认值（下一行就打印用法并退出 2） | **已修** | 文案改为"缺少值的参数（已忽略）"——我自己刚写的那句话不该是假的 |
| **M5** F1 的测试只钉了**顶层**键序，没钉嵌套对象 / 对象数组 | **已修** | 同一测试补一个嵌套例：`{zeta:{b,a}, alpha:[{y,x}]}` → `{"alpha":[{"x":2,"y":1}],"zeta":{"a":2,"b":1}}` |
| **M6** `stableJson` 从 `render.ts` 导出了，但没从包入口 `index.ts` 再导出（其它 render 导出都在） | **已修** | `index.ts` 补上 `stableJson` |
| **M3** `--url --user alice` 会静默误解析（`url` 变成字面量 `"--user"`，`--user` 被吃掉）——F3 的新机制本可以顺手拦住 | **延后（理由）** | 这是**既存**行为（`inline ?? argv[++index]` 从不检查下一个 token 是不是 flag），不在本次获批范围；F3 的机制让它变得便宜（下一个 token 以 `--` 开头就记进 `valuelessFlags`），但改它会改变既有语义。**列为后续项** |

**评审"Declined to judge"各行**：**维持**——daemon 侧的 `objective ?? ""` 强制（上游、未动）、`renderReport` 的 N5（上一阶段已裁决"不改"）、`readlinePrompter` 的 M5 监听器（上一阶段已裁决"不改"）、`--secret=` 得空串（既存解析行为）、README 不提新告警（设计未要求）、`createInFlight`/`stableJson` 的入口导出（M6 已修 `stableJson`，`createInFlight` 不必要公开）。

**本次刻意不做**：M3 的 flag-值判定、把 `console.ts`（现 ~470 行）拆成 `prompter.ts` / `args.ts`。
