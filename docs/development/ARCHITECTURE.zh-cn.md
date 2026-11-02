# 架构说明

[简体中文](ARCHITECTURE.zh-cn.md) · [English](ARCHITECTURE.en.md)

本文根据当前源码说明 ligule 的运行结构、一次 Agent Loop 和会话数据路径。工作区有三个源码模块：`core/` 是共享 Agent Core，`tui/` 是 CLI/TUI 产品，`desktop/` 是 Electron 产品。依赖方向为 `tui → core ← desktop`；Core 内部继续区分 Kernel、Host、Session、Model、Policy 与 Tools。产品分别通过 npm `ligule` 和 GitHub Release 发布，Core 不单独发版。

本文面向阅读或修改仓库的贡献者，说明组件职责、依赖方向、一次请求的执行路径和会话恢复。协议字段与模块细节以链接到的源码为准。

用户配置层的 `[telemetry].enabled = true` 可开启有界本地 JSONL 事件日志；可选的 `otlpEndpoint` 只接受本机回环 OTLP/HTTP protobuf 地址，并导出有界 OpenTelemetry Trace。默认关闭；项目配置不能启用此功能，存储或导出失败均不影响 Agent 执行。本地 JSONL 存储固定最多保留四个 64 KiB 分段和有界 Manifest；分段保留数不是用户配置项，因为调整它需要安全迁移 Manifest。本地存储失败会停用当前遥测写入器，并通过 Host 日志记录脱敏后的错误码；直接调用 `flush()` 时会收到该错误。日志和 Trace 不包含提示词、推理、工具参数/结果、文件路径或凭据。Session JSONL 仍是恢复事实来源；本地 JSONL 是结构化事件日志，不是 OpenTelemetry Logs，Ligule 也没有 Trace 查看器。

CLI 的 npm 包内置私有 Core 的编译代码、模式与元数据；Core 的外部运行依赖合并到公开包清单，由 npm 在消费者系统安装对应的原生依赖。打包时不内置构建机器的外部依赖树，同一 tarball 用于 Windows 与 Linux 的安装验证。

## 源码与发布包依赖

源码 import 图和 npm 安装图描述的是不同关系。模块级依赖方向如下：

| 源码层 | 依赖方向 |
| --- | --- |
| Core | Host 组合 Kernel、Session、Model、Capability 与 Tools；Core 不导入 TUI/Desktop 客户端或 React、Ink、Electron 包。 |
| CLI/TUI | 适配层依赖公开的 `@ligule/core` 接口。 |
| Desktop 前端 | Renderer 管理自己的 UI 模块，只能将 `desktop/electron/api.ts` 作为 type-only 协议契约导入。 |
| Electron Main | Main 管理窗口、IPC、安全与运行时启动器；它通过分帧 IPC 与独立 Node Host 通信，不导入 Core 业务代码。 |

运行 `pnpm check:dependencies`，使用锁定的 `dependency-cruiser@18.7.0` 与工作区 TypeScript 版本扫描源码 import。规则拒绝 Core 反向依赖客户端、Electron Main 导入 Core、运行时依赖循环，以及 Core/TUI/Electron Main/Renderer 运行时导入 `npm-dev` 依赖；Renderer 运行时导入 Electron API 契约也会被拒绝。Electron Main 可以导入由打包后的 Electron Runtime 提供的 `electron` Host API，这是唯一允许的 npm-dev 运行时例外。type-only 循环、type-only 导入及 Renderer 的环境类型声明不属于运行时违规。扫描排除测试、生成的 `dist`、vendored 代码和 `testplace`；完整依赖图不提交到仓库。

规则配置见 [dependency-cruiser.cjs](../../dependency-cruiser.cjs)；[check-dependencies.mjs](../../scripts/check-dependencies.mjs) 会执行源码扫描、正向 fixture 与受控负向 fixture。

CLI 发布清单由 [`releaseManifest()`](../../scripts/pack-release.js) 从 `tui/package.json` 与 Core 的 `dependencies`、`optionalDependencies` 合成。tarball 内置私有 `@ligule/core` 运行时与无依赖的 `xlsx`；其余依赖由消费者按自身平台安装，原生 optional 包也只选择适用的项目。TUI 的 `devDependencies` 可能仍留在 manifest 元数据中，但 npm 消费者不会传递安装它们。Desktop 使用独立产品清单，不属于 CLI tarball。CI 发布工作流在干净 checkout 中调用 `pnpm --filter ligule run check-pack` 与 `pnpm --filter ligule run verify-install <tarball>`。在已有工作区本机验收时，应将新 `testplace/tmp` work root 传给脚本，避免替换原有 `testplace/pack` 产物：

代表性的直接依赖类别与源码用途如下：

| 用途 | 源码与依赖 | 安装方式 |
| --- | --- | --- |
| MCP 与参数模式 | `core/src/capability/mcp.ts`、`core/src/host/mcp-server.ts`；MCP SDK、AJV | Core 生产依赖，由 npm 安装到消费者。 |
| Shell 解析与搜索 | `core/src/capability/command.ts`、`powershell.ts`、`ripgrep.ts`；Tree-sitter 语法包与 `@vscode/ripgrep` | 生产依赖；原生语法模块和搜索二进制按消费者平台选择。 |
| 文档与媒体 | `core/src/capability/document-parser.ts`、`media.ts`、`artifact.ts`；Office/PDF 解析器、`yauzl`、`sharp`、Canvas | 解析器按需加载。原生图像模块由消费者安装；`xlsx` 因无运行依赖和平台二进制而内置。 |
| 凭据与进程集成 | `core/src/kernel/credentials.ts`、`core/src/capability/mcp-posix.ts`、`win32-job.ts`、`screen-capture-worker.ts`；keyring、`koffi`、`node-screenshots` | keyring 是生产依赖；`koffi` 与 `node-screenshots` 是可选原生依赖。缺少 Koffi 时 POSIX MCP 会拒绝启动，不会在没有进程组归属时继续运行。 |
| Telemetry | `core/src/kernel/telemetry-otlp.ts`；OpenTelemetry API、资源、Trace SDK 与 OTLP Exporter | 即使 Telemetry 关闭仍是 Core 常规依赖；仅配置后才创建 OTLP Sink。 |
| 终端界面 | `tui/src/tui/start.ts` 及其 React/Ink、Markdown 和宽度辅助包 | npm 可选依赖，仅进入 TUI 时加载；用户省略这些包时 CLI 会明确提示缺少 TUI 依赖。 |

Desktop 使用独立清单：`desktop/electron/` 使用打包的 Electron Host API，`desktop/frontend/` 的依赖由 Vite 打入 Renderer。这两组依赖都不属于 CLI npm tarball。清单和锁文件仍是版本权威；本表概述代表性的运行时用途，不重复维护所有包版本。

```sh
pnpm --filter ligule run check-pack -- --work-root testplace/tmp/package-check-example-1
pnpm --filter ligule run verify-install -- testplace/tmp/package-check-example-1/ligule-0.1.0.tgz --work-root testplace/tmp/install-check-example-1
```

请将示例目录名替换为当前不存在的名称，并将 check-pack work root 中生成的 tarball 路径传给 `verify-install`。两项检查必须使用同一个实际归档；不要只凭工作区清单推断最终发布包。

### Core 模块职责边界

以下模块负责共享数据规则或投影；Host 与 Kernel 仍分别拥有生命周期和执行：

| 模块 | 职责与边界 |
| --- | --- |
| [`errors.ts`](../../core/src/errors.ts) 与 [`kernel/error.ts`](../../core/src/kernel/error.ts) | `errors.ts` 集中定义共享错误类型和诊断；`kernel/error.ts` 保留兼容导出。 |
| [`data-root.ts`](../../core/src/data-root.ts) 与 [`workspace-identity.ts`](../../core/src/workspace-identity.ts) | 解析用户数据根和规范化工作区身份；配置存储与工作区注册表仍各自持有状态。 |
| [`kernel/observe.ts`](../../core/src/kernel/observe.ts) 与 [`session/spill.ts`](../../core/src/session/spill.ts) | 分别在 Kernel 与 Session 层保存单次运行的文件观察和超限结果旁路文件。 |
| [`host/session-initial-settings.ts`](../../core/src/host/session-initial-settings.ts) | 解析并校验初始生成限制；Grant 检查、Provider 选择、信任更新和 Session 创建仍由 Host 负责。 |
| [`host/tool-catalog.ts`](../../core/src/host/tool-catalog.ts) | 组装只读、不可执行的设置目录并关闭临时注册表；不持有活动 Session。 |
| [`host/run-records.ts`](../../core/src/host/run-records.ts) | 投影持久 Run 回执与事件窗口；Host 仍负责调用方 scope 和授权。 |
| [`media.ts`](../../core/src/media.ts) | 定义图像引用校验与共享限制，不负责存储或 Session 所有权。 |
| [`tui.ts`](../../core/src/tui.ts) | 提供 CLI/TUI 适配层使用的受支持 Core 门面；实现仍留在各自职责模块中。 |

## 运行时与执行

- [运行结构](#运行结构)
- [Kernel、插件、工具与能力](#kernel插件工具与能力)
- [一次 Agent Loop](#一次-agent-loop)

## 会话数据与恢复

- [会话记录与恢复](#会话记录与恢复)
- [会话数据路径](#会话数据路径)

## Host 与客户端

- [Host 协议与客户端](#host-协议与客户端)
- [相关文档](#相关文档)

### 运行结构

```mermaid
flowchart LR
  CLI[命令行] -->|进程内调用| Host[Node Host]
  TUI[React 与 Ink] -->|内存协议| Host
  External[本地 MCP 客户端] -->|stdio MCP| MCP[MCP 适配器]
  MCP --> Control[进程内控制门面]
  Control --> Host
  Web[React 桌面界面] <-->|沙盒 Preload 与 IPC| Main[Electron Main]
  Main <-->|按行分隔的消息帧| Child[Node Host 子进程]
  Child --> HostLogic[Host 与内核]
  Host --> Project[项目环境]
  Host --> Loop[Agent Loop]
  Host --> Session[会话 JSONL]
  Loop --> Provider[模型适配器]
  Loop --> Kernel[Kernel]
  Kernel --> Policy[审批判定链]
  Kernel --> Registry[工具注册表]
  Registry --> Tool[已注册工具]
  Tool --> Capability[平台与 I/O 能力]
  Provider --> Endpoint[模型服务]
```

`ligule run` 与直接运行 `ligule`（或使用兼容命令 `ligule tui`）会在界面所属的 Node.js 进程中创建 Host。TUI 通过内存连接发送协议消息。桌面前端只通过固定的沙盒 Preload API 与 Electron Main 通信；Main 将协议帧转发给独立 Node Host，并管理窗口、原生交互和进程生命周期。Node Host 管项目环境、会话、审批与模型请求。入口分别见[命令行](../../tui/src/cli.ts)、[TUI 启动器](../../tui/src/tui/start.ts)、[消息连接](../../core/src/host/connection.ts)、[Electron IPC](../../desktop/electron/ipc.ts)和[Preload API](../../desktop/electron/preload.ts)。

[项目环境装载模块](../../core/src/host/environment.ts) 为 CLI 与 Desktop Host 入口提供同一次读取的配置层与扩展来源。[Provider 构造模块](../../core/src/host/provider.ts) 校验模型协议、能力声明与重试设置；未配置模型的 Host 可以接收设置请求，模型运行明确失败。[会话模式事务](../../core/src/host/session-mode.ts) 负责安装工具限制、提示片段、失败回收和模式事实记录；Host 继续持有会话锁、活跃轮次、协议路由与资源清理。TUI 的记录投影位于 [transcript.ts](../../tui/src/tui/transcript.ts)，Desktop 的[流式缓冲](../../desktop/frontend/src/session-stream.ts) 按会话隔离未落盘输出。

`ligule mcp-server --project <绝对项目根>` 通过 [MCP 适配器](../../core/src/host/mcp-server.ts) 暴露本地控制工具。[控制门面](../../core/src/host/control.ts) 调用同一 Host，维护进程内 operation 状态，并将会话操作限制在启动时授权的项目内。默认模式拒绝需要审批的操作；明确启用 `--operator` 后，客户端可答复真实待决的审批与提问，并修改受支持的会话设置，但不能覆盖硬拒绝。可信 TUI/Desktop 可创建项目绑定的 [Agent Control Grant](../../core/src/host/agent-control.ts)；`--grant <id>` 将会话 Permission、网络和 Policy 限制在 Grant 的默认值与上限内，Host 会在请求时核验撤销、到期和项目绑定。连接关闭时会取消运行并释放会话锁；Session JSONL 持久保存会话记录，operation ID 和消息队列只在当前进程内有效。使用方法见 [Agent Control（MCP）指南](../agent-control/guide.zh-CN.md)。

### 委派执行与外控会话

一次运行可带有 `DelegationSpec`，其中的 `mode` 和 `outputSchema` 由共享的[委派契约](../../core/src/delegation.ts)校验。内部 `subagent` 工具与 MCP 的 `ligule_run` / `ligule_run_start` 共用结构化输出验证和 `RunResult` 结果类型；外部 MCP 运行仍使用其原会话，不会自动创建子会话。

内部子代理在同一 Host 进程中创建派生 Kernel、Loop 和独立 Session JSONL，记录 ID 为父 Session 的 `.sub-N`。子代理继承父会话的配置、Provider、插件工具、Permission 与 Policy 判定实例，但不注册 `subagent` 工具；每个父轮最多同时运行三个。子模式只能收窄父模式可用工具，模型调用次数、输出、思考和循环预算不能超过父上限。子任务的 RunResult 和 Session 引用作为父工具结果返回，因此失败或取消的子记录仍可查看。

外部客户端通过本地 stdio MCP 进入 Control 门面，再由它操作授权项目中的 Host Session。可信 TUI/Desktop 通过本地 Agent Control IPC 观察状态、回答交互或接管任务；Host 仍是 Session 的写入者，锁阻止另一个 Host 并发写同一记录。答复结果和控制事件以 `source=human` 或 `source=controller` 区分本机用户与 MCP 操控者；只有本机用户答复可以保存审批记忆。接管会取消当前外控轮次、清空尚未发送的外部队列、释放 Host 会话锁并发出所有权转移事件。撤销工作区信任会使当前 Host 停止基于该信任启动的受管进程；其他 Host 通过共享信任记录定期复核并停止相关进程。Session JSONL 保存消息和工具事件；operation ID、事件缓存、待处理请求和消息队列属于 Control 进程内状态。服务重启后，如需实时状态、交互、记录读取或继续工作，应重新接回持久 Session，且旧运行编号不可继续使用；授权项目中的持久回执则可直接用 `ligule_run_get` 只读查询，无需打开 Session 写入方。`run.wait` 必须明确指定 origin，但该字段本身不授予权限：可信本地 UI 可读取本 Session 的 human 与 controller 回执；经过认证的 Agent Control 桥接可读取 human 回执和当前 Grant 的 controller 回执；其他 Host 只能读取自己的 controller scope。Host 根据持久化 Run 归属并结合调用方上下文判定权限。若 `requestKey` 在多个可见 scope 中都匹配，返回 `run_request_key_ambiguous`；调用方应使用唯一的 `runId` 选择回执。Host 返回结果前会检查对应回执。

```mermaid
flowchart LR
  Parent[父 Kernel 与 Session] -->|subagent 工具| Child[派生 Kernel 与子 Session JSONL]
  Child -->|RunResult 与子 Session 引用| Parent
  MCP[本地 stdio MCP] --> Control[Control 门面与进程内运行状态]
  UI[TUI / Desktop] -->|Agent Control 本地 IPC| Control
  Control --> Host[授权项目的 Host]
  Host --> Log[(Session JSONL)]
```

### Kernel、插件、工具与能力

Kernel 从空工具注册表开始。Host 通过[装配器](../../core/src/kernel/assembly.ts)安装插件；插件可以注册工具和提示片段，并返回清理动作。工具模式从已注册工具中选择可交给模型的项目，并选择提示片段；模式不实现工具，也不作审批决定。

工具是模型可调用的契约，包含名称、说明、JSON 参数模式和执行函数。工具实现可以调用 [`core/src/capability/`](../../core/src/capability/) 下的平台能力，例如路径检查、命令执行、网络解析或剪贴板访问。能力本身不会自动成为模型可调用工具。审批结果中的 `capability` 字段用于标记本次判定的操作。

模型提出的每个工具调用都会进入 [`kernel.call`](../../core/src/kernel/kernel.ts)。Kernel 先检查工具注册和参数，再解析声明的命令或网络目标，随后调用审批判定链。判定链按既定顺序应用限制、守卫、配置规则、自动审批条件和用户审批。只有获准的调用会进入工具实现。Kernel 会记录判定结果，以及完成、拒绝或失败的工具结果；模型清单只包含工具名称、说明和参数模式。

配置的 stdio MCP Server 在 POSIX 系统中使用独立进程组启动，在 Windows 中使用 Job Object。撤销、取消和 Host 关闭时先关闭协议传输，再有界地尝试正常终止，并强制停止仍存活的所属进程。清理失败会保留为可见、可重试状态。POSIX 进程组只覆盖仍留在该组中的后代；主动通过 `setpgid` 移入其他进程组或通过 `setsid` 创建新会话的后代不属于此清理边界。若 Node.js 进程组启动器或 Koffi 原生 `setsid` 支持不可用，POSIX MCP 会拒绝启动。

内置 `delete` 工具只调用操作系统回收站，Linux 使用 GIO 系统回收操作。后端报错后，Ligule 会比较原路径上的目标对象身份和顶层元数据与操作前快照。仍匹配时返回后端错误；无法匹配时返回 `delete_outcome_unknown`，要求用户检查工作区和系统回收站再重试。这项检查不比较文件正文，也不递归核对目录内容。Ligule 不维护自建回收列表或恢复存储。Shell 删除仍沿 Shell 的 Permission、Policy 和 Approval 链执行。

`write` 会在替换内容前将文件与本轮最后一次完整读取的版本进行比较。比较和写入是两个独立的文件系统操作，因此外部并发写入仍可能在检查后发生；该工具不提供原子比较并交换保证。

`edit` 会读取当前文件、定位唯一锚点，再通过另一次文件操作写入替换内容。外部进程仍可能在这两步之间修改文件，因此锚点检查不能防止并发修改被覆盖。

Host 为每个会话持有独立的 Permission 与 Policy 状态。Permission 在 Kernel 判定之前按工具的资源访问类别检查读、写、命令、网络和外部进程；Policy 随后决定是否审批或拒绝。交互式 TUI 与 Desktop 可更改会话 Permission，启用 `full-access` 和 `unrestricted` 网络分别需要确认。命令执行通过 [`permission-capabilities.ts`](../../core/src/capability/permission-capabilities.ts) 探测所选 Shell 和平台能力。Linux 使用 bubblewrap，并按实测报告文件系统隔离能力；受限命令使用的 Node 若位于隐藏目录中，沙箱只读映射该可执行文件及发行包自带的 npm/Corepack 文件到固定路径，用户主目录和包管理器缓存仍保持隐藏。Windows `workspace-write` 使用每次运行独立的 `WRITE_RESTRICTED` Token 和临时 ACL，标为 `partial`；需要明确授权项目、确认风险并使用不受限网络，且无法限制读取和网络。硬链接、可写祖先目录的 `FILE_DELETE_CHILD` 权限及并发 ACL 修改仍可能越界。Windows `read-only` 仅当所选 Shell 能进入实际工作区时才使用 AppContainer，否则 Kernel 预检会拒绝；可用时它会阻止工作区写入和 Shell 联网，但系统公开可读文件仍可能被读取。项目脚本与 Git 命令都需要工作区信任；每条 Git 命令还需逐次审批，因为仓库配置可能运行 Hook、辅助程序或别名。`full-access` Shell 使用当前操作系统用户权限，并要求不受限网络与进程管理能力可用。MCP `--operator` 不管理 Permission，硬拒绝也不能通过审批覆盖。

`fetch` 会在 Policy 判定前解析地址，并将每个 socket 固定到获批的 IP。它只跟随同源重定向；每一跳重新解析后必须仍落在首次获批的 IP 集内。结果记录实际连接过的地址。IPv4/IPv6 特殊用途地址按 IANA `Forwardable` 与 `Globally Reachable` 属性映射到现有策略类别：可转发但不可全球到达的目标按 `private` 处理并要求审批；非目标地址或不可转发范围按 `unspecified` 拒绝；注册表明确允许全球到达的分配继续按 `public` 处理。`shownBytes` 统计 UTF-8 解码前保留的源响应字节。

默认 `minimal` 模式还提供 `managed_process`，供开发服务器等需要跨工具调用运行的命令使用。启动命令仍按 `exec` capability 应用 Permission、Script Binding、工作区信任和 Policy；现有 `exec` 拒绝规则同样适用。启动须提供 HTTP 回环健康检查地址，并等待其返回 2xx 后才返回 Session 内句柄、端口和就绪状态；失败探测会有界退避，取消或进程退出会打断等待。状态、限量日志和显式停止也限定在该 Session；日志最多返回 16 KiB。停止操作无法确认进程退出时会返回失败并报告 `terminationPending: true`；进程已结束但执行资源清理未确认时会报告 `cleanupPending: true`；进程活性与资源清理都未确认时两个标记同时为 true。启动和进程树终止都失败时，启动错误保留原错误码并同时报告两类错误；状态视图通过 startupFailure 和 terminationFailure 分别暴露。后续 close/stop 会复用在途 Lease 请求，并对失败的资源清理进行有限重试。最多保留 128 条已确认终态 Entry；活性未知或资源清理未完成的 Entry 不会被淘汰。普通 `exec` 仍等待命令结束并由 Guardian 清理后代。受管进程继续留在 Guardian/Job Object 进程树中，随运行取消、Permission 变更、Session/Host 关闭或所属 Grant 撤销而停止；外部撤销或过期的 Grant 会每秒重新校验。健康检查地址只限制 Host 的探测目标，实际监听地址和命令的网络访问仍由启动命令与当前平台 Permission 决定。

### 一次 Agent Loop

```mermaid
sequenceDiagram
  actor User as 用户
  participant Adapter as CLI / TUI / 桌面适配器
  participant Host as Node Host
  participant Loop as Agent Loop
  participant Session as 会话记录
  participant Provider as 模型服务
  participant Kernel as Kernel 与审批链
  participant Tool as 工具与平台能力
  User->>Adapter: 提交一条消息
  Adapter->>Host: run.start
  Host->>Session: 追加用户事件与本轮设置
  Host->>Loop: 使用会话、提供方与 Kernel 运行
  Loop->>Session: 读取模型视图
  Loop->>Provider: 发送提示、工具清单与消息
  Provider-->>Loop: 流式文本、推理与工具调用
  Loop->>Session: 追加助手内容与工具调用
  alt 模型返回工具调用
    Loop->>Kernel: 校验并请求判定
    Kernel->>Kernel: 检查限制、规则与审批
    opt 判定需要用户审批
      Kernel->>Host: 等待本会话的审批答复
      Host-->>Adapter: approval.request
      Adapter-->>User: 显示审批卡
      User-->>Adapter: 允许或拒绝
      Adapter->>Host: approval.respond
      Host-->>Kernel: 返回判定结果
    end
    Kernel->>Tool: 执行获准的工具
    Tool-->>Kernel: 返回结果
    Kernel->>Session: 记录判定与工具结果
    Loop->>Provider: 带上工具结果继续请求
  else 模型完成本轮
    Loop->>Session: 追加完成、取消或失败终态
  end
  Host-->>Adapter: 状态、事件与最终结果
  Adapter-->>User: 显示会话更新
```

[Agent Loop](../../core/src/kernel/loop.ts) 执行一轮用户输入及所需的模型与工具迭代：

1. 将用户输入和本轮有效设置追加到会话记录。
2. 生成系统提示、工具清单，并从会话记录构建模型消息。
3. 若启用了上下文压缩，在发送前检查请求大小；服务报告请求过大时，最多执行一次恢复压缩与重试。
4. 流式接收模型响应；文本与推理先写入独立的临时快照，响应处理后再将助手消息和工具调用写入会话记录。
5. 通过 Kernel 执行工具调用，将结果写入记录，再按模型响应继续迭代。
6. 在本轮完成、取消或失败时写入一条终态。

[模型适配器](../../core/src/model/) 实现当前支持的 HTTP 消息格式。Host 根据生效的模型服务选择 Provider，并只在发送请求时读取凭据。HTTP 适配器要求响应包含协议终止标记和受支持的结束原因，并发出 `finish` 事件；Loop 在判定完成前拒绝输出耗尽或空响应。工具调用批次会在执行前完整解析并校验参数模式。参数校验拒绝会作为工具结果交给模型处理；Provider JSON 无效或流中断会使本轮失败，且不会重放工具调用。上下文压缩摘要也经过相同的完成检查后才写入检查点。

声明为串行的调用与结束本轮的工具会形成顺序屏障。连续的独立调用通过滚动并发池执行，并受项目配置 `[loop].maxParallelTools` 限制；范围为 1 至 32，默认 4，内部子代理继承父级上限。取消或 Kernel/运行时内部错误发生后，Loop 不再启动排队调用，等待已经启动的调用完成并清理，再为每个未启动的 `callId` 恰好写入一条 `tool_skipped` 结果。已启动工具产生的副作用不会回滚。上下文溢出恢复每个 `run` 最多压缩并重试一次；预算由该次运行持有，同一 Session 的后续轮次会重新获得一次恢复机会。

`model.outputTokens` 表示本次请求的输出预算，与旧版能力上限调整相互独立。模型服务保留字符串形式的 `models` 列表，并可按模型 ID 配置 `modelSettings`，包括显示名称、上下文窗口和请求输出预算。模型级输出声明可以提高未知端点的保守默认值，但不能超过已核实的端点或模型上限，也不能覆盖显式能力限制。未设置该声明的旧配置仍使用保守上限。[预算解析器](../../core/src/model/output-budget.ts)会校验生效限制；同一模型的上下文窗口也控制 Host 的压缩。Provider 重建和会话生成设置变更在轮次边界生效。

Host 的运行进度仅在当前活跃会话与任务期间存在，由 Loop、压缩、审批和提问事件生成。`status.get` 与 `progress` 通知提供阶段、时间和计数；活动进度快照也携带 TaskBudget 状态，使 TUI 与 Desktop 可直接显示剩余执行时间、累计交互等待和 Host 判定的暂停状态，无需轮询完整状态视图。Host 会合并短时间内重复的活动通知，但保留实际进度时间；任务结束时清除进度。进度心跳不会写入 Session JSONL，默认也不会因无活动超时而取消任务。

### 会话记录与恢复

追加式 [JSONL 会话记录](../../core/src/session/session.ts)是对话事实来源。首行记录会话标识和项目信息；之后的事件记录用户与助手消息、工具调用和结果、轮次状态、模型选择、Permission、Policy 覆盖和拒绝计数等状态。Policy 快照可由旧版本读者跳过，不进入模型消息或检查点。会话锁阻止多个进程同时写入同一记录。

Provider 响应流式传输期间，[`stream-draft.ts`](../../core/src/session/stream-draft.ts) 会将临时快照单独写入 `<sessionId>.stream.json`。首个文本或推理片段立即保存；之后每隔 250 毫秒或累计新增 16 KiB 时写入。文本与推理各保留最后 8,192 个 UTF-16 字符，并记录总字符数和是否截断。JSON 快照有界，不超过 128 KiB；写入临时文件并 flush 后再原子替换。它不是 Session 事件，也不会进入 `modelView()`，助手响应正式写入后会删除。后续 writer 不会删除所有权无法确认的残留快照临时文件。Host 的 session read/observe 和 MCP `ligule_session_read` 通过独立的 `provisionalOutput` 字段返回快照，并标记 `provisional: true`；快照无效时返回 `provisionalOutputError: session_stream_invalid`，同时仍返回正式记录。若正式记录已有相同 `responseId`，读取时会忽略残留快照。强制终止进程可能丢失尚未写入快照的最后一批内容。界面不会自动恢复或渲染该字段，目前只能通过协议读取。

默认路径为 `dataRoot()/workspaces/<可读路径>--<稳定哈希>/sessions/`，同目录保存记录和附属文件。只读列表与搜索会扫描旧全局目录和项目目录但不迁移；用户打开旧会话时才会复制到工作区目录，并保留原件。

模型请求使用从记录计算出的投影。界面可以读取推理、标签、轮次信息和用量；按投影规则，这些内容不会全部进入模型消息。创建分支会复制整份记录，或复制到一轮完整结束处为止；父会话保持不变。

压缩块文件是派生文件，一个会话的全部块保存在同一文件中，每次压缩整体原子替换。使用前逐块核验格式、覆盖的序号区间以及相对于会话事件的摘要值；任一块校验失败或文件不存在时，从 JSONL 记录重建模型视图。压缩只追加块，不改写会话记录，原始事件始终可回读。模型经 `compact` 工具查看压力与块、读回原文，并可自行选择范围撰写摘要形成新块；压力达到软阈值时注入一次性临时提醒，硬阈值仍由自动压缩兜底。过大的工具结果与摘要放在旁路文件中，记录和块保留读取与导出所需的引用。

重新打开会话时，若已派发的工具调用没有结果，恢复逻辑会记下 `tool_outcome_unknown`，不会重放该调用。这样可以重建有效的模型投影，同时避免重复执行结果未知的外部操作。

Harbor 评测通过 [`sessionTurnToAtif()`](../../core/src/session/atif.ts) 将选定的持久化 Session 轮次导出为 ATIF-v1.8。这是用于评测的投影，不是完整执行回放：每条已持久化的助手响应计为一次逻辑 LLM 调用，隐藏的 HTTP 重试和系统压缩不计入；子代理轨迹和图片负载不会嵌入。只有在按同一 Session 目录校验后才恢复旁路内容；仅有预览的内容会标记为 `spill_content_missing`，无法解析的引用则使导出失败。省略项会写入 `extra.ligule.missing_features` 和每个调用的标记，因此依赖缺失证据的报告指标保持未知。详见 [Harbor 适配器说明](../../evals/harbor/README.md)。

### 会话数据路径

```mermaid
flowchart TD
  Config[用户配置与项目配置] --> Environment[项目环境快照]
  Environment --> Provider[模型服务与凭据读取]
  Environment --> Policy[审批规则与工具模式]
  Client[CLI / TUI / 桌面界面] --> Protocol[Host 协议]
  Protocol --> Host[Node Host]
  Host --> Log[追加式会话 JSONL]
  Host --> Loop[Agent Loop]
  Log --> Projection[模型消息投影]
  Projection --> Loop
  Loop --> Provider
  Loop --> Kernel[Kernel 判定与工具执行]
  Kernel --> Log
  Log --> Checkpoint[校验后的检查点]
  Log --> Spill[工具结果旁路文件]
  Log --> Export[导出与历史浏览]
  Spill --> Export
```

配置层在 Host 启动项目环境时合并成快照。会话 JSONL 是消息和工具结果的来源；检查点与旁路文件保存可重新校验或取回的派生内容。历史浏览和导出读取记录与可用旁路文件，不以界面缓存作为会话事实来源。用户数据根和项目工作区分别管理用户级资料与项目归属。

配置编辑在版本校验、TOML 修改、生效配置校验和原子替换期间持有目标文件锁。Host 会在保存前校验模型变更，包括共享默认值、其他已载入项目的共享设置以及会话显式选择；拒绝的变更不会修改文件。通过校验的配置仍在现有会话轮次边界生效。SSE 流式响应与非流式 JSON 适配器会向 Loop 提供相同的完成状态、用量、文本、推理和工具调用事件。

### Host 协议与客户端

Host 协议在[协议表](../../core/src/host/protocol.ts)中定义方法、参数、审批请求、问题请求和通知。[`connection.ts`](../../core/src/host/connection.ts) 使用按行分隔的 JSON 消息。Host 在分派前校验方法参数，并持有会话状态；客户端通过协议创建或打开会话、启动或取消轮次、读取记录、回应待办和修改支持的设置。

CLI 命令直接调用 Host。TUI 在内存连接上使用相同协议。桌面前端通过固定的 Preload API 使用 IPC 连接 Electron Main，Main 只转发消息帧，不解释 Host 方法或会话数据。传输方式不同，Host 方法和 Kernel 行为保持共用。

### 相关文档

[术语表](GLOSSARY.zh-cn.md)定义项目用语；[贡献与验证](CONTRIBUTING.zh-cn.md)列出开发命令和检查范围；[使用手册](../guide.zh-CN.md)说明 CLI、TUI 和 Desktop 的用户操作。
