# 桌面版更新记录 / Desktop Changelog

此文件只记录 Ligule Desktop 的安装包与桌面应用变化。CLI/TUI 更新单独记录在 `tui/CHANGELOG.md`。

This file records Ligule Desktop installer and application changes only. CLI/TUI updates are tracked separately in `tui/CHANGELOG.md`.

## [Unreleased]

### 简体中文

**改进**

- 审批方式改为四档：`always`（每次都要审批）、`ask`（逐次审批）、`auto`（自动判定）、`never`（完全不审批）。设置里的审批方式选择器、会话配置行和外控授权草稿同步更新；选择 `never` 前必须先确认。
- 旧配置与会话记录里的 `none`、以及旧语义的 `never` 按 `ask` 读取，历史数据不会自动变成“跳过审批”。

### English

**Improved**

- Approval modes are now `always`, `ask`, `auto`, and `never` (skip the policy layer). The settings picker, session status line, and Agent Control grant draft follow the new set, and choosing `never` requires a confirmation.
- Legacy `none` values and the old `never` meaning are read as `ask`, so existing data never silently becomes “skip approvals”.

## [0.1.2] - 2026-11-02

### 简体中文

**改进**

- 「设置 → 工具」会标明自定义 TOML 工具来源，并展示工具声明诊断；没有活动会话时，列表也会区分已发现的元数据与当前 Mode、Permission 下实际可用的工具。

**修复**

- Session 切换 Mode 时，旧工具清单会保持生效，直到新设置写入成功，避免界面和 Host 暂时显示不同的可用工具。

### English

**Improved**

- Settings → Tools identifies custom TOML tools and shows declaration diagnostics. With no active Session, it distinguishes discovered metadata from tools actually available under the current Mode and Permission.

**Fixed**

- During a Session Mode change, the previous tool set remains active until the new settings are persisted, keeping the UI and Host on the same available tool set.

## [0.1.1] - 2026-11-01

### 简体中文

- 桌面输入区把模型、工具模式、权限、审批固定在同一顺序；截图授权收为右侧次级图标按钮，状态保留在按钮与授权确认中。
- 权限弹窗只保留当前会话的权限档与必要确认；网络访问、隔离细节与项目信任集中到「设置 → 权限与安全」。工具目录改为一行一个工具并折叠详情；模型服务列表只显示模型数量与首个模型；外控面板的会话配置折叠进详情。
- 消息区的工具调用只显示一次工具名，不再逐行重复「完成」。
- 工具模式菜单直接列出 minimal / full 的一句话区别并可点选，自定义模式移到「其他模式」；会话搜索结果先显示会话名，再用浅色标注命中位置；折叠区恢复 ▸ / ▾ 标记。
- 失败行先用一句话说明发生了什么和下一步，原始错误码与英文正文收进「原始信息」。
- 外控授权的到期时间必须晚于当前时间；已过期或当前到期的值不能提交。
- 审批摘要与脚本绑定说明分别生成中文和英文内容，切换界面语言时保持一致。
- 会话写入锁仍由其他 Host 持有时，桌面以只读方式打开并保留占用说明。
- 只读观察区分普通 Host 写入与可用的外控 Agent runtime；仅在 runtime 可用时显示外控面板与指导输入。断连提示会保留到 Host 的只读观察或会话恢复成功。
- 普通会话与外控会话的问题卡片草稿按 Session 保存并在切换后恢复；提交期间继续输入的新文本不会被旧请求清空。
- 外控审批目标、观察状态与异步响应绑定所属 Session；切换会话后，旧会话的迟到结果不会更新当前会话界面。
- 权限结果仅在实际提高权限时标记为升级，避免普通策略判断被误报为权限升级。

- `run.wait` 必须明确指定 `origin`，但该字段不授予权限。可信本地 UI 可读取本 Session 的所有回执；经过认证的 Agent Control 桥接受限于 human 与当前 Grant scope；其他 Host 只能读取自己的 controller scope。Host 按持久 Run 归属与调用方上下文授权。跨 scope 的 `requestKey` 多重匹配返回 `run_request_key_ambiguous`，应使用 `runId`。
- POSIX MCP Server 使用独立进程组；撤销、取消或 Host 关闭时有界地发送终止信号并清理仍存活的所属子进程，失败保留为可重试错误。主动通过 `setpgid` 移入其他进程组或通过 `setsid` 创建新会话的后代不在原进程组边界内。
- 文件工具 `delete` 只使用操作系统回收站；系统后端报错后会复核原目标对象身份及顶层元数据，仍匹配时返回后端错误；不核对文件正文或递归目录内容，无法确认时返回 `delete_outcome_unknown`。Linux 通过 GIO 调用系统回收站。历史 `.ligule-trash` 不迁移或清理，Shell 删除继续使用自己的 Policy 与审批链。
- 用户层 `[telemetry]` 可显式开启有界本地 JSONL 事件日志和可选的本机 OTLP Trace；默认关闭，导出不含对话正文或工具内容。
- `[loop].maxParallelTools` 限制范围为 1–32，默认 4，防止一次模型响应启动不受限的工具并发。
- `managed_process` 对非 2xx 响应和请求失败使用有界退避；HTTP 2xx 立即就绪，用户取消或所属进程退出会停止探测。
- `fetch` 的同源重定向只能连接首次策略检查覆盖的 IP；特殊用途地址按 IANA 转发与全球可达属性执行审批或拒绝，截断提示按保留字节数计算。
- `managed_process` 分别报告 `terminationPending` 与 `cleanupPending`，区分进程活性未知和进程结束后的平台资源清理失败；两者可同时为 true，关闭或显式停止会重试可重试的资源清理，未确认状态的条目不会被淘汰。
- 本地 Telemetry 遇到未知 Manifest 文件时会保留原文件、停用当前写入器并报告稳定错误码；Host 日志不记录路径或正文。
- 交付文件卡片可查看状态、核验文件摘要、预览安全文本或静态图片、复制相对路径，并由可信原生界面在文件夹中定位。
- 共享 Host 支持持久委派回执与请求去重，外控在重启后可按 `runId` 查询确定的终态结果；工作区清理新增分批 Session 引用核查与受管浏览器目录租约保护。

- 托管无头浏览器支持按会话隔离和持久截图；顶栏可查看状态、停止及恢复，外控只读会话显示接管与关闭提示。

- `full` 模式新增 `web_search`，复用已配置的官方 DeepSeek 服务；仅在配置和凭据可用时注册，仍受网络 Permission 与 Policy 控制。

- 历史工具图片可按需预览，包含外控及已关闭会话；显示资源随会话切换释放。`full` 新增受限文档读取与 PDF 页面图像，沿用同一图片预览通路。

- Windows 截图使用独立授权；已有会话可确认或撤销，外控 Grant 可单独声明屏幕观察。捕获仅读取现有画面，不切换焦点。

- `full` 模式新增 `read_image` 与持久图像引用，Markdown 导出包含相对图片附件；模型设置可选择图像输入能力并在应用重启后保留。

- `full` 模式新增 `todo_write`，每轮任务清单随会话保存历史，内部子代理使用独立清单。
- 运行结果提供已知的任务预算、部分输出和文件交付元数据；`full` 的 `present` 记录工作区文件类型、大小与摘要。仍被 Session 引用的图片超过 30 天也保持可用。

### English

- The desktop composer keeps model, tool mode, permissions, and approvals in one fixed order; screen capture becomes a secondary icon button on the right, with its state kept in the button and the consent dialog.
- The permission popover now only holds the active session's profile and its confirmations; network access, isolation details, and project trust move to Settings → Permissions and security. The tool catalog lists one tool per row with folded details, model services show a model count and the first model, and Agent Control folds the session configuration into details.
- Tool calls in the message stream name the tool once instead of repeating a "Done" badge on every row.
- The tool-mode menu explains and selects `minimal` or `full`, moves custom modes under “Other modes”, shows session names before matching search text, and restores the `▸` / `▾` fold markers.
- Failure rows lead with a short explanation and next step; the raw error code and English details are folded under “Raw information”.
- Agent Control grant expirations must be in the future; expired and current-time values cannot be submitted.
- Approval summaries and script-binding details keep separate Chinese and English text across interface-language changes.
- If another Host still holds a session writer lock, Desktop opens the conversation read-only and keeps the lock explanation visible.
- Read-only observation distinguishes an ordinary Host writer from an available Agent Control runtime, showing control panels and guidance input only when that runtime responds. Disconnect notices remain until a read-only Host observation or session reopen succeeds.
- Question-card drafts in normal and externally controlled Sessions are saved per Session and restored after switching; text typed while a submission is in flight is not cleared by the earlier request.
- Agent Control approval targets, observation state, and asynchronous responses stay bound to their owning Session, so late results from an old Session do not update the current view.
- Permission results are marked as escalations only when they actually raise privileges, avoiding false escalation labels for ordinary policy decisions.

- `run.wait` requires an explicit `origin`, but that field does not grant access. A trusted local UI can read all Receipts in its Session; an authenticated Agent Control bridge is limited to human and its active Grant scopes; other Hosts can read only their controller scope. The Host authorizes access from the persisted Run owner and caller context. An ambiguous `requestKey` across visible scopes returns `run_request_key_ambiguous`; use `runId` to select one.
- POSIX MCP servers use dedicated process groups. Revoke, cancellation, and Host shutdown send bounded termination signals and clean up surviving owned descendants; failures remain retryable. Descendants that move to another group with `setpgid` or start a new session with `setsid` are outside the original process-group boundary.
- The `delete` file tool uses only the operating system recycle bin. After a backend error, Ligule rechecks the original target's identity and top-level metadata: a match returns the backend error. It does not compare file contents or recursively inspect directories; if the target cannot be confirmed, it returns `delete_outcome_unknown`. Linux delegates to GIO's system trash operation. Legacy `.ligule-trash` folders are neither migrated nor cleaned; Shell deletion keeps its own Policy and approval path.
- User-layer `[telemetry]` can explicitly enable bounded local JSONL events and optional loopback OTLP traces; it is disabled by default and exports no conversation or tool content.
- `[loop].maxParallelTools` is capped at 1–32 (default 4) to prevent one model response from starting unbounded tool concurrency.
- `managed_process` uses bounded backoff for non-2xx responses and request failures; HTTP 2xx is immediate, and cancellation or owned-process exit stops probing.
- Same-origin `fetch` redirects can connect only to IPs covered by the initial Policy check; IANA forwardability and global reachability determine whether special-purpose addresses require approval or are denied, and truncation reports retained response bytes.
- `managed_process` reports `terminationPending` and `cleanupPending` separately for unknown process liveness and failed platform-resource cleanup after exit; both can be true. Close and explicit stop retry cleanup when retryable; entries with either unresolved state are not evicted.
- Local Telemetry preserves unknown Manifest files, disables the current writer, and reports a stable error code; Host logs omit paths and content.
- File-delivery cards verify current file digests, show status, preview bounded text or static images, copy relative paths, and reveal files through the trusted native bridge.
- The shared Host supports durable delegation receipts and deduplication; external controllers can query stored terminal results by `runId` after restart. Workspace cleanup now pages Session references and protects managed browser directories with owner leases.

- Managed headless browsing provides Session isolation and durable screenshots. The top bar shows status, Stop and Resume controls, with takeover and close guidance for read-only external sessions.

- The `full` mode adds `web_search`, reusing a configured official DeepSeek service. It is registered only when configuration and credentials are available and remains subject to network Permission and Policy.

- Recorded tool images support on-demand previews, including externally controlled and closed Sessions, with display resources released on Session changes. Bounded document reading and PDF page images use the same preview path in `full` mode.

- Windows screen capture has separate Session consent and revocation plus an explicit Agent Control grant capability; captures read the existing screen without changing focus.

- The `full` mode includes `read_image`, persistent image references and relative Markdown image assets; model settings preserve image capability selections across application restarts.

- The `full` mode includes `todo_write` with persistent task-list history and separate lists for internal subagents.
- Run results retain known task budgets, partial output, and file-delivery metadata. The `full` mode adds `present` with file type, size, and digest; images still referenced by Sessions remain available beyond 30 days.

## [0.1.0] - 2026-10-24

### 简体中文

**新增**

- 长对话中模型获得 `compact` 工具：可查看上下文压力与压缩块、读回被压缩的原文和溢出文件，并自行选择范围撰写摘要完成压缩。达到软阈值时注入一次临时提醒引导，硬阈值仍由自动压缩兜底。
- 设置工具页新增 MCP Server 配置表单：增删改使用者默认层的服务器（环境变量仅接受 `${NAME}` 引用），配置变更后需在信任面板重新确认。
- 设置工具页的扩展条目新增停用/启用开关，登记在下次启动 Host 时生效。
- 在用户数据根 `tools/` 目录放置 TOML 文件即可声明命令工具：占位符整位替换模型参数、不进入 shell 语法，执行沿用 Shell 的权限与审批链路；工具需在模式中列出才会提供给模型。

**改进**

- 压缩结果保存为逐块校验的块序列，多次压缩各自成块、互不覆盖；分支会携带已压缩块，摘要不再丢失。
- 压缩压力阈值预留输出预算（上限为窗口的四分之一），长输出请求更早压缩；每次压缩的原因（手动、自动、超限恢复、模型主动）写入会话记录。
- 会话列表使用可重建的目录索引缓存，未变化的记录不再每次完整解析，长会话目录下列表与恢复浏览明显变快。
- 扩展安装目录支持一目录一包（含 `index.js` 入口）；已安装扩展可停用并登记在数据根，下次启动生效，配置层显式声明的路径不受影响。

**兼容性**

- 工作区信任记录改存数据根的 `trust.json`：旧版 `tui-trust.json` 仍自动读取并在下次写入时合并进新文件，旧文件保留不删除。

**修复**

- 模型请求的凭据绑定用户或命令行声明的服务地址与接口，项目覆盖地址或密钥引用时拒绝发送；对话、压缩和内部子代理沿用同一轮次的绑定快照。
- 自定义搜索后端仅由用户配置或命令行选择，项目配置不能借只读搜索启动指定程序；受管理回收目录拒绝越界路径与指向文件边界外的链接。
- MCP 工具保留服务器配置身份，身份限定的参数规则和审批记忆按实际登记路径生效。
- 并发创建同名文件时仅一个请求成功，其他请求保留已有内容并返回冲突；搜索流式输出完整保留中文与多字节字符。
- 会话恢复与模型请求校验按记录顺序配对工具调用和结果，复用调用 ID 的新轮次仍会识别未完成调用并记录未知结果。
- Markdown 代码块的复制按钮及成功、失败反馈跟随桌面界面语言显示；复制的代码内容保持原文。

### English

**Added**

- In long conversations the model gains the `compact` tool: it can inspect context pressure and compaction blocks, read back the summarized originals and overflow files, and compact a chosen range with a summary it writes itself. A one-time reminder appears at the soft threshold; the hard threshold still compacts automatically.
- The settings tools page gains an MCP server configuration form: add, edit, and remove servers in the user defaults layer (environment entries only accept `${NAME}` references); a changed configuration needs trust again in the trust panel.
- Extension entries on the settings tools page gain disable/enable toggles; the registry takes effect the next time the Host starts.
- Declaring a command tool takes a TOML file in the data root's `tools/` directory: placeholders replace whole argument entries so model input never enters shell syntax, and execution follows the Shell permission and approval chain; a tool reaches the model only when a mode lists it.

**Improved**

- Compaction is stored as individually validated blocks, so successive passes form separate blocks instead of overwriting one summary, and branches carry their blocks instead of losing the summaries.
- The compaction threshold reserves the output budget (capped at a quarter of the window), so long-output requests compact earlier; every compaction records its reason (manual, automatic, overflow recovery, or model-initiated) in the session record.
- Session listing uses a rebuildable directory index, so unchanged records are no longer fully re-parsed on every list, making listing and resume browsing faster for long session directories.
- The extension install directory supports one-directory packages with an `index.js` entry; installed extensions can be disabled through a registry in the data root that takes effect on the next start, while paths declared by configuration layers stay unaffected.

**Compatibility**

- The workspace trust record now lives in `trust.json` under the data root. The earlier `tui-trust.json` is still read and merged into the new file on the next write; the old file is kept untouched.

**Fixed**

- Model requests bind credentials to the service URL and API declared by the user or command-line flags. Project overrides of the URL or key reference cannot send existing credentials; conversation, compaction, and internal subagents share the turn's binding snapshot.
- Custom search backends can only be selected through user configuration or command-line flags; project configuration cannot launch its own program through read-only search. Managed trash rejects paths and links outside the workspace boundary.
- Registered MCP tools retain their server configuration identity so identity-bound argument rules and approval memory apply correctly.
- Concurrent file creation has one winner and reports conflicts without overwriting content. Streaming search output preserves Chinese and other multibyte characters.
- Recovery and model-request validation pair tool calls with results in record order. A later turn reusing a call ID still detects its pending call and records an unknown outcome.
- The Markdown code block copy button and its success or failure feedback follow the Desktop interface language; copied code remains unchanged.

## [0.0.7] - 2026-10-22

### 简体中文

**新增**

- 默认 `minimal` 模式增加 `managed_process`，可在同一 Session 中启动受 Guardian 管理的本地开发服务器，查看就绪状态、端口与有界日志，并显式停止进程；启动命令沿用 `exec` 的 Permission、Policy、工作区信任与脚本审批。
- 增加外控会话输入栏，可查看当前会话的模型、工具模式、Policy、Permission 与 Grant 上限，并向同一 Host Session 发送消息；会话菜单可查看内部子代理记录。
- 增加 MCP 信任设置面板，可查看本机 Server 启动详情、按会话/项目/用户范围信任或撤销；信任仅允许启动进程，工具调用仍逐次经过 Policy。

**改进**

- 审批卡对大型参数先显示字节数、摘要和短预览，可信界面可在待决期间按需展开详情。审批记忆支持本次、会话、项目和用户范围；文件许可默认限定在当前文件。
- Policy 使用 `ask`、`auto`、`none` 三档，旧版 `never` 保持拒绝语义。硬拒绝、审批不可用与取消保持各自结果，不显示为用户拒绝。
- 设置重组为八个独立入口，常规页整合外观设置；工具模式和 Grant 选择只用于查看，不会改变运行中的会话。权限、MCP Server 和 Grant 的低频细节按需展开，保留原有创建、信任、审批和撤销操作。
- MCP 信任面板读取 Server 工具清单设有有界超时；无响应的 Server 不会无限期占用临时连接。

**安全**

- 撤销工作区信任会停止基于该信任启动的受管进程；其他 Host 定期检查共享信任状态。
- 子代理只能使用父会话当前可见的工具；显式子 Mode 不能恢复父 Mode 隐藏或 Permission 不可用的工具。

### English

**Added**

- Added `managed_process` to the default `minimal` mode. It starts local development servers under Guardian ownership, reports readiness and port, provides bounded logs, and supports explicit stop within the same Session. Start commands keep `exec` Permission, Policy, workspace trust, and script approval checks.
- Added an external-session composer that shows the active session's model, tool mode, Policy, Permission, and Grant ceilings, and routes messages to the same Host Session. The conversation menu also exposes internal subagent records.
- Added MCP trust settings to inspect local server launch details and trust or revoke servers at session, project, or user scope. Trust permits process startup only; every tool call still passes through Policy.

**Improved**

- Approval cards show a byte count, digest, and short preview for large parameters; trusted interfaces can retrieve full details while the request is pending. Remembered approvals support one-call, session, project, and user scopes; file approvals default to the selected file.
- Policy now distinguishes `ask`, `auto`, and `none`, while legacy `never` retains its refusal behavior. Hard denials, unavailable approval channels, and cancellation keep distinct outcomes instead of appearing as user refusals.
- Settings now has eight separate sections, with appearance controls in General. Mode and Grant selections only change what is inspected; they do not change a running session. Less-frequent Permission, MCP server, and Grant details expand on demand while existing create, trust, approval, and revoke actions remain available.
- MCP server tool discovery in the trust panel has a bounded timeout, so an unresponsive server cannot hold a temporary connection indefinitely.

**Security**

- Revoking workspace trust stops managed processes started from that trust; other Hosts periodically check the shared trust state.
- Subagents are limited to tools visible to the parent session; an explicit child Mode cannot restore tools hidden by the parent Mode or unavailable under its Permission.

## [0.0.6] - 2026-10-19

### 简体中文

**新增**

- 新会话发送第一条消息前可设置工具模式、审批方式、文件/命令权限与网络模式；完全访问和不受限网络仍需分别确认，并由 Host 记录确认来源。
- 增加会话 Permission 控制面板，可查看平台隔离能力并单独更改文件/命令档位与网络模式；启用 `full-access` 或不受限网络需要确认，Sandbox 能力不足时 Shell 会拒绝执行。
- 模型服务提供可编辑的模型目录表，支持逐模型名称、上下文窗口和最大输出 token 数；获取可用列表后可选择要加入的模型，并保留已有模型的手动参数，设置实际用于选中模型的请求与压缩。

**改进**

- 安装包中的 Node 运行树只包含产品清单和生产依赖；构建与运行资源检查会拒绝源码、测试材料和嵌套部署目录。
- 当文件权限边界与项目目录不同时，会话归属、项目设置与重启恢复仍使用实际项目目录。
- 状态栏显示 Host 确认的运行阶段与无进展时长；长标题保留状态和操作按钮的显示空间。
- 共享 Core 区分正常完成、空回复、输出耗尽及断流，安全拒绝非法工具批次，并支持显式输出预算和双 API 非流式 JSON 响应。
- 模型配置在写入前验证共享默认层、项目有效配置和会话显式选择，拒绝时保持文件原文；构建与运行树校验拒绝过时的 Core 内容和越界链接。
- 危险操作分类和自动审批统一使用解析后的 Bash 命令名；引号与字面片段拼接不能绕过硬拒绝或解释器审批。
- Bash 危险命令检查会解码未加引号的转义和可识别的 ANSI-C 字符串；不完整或不支持的转义仍需逐次审批。
- Node/Python 脚本审批卡显示规范路径、SHA-256、解释器、工作区和 Permission；审批等待期间这些内容发生变化会拒绝执行，无法安全绑定的脚本形式也会拒绝运行。

**修复**

- 修复没有选中会话时重连后断连横幅残留；Linux deb 增加 GBM 和 ALSA 运行依赖声明。
- 授权详情显示可信界面来源；旧授权未记录来源时明确标记，不追认为可信界面创建。
- Permission 变更会保留当前会话的 Policy 覆盖和拒绝状态，并在重新打开会话时恢复；旧格式会话仍可读取，但拒绝写入其不支持的设置事件。

### English

**Added**

- New conversations can select a tool mode, approval mode, file/command permission profile, and network mode before the first message. Full access and unrestricted networking still require separate confirmations, which the Host records with their source.
- Added a per-session Permission panel to inspect platform isolation capabilities and change file/command profiles separately from network mode. Enabling `full-access` or unrestricted networking requires confirmation; Shell is denied when sandbox capabilities are insufficient.
- Added editable model catalogs with per-model display names, context windows, and maximum output tokens. Fetching shows the available models for selection and preserves existing manual settings; the selected model's limits control actual requests and compaction.

**Improved**

- Restricted the packaged Node runtime tree to its product manifest and production dependencies; build and runtime-resource checks reject source files, test material, and nested deployment directories.
- Session ownership, project settings, and restart recovery use the actual project directory when it differs from the filesystem permission boundary.
- Status shows Host-confirmed run phases and time without progress; long titles retain space for status and action buttons.
- Shared Core distinguishes normal completion, empty replies, exhausted output, and interrupted bodies, safely rejects invalid tool batches, and supports explicit output budgets and non-streaming JSON responses for both APIs.
- Model configuration validates shared defaults, effective project settings, and explicit session selections before writing; rejected edits preserve the file. Build and runtime-tree checks reject stale Core content and links escaping the runtime.
- Dangerous-operation checks and automatic approval use the same parsed Bash executable name, so quoting or literal concatenation cannot bypass hard denials or interpreter approval.
- Bash dangerous-command checks decode unquoted escapes and recognized ANSI-C strings; incomplete or unsupported escapes remain approval-gated.
- Node/Python script approval cards show the canonical path, SHA-256, interpreter, workspace, and Permission. Changes while approval is pending refuse execution, and script forms that cannot be safely bound are refused.

**Fixed**

- Fixed the disconnected banner remaining after reconnecting without a selected session; the Linux deb now declares GBM and ALSA runtime dependencies.
- Grant details identify grants created through the trusted UI and label legacy grants whose origin was never recorded.
- Permission changes preserve the current session's Policy override and denial state across reopen. Legacy session records remain readable but refuse unsupported setting events.

## [0.0.5] - 2026-10-15

### 简体中文

- 改善桌面侧栏搜索焦点、工作区分组和停止本轮操作的可见性；支持折叠其他会话。
- 添加 DeepSeek、OpenAI 与 Anthropic 服务预设，以及 OpenAI 兼容服务的模型发现和多选；凭据使用系统凭据库或环境变量引用。
- 增加需明确确认的「完全不需审批」档位；工作区边界、拒绝规则和安全守卫仍然生效。
- 外观设置增加独立的界面、用户消息和模型回复 px 字号，以及可调会话行距；审批设置内容支持键盘和滚轮滚动。

### English

- Improved desktop search focus, workspace grouping, and stop-turn visibility; the Other conversations group can be collapsed.
- Added DeepSeek, OpenAI, and Anthropic service presets plus model discovery and multi-select for OpenAI-compatible endpoints; credentials use the OS credential store or environment-variable references.
- Added a no-approval tier that requires explicit confirmation; workspace boundaries, deny rules, and safety guards remain active.
- Added independent px controls for interface, user-message, and assistant-message fonts, adjustable transcript line spacing, and keyboard/scroll-wheel access to approval settings.

## [0.0.4] - 2026-10-14

### 简体中文

#### 桌面架构

- Desktop 从 Tauri 迁移到 Electron，通过 React 前端、Electron Main/Preload 和独立 Node Host 连接共享 Agent 内核；会话状态与工具权限仍由 Host 管理。
- 安装包内置对应平台的 Node 运行时与 Host 依赖，安装后不需要用户另外安装 Node.js、npm 或 pnpm。

#### 工作区、审批与可靠性

- 新增工作区选择与默认工作区设置，支持在不同项目间切换，同时维持工作区和会话的归属关系。
- 提供桌面端审批设置与交互反馈；文件和命令操作继续遵循共享 Host 的权限规则。
- 改进跨会话导出及保存操作，处理文件对话框取消、目标覆盖与过期会话响应等情况，降低作用到错误文件或会话的风险。
- 加强 Electron Main/Preload 与 Host 间的输入校验及退出清理；Renderer 不直接获得任意 Node、文件系统或命令执行能力。

#### 发行平台

- 提供 **Windows x64 NSIS 安装程序**、**Linux x64 AppImage 和 deb**。

### English

#### Desktop architecture

- Migrated Desktop from Tauri to Electron, connecting the React UI, Electron Main/Preload, and an isolated Node Host to the shared Agent kernel. Session state and tool permissions remain owned by the Host.
- Bundled the platform-matched Node runtime and Host dependencies, so users do not need to install Node.js, npm, or pnpm separately to run the installed app.

#### Workspaces, approvals, and reliability

- Added workspace selection and default-workspace settings for switching projects while preserving correct workspace/session ownership.
- Added Desktop approval settings and interaction feedback. Filesystem and command operations continue to follow shared Host policy.
- Improved export and save operations across session changes, handling cancelled file dialogs, overwrite decisions, and stale session responses to reduce the risk of acting on the wrong session or file.
- Strengthened input validation and shutdown cleanup between Electron Main/Preload and Host; the renderer has no unrestricted Node, filesystem, or command execution access.

#### Release platforms

- Ships a **Windows x64 NSIS installer** and **Linux x64 AppImage and deb** packages.
