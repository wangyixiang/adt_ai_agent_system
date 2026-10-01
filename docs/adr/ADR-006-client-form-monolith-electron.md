# ADR-006: Client 形态——单体 Electron 应用

- **Status:** ACCEPTED
- **日期:** 2026-10-01
- **关联:** `ADR-003`（部署与信任模型）、`ADR-004`（技术栈；本 ADR 取代其 Client 形态一行）、`PROTOCOL_SPEC.md`（不变）、`CAPABILITY_SPEC.md`、`REQUIREMENTS.md` NFR-7、`docs/superpowers/specs/2026-09-29-mvp-scope.md`
- **来源:** 桌面产品形态决定
- **取代:** `ADR-004` §3 的"形态"行与 §Rejected Alternatives 中"Client 直接用 Electron 单应用"一条

---

## Context

Client 侧现在的代码：

* `packages/client-daemon`：一个**库**——连接与握手、可插拔 Capability 适配器、`node:sqlite` 幂等台账、会话存储、blob 收发；对外入口是 `ClientDaemon.connect(...)` 与 `HostPort`（四个决策：确认 / 手工动作 / 资源冲突 / 完成候选）。
* `packages/client-cli`：终端控制台，**在同一个 Node 进程内** `import` `@adt/client-daemon` 使用它——进程内宿主，四个决策由终端回答。
* `packages/server`、`packages/shared`：Server 与共享协议类型。

我们要的是一个**桌面产品**：双击即用、可分发、有图形界面。`ADR-004` §3 当时把 Client 形态定为"本地 Node daemon + 浏览器 UI"，并在 §Rejected 里否决了 Electron 单应用。本 ADR 推翻这两处：桌面产品做成**一个单体 Electron 应用**——`client-daemon` 作为库嵌进同一个程序里，不再有第二个进程。

（`ADR-004` 的其余决定不变：TS/Node 同栈、Server 的 Fastify + `ws` + Postgres、Capability 适配器层、`node:sqlite` 台账、`BlobStore`、认证。）

---

## Decision

### 1. 形态

* Client 桌面产品 = **一个 Electron 应用程序，打成单个可分发 exe**。
* `client-daemon` **作为一个 package 在 Electron 的 main 进程内直接使用**（`import { ClientDaemon } from "@adt/client-daemon"`），与 `client-cli` 用它完全一样。
* UI 是 Electron 的 **renderer**；renderer 通过 **preload + `contextBridge` 暴露的 IPC** 与 main 里的 daemon 通讯。
* 安全基线：`contextIsolation: true`、`nodeIntegration: false`；**renderer 不直接持有 Node、不直接 import daemon**。

### 2. 程序结构（目录名由实现计划定）

```text
client-electron/
├── src/main/       # 内嵌 client-daemon：连接、能力、台账、会话、blob；四决策的宿主端口
├── src/preload/    # contextBridge：把"快照 / 事件 / 命令 / 回答"这一小组能力暴露给 renderer
└── src/renderer/   # UI：对话流、工具卡、四张决策卡
```

### 3. 四个决策的宿主

`client-daemon` 已有 `HostPort`（确认 / 手工动作 / 资源冲突 / 完成候选）。单体里这个宿主由 **renderer 的卡片**回答：main 把问题经 IPC 推给 renderer，renderer 把人的点击经 IPC 送回 main 解析成 `HostPort` 的返回值。**没人回答时仍落安全默认**（拒绝 / `stop` / 无反馈 / `not_solved`）——这条由 daemon 定义，不随宿主形态变。

### 4. 数据与生命周期

* 幂等台账与会话存储落在 Electron 的 `app.getPath("userData")` 下（不再是工作目录里的 `.adt/…`）。
* 应用退出时正在跑的 Workflow 如何处理（取消 / 等待收敛 / 托盘后台继续）见 §开放项。

---

## Superseded（被取代的措辞）

* `ADR-004` §3 形态行"本地 Node daemon + 浏览器 UI（localhost）" → **改为：单体 Electron 应用（main 内嵌 client-daemon，renderer 经 IPC）**。
* `ADR-004` §Rejected Alternatives 第一条"Client 直接用 Electron 单应用"的否决 → **撤销**。
* `ADR-004` 其余决定**不变**；`ADR-004` 正文不改，以本 ADR 取代。

---

## Rejected Alternatives

* **renderer 直接用 daemon / 打开 `nodeIntegration`**：renderer 拿到 Node 与凭据面，安全边界过宽；**否决**。改 IPC + `contextIsolation`。
* **在单体里保留一个本地 HTTP 服务给 renderer 用**：多一个端口、一套鉴权面，只为进程内通讯，不必要；**否决**。单体就用 IPC。
* **Tauri（Rust 壳）**：体积小、安全，但引入 Rust，与"TS 同栈"冲突（沿用 `ADR-004` 的结论）。
* **继续"daemon 独立进程"的形态**：用户要的是双击即用的单体桌面程序，而不是"起一个进程再连过去"；**否决**。

---

## Consequences

**正面：**

* 单一可分发包、双击即用；不需要用户理解或管理任何后台进程。
* 没有对外监听端口、没有本地鉴权面，程序的攻击面就是"一个用户自己的桌面应用"。

**需要落实：**

* 新增 `packages/client-electron`：main 内嵌 `client-daemon`、preload 的 `contextBridge` 面、renderer UI，以及**打包**（一条命令产出 exe）。
* renderer 与 main 的通讯层：快照/事件（单向推送）/命令（提交请求、回答决策）。
* `userData` 下的台账/会话路径；退出语义。
* 打包、签名、自动更新。

**风险 / 开放项：**

* **Electron 自带的 Node 与 `node:sqlite`**：`ADR-004` 修订 A1 为免原生构建改用 Node 内置 `node:sqlite`；Electron 的 Node 版本/该模块可用性**必须先实测**——不成立则回退 `better-sqlite3`（原生模块，需随 ABI 构建）。**建议先于一切打包工作做这个探针。**
* **Windows 产品接入形式**（`D6(a)`）：单体打包会把"进程外 / 原生桥"的边界推到更前；结论仍要补一份 ADR。
* **能力在 Electron main 内执行的语义**：`child_process` / git / docker 的权限、杀进程、退出时清理。

**明确不做（本形态）：**

* 只读旁观者、`curl`/脚本客户端（那是"daemon 独立进程"才有的东西）。
* "UI 关闭后长任务继续"（除非显式决定做托盘/后台服务；见开放项）。
* TLS、多实例、MinIO/S3 等（沿用 `ADR-004` §明确延后）。

---

## 开放项

1. **退出语义**：应用退出时在跑的 Workflow 取消 / 等待收敛 / 托盘后台继续——三选一，写进实现计划。
2. **实现计划**：`docs/superpowers/plans/2026-10-0x-electron-monolith.md`（新增 `packages/client-electron`；先做 IPC 通讯层与 `HostPort` 宿主，再打包）。
3. **`node:sqlite` in Electron 的可行性实测**（先于打包）。
