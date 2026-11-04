# 更新记录 / Changelog

本文件只记录 CLI/npm 产品中面向使用者的重要变化。桌面安装包和应用变化单独记录在 `desktop/CHANGELOG.md`。

This file records user-visible changes for the CLI/npm product only. Desktop installer and application changes are recorded separately in `desktop/CHANGELOG.md`.

## [Unreleased]

### 简体中文

**改进**

- 审批方式改为四档：`always`（每次都要审批）、`ask`（逐次审批）、`auto`（自动判定）、`never`（完全不审批）。`/policy`、审批方式选择器和底部配置行同步更新；选择 `never` 前必须先确认，并说明规则表里的 allow/ask/deny 不再参与判定。
- 旧配置、旧会话记录和旧授权里的 `none`、以及旧语义的 `never` 一律按 `ask` 读取，历史数据不会自动变成“跳过审批”；新写入的记录带语义标记，可与旧记录区分。
- 用户或项目配置可用 `[reviewer]` 表启用可选的自动审批复审：它默认关闭，只在 `auto` 且确定性策略认不出命令形状时调用一次独立模型；复审只能回答 allow / deny / ask-human，超时、超预算与不合规回复一律转人工审批，规则拒绝、硬拒绝、强制人审、私有网络与外部访问永远不交给模型；结论以 `policyReview` 事件记入会话（可跳过、不进入模型上下文）。未配置时 `auto` 行为不变。
- `/usage` 显示本会话的 Token 用量，主 Agent 与复审分成两份账：缓存命中是输入的子集、不重复计入，端点没有报回的数字保持未知而不是记成 0；桌面端与外控读取同一份 `usage.get` 汇总。

**修复**

- 外控授权向导提交完成后，尚未处理的一次回车不再会从陈旧状态复活向导、用同一个名字重复提交授权。
- `/usage` now shows this session's token usage with the main agent and the reviewer accounted separately: cached tokens are a subset of the input and are never added to it again, numbers the endpoint did not report stay unknown instead of becoming zero, and the desktop app and external control read the same `usage.get` aggregate.

### English

**Improved**

- Approval modes are now `always` (every call waits), `ask`, `auto`, and `never` (skip the policy layer). `/policy`, the mode picker, and the bottom configuration line follow the new set; choosing `never` requires a confirmation that explains allow/ask/deny rules no longer take part.
- Legacy `none` values and the old `never` meaning are read as `ask` in existing config, session records, and grants, so history never silently becomes “skip approvals”. Newly written records carry a semantics marker that separates them from old ones.
- A `[reviewer]` table in the user or project configuration can enable an optional automatic approval reviewer. It is off by default and only runs under `auto`, when the deterministic policy cannot recognise the command shape; it may answer only allow / deny / ask-human, and timeouts, exhausted budgets and unusable replies always fall back to asking a human. Deny rules, hard denials, forced manual approval, private networks and external access are never handed to the model. Decisions are recorded as `policyReview` session events (skippable, never part of the model context). Without the table, `auto` behaves exactly as before.

**Fixed**

- After a grant request is submitted, an Enter that was still in flight can no longer resurrect the wizard from stale state and submit the same grant twice.

## [0.1.2] - 2026-11-02

### 简体中文

**改进**

- Agent Control 的 `ligule_run_get` 可在授权项目中只读查询已保存回执；控制器重启后无需重新打开 Session 或占用写锁，任务不会因此重放。

**修复**

- Session 切换 Mode 时，旧工具清单会保持生效，直到新设置写入成功；自定义 TOML 工具冲突和单个 Skill 文件读取失败会报告各自诊断，不再遮蔽其他可用条目。

### English

**Improved**

- Agent Control `ligule_run_get` can read a persisted receipt in the authorized project without reopening the Session or taking its writer lock after a controller restart. The lookup does not replay work.

**Fixed**

- During a Session Mode change, the previous tool set stays active until the new settings are persisted. Conflicting TOML tools and individual unreadable Skill files report diagnostics without hiding other usable entries.

## [0.1.1] - 2026-11-01

### 简体中文

- 终端常驻区只保留模型、思考档（模型声明可用时）、工具模式、权限、审批与会话阶段；预算、计数和完整标识符在 `/status` 查看。
- 外控授权向导读取 MCP 清单期间可取消；迟到结果不会重新打开向导。提交授权后会显示等待状态，避免误报取消或重复创建。
- MCP Server 信任请求及其异步结果绑定发起时的 Session；切换会话后，迟到的读取或确认结果不会污染另一会话。
- 外控问题答复失败时保留已填写答案并允许重试；只有 Host 确认接收后才清除待处理交互。
- 窄终端下状态行按可用列宽截断并保留打断提示；MCP 调用的目标从实际嵌套参数中提取，避免显示错误目标。
- 权限结果仅在实际提高权限时标记为升级，避免普通策略判断被误报为权限升级。

- `run.wait` 必须明确指定 `origin`，但该字段不授予权限。可信本地 UI 可读取本 Session 的所有回执；经过认证的 Agent Control 桥接受限于 human 与当前 Grant scope；其他 Host 只能读取自己的 controller scope。Host 按持久 Run 归属与调用方上下文授权。跨 scope 的 `requestKey` 多重匹配返回 `run_request_key_ambiguous`，应使用 `runId`。
- POSIX MCP Server 使用独立进程组；撤销、取消或 Host 关闭时有界地发送终止信号并清理仍存活的所属子进程，失败保留为可重试错误。主动通过 `setpgid` 移入其他进程组或通过 `setsid` 创建新会话的后代不在原进程组边界内。
- `delete` 只使用操作系统回收站；系统后端报错后会复核原目标对象身份及顶层元数据，仍匹配时返回后端错误；不核对文件正文或递归目录内容，无法确认时返回 `delete_outcome_unknown`。Linux 通过 GIO 调用系统回收站。历史 `.ligule-trash` 不迁移或清理，Shell 删除继续使用自己的 Policy 与审批链。
- 用户层 `[telemetry]` 可显式开启有界本地 JSONL 事件日志和可选的本机 OTLP Trace；默认关闭，导出不含对话正文或工具内容。
- `[loop].maxParallelTools` 限制范围为 1–32，默认 4，防止一次模型响应启动不受限的工具并发。
- `ligule run --json` 输出可校验的 Host 终态与调用统计，不输出回答正文；必须在命令行显式加 `--allow-full-access` 才会使用当前操作系统用户的完整权限运行，并且没有 OS 沙箱。Policy 的审批和拒绝规则继续生效。
- `[loop].maxConcurrentSubagents` 可在 1–8 间设置内部子代理并发数，默认 3；任务可设置默认 12 小时的累计交互等待上限，只有所有工作都被交互阻塞时才暂停执行期限。
- 并行审批或提问重叠时，执行期限会等最后一个阻塞交互结束后再恢复，不会因单个等待提前恢复。
- `managed_process` 仅在健康检查 URL 返回 HTTP 2xx 后报告就绪；启动前的回环端口检查覆盖 IPv4 与 IPv6。
- `managed_process` 对非 2xx 响应和请求失败使用有界退避；HTTP 2xx 立即就绪，用户取消或所属进程退出会停止探测。
- `fetch` 的同源重定向只能连接首次策略检查覆盖的 IP；特殊用途地址按 IANA 转发与全球可达属性执行审批或拒绝，截断提示按保留字节数计算。
- `managed_process` 分别报告 `terminationPending` 与 `cleanupPending`，区分进程活性未知和进程结束后的平台资源清理失败；两者可同时为 true，关闭或显式停止会重试可重试的资源清理，未确认状态的条目不会被淘汰。
- 本地 Telemetry 遇到未知 Manifest 文件时会保留原文件、停用当前写入器并报告稳定错误码；Host 日志不记录路径或正文。
- Session 用量保留提供方明确上报的缓存命中、未命中与输出字段；缺失的总量和成本仍为未知，不按账户日账单推算单次 Run 费用。
- 外控委派支持持久 `runId` 回执、`requestKey` 去重与 `ligule_run_get` 查询，重启后可读取已保存的结果或中断状态，不自动重跑任务。
- CLI/TUI 显示已确认的文件交付。`ligule storage inspect` 检查工作区数据；交互式 `storage cleanup` 分页核查历史引用、预览并确认删除过期截图及带归属/租约验证的受管残留（未知旧目录保留）。

- 支持可信配置的无头 Playwright MCP 浏览器，按会话隔离，截图沿用持久图像通路；`/browser` 可查看状态、停止及恢复。

- `full` 模式新增 `web_search`，复用已配置的官方 DeepSeek 服务；仅在配置和凭据可用时注册，仍受网络 Permission 与 Policy 控制。

- `full` 新增 `read_document`，受限读取 PDF、DOCX、XLSX、PPTX，支持定位续读、公式缓存与 PDF 页面图像；独立进程限制资源并响应取消。

- Windows `full` 新增单帧 `screenshot`，沿用持久图像通路；新增独立截图同意、撤销及明确的外控 Grant 上限，捕获不切换焦点。

- `full` 模式新增 `read_image`，支持持久图像引用、两种模型协议、会话恢复与分支；Markdown 可携带图片副本导出。
- 模型服务可按模型声明 `imageInput`，未知图像能力默认拒绝，子代理图片按会话隔离。

- 外控新增 `ligule_session_close` 关闭空闲会话并释放名额，人工接管同样释放名额；会话历史继续保留。
- `full` 模式新增 `todo_write`，支持每轮独立、持久保存历史的完整任务清单，内部子代理各自隔离。
- 委派运行支持整个任务和单次模型请求的期限、父子共享模型调用次数上限；失败结果保留已确认的用量与部分正文。`full` 新增 `present`，记录工作区文件交付时的类型、大小和 SHA-256。图片按 Session 引用保留，过期且未引用的图片可有界清理。

### English

- The terminal status area keeps only the model, thinking effort (when the model declares one), tool mode, permission, approvals, and the session phase; budgets, counters, and full identifiers live in `/status`.
- The Agent Control grant wizard can be canceled while it reads MCP lists; late responses no longer reopen it. Grant submission shows a waiting state to prevent false cancellation and duplicate creation.
- MCP server trust requests and their asynchronous results stay bound to the originating Session; late list or confirmation responses after a Session switch cannot change another Session's trust state.
- Failed external question replies retain the entered answers for retry; the pending interaction is cleared only after the Host confirms the reply.
- On narrow terminals, the status line truncates to the available width while preserving the interrupt hint; MCP call targets are derived from their actual nested arguments.
- Permission results are marked as escalations only when they actually raise privileges, avoiding false escalation labels for ordinary policy decisions.

- `run.wait` requires an explicit `origin`, but that field does not grant access. A trusted local UI can read all Receipts in its Session; an authenticated Agent Control bridge is limited to human and its active Grant scopes; other Hosts can read only their controller scope. The Host authorizes access from the persisted Run owner and caller context. An ambiguous `requestKey` across visible scopes returns `run_request_key_ambiguous`; use `runId` to select one.
- POSIX MCP servers use dedicated process groups. Revoke, cancellation, and Host shutdown send bounded termination signals and clean up surviving owned descendants; failures remain retryable. Descendants that move to another group with `setpgid` or start a new session with `setsid` are outside the original process-group boundary.
- `delete` uses only the operating system recycle bin. After a backend error, Ligule rechecks the original target's identity and top-level metadata: a match returns the backend error. It does not compare file contents or recursively inspect directories; if the target cannot be confirmed, it returns `delete_outcome_unknown`. Linux delegates to GIO's system trash operation. Legacy `.ligule-trash` folders are neither migrated nor cleaned; Shell deletion keeps its own Policy and approval path.
- User-layer `[telemetry]` can explicitly enable bounded local JSONL events and optional loopback OTLP traces; it is disabled by default and exports no conversation or tool content.
- `[loop].maxParallelTools` is capped at 1–32 (default 4) to prevent one model response from starting unbounded tool concurrency.
- `ligule run --json` emits a verifiable Host terminal state and call counts without response text. Full local permissions require the explicit `--allow-full-access` flag and run as the current OS user without an OS sandbox. Policy approvals and denials still apply.
- `[loop].maxConcurrentSubagents` sets internal subagent concurrency from 1 to 8 (default 3). Tasks also have a cumulative interaction-wait limit of 12 hours by default; the execution deadline pauses only while all work is blocked on interaction.
- Overlapping parallel approvals or questions keep the execution deadline paused until the last blocking interaction ends.
- `managed_process` reports ready only after its health URL returns HTTP 2xx; startup port checks cover IPv4 and IPv6 loopback.
- `managed_process` uses bounded backoff for non-2xx responses and request failures; HTTP 2xx is immediate, and cancellation or owned-process exit stops probing.
- Same-origin `fetch` redirects can connect only to IPs covered by the initial Policy check; IANA forwardability and global reachability determine whether special-purpose addresses require approval or are denied, and truncation reports retained response bytes.
- `managed_process` reports `terminationPending` and `cleanupPending` separately for unknown process liveness and failed platform-resource cleanup after exit; both can be true. Close and explicit stop retry cleanup when retryable; entries with either unresolved state are not evicted.
- Local Telemetry preserves unknown Manifest files, disables the current writer, and reports a stable error code; Host logs omit paths and content.
- Session usage preserves provider-reported cache hit, miss, and output fields. Missing totals and costs remain unknown; account-wide daily billing is not attributed to a single run.
- External delegation adds durable `runId` receipts, `requestKey` deduplication and `ligule_run_get` for result or interruption lookup after restart, without automatic replay.
- CLI/TUI display confirmed file deliveries. `ligule storage inspect` reports Workspace data; interactive `storage cleanup` pages Session references and confirms old screenshots or owner/lease-verified managed residue, preserving unknown legacy folders.

- Trusted configuration can enable a headless Playwright MCP browser with Session isolation and durable screenshots; `/browser` shows status, stops, and resumes it.

- The `full` mode adds `web_search`, reusing a configured official DeepSeek service. It is registered only when configuration and credentials are available and remains subject to network Permission and Policy.

- `full` includes `read_document` for bounded PDF, DOCX, XLSX and PPTX extraction, located continuation, cached formulas and PDF page images, with isolated resource limits and cancellation.

- Windows `full` includes single-frame `screenshot` with persistent images, separate consent and revocation, explicit Agent Control grant limits, and no focus changes.

- The `full` mode includes `read_image` with persistent images, both provider protocols, Session recovery and branching, and portable Markdown image exports.
- Per-model `imageInput` declarations keep unknown image capabilities disabled and isolate internal subagent images by Session.

- External controllers can close idle sessions with `ligule_session_close`; closing and human takeover release session slots while preserving history.
- The `full` mode includes `todo_write` for per-turn task lists with durable history and isolated internal subagent state.
- Delegated runs support whole-task and per-request time limits plus a shared parent/child model-call budget; failures retain known usage and partial text. The `full` mode adds `present` with file type, size, and SHA-256 metadata. Session references protect images from expiration; old unreferenced images support bounded cleanup.

## [0.1.0] - 2026-10-24

### 简体中文

**新增**

- 长对话中模型获得 `compact` 工具：可查看上下文压力与压缩块、读回被压缩的原文和溢出文件，并自行选择范围撰写摘要完成压缩。达到软阈值时注入一次临时提醒引导，硬阈值仍由自动压缩兜底。
- `/mcp add <名称> <程序> [参数…]` 与 `/mcp remove <名称>` 把 MCP Server 写入使用者默认配置（环境变量引用与工作目录在配置文件中补充，配置变更后需重新信任）。
- `/extensions [on|off <名称>]` 列出用户扩展并支持停用与启用，登记在下次启动 Host 时生效。
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

### English

**Added**

- In long conversations the model gains the `compact` tool: it can inspect context pressure and compaction blocks, read back the summarized originals and overflow files, and compact a chosen range with a summary it writes itself. A one-time reminder appears at the soft threshold; the hard threshold still compacts automatically.
- `/mcp add <name> <executable> [args…]` and `/mcp remove <name>` write MCP servers into the user defaults (add environment references and a working directory in the config file; a changed configuration needs trust again).
- `/extensions [on|off <name>]` lists user extensions and disables or enables them; the registry takes effect the next time the Host starts.
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

## [0.0.8] - 2026-10-23

### 简体中文

**修复**

- CLI 安装包仅内置私有 Core 的代码与资源，外部运行依赖由 npm 为当前系统安装，确保同一发行包在 Windows 和 Linux 加载对应的搜索与原生绑定。

### English

**Fixed**

- The CLI tarball bundles the private Core code and resources, while npm installs external runtime dependencies for the consumer's system. The same release artifact loads the matching search backend and native bindings on Windows and Linux.

## [0.0.7] - 2026-10-23

### 简体中文

**改进**

- 终端界面输入 `/` 即可浏览全部命令，按名称或说明筛选并滚动选择；固定命令参数支持 Tab 补全，补全仅修改草稿，权限升级仍需确认。
- `/sessions` 和不带参数的 `/resume` 支持按名称、编号或工具模式筛选；列表优先显示会话名称，筛选文字与聊天草稿分别管理。
- 欢迎区改为左对齐；运行阶段使用 Host 确认的状态，输入区限制显示高度。选择菜单、会话列表、历史和审批面板打开时让普通编辑区让位；工具调用先显示目标摘要，完整内容可从 Ctrl+O 查看。颜色使用继承终端调色板的 ANSI 角色，空间不足时禁用审批操作。
- `/queue list` 可查看待发送消息及队列状态。
- 长问题与选项可分页阅读，回答输入区保持可见；审批和历史详情中的粘贴不会修改隐藏草稿。

**修复**

- Delete 向前删除完整字符，Backspace 向后删除；多行输入的上下移动按显示列定位，避免拆开中文、组合字符和表情。
- 会话切换在目标会话成功打开后才释放原会话锁；切换失败时继续保留当前会话。
- 草稿和外部编辑器内容中的 CRLF 在编辑前统一为 LF，避免光标移动或删除时留下孤立的回车符。
- 未设置 `FORCE_COLOR` 时，终端启动遵守非空的 `NO_COLOR`；窄窗口保留当前会话状态提示。
- 工具审批和提问会临时收起授权设置向导；问题回答只发送给当前问题，不会被用作授权参数。
- 问题回答独立于普通草稿，回答或取消后恢复原文字和光标；退出时保存普通草稿与队列，问题期间收回队列也保留原输入。

### English

**Improved**

- Typing `/` in the terminal UI browses all commands with name or description filtering and scrollable selection. Fixed command arguments support Tab completion, which only edits the draft; permission upgrades still require confirmation.
- `/sessions` and `/resume` without arguments filter by session name, ID, or tool mode. Names appear first, and search text stays separate from the chat draft.
- The welcome area is left-aligned; run phases use Host-confirmed status, and the composer has a bounded display height. Selection menus, session lists, history, and approvals take the place of ordinary editing while open. Tool calls lead with a target summary, with full details available through Ctrl+O. ANSI color roles follow the terminal palette, and approvals are disabled when the window cannot show the required information.
- `/queue list` shows pending messages and queue status.
- Long questions and options can be paged while the answer editor stays visible; pasting in approvals or transcript details preserves the hidden draft.

**Fixed**

- Delete removes the next whole character and Backspace the previous one. Vertical movement in multiline drafts follows display columns without splitting Chinese text, combining characters, or emoji.
- Session navigation releases the previous session lock only after the target opens successfully; a failed switch keeps the current session active.
- CRLF in saved drafts and external-editor content is normalized to LF before editing, so movement and deletion do not leave a stray carriage return.
- Terminal startup honors a nonempty `NO_COLOR` when `FORCE_COLOR` is unset, and narrow windows retain the active-session status hint.
- Tool approvals and questions temporarily hide grant setup; question answers go only to the active question and cannot become grant parameters.
- Answers use a separate draft. Answering or cancelling restores the original text and caret; exit saves the ordinary draft and queue, and queue recovery during a question preserves existing input.

## [0.0.6] - 2026-10-22

### 简体中文

**新增**

- 默认 `minimal` 模式增加 `managed_process`，可在同一 Session 中启动受 Guardian 管理的本地开发服务器，查看就绪状态、端口与有界日志，并显式停止进程；启动命令沿用 `exec` 的 Permission、Policy、工作区信任与脚本审批。
- `full` 工具模式包含内部 `subagent`，可并行委派最多三个独立子任务；子任务保留独立会话记录，可用 `/sub <序号>` 检查。MCP `ligule_run` 与 `ligule_run_start` 也支持单轮模式收窄和经 schema 验证的结构化结果。
- 本地 MCP 控制新增 `ligule_run` 的有界等待和 `ligule_run_await`，超时不会取消仍在运行的任务。
- 增加 `/mcp list|trust|confirm|revoke|tools` 管理本地 MCP Server 信任；信任可按会话、项目或用户范围设置，服务器配置变化后需要重新确认。

**改进**

- 审批方式明确区分 `ask`、`auto`、`none` 与旧版 `never`；记住的许可可限定本次、会话、项目或用户，文件许可默认只记当前文件。
- 大型审批先显示字节数、摘要和短预览，再由可信界面按需展开详情；系统拒绝、审批不可用和取消不再记作用户拒绝。

**安全**

- 撤销工作区信任会停止基于该信任启动的受管进程；其他 Host 会复核共享信任状态并停止相关进程。
- 子代理只能使用父会话当前可见的工具；显式子 Mode 不能恢复父 Mode 隐藏或 Permission 不可用的工具。

### English

**Added**

- Added `managed_process` to the default `minimal` mode. It starts local development servers under Guardian ownership, reports readiness and port, provides bounded logs, and supports explicit stop within the same Session. Start commands keep `exec` Permission, Policy, workspace trust, and script approval checks.
- The `full` tool mode includes the internal `subagent` tool for up to three concurrent independent child runs; each child keeps a separate Session record that can be inspected with `/sub <seq>`. MCP `ligule_run` and `ligule_run_start` also accept per-run mode narrowing and schema-validated structured results.
- Added bounded waiting with `ligule_run` and `ligule_run_await` to the local MCP control tools. A wait timeout does not cancel the active run.
- Added `/mcp list|trust|confirm|revoke|tools` to manage local MCP server trust by session, project, or user scope. Server configuration changes require trust again.

**Improved**

- Approval modes now distinguish `ask`, `auto`, `none`, and legacy `never`. Remembered approvals can be scoped to one call, a session, a project, or the user; file approvals default to the selected file.
- Large approvals show a byte count, digest, and short preview before trusted interfaces retrieve details on demand. System refusals, unavailable approval channels, and cancellation are no longer recorded as user refusals.

**Security**

- Revoking workspace trust stops managed processes started from that trust; other Hosts recheck the shared trust state and stop affected processes.
- Subagents are limited to tools visible to the parent session; an explicit child Mode cannot restore tools hidden by the parent Mode or unavailable under its Permission.

## [0.0.5] - 2026-10-19

### 简体中文

**新增**

- 增加会话 Permission 控制，可查看平台隔离能力并单独更改文件/命令档位与网络模式；启用 `full-access` 或不受限网络需要确认，Sandbox 能力不足时 Shell 会拒绝执行。
- 增加 `ligule mcp-server --project <绝对目录>` 本地 stdio MCP 入口，支持会话管理、任务运行与取消、状态查询和记录分页。显式启用 `--operator` 后可修改受支持的会话设置，并答复真实待决的审批或提问；operation ID 和消息队列仅在当前进程内有效。
- 增加 `model.outputTokens` 请求预算与双 API 非流式 JSON 响应支持；模型设置在完整配置校验通过后才保存，拒绝时保留文件原文并保护其他项目的启动。

**改进**

- `/control list` 显示授权来源；旧记录没有来源时明确标注未记录，不推断创建渠道。
- 权限变更记录只会在本次操作实际启用完全访问或不受限网络时标记对应确认。
- 共享模型服务配置支持逐模型上下文窗口和输出额度，按当前选择应用于请求与压缩，兼容原有模型标识列表。
- 完整校验模型终止原因，区分空回复、输出耗尽、协议不完整及断流；非法工具批次不执行副作用，诊断不包含原始参数或网关错误正文。
- 危险操作分类和自动审批统一使用解析后的 Bash 命令名；引号与字面片段拼接不能绕过硬拒绝或解释器审批。
- Bash 危险命令检查会解码未加引号的转义和可识别的 ANSI-C 字符串；不完整或不支持的转义仍需逐次审批。
- Node/Python 脚本审批显示规范路径、SHA-256、解释器、工作区和 Permission；审批等待期间这些内容发生变化会拒绝执行，无法安全绑定的脚本形式也会拒绝运行。
- Permission 变更会保留当前会话的 Policy 覆盖和拒绝状态，并在重新打开会话时恢复；旧格式会话仍可读取，但拒绝写入其不支持的设置事件。
- TUI 显示 Host 确认的运行阶段与无进展时长，并提供可操作的 Provider 错误提示。

### English

**Added**

- Added per-session Permission controls to inspect platform isolation capabilities and change file/command profiles separately from network mode. Enabling `full-access` or unrestricted networking requires confirmation; Shell is denied when sandbox capabilities are insufficient.
- Added `ligule mcp-server --project <absolute-directory>` for local stdio MCP control: manage sessions, run and cancel tasks, query status, and page through records. Explicit `--operator` mode can change supported session settings and answer real pending approvals or questions; operation IDs and the message queue are process-local.
- Added the `model.outputTokens` request budget and non-streaming JSON responses for both APIs. Model settings are saved only after complete configuration validation; rejected edits preserve file contents and other projects' startup behavior.

**Improved**

- `/control list` shows grant origin; legacy grants with no recorded origin are labeled as unknown instead of inferred.
- Permission records mark a confirmation only when that change grants full access or unrestricted networking.
- Shared service configuration supports per-model context windows and output budgets for requests and compaction, while preserving existing model ID lists.
- Validate model finish reasons and distinguish empty replies, exhausted output, incomplete protocols, and interrupted bodies. Invalid tool batches have no side effects, and diagnostics omit raw arguments and gateway error bodies.
- Dangerous-operation checks and automatic approval use the same parsed Bash executable name, so quoting or literal concatenation cannot bypass hard denials or interpreter approval.
- Bash dangerous-command checks decode unquoted escapes and recognized ANSI-C strings; incomplete or unsupported escapes remain approval-gated.
- Node/Python script approvals show the canonical path, SHA-256, interpreter, workspace, and Permission. Changes while approval is pending refuse execution, and script forms that cannot be safely bound are refused.
- Permission changes preserve the current session's Policy override and denial state across reopen. Legacy session records remain readable but refuse unsupported setting events.
- TUI status shows Host-confirmed run phases and time without progress, with actionable Provider error messages.

## [0.0.4] - 2026-10-14

### 简体中文

#### 终端界面与工作区

- 改进 TUI 的工作区信任提示与访问边界处理，让在项目目录中进行文件和命令操作时的授权决策更清楚。
- 优化会话控制与状态反馈，便于在终端中继续对话、取消操作和恢复已有会话；会话数据仍由共享 Host 维护。

#### 稳定性与使用方式

- 完善启动失败时的提示与排查信息，帮助识别工作区、终端环境或模型配置相关的问题。
- CLI 与 TUI 仍通过同一个 npm 包分发：在交互式终端运行 `ligule` 打开 TUI，单轮任务使用 `ligule run "任务内容"`；继续沿用现有的工具审批和会话恢复能力。

### English

#### Terminal UI and workspaces

- Improved workspace trust prompts and access-boundary handling in the TUI, making authorization decisions clearer before filesystem and command operations in a project.
- Refined session controls and status feedback for continuing conversations, cancelling operations, and resuming sessions; the shared Host continues to own session data.

#### Reliability and usage

- Improved startup failure messages and troubleshooting guidance for issues involving the workspace, terminal environment, or model configuration.
- CLI and TUI remain part of the same npm package: run `ligule` in an interactive terminal for the TUI or `ligule run "task"` for one-off requests. Existing tool approval and session recovery capabilities remain available.

## [0.0.3] - 2026-10-12

### 简体中文

#### 新增

- 新增共享 Agent 内核的命令行、终端界面和桌面界面，并提供工具、插件、技能与扩展入口。
- 新增按工作区归属的会话、已完成轮次分支、Markdown 导出、消息队列、输入恢复、检查点压缩和中断恢复。
- 桌面版新增多模型服务设置、系统凭据、待审批和待回答提醒、托盘与通知设置。
- CI 新增 Windows x64、Linux x64、macOS arm64 和 macOS x64 桌面安装包构建。

#### 变更

- 在交互式终端直接运行 `ligule` 会打开终端界面；单轮命令使用 `ligule run`。
- 会话记录默认保存在 `~/.ligule`，并支持使用 `LIGULE_HOME` 指定数据根。

#### 修复

- 取消工具调用时会终止其拥有的进程树；会话锁阻止多个进程同时写入同一记录。
- 恢复时不会重放没有记录结果的工具调用，并会将结果标记为未知。

### English

#### Added

- Added CLI, TUI, and desktop interfaces over one Agent kernel, with tools, plugins, skills, and extensions.
- Added workspace-owned sessions, branches from completed turns, Markdown export, message queues, input recovery, checkpoint compaction, and interrupted-turn recovery.
- Added desktop settings for multiple model services and system credentials, plus approval, question, tray, and notification controls.
- Added CI builds for Windows x64, Linux x64, macOS arm64, and macOS x64 desktop installers.

#### Changed

- Running `ligule` in an interactive terminal opens the TUI; use `ligule run` for a single request.
- Session records default to `~/.ligule`; set `LIGULE_HOME` to choose another data root.

#### Fixed

- Cancelling a tool call terminates its owned process tree; session locks prevent concurrent writers to one record.
- Recovery does not replay tool calls without recorded results and marks their outcomes as unknown.

## [0.0.1] - 2026-09-29

### 简体中文

初始公开版本。完整记录见 [v0.0.1 GitHub Release](https://github.com/xswt442-cmd/ligule/releases/tag/v0.0.1)。

### English

Initial public release. See the [v0.0.1 GitHub Release](https://github.com/xswt442-cmd/ligule/releases/tag/v0.0.1) for its published record.
