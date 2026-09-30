# Blob 配置解析器统一（bounded 补丁记录）

> 这不是阶段计划，而是一次 **bounded 变更**的记录：收掉上一份补丁（`2026-09-30-p4d-minors.md`）评审里留下的 M2——"one shared parser" 的说法还差一个站点没兑现。设计在对话中定稿，这里留的是**决策与裁决表**。

- **分支：** `blob-config-parser`（基于 `master` @ `77ba03e`）
- **来源：** `docs/superpowers/plans/2026-09-30-p4d-minors.md` 的「Review 修复轮」表 M2

---

## 决议（定稿于对话）

| 项 | 决议 |
|---|---|
| `blob/config.ts` 的本地 `int()`（`Number.isFinite && > 0`，会接受 `2.5` 当 `BLOB_MAX_BYTES`、且无上界） | **删掉，三个字段都走 `parseBoundedInt`**，`min: 1`（保持"`0` 视为不可用"的既有语义），并各加上限 + `name`（被拒时告警） |
| 上限取值 | `BLOB_TOKEN_TTL_MS` ≤ **24h**（超过一天，签名 URL 不再是有意义的控制）；`BLOB_RETENTION_MS` ≤ **365d**（无上界 = "永不回收"，让 `BlobLifecycle` 形同虚设）；`BLOB_MAX_BYTES` ≤ **8 GiB**（16× 默认；无上界 = 允许客户端灌到磁盘满） |
| `index.ts` 的 `PORT`（`Number(process.env.PORT ?? 8080)`，`PORT=abc` → `NaN` → listen 时 `ERR_SOCKET_BAD_PORT`） | **一起改**：新增 `resolvePort(explicit, env)`，显式选项优先（含 `0`＝任意空闲端口），否则走 `parseBoundedInt`，上下限 `[1, 65535]` |

---

## Review 修复轮（Review fix pass）

整体评审：`opencode-go/deepseek-v4.1-flash`，范围 `77ba03e..470d93f`。**无 Critical**；评审逐项确认设计被忠实执行、三个上限都留了充裕余量（16×/12×/24× 默认值）、`2.5` 那个洞是真 RED→GREEN、`port: 0` 的路径未被破坏、既有 blob 测试的断言没有因为新告警而变得空洞。修复后 **427 passed / 1 skipped**，typecheck 干净。

| 评审项 | 裁决 | 落点 |
|---|---|---|
| **I1（重要）** `PORT` 的保证只到单元层：`env.test.ts` 测了 `resolvePort`，但**没有任何测试证明 `start()` 真的会读 `PORT`**（其它用例一律显式传 `port`）；且该单元测试的告警断言只检查 `warn.mock.calls[0]`，顺序一变就会静默检查错的那一次 | **已修** | ① `start.int.test.ts` 新增用例：临时把 `PORT` 设为一个**动态取得的空闲端口**，断言 `server.url` 用上了它（证明生产入口确实读 `PORT`，且不绑死 8080、不引入固定端口的脆弱性）；② 单元测试改为断言 `toHaveBeenCalledTimes(3)` **且每次调用都含 `PORT`** |
| **I2（重要）** `resolvePort` 只清洗了 `PORT` 这条路：显式传入的 `NaN` / `2.5` / `-1` / `70000` 被**原样返回**，仍然会在 listen 时炸——而函数的文档正宣称"绝不让 Node 拿到 `NaN`"，且 `StartOptions.port` 是公开 API | **已修** | 显式路径同样校验（整数且 `[0, 65535]`，`0` 仍合法），否则告警并回落默认；新增一例 RED→GREEN；文档改为"**两条路都清洗**" |
| **M1** 新增的告警机制缺一例"值在范围内但非整数也告警"的断言 | **已修** | 与 I1 同一次编辑：告警断言覆盖到每一次被拒的调用 |
| **M2** `env.ts` 现在混了一个服务端关切（`resolvePort` / 8080 / 65535），而文件头只描述通用解析 | **已修** | 文件头改写为模块说明，点明 `resolvePort` 为何住在这里 |
| **M3** README 的汇总句没明说"上限是硬回落、不是截断" | **不改（无需）** | 汇总句已写"**不截断**"，且逐条 bullet 都带"上限"；评审自己也标注"很低影响"。再改只是重复 |

**评审"Declined to judge"各行**：**维持**——三个上限的具体数值（设计已在对话中批准，评审只判断是否会切断合理配置，结论是不会）、`KB_TIMEOUT_MS` 故意不设上限（上一份补丁已定，不在本次范围）、`inlineThresholdBytes` 不从环境读（无解析洞）、`retryBaseMs` 无环境开关（既存、本次未动）、blob 令牌在查询串（P4c 的 N8，按设计延后）。

**本次刻意不做**：`resolvePort` 的显式路径与 `PORT` 路径**共用**同一个"拒绝即告警"的文案（两条路的措辞略有差异，但都含变量/范围/回落值）——统一文案的收益不抵多一层抽象。
