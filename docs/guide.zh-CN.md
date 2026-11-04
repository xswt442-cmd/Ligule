# ligule 使用手册

[简体中文](guide.zh-CN.md) · [English](guide.en.md)

ligule 提供命令行、终端界面和桌面界面。三种入口使用同一套配置和会话记录。

## 开始使用

- [开始第一次对话](#开始第一次对话)
- [安装和启动](#安装和启动)
- [工作区和数据](#工作区和数据)
- [配置模型服务](#配置模型服务)

## 日常使用

- [会话和输入](#会话和输入)
- [工具模式与内部子代理](#工具模式与内部子代理)
- [审批和设置](#审批和设置)
- [分支和导出](#分支和导出)

## 恢复和参考

- [恢复和取消](#恢复和取消)
- [语言、外观和快捷键](#语言外观和快捷键)
- [常见问题](#常见问题)

### 开始第一次对话

1. 选择命令行与终端界面，或桌面界面。CLI 和 TUI 通过 `npm install -g ligule` 安装；桌面版安装与系统平台和架构匹配的程序包。
2. 配置模型服务：桌面版在「设置 → 模型服务」中填写；CLI 和 TUI 按[模型服务配置](#配置模型服务)填写配置文件。
3. 在项目目录运行 `ligule run "查看项目结构并提出建议"` 完成单轮任务，或运行 `ligule` 打开终端界面。桌面版选择工作区并新建会话后发送消息。

### 安装和启动

命令行包需要 Node.js 24 或更新版本。通过 npm 安装 CLI 和 TUI：

```sh
npm install -g ligule
```

安装后运行 `ligule --version` 查看 CLI 和 TUI 的版本。桌面版使用 Electron；请安装与系统平台和架构匹配的程序包。

在项目目录中运行 `ligule run "查看项目结构并提出建议"`，可以执行一轮对话。日常使用可以直接运行 `ligule` 打开终端界面，或启动已安装的 ligule 桌面版。`ligule tui` 仍可作为终端界面的兼容命令。终端界面需要交互式终端；脚本和管道使用 `ligule run`。

CLI 单轮任务默认只读。只有明确使用 `ligule run --allow-full-access "..."` 才会为本次运行启用本机完整文件、进程和网络权限；Shell 命令以当前操作系统用户身份执行，不提供 OS 沙箱。此标志仅适用于 `run`，不能通过项目配置或模型调用启用，也不会绕过 Policy 审批、拒绝规则或危险命令硬拒绝。

使用 `ligule --help` 查看命令。`ligule sessions` 列出当前项目的会话，`ligule workspaces` 列出已登记的工作区，`ligule tools`、`ligule skills` 和 `ligule extensions` 查看已加载的能力。

### 工作区和数据

终端界面和命令行默认把启动时所在的目录作为工作区。桌面版首次启动时会在系统文档目录下创建并登记 `ligule/default-workspace`；之后新会话使用设置中选定的默认工作区。桌面左侧栏可以添加其他工作区并查看其中的会话。工作区菜单可以隐藏侧栏条目，也可以删除工作区登记；删除登记前须先取消默认选择，且该目录中有会话运行时暂不能删除。删除登记不会删除项目目录、文件或会话记录；以后重新添加工作区仍可查看原有会话。

终端界面首次进入一个目录时，会在读取项目配置、指南和技能之前询问是否信任，默认选中「退出」。选择「信任并继续」后记住该准确目录，子目录仍需分别确认。使用 `/trust` 查看说明，使用 `/trust revoke` 撤销信任并退出。信任不会自动批准工具，也不会改变审批规则或访问边界；项目 `AGENTS.md` 沿用现有指南装载机制，不能授予系统权限。每次启动会显示 Ligule 标识、版本、工作区和帮助提示。

每个新会话只属于一个工作区。终端界面启动时准备新会话；桌面版启动时恢复上次打开的会话，没有上次会话时准备一个新会话。会话记录保存在用户数据根的 `workspaces/<可读工作区路径>--<短哈希>/sessions/` 下。路径名保留工作区特征，哈希用于避免不同路径重名。桌面版新会话的工作区菜单提供「浏览」按钮，可用系统文件夹选择器选目录，也可直接输入路径。

用户数据根默认为 `~/.ligule`。设置绝对路径环境变量 `LIGULE_HOME` 可以更换数据根；相对路径会报 `data_root_invalid`。用户配置在 `~/.ligule/config.toml`，项目共享配置在 `.ligule/config.toml`，项目本地配置在 `.ligule/config.local.toml`。用户数据根还保存：工作区登记 `workspaces.json`、工作区信任记录 `trust.json`（旧版本的 `tui-trust.json` 仍可读取）、MCP 服务器信任 `mcp-trust.json`、外部 Agent 授权 `agent-control.json`、扩展启停登记 `extensions-state.json`、终端输入历史、桌面偏好 `desktop.json` 和密钥引用（密钥本身存放在系统凭据库，不在数据根）。会话目录中除记录 `.jsonl` 外，还包含可重建的派生文件：压缩块文件 `<编号>.checkpoint.json`、超限内容溢出文件 `result-*.json` 与 `summary-*.txt`、会话列表索引 `index.json`；这些文件损坏或缺失时自动从记录重建，可安全删除。旧会话仍可从原全局 `sessions/` 和项目 `.ligule/sessions/` 中只读浏览；打开旧会话时才会将记录及附属文件复制到新的工作区目录，原件保留。WebView 的 `ligule.ui` 只作首屏缓存。终端界面与桌面界面的草稿和队列分别保存。

文件工具 `delete` 只使用操作系统回收站。Windows 使用系统回收站，Linux 调用 GIO 的系统回收操作。回收后端报错时，Ligule 会比较原路径上的目标对象身份和顶层元数据与操作前快照。仍匹配时返回后端错误；无法确认匹配时返回 `delete_outcome_unknown`，请先检查工作区和系统回收站再重试。这项检查不比较文件正文，也不递归核对目录内容。恢复由操作系统负责；Ligule 不提供自建回收列表、恢复或永久删除管理。Shell 命令中的删除仍按普通 Shell 操作执行，受当前 Permission、Policy 与审批控制，不会自动改送回收站。旧 `.ligule-trash` 目录保留原位、不迁移也不清理；搜索继续跳过该历史目录。旧 `trashBackend` 或 `limits.trashDirectory` 配置会报 `trash_legacy_config_unsupported`，删除时应移除这些配置项。

搜索默认使用随包提供的 ripgrep。自定义 `ripgrepPath` 会选择可执行程序，只能在用户配置或命令行 `--config` 中设置；项目共享配置和项目本地配置声明该字段时会报 `search_backend_source_untrusted`。将自定义路径移至用户配置，或删除该字段以使用随包后端。

### 配置模型服务

桌面版打开「设置」中的「模型服务」即可新增多套服务与模型，并选择默认项。终端界面和命令行读取同一份配置。手动配置多套服务时，在配置文件中填写：

```toml
[model]
services = [
  { id = "deepseek", name = "DeepSeek", api = "chat-completions", baseURL = "https://api.deepseek.com/v1", apiKeyEnv = "DEEPSEEK_API_KEY", models = ["deepseek-flash"] },
]
selection = { provider = "deepseek", model = "deepseek-flash" }
```

可在用户配置文件中显式开启无正文的结构化事件日志，并选择本机 Trace Collector：

```toml
[telemetry]
enabled = true
otlpEndpoint = "http://127.0.0.1:4318/v1/traces"
```

`otlpEndpoint` 仅允许 `localhost`、`127.0.0.1` 或 `::1` 的 OTLP/HTTP protobuf `/v1/traces` 地址，例如本机 Phoenix。默认关闭，项目配置不能开启；不读取继承的 `OTEL_*` Header 或凭据。日志和 Trace 不保存提示词、推理、工具参数/结果、路径或密钥。导出失败不会影响运行；本地 JSONL 是结构化事件日志，不是 OpenTelemetry Logs。

每项服务的 `api` 可设为 `chat-completions` 或 `messages`，`models` 列出该服务可选的模型。把密钥放入 `apiKeyEnv` 指定的环境变量；桌面版也可以把密钥保存到操作系统凭据库。非空环境变量优先；Linux 使用 Secret Service，服务不可用时会明确报错。旧的单服务 `model.api`、`model.baseURL` 和 `model.model` 配置仍受支持；这类配置未填写 `apiKeyEnv` 时使用 `LIGULE_API_KEY`。

服务和模型的默认选择影响新会话。会话输入区的模型菜单可以为当前会话单独选择模型；终端界面使用 Ctrl+P 或 `/model` 打开模型列表，也可使用 `/model <服务> <模型>` 切换。切换会话模型不会改写全局默认；会话运行时选择会在本轮结束后生效。

终端界面使用 `/credentials` 检查当前模型的凭据引用和来源，只显示环境变量、系统凭据或未设置，不显示密钥。`provider_credential_missing` 表示当前引用在这次启动的环境和对应数据根的系统凭据库中均没有密钥。环境变量修改后应重新启动终端程序；也可通过桌面「模型服务」保存到系统凭据库。两端需要使用同一 `LIGULE_HOME` 才能访问同一份凭据。

#### 模型输出预算

桌面「设置 → 模型服务」的每个服务都有模型配置表，可手动添加、删除模型，并填写显示名称、上下文窗口与最大输出 token 数。留空的数值继承现有配置；填写数字时使用完整的正整数，例如 `128000`。显示名称不改变发送到服务的模型标识。支持模型发现的服务可以获取可用列表，再勾选要加入的模型；已有模型的名称和参数保留。在响应体大小上限内，发现结果保留全部有效且不重复的候选；每个保存的服务最多包含 128 个模型。获取列表不会探测 token 上限。目录修改在「保存服务」后生效。

逐模型设置保存在同一服务的可选 `modelSettings` 列表中，`id` 对应 `models` 中的模型标识，例如 `modelSettings = [{ id = "custom-model", name = "我的模型", contextTokens = 128000, outputTokens = 16384 }]`。选中该模型时，其上下文窗口用于压缩判断，输出额度用于实际请求并参与压缩压力阈值（预留上限为窗口的四分之一）。不同服务中同名模型的设置互相独立；旧的纯模型标识列表仍可使用。

`model.outputTokens` 是每次请求的最大输出 token 预算，未设置时保留默认 8192。可以在 `[model]` 下显式填写 `outputTokens = 16384`；该字段也支持现有 `config.set` 配置接口。预算必须是正整数，并且不能超过已核实的模型上限、显式配置的能力限制或上下文窗口。

默认输出预算也必须满足配置的上下文窗口；如果把上下文设得低于默认预算，需要同时填写不超过该窗口的输出额度。无效配置会明确拒绝，不自动缩小预算。

当前内置的更高上限适用于官方 `https://api.deepseek.com` 端点的 `deepseek-flash`、`deepseek-v4-pro`，同时覆盖 Chat Completions 和 Anthropic 兼容 Messages。其他服务和未经核实的模型在没有逐模型声明时保留 8192 的保守限制；逐模型 `outputTokens` 可声明自定义服务支持的更高额度，请按服务的实际能力填写。声明不能提高已核实的官方模型上限，也不能超过显式能力限制或选中模型的上下文窗口。高于有效上限时报 `provider_output_budget_unsupported`，非法值时报 `provider_output_budget_invalid`，不会静默改成较低预算。模型或服务切换会重新核对限制。

旧的 `model.capabilities.maxOutputTokens` 继续只能降低适配器声明的限制，填写 16384 不会提高原有 8192 上限。需要更高预算时使用 `model.outputTokens`，并核对是否还存在较低的旧能力限制。配置更新在会话轮次边界生效；正在执行的一轮保持原有预算。

模型设置保存前会校验完整的有效配置；拒绝时配置文件保持原样。用户层变更还会单独检查共享默认配置、其他已加载项目和会话显式选择的模型；更高优先级的项目或命令行设置仍然生效。首次设置可以逐字段保存尚未完整的模型配置，以便继续填写其余字段。

两种 API 均支持 `model.capabilities.streaming = false`，请求改为接收普通 JSON 响应。完成判定、输出预算、工具校验和取消规则与流式响应一致；该设置只改变响应传输方式，不改变工具权限或自动重试范围。

对话、压缩和内部子代理只向用户配置或命令行明确绑定的接口类型、服务根地址与凭据引用发送密钥。项目配置可以选择已绑定服务的模型，覆盖地址或密钥引用不能借用原有凭据；未绑定时返回 `provider_credential_unbound`。请将服务保存到用户配置，或通过命令行明确选择目标。绑定与生成设置一同在轮次边界采用。

### 会话和输入

终端界面输入 `/` 浏览命令，继续输入命令名或说明文字可以筛选；上下方向键选择，Tab 只补全草稿，Enter 执行。`/policy `、`/queue `、`/permission ` 等命令提供固定参数候选；权限升级仍需单独确认。按 Escape 收起候选，`/help` 查看分类帮助与当前快捷键。

终端欢迎区左对齐显示标识、版本、工作区与帮助入口；运行阶段只显示 Host 确认的状态。输入区高度有界，长草稿可继续编辑。命令和文件候选显示在编辑区附近；打开选择菜单、会话列表、完整历史或审批时，普通编辑区让位给对应面板。工具调用优先显示工具名和目标摘要；按 Ctrl+O 可查看完整参数、结果和会话记录。界面使用终端 ANSI 配色角色并继承当前调色板。窗口空间不足以展示审批信息时，允许操作会被禁用并提示放大窗口。

回答问题时，输入区专用于当前答案；长问题和选项使用 PageUp/PageDown 翻阅，答案草稿保持不变。回答与普通会话草稿分别编辑，问题结束后恢复普通草稿与光标；退出时保存普通草稿和待发送队列。快捷键可通过 `/bind` 自定义，界面提示会显示当前绑定。

终端界面使用 `/sessions` 或不带参数的 `/resume` 浏览当前工作区的会话。在列表中输入名称、编号或工具模式进行筛选，上下方向键选择、Enter 恢复、Escape 关闭；筛选文字不会进入聊天草稿。也可使用 `/resume <编号> [模式名]` 直接恢复，编号可以使用唯一前缀。桌面版使用左侧栏切换会话；顶部会话菜单提供重命名、归档、取消归档、分支、导出、查看子任务、刷新记录和压缩上下文。

长对话在接近窗口时自动压缩：较早的历史由模型撰写的摘要替代，每次压缩形成一个可校验的块，原始事件始终完整保留。达到软阈值时模型收到一次提醒，可通过 `compact` 工具查看上下文压力、列出压缩块、读回某段原文或溢出文件，并自行选择范围撰写摘要；超过硬阈值时自动压缩兜底，界面中的"压缩上下文"命令仍可随时手动触发。声明的输出预算参与压力阈值（预留上限为窗口的四分之一）。分支会继承已压缩的块，被压缩的细节仍可在记录与导出中找到。

工具结果超过输出上限时，提供 `compact` 的会话可以使用 `action: "spill"` 和结果中的 `name` 读取完整内容。返回页面被截断时，使用其中的 `offsetBytes` 继续；偏移量以 UTF-8 字节为单位，必须落在字符边界。

在输入框中键入 `@` 可以查找当前工作区中的文件。选择候选文件只会把路径放进草稿，不会发送消息。按 Enter 发送；长消息按 Shift+Enter 换行。运行中的会话收到的新消息会排队，按顺序发送。取消本轮也会暂停队列；可以查看队列、继续发送，或把排队消息收回草稿。终端会话恢复后，待发送消息保留在暂停的队列中，不会自动发送。

桌面版按工作区和会话分别保存草稿与队列；关闭窗口后再次打开仍可恢复。终端界面按工作区和会话保存输入草稿与队列。两种界面共用已发送消息的输入历史。

桌面版的问题卡片会在同一会话中保存未提交的选项和补充文字，切换到其他会话再返回时仍可继续回答。正在观察外控会话时，只有 Host 确认 Agent Control runtime 可用，才显示外控状态与指导输入；指导草稿随会话切换保留。若仅有其他普通 Host 持有写入锁，桌面只提供只读观察，不会把写入锁误认为可用的 Agent Control。

运行时，终端和桌面状态栏显示 Host 确认的阶段：准备上下文、请求模型、执行工具、压缩上下文、等待审批或输入、收尾。没有新事件的时长从最后一次真实模型输出或工具活动计算，不能据此断定请求已经失败。工具进程结束后，Agent 仍可能继续请求模型；程序不会因为固定的无进展时限自动取消本轮。

模型正常结束且有有效正文或工具调用才算完成。输出被截断、只有推理或空白正文、流未完整结束时，本轮记录为失败；已有部分正文保留，已经执行的工具不自动重做。可以查看记录后明确提交新任务或取消当前任务。

| 错误码 | 含义 |
| --- | --- |
| `provider_output_exhausted` | 模型明确报告已到输出预算，结果未完整完成 |
| `provider_empty_response` | 正常结束但没有有效正文或工具调用 |
| `provider_stream_incomplete` | 缺少协议结束标记、结束原因或完整分片 |
| `provider_stream_interrupted` | 响应流读取中断 |
| `provider_finish_reason_invalid` | 提供方返回了不支持的结束原因 |
| `provider_tool_call_invalid` | 工具调用缺少有效标识、名称或出现重复标识 |
| `provider_tool_args_invalid` | 工具参数不是合法 JSON，未执行该批调用 |
| `exec_script_binding_unavailable` | 脚本或解释器无法安全绑定到审批，本次执行被拒绝 |
| `exec_script_binding_changed` | 审批后脚本、解释器、工作区或 Permission 发生变化，本次执行被拒绝 |
| `session_permission_format_unsupported` / `session_policy_format_unsupported` | 旧格式会话无法保存此类设置；会话记录未被修改 |

HTTP 错误只显示状态码及必要的固定错误分类，不显示网关原始正文或非法工具参数。开始读取成功响应正文前的可重试故障（传输失败及按配置可重试的 429/5xx）遵守已配置次数和退避；响应正文读取开始后的断流不自动重发整个请求。用户主动取消仍记录为 `cancelled`。

### 工具模式与内部子代理

Windows 的 `full` 模式提供 `screenshot`，每次捕获一帧主显示器 `screen` 或 `active-window`，可用相对目标的 `{x, y, width, height}` 指定区域。它仅读取现有画面，不创建窗口或切换焦点。活动窗口模式保存该窗口屏幕区域内的可见像素；跨屏窗口、捕获时窗口或显示参数变化、锁屏和无交互桌面均明确失败。每次捕获使用受控独立进程，限时 12 秒、进程内存 512 MiB、像素 4,000 万。成功后立即返回真实图像及 `shotId`，可用 `read_image({shotId})` 重读。

截图需要独立同意。桌面版已有会话选择 `full` 后，点击“截图关闭”并确认即可授权；同一入口可撤销，并中止进行中的捕获。TUI `/screen on` 显示范围说明，`/screen on confirm` 授权当前会话及内部子任务，`/screen off` 撤销。CLI 的 `run`、`resume`、`tui` 支持 `--allow-screen-capture`，明确授权该进程。普通单会话授权不会在重新打开时恢复；显式启动参数或仍有效的截图 Grant 按各自范围生效。MCP 必须在可信界面另行创建并确认“屏幕观察”授权；`--operator`、Permission 档位不能自行开启，MCP 也不接受该启动参数。截图同意不扩大工具模式、Shell 权限或 Policy 规则。已保存的图片仍受会话归属和保留期控制。

`full` 模式还包含 `read_image`：使用 `{path: "diagram.png"}` 读取文件边界内图片，或用 `{shotId: "…"}` 重读本会话持有的已保存图片。PNG、JPEG、WebP、GIF 会经解码并统一为 PNG，动画只读首帧；输入最多 20 MiB、4,000 万像素，输出最长边 2048 像素、最多 8 MiB。Session JSONL 只保存引用，模型请求发送前才读取并校验图片字节。图片位于数据根下本工作区的 `screenshots/`，配额 256 MiB。被历史记录引用或源 Session 仍存在的图片没有固定可读期限；源 Session 已不存在、图片未被引用且超过 30 天时，可以执行有界清理。分支只继承复制历史中已有的图片；内部子代理持有独立图片。缺失、过期或被修改的图片明确报错。Markdown 导出将可用图片复制到同级 `.assets` 目录并使用相对链接，单独报告不可用文件；导出副本由使用者管理。

`full` 模式提供 `read_document`，在文件边界内读取 PDF 页、DOCX 段落和表格块、XLSX 工作表单元格、PPTX 幻灯片文字及表格。普通文本仍使用 `read`。`{path, start, count}` 默认读取前 20 个单元；`start` 从 1 开始，`count` 最多 20，XLSX 默认读取行和前十列。指定表格区域可用 `{path, sheet, range: {startRow, endRow, startColumn, endColumn}}`，最多 200 行、10,000 个单元格。返回来源位置、工作表名、警告和 `truncated`；截断时照 `continuation` 继续读取，包括块内文本 `offset`。公式返回原式和已有缓存，不重新计算。

PDF 的 `{path, renderPage: 2}` 单独渲染一页，要求当前模型支持图片，输出持久 `document` 图片引用；没有文字层的页会提示渲染，不当成空白。页面最长边 2048 像素，源栅格图片最多 4,000 万像素。该工具不做 OCR，不渲染 Office 图片或图表，不执行宏、脚本、外链或嵌入对象。输入最多 20 MiB，提取文本最多 24,000 UTF-8 字节；PDF/PPTX 最多 200 页/张。Office ZIP 最多 2,000 条、实际解压量 64 MiB。独立解析进程默认限时 15 秒、V8 堆上限 192 MiB，Windows 另有 512 MiB 进程内存上限；取消会等待解析进程退出。可用 `limits.documentBytes`、`limits.documentOutputBytes`、`limits.documentTimeoutMs` 调低上限，文本预算至少 256 字节。密码 PDF 报 `document_password_required`；加密或旧版 Office 容器报 `document_encrypted_or_legacy`，不接受密码参数。损坏文件和资源超限明确失败。

桌面版成功工具结果中的“预览图片”按钮读取会话已有图片，生成最长边 512 像素、最多 256 KiB 的临时 WebP 缩略图。外控会话和已关闭会话也可只读预览，无须接管或重新授权截图；预览不会捕获当前屏幕。图片缺失、过期或完整性校验失败会显示错误。缩略图不写入会话记录，切换会话或卸载组件时释放显示资源。

自动图像输入仅启用已验证的 DeepSeek 官方 `deepseek-flash` 路由及其文档声明的旧视觉别名，未知路由默认拒绝。可通过 `modelSettings = [{id = "custom-model", imageInput = true}]` 明确声明模型支持图像；`false` 禁用，省略则自动识别。桌面版可为每个模型选择“自动／支持／不支持”。切换至不支持图像的模型时，会拒绝发送仍包含图片的上下文；可改用支持图像的模型或新建 Session。每个请求最多八张图片、16 MiB 规范化图片字节。含图片的记录需要能识别不可忽略图像事件的程序读取；旧程序会拒绝重新打开。

`full` 模式包含 `todo_write`，以 `items: [{content, status}]` 替换当前轮次的完整任务清单，状态为 `pending`、`in_progress` 或 `completed`；空数组清空清单。最多 40 个不重复的非空项目，每项最多 400 个字符，内容合计最多 8,000 个 UTF-8 字节。快照作为 Session 元数据保留历史；轮次结束后活动清单清空，下一轮从空清单开始。内部子代理使用独立清单。这个工具不授予工作区写权限，随包 `minimal` 模式不包含它。

`full` 模式仅在搜索配置与凭据可用时提供 `web_search`；它不在随包 `minimal` 中，`minimal` 的九个工具保持不变。在用户配置中，将 `serviceId` 设为 `[model].services` 中已有服务的 ID：

```toml
[search]
provider = "deepseek"
serviceId = "deepseek"
```

该服务必须使用官方 `https://api.deepseek.com` 地址；`/v1` 和 Anthropic 兼容的 `/anthropic/v1` 根路径也受支持。Search 复用该服务的 `apiKeyEnv` 引用，优先读取非空环境变量，再读取操作系统凭据库；不要在聊天或配置文件中写入明文密钥。`[search]` 只能由用户配置、明确的命令行配置或受管配置启用和选择；项目共享和本地配置不能启用 Search，也不能替换服务或凭据绑定。没有配置、服务无效、凭据缺失/格式错误或系统凭据库不可用时，`web_search` 不会注册。`status.get` 的 `search` 字段显示 `configured`、`available`、可选的 `serviceId` 和错误 `code`；外控调用 `ligule_session_configure` 时也可从返回的 `effective.search` 读取该状态。`available` 只表示配置有效且凭据存在并符合格式，不代表远程账户认证成功。搜索设置和服务绑定在 Session 创建时读取；更新后重启 Host 可确保新 Session 使用新配置。每次搜索请求都会重新读取同一凭据引用。

调用 `web_search` 时，`query` 必须是 1–128 个 Unicode 字符的非空文本；`count` 可选，范围为 1–10，默认 5。请求只发送到固定的官方 Search API，模型不能提供 URL 或密钥。默认不请求网页正文，也不会自动抓取结果页面。响应含标题、URL、摘要片段、总结和可用日期，并报告 `received`、`returned`、`truncated`。标题、片段、总结和 URL 分别最多 256、512、1,024 和 2,048 个 UTF-8 字节；总结果受 `limits.resultBytes` 限制（默认 16,000 字节，硬上限 24,000 字节），预算低于 1,024 字节时拒绝搜索。结果不提供游标；出现截断时缩小或改写查询。请求沿用 `fetchBytes` 与 `fetchTimeoutMs` 配置，并分别受 2 MiB 响应和 30 秒硬上限约束；不会自动跟随重定向。网络 Permission、Policy 和 Agent Control Grant 仍适用。HTTP 错误以固定错误码报告，不回显响应正文或密钥：`search_credential_rejected`、`search_payment_required`、`search_rate_limited`、`search_forbidden`、`search_timeout`、`search_service_unavailable`。

工具模式选择交给模型的工具清单和提示片段，不会更改 Permission、Policy 或 Agent Control Grant。随包提供的 `minimal` 是默认模式；`full` 会包含当前 Host 注册的全部工具。模式文件按项目、用户、随包的顺序查找；高优先级文件完整替代低优先级同名文件。

#### 用户 DIY 最小示例

在用户数据根中创建 `skills/release-check/SKILL.md`，可用 `ligule skills` 检查发现结果，然后让模型按名称激活技能：

```markdown
---
name: release-check
description: Check a proposed release against the repository's release guide.
---
Read the release guide first. Report the exact files and checks that need attention.
```

技能和支持文件只作为说明按需提供给模型；它们不授予权限。已打开的 Session 保持创建时发现的技能注册表；删除技能文件会影响后续发现。

在用户数据根 `modes/read-review.toml` 中可创建只提供读取工具的用户模式：

```toml
tools = ["read"]
prompt = []
```

选择 `read-review` 只让模型看到已登记的 `read` 工具，不会改变 Permission、Policy 或 Grant；切换到其他模式即可停用。

在用户数据根 `prompts/review.md` 中放置纯文本提示模板，可在交互输入中用 `/review core/src` 调用：

```markdown
---
description: Review a requested source area.
argument-hint: [scope]
---
Review $ARGUMENTS against the repository's documented contracts.
```

模板展开后的内容作为普通用户输入记录；模板本身不执行代码或绕过工具判定。

在用户数据根的 `tools/` 目录放置一个 TOML 文件即可声明自己的命令工具：`description` 说明用途，`command` 是不带参数的可执行文件，`args` 数组用 `{参数名}` 占位符（独占一项）在调用时替换为模型提供的参数，`parameters` 描述参数模式（受支持子集与内置工具相同）。占位符只替换整个参数位，模型输入不进入 shell 语法；执行按 Shell 命令走同一权限与审批链路，声明一个工具不授予任何额外权限。声明的工具默认不进入模式清单：需要在模式文件中列出其名称（或使用 `tools = "*"`）才会提供给模型。无效文件以诊断报告并跳过，不阻塞其他工具。

例如在 `tools/git-summary.toml` 中声明只读的工作区状态查询：

```toml
description = "Show a short summary of Git changes in the workspace."
command = "git"
args = ["status", "--short"]
parameters = { type = "object", properties = {} }
```

把 `git-summary` 加到某个 Mode 的 `tools` 列表后，重新创建或切换到该模式即可供模型使用。Git 命令仍需可信工作区和逐次审批。

代码型扩展安装在用户数据根的 `extensions/` 目录：单个 `.js` 文件，或一个包含 `index.js` 的目录（一目录一包）。扩展以 Host 进程内代码运行，只有 full-access 且不受限网络的会话才会加载；`ligule extensions` 列出当前会加载的路径与诊断。已安装扩展可以停用：终端 `/extensions [on|off <名称>]`、桌面设置工具页的开关写入数据根的 `extensions-state.json`，下次启动生效；配置层显式声明的扩展路径不受登记影响。

只注册提示片段的扩展示例（例如 `extensions/review-hint.js`）：

```js
export default function reviewHint(host) {
  host.registerPrompt({
    name: 'review-hint',
    text: 'Check file boundaries and preserve the current permission policy.',
  });
}
```

在 Mode 的 `prompt` 列表选择 `review-hint` 后片段才会注入提示词。扩展本身仍是拥有 Host 进程权限的可执行 JavaScript，不是沙箱；只从你信任的来源安装，并且只在满足上述会话 Permission 条件时加载。通过 `/extensions off review-hint` 停用已安装扩展，下次 Host 启动生效。

在包含 `subagent` 工具的模式中，模型可以把互相独立的工作委派给内部子代理。每个子代理在同一 Host 进程中运行，但拥有独立的子会话记录。父会话默认最多并行三个子代理，可在创建会话时通过 `[loop].maxConcurrentSubagents` 将上限设为 1 至 8；子代理不能继续创建子代理。子任务沿用父会话的 Provider、Permission 和 Policy 判定，模式只能进一步缩小工具范围，模型调用次数、输出、思考和循环预算不能高于父会话。独立工具调用按项目 `[loop].maxParallelTools` 上限并发执行，默认值为 4，范围为 1 至 32；子代理沿用此上限，工具并发上限也可能进一步限制子代理并发。通过输出 schema 要求结构化结果时，子代理必须提交并通过验证；无效提交可在本轮现有迭代预算内纠正。子代理若未提交有效结果便结束，会以失败状态保留 Session 记录和已完成的工具副作用。TUI 可用 `/sub <序号>` 查看子记录；桌面会话菜单提供子任务列表，Markdown 导出会包含子会话记录。失败或取消的子任务仍会保留可查看的会话引用。

项目 `[loop]` 可设置 `totalModelCalls`、`taskTimeoutMs`、`requestTimeoutMs` 和 `interactionWaitTimeoutMs`，默认分别为 `modelCalls`、30 分钟、2 分钟和 12 小时。父任务、内部子代理与自动压缩共享预算。只有所有工作都因审批或用户提问而阻塞时，执行期限才暂停；存在待处理交互时，即使其他工作继续运行，也会消耗整次 Run 的独立累计等待上限，重叠等待只计一次。单次委派可通过 `delegation.budget` 收紧上限；执行期限最长 24 小时，单次模型请求最长 1 小时，交互等待最长 7 天。客户端等待超时不会取消任务。运行失败时仍尽量保留已确认的调用次数和部分正文。

提供方上报用量时，Session 会保留可获得的输入、输出与缓存 Token 数及其原始字段名；缺失或无效的数值保持未知。Chat Completions 的缓存命中和未命中按字段记录，不根据兼容端点猜测服务商。Messages 响应只有在未缓存、缓存读取和缓存创建三项均已知时才记录总输入量。账号按日汇总的账单不能仅凭这些记录归因到某一次 Run。

`full` 模式提供 `present`，可提交最多 16 个工作区内现存的普通文件。工具同时检查工作区和文件边界，记录媒体类型、字节数、SHA-256 与可选说明。单文件最多 20 MiB，一次调用合计最多 64 MiB。运行结果除 Session 引用外还可包含已经确认的文件交付；后续模型请求失败也保留这些记录。工具不复制源文件，源文件改动或删除后不能根据哈希还原。

仍被 Session 历史引用的图片，或源 Session 仍存在的图片，超过 30 天也继续可读。只有源 Session 已不存在、没有其他引用并且已经过期的图片才可被显式有界清理；当前工作区图片配额仍为 256 MiB。

交付文件会显示在 CLI 输出、TUI 记录和 Desktop 结果卡片中。Desktop 可重新计算当前文件的 SHA-256，预览最多 8 KiB 的安全文本或缩小后的静态图片、复制相对路径，并在用户明确点击后在文件夹中定位可用文件。不支持的格式只显示元数据；HTML、SVG、脚本、可执行文件不会作为活动页面渲染。Host 的 `artifact.list` 支持按 Session 或 `runId` 分页，`artifact.inspect`、`artifact.preview` 和只供可信原生操作使用的 `artifact.resolve` 必须引用已登记的 `artifactKey`。文件状态可区分可用、已修改、丢失、拒绝访问与不支持预览；交付后文件变化不会悄悄覆盖记录。

运行 `ligule storage inspect` 可查看工作区数据分类的有界递归用量（每类最多 1,000 项、16 层目录；不完整扫描会标记）。受信任的交互式终端可运行 `ligule storage cleanup`：先分页核对 Session 引用（每页最多 100 条记录、16 MiB；游标只在当前 Host 内有效），再预览最多 100 项待清理对象并输入 `delete` 确认。候选包括已过期、未被引用的截图，以及带有 Ligule v1 owner 标记、超过 30 天、无活跃租约的浏览器残留和已登记的 cache/tmp 派生目录；当前版本没有为不存在的缓存强行创建数据。旧版未标记目录、仍有来源 Session 的浏览器目录、活跃租约、Session 记录、结果 sidecar 和交付源文件都不会自动回收。apply 在删除前复查目录身份与 Session 引用；多页历史若期间发生变化，须重新预览，无法完整验证时禁止删除。共享数据根仍通过 `LIGULE_HOME` 选择，不写死个人目录。

### 审批和设置

桌面版「设置」分为「常规」「模型服务」「权限与安全」「工具与插件」「外部控制」「通知」「快捷键」和「关于」。常规页包含语言、工作区、配色与显示偏好；权限与安全页管理默认 Policy、审批规则、工作区信任、隔离状态，以及当前会话的权限档与网络访问。聊天输入区的权限弹窗只调整当前会话的权限档和必要确认；网络、隔离细节与项目信任在该设置页完成。

「工具与插件」页可选择查看 Mode 并检查其工具集合、所有已登记工具、MCP Server、扩展和 Skills。Mode 选择只切换设置页的查看对象，不会更改当前会话；要切换会话 Mode，请使用聊天输入区的工具菜单。选择查看/新建授权的工作区和 Grant，只改变外控页面的查看对象或新建草稿目标，不修改运行中的外控会话；新建和撤销 Grant 仍是独立的明确操作。外控会话的观察、答复审批、发送消息和接管都在该会话界面完成。模型设置修改默认或项目配置，不会覆盖正在运行会话的当前模型。

默认审批方式为逐次询问。终端界面在审批提示中按 `y` 允许、按 `n` 拒绝；桌面版使用审批卡上的允许或拒绝按钮。较大的文件改动会先显示字节数、SHA-256 和短预览；展开审批卡后，才读取并查看完整待审批内容。系统硬拒绝、审批通道不可用、超时或取消会显示各自的结果，不会伪装成用户选择了拒绝；只有可信用户实际拒绝才记录为用户拒绝。

可选审批档位有四档：`always`、`ask`、`auto` 和 `never`。终端界面使用 `/policy always|ask|auto|never` 修改，使用 `/policy reset` 恢复配置默认值；桌面版输入区旁的下拉菜单提供同样的四档。`always` 让每个工具调用都先经过拒绝规则、再单独等待批准，记忆的批准和放行规则都不会跳过询问。`ask` 先按规则表判定，没有结论时等待可信用户决定。`auto` 由规则表以及守卫和命令解析器判定，无法确认的调用仍会询问。`never` 跳过整个 Policy 层：规则表中的 allow/ask/deny 都不再参与判定，审批也不再出现；但工作区边界、交互通道限制、脚本绑定、系统硬拒绝、Permission 隔离和 Grant 上限仍然生效。旧配置与会话记录里的 `none` 和旧 `never` 一律按 `ask` 读取，只有新版写入并带语义标记的记录才认作新的 `never`，历史事件保留原值不动。桌面版输入区旁的工具与审批菜单可以修改当前会话；新会话发送第一条消息前，也可以先选择工具模式和审批方式。选择「完全不审批」前会显示确认框。设置中的「审批规则」可以将审批默认值保存到用户配置或项目本地配置。不保存记忆时，允许仅对本次调用生效；保存时可选本会话、项目或用户范围，项目规则高于用户规则。记住文件审批时默认只限定当前文件；扩大到工作区需要另行明确选择，且仍只适用于同一种操作。审批方式和规则在保存后立即用于后续判定。

需要时可以在用户配置或命令行里增加 `[reviewer]` 表启用「复审」：它默认关闭，只在 `auto` 且确定性策略认不出命令形状时，把这一次调用交给同一轮运行所用的模型做一次只读判断。复审没有自己的模型或端点：它跟随当前会话选中的服务与凭据，模型在每个运行轮次的边界切换，因此同一份配置不会把已保存的密钥发到别处。可用键只有 `enabled`（必须是布尔 `true` 才启用）和预算键 `maxInputTokens`（默认 2000）、`maxOutputTokens`（默认 400）、`timeoutMs`（默认 20000）、`maxPerRun`（默认 8）、`maxTotalTokens`（默认 40000）；项目配置只能收紧预算，不能自行启用复审。旧的 `model`、`baseURL`、`api`、`apiKeyEnv` 已移除，配置里仍然写着会在建立会话时以 `reviewer_route_removed` 明确失败，不会静默生效。复审只能回答 `allow`、`deny` 或 `ask-human`：`deny` 与 `ask-human` 都不执行，超时、超预算、请求失败或回复不合规一律转人工审批，绝不当成放行；规则拒绝、规则要求审批、系统硬拒绝、强制人审、私有网络与外部访问永远不会交给模型改判。每次复审的结论、原因码与耗时写入会话 JSONL 的 `policyReview` 事件（标为可跳过，不进入模型上下文）。没有 `[reviewer]` 表或 `enabled` 不为真时，`auto` 的行为与之前完全一致。复审的证据只从原始会话事件里取，不读摘要、不读工具输出：仍然有效的用户约束、被收紧或撤销的限制（权限降档、新增拒绝规则、Grant 失效）和少量相关执行记录各带事件序号，结论也把序号写进 `policyReview` 事件，可以回查到底是哪一条记录支撑了这次判定。约束本身超出输入预算时直接转人工，不会截断约束去省 token。只有明确以正常结束（`finish.stop`）收尾的回复才可能成为裁决：被截断（`length`、`max_tokens`）、以工具调用中止或流直接结束的回复一律转人工，这次的用量仍然记账；复审的回复必须整段就是一个 JSON 对象：从说明文字里挑第一个对象的回复判为无效，重复键、未知字段、不合规的枚举与代码一律转人工；复审在等待期间若审批方式或规则发生变化，这一份结论作废并回到确定性路径；预算在发请求前就按“输入估算 + 最大输出”预留，并发的复审不会同时看到同一份额度；Run 被取消时，正在等待的复审立即中止并转人工审批（`review_cancelled`），这一次的用量仍会记账。

终端界面用 `/usage` 查看本会话的 Token 用量，主 Agent 与复审分开显示。缓存命中是输入的子集，不会重复计入输入；端点没有报回的输入或输出显示为未知，而不是记成 0。会话里有复审记录时，`/usage` 还会显示最近一次复审的裁决、原因码与证据条数；没有复审记录就不显示这一行。最近一次的记录早于最新一页事件时，`/usage` 会向前翻页去找它；翻到页数上限仍然没找到，会明确说“查询未完成”，不会把“没查完”当成“没有复审”。桌面端与外部控制可以读取同一份汇总（Host 的 `usage.get`），不需要各自再算一遍。

Permission 单独控制会话可访问的操作系统资源，Policy 决定允许的操作是否需要审批或必须拒绝。在 TUI 输入 `/permission`，或在桌面版输入区打开权限菜单，可以查看和更改当前会话的 Permission；新会话也可在发送第一条消息前选择文件/命令档位与网络模式。`read-only` 禁止文件工具写入；`workspace-write` 允许文件工具在配置的路径边界内写入；`full-access` 放宽命令的操作系统隔离，启用时需要再次确认。内置文件工具仍受路径边界约束。网络也单独设置为 `policy`、`disabled` 或 `unrestricted`；不受限网络需要再次确认。新会话创建时由 Host 应用所选档位；需要确认的升档由 Host 校验并记录可信界面的确认来源。Permission 状态显示平台的文件读写、网络与进程隔离能力，以及当前 Shell 是否可用。

Node/Python 脚本不能由自动策略直接放行。逐次审批会显示脚本路径、SHA-256、解释器、工作区和 Permission；审批等待期间相关内容发生变化时，Host 会拒绝执行。无法安全绑定的 Shell 脚本、包装器、复合命令或动态命令也会被拒绝。Git 命令需要先信任工作区，并且每次执行都要审批，因为仓库配置可能运行 Hook、辅助程序或别名。旧格式会话仍可读取，但不能修改 Permission 或 Policy；新建会话即可调整这些设置。

撤销工作区信任后，基于该信任启动的受管服务器会由当前 Host 立即停止；其他 Host 会定期检查共享信任状态并停止相关进程。之后的项目代码命令仍会在执行前重新检查信任。

使用 TUI 的 `/control create` 或桌面版「设置 → 外部控制」可以创建只绑定一个项目的 Agent Control Grant。Grant 设置默认值与权限上限、网络范围、允许的 Policy、有效期和是否允许普通 Operator 操作；`full-access` 与不受限网络需分别确认。MCP Server 使用 `--grant <id>` 接入 Grant；`--operator` 只有在该 Grant 允许时才能回答常规审批或在授权上限内调整会话。撤销或到期会阻止后续控制；Grant 不解除 OS Sandbox 限制或 Policy 硬拒绝。

桌面版切换到由外部 Agent 控制的会话时，底部输入区会显示为外控输入栏，并列出当前模型、工具模式、Policy、Permission 与 Grant 的默认值和权限上限。此处发送的消息会交给对应的外控会话处理。

Shell 只有在平台后端满足所选档位要求时才会执行；能力不足或 Sandbox 不可用时会拒绝执行。Linux 使用 bubblewrap，文件系统隔离能力会按实测标为 `partial`。Windows 的 `workspace-write` 使用每次运行独立的 `WRITE_RESTRICTED` Token 和临时工作区 ACL，整体标为 `partial`；必须先明确授权项目并确认限制，同时将网络设为 `unrestricted`。该后端不能限制命令读取文件或联网；既有硬链接、可写祖先目录的 `FILE_DELETE_CHILD` 权限或并发 ACL 修改也可能越过工作区边界，因此不适合运行恶意原生代码。Windows `read-only` 仅在实时探测确认所选 Shell 能进入实际工作区时使用 AppContainer，否则该档位下 Shell 不可用；可用时会阻止工作区写入和 Shell 联网，但系统中公开可读的文件仍可能被读取。macOS 当前没有受支持的进程管理或 OS Sandbox 后端，因此所有档位下都无法使用 Shell。`full-access` 下 Shell 直接使用当前操作系统用户的权限，且要求网络设为 `unrestricted` 和进程管理能力可用。该档位不会绕过 Policy 的拒绝规则和危险操作硬拒绝。已加载扩展属于可信代码，直接使用操作系统能力时不经过 Host 的 Policy 判定；降低权限前必须先关闭扩展并重启 Host。

模型配置选择用户默认或项目本地层后保存；运行中的会话会在本轮结束后采用模型配置变更，高优先级配置仍覆盖较低层的设置。离开含有未保存内容的设置页面时，界面会先询问是否丢弃修改。「关于」页提供应用版本、帮助、许可与诊断入口。

用户或项目配置中的 `limits.execTimeoutMs` 可设置单次 Shell 命令的最长执行时间。默认 120,000 毫秒，可设为 1 至 600,000 毫秒（10 分钟）。它与模型单次请求超时不同；Shell 命令仍受所选 Permission、Policy 和进程清理规则约束。

### 分支和导出

终端界面使用 `/branch` 从当前记录创建分支，或使用 `/branch <序号>` 从已完成的一轮创建分支。桌面版顶部会话菜单中的「分支会话」会复制当前记录；转录中每个已完成轮次也有分支入口。分支会创建新会话，原会话保持不变。

使用 `/export <路径>` 将终端界面当前会话及其子任务导出为 Markdown。桌面版在顶部会话菜单中选择「导出 Markdown」，再选择保存位置。导出会报告每个文件的写入结果；已有的子任务文件不会覆盖，主会话文件会写入所选路径。

终端界面按 Ctrl+O 打开完整历史，使用 `/show <序号>` 查看单条完整记录，使用 `/sub <序号>` 查看子任务记录。桌面版可在转录中展开记录，并通过会话菜单的「查看子任务」打开支线列表。

### 恢复和取消

运行中的本轮可在终端界面按 Esc 取消，在桌面版按停止按钮取消。界面分别显示已完成、已取消、失败或意外中断的轮次。

桌面版显示断连横幅时，按「重新连接」重启后端并恢复当前会话。没有得到答复的审批和问题会作废；**成功重新取得会话写入权后**，原待发送队列会移回草稿，等待用户明确发送。普通会话切换或恢复时，待发送队列仍暂停保存，不会自动发送。若写入锁仍被其他 Host 持有，桌面进入只读观察，可查看进度，待锁释放后再重新打开会话。终端界面退出后使用 `/resume <编号或唯一前缀>` 恢复会话。

`tool_outcome_unknown` 表示进程意外退出时，某个工具调用是否完成无法确定。先检查文件或外部状态，再决定是否重做。`session_locked` 表示另一进程仍持有会话；关闭该进程后再恢复。终端界面退出后，先运行 `ligule`，再输入 `/resume <编号或唯一前缀>`；也可以从命令行运行 `ligule resume <编号> "<要发送的消息>"`。`host_model_config_missing` 表示模型服务配置不完整；检查 `~/.ligule/config.toml` 中的模型字段，或在桌面版「模型服务」中填写配置。`provider_credential_missing` 表示密钥环境变量或系统凭据库中没有对应密钥。`credential_store_unavailable` 表示系统凭据库不可用；Linux 请检查 Secret Service。

### 语言、外观和快捷键

桌面版在「设置 → 常规」中选择跟随系统、简体中文或 English，并调整配色、字号、侧栏宽度和面板位置。配色包括墨青、羊皮纸、蓝天、石墨、森林和黄昏。CLI 和终端界面可以用 `--lang zh`、`--lang zh-CN`、`--lang en` 或 `--lang auto` 选择语言；`zh-CN` 与 `zh` 都选择简体中文。

终端界面的常用按键：Enter 发送，Shift+Enter 或 Ctrl+N 换行，Esc 取消本轮，Ctrl+C 退出，Ctrl+O 浏览历史，Ctrl+R 搜索输入历史，Ctrl+G 在外部编辑器中编辑草稿，Ctrl+Z 和 Ctrl+Y 撤销或重做草稿。Ctrl+P 选择模型，Ctrl+T 选择工具模式，Ctrl+A 选择审批方式；各面板提示显示实际绑定。按 `/bind` 查看或修改快捷键。正常退出会保存草稿与队列，恢复的队列保持暂停；`/quit` 不会作为草稿恢复。

`/help` 打开分类帮助面板，暂时替代普通编辑区，不写入会话正文。使用左右方向键切换命令、按键和提示模板，上下方向键或 PageUp、PageDown 浏览内容，Esc 关闭并回到草稿。选择列表也使用上下方向键、Enter 和 Esc；这些按键均可通过 `/bind` 配置。

终端配色继承当前调色板；设置非空的 `NO_COLOR` 可关闭颜色，显式设置的 `FORCE_COLOR` 优先。

桌面版的常用按键：Ctrl+K 打开命令面板，Ctrl+B 收起或展开左侧栏，Ctrl+Shift+C 复制最新回答，Enter 或 Ctrl+Enter 发送，Shift+Enter 换行，Esc 先关闭打开的面板，再取消运行中的本轮。可以在「设置」的「快捷键」中查看或修改绑定。

桌面版提供五类系统通知：等待回答、等待审批、本轮完成、本轮失败和连接中断。可以在「设置」的「通知」中总开关通知并分别启用各类提醒；点击通知会打开对应会话。通知权限与系统通知设置会影响提醒是否显示。通知栏会显示会话名称和状态，不包含提示词、工具命令或密钥。跨平台的原生通知点击行为尚不在已验证的支持范围内。

托盘可用时，点窗口关闭按钮会隐藏窗口，后台会话继续运行。托盘菜单中的「打开 ligule」会恢复窗口，「退出 ligule」会显示受影响的会话并询问是否中断任务后退出。托盘不可用时，关闭窗口会先显示退出确认。

### 本地 MCP 与权限范围

`mcp.servers.<名称>` 支持 stdio 服务器：`command` 指定单个可执行文件，`args` 为参数数组，`cwd` 为可选工作目录。`env` 的值只能使用 `${环境变量名}` 引用。服务器按需启动；模型先通过 `mcp.inspect` 读取工具定义和摘要，再通过 `mcp.call` 提交匹配声明的 JSON 参数。定义改变后必须重新披露。

终端 `/mcp add <名称> <程序> [参数…]` 与 `/mcp remove <名称>`、桌面设置工具页的服务器表单可以把配置写入使用者默认层；环境变量引用与工作目录在配置文件中补充。写入与删除只改使用者默认层，其他配置层与信任记录不受影响。

使用 TUI 的 `/mcp list` 查看服务器与信任状态；`/mcp trust <服务器> <session|project|user>` 会显示程序、参数、工作目录和环境变量名，检查后用 `/mcp confirm` 确认。`/mcp tools <服务器>` 查看其工具，`/mcp revoke <服务器> <范围>` 撤销相应信任。Desktop 设置中的 MCP 面板也可编辑服务器配置、查看启动详情、按会话/项目/用户范围信任或撤销。信任绑定服务器配置摘要；程序配置改变后需要重新信任。信任只允许启动这个本地程序，并不会预先批准工具调用。

MCP 调用以 `mcp:<服务器>/<工具>` 进入 Host 的 Policy 判定。配置的服务器是外部进程；Host 的文件工具 `boundary` 不会为该进程提供操作系统沙盒，也不能约束任意服务器资源。只配置可信服务器，并用服务器自身的目录限制、操作系统隔离与 Policy 控制访问范围。文件工具边界不能代表外部进程的权限边界。

取消当前轮次会取消正在等待的 MCP 请求；已在外部服务器产生的副作用需要核对。服务器意外断连时调用失败，不自动重新连接或重放；确认外部状态后，在桌面版重连 Host，或退出并重新启动终端界面，再重新披露工具。Skill 声明的 MCP 依赖只检查服务器是否已配置，不能证明它可连接，也不会授予调用权限。

### 托管浏览器

托管浏览器由 Ligule 以 MCP Server `ligule-browser` 启动 Playwright MCP。配置只接受使用者配置、命令行 flag 或 managed 配置层中的 `[browser]`；项目和目录配置不能指定浏览器程序。支持的配置形状如下，两个路径都必须是绝对路径：

```toml
[browser]
provider = "playwright-mcp"
entryPoint = "/absolute/path/to/node_modules/@playwright/mcp/cli.js"
executablePath = "/absolute/path/to/chromium"
```

`entryPoint` 必须指向受支持版本 `@playwright/mcp` **0.0.83** 的 `cli.js`，`executablePath` 指向 Chromium 浏览器可执行文件。Ligule 以 headless 和 isolated 模式启动；每个 Session 及派生子任务使用独立的浏览器上下文和存储目录。浏览器进程不受 Ligule 的 OS 网络沙箱约束，因此配置浏览器会启动能访问该操作系统网络的外部进程。

使用前需要当前会话的 Permission 为 `full-access`、网络为 `unrestricted`，并且平台报告完整的进程管理能力；`network = "policy"` 或 `network = "disabled"` 时会拒绝浏览器操作。MCP Server `ligule-browser` 仍需按其精确配置摘要在可信界面信任。外控 Agent 的 Grant 还必须允许该 Server 以及被调用的精确 MCP 工具；这些信任和 Grant 不会绕过 Policy。

浏览器只开放 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_press_key`、`browser_wait_for`、`browser_take_screenshot`、`browser_close` 和 `browser_handle_dialog`。导航只接受不含用户名或密码的 HTTP(S) URL；截图只返回当前 viewport。接口拒绝 `filename`、整页或元素截图参数，以及执行脚本、文件上传、安装扩展和调整 viewport 等能力。

TUI 输入 `/browser` 可查看配置、可用性、Permission、暂停状态和 MCP 连接状态；`/browser stop` 会暂停并终止当前 Session 及派生任务的浏览器进程，`/browser resume` 只解除暂停，不会启动浏览器实例。运行中的轮次也可执行 stop。外控只读会话不能本地执行这两项操作，需先接管或关闭外控会话。桌面版的 Browser Stop 使用相同的 Session 范围。人工停止、取消轮次、关闭 Session 或撤销生效的 MCP 信任会终止对应浏览器进程；恢复后，下次需要浏览器工具时才会重新连接。

### 常见问题

- `tui_terminal_required`：请在交互式终端运行 `ligule`；脚本中使用 `ligule run`。
- `tui_dependency_missing`：终端界面依赖未安装完整；检查 npm 安装是否包含可选依赖。
- `data_root_invalid`：`LIGULE_HOME` 必须是绝对路径；未设置时使用 `~/.ligule`。
- `provider_model_required` 或 `provider_base_url_required`：检查服务地址、接口类型和模型名称。
- `resume_mode_changed`：恢复会话时指定其原有模式，或在终端界面使用 `/resume <编号> <模式名>`。
- `delete_target_is_link`：删除工具拒绝目标路径最后一项为符号链接或 junction，并保留链接目标；如果确实要将真实目标送入回收站，请明确指定目标本身。
- `recycle_backend_missing`：当前平台没有可用的系统回收站；源文件保持不变。
- `recycle_backend_failed`：系统回收站操作失败，原路径上的目标对象身份和顶层元数据仍与操作前快照匹配。该检查不核对文件正文或目录内的全部内容；重试前请检查这些内容和系统回收站。
- `delete_outcome_unknown`：后端报错后，Ligule 无法确认原路径目标对象的身份和顶层元数据与操作前快照匹配；重试前请检查工作区和系统回收站。
- `delete_target_changed`：目标在检查期间发生变化；先检查实际文件，再重新发起删除。
- `trash_legacy_config_unsupported`：从用户/项目配置中删除旧的 `trashBackend` 和 `limits.trashDirectory` 字段。
- 命令不熟悉时运行 `ligule --help`；在终端界面输入 `/help` 查看界面命令和按键。
