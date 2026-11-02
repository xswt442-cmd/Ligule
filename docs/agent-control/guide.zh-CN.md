# 通过 MCP 使用 Agent Control

Ligule CLI 可以通过标准输入输出启动本地 MCP Server。它让外部 MCP 客户端调用现有 Host 来创建或接回会话、提交任务、检查运行状态、读取记录和取消任务。

## 启动

需要 Node.js 24 或更新版本，并安装 Ligule CLI：

```sh
npm install -g ligule
```

先进入目标项目目录，交互式运行一次 `ligule`，确认信任该工作区后退出。MCP Server 必须使用相同的操作系统用户和 `LIGULE_HOME`，才能读取已有信任记录。Server 在读取项目配置前检查信任；未信任时以 `control_project_untrusted` 退出，不在 stdio 上弹出信任提示，也不提供通过 MCP 授予信任的工具。工作区信任不等于工具审批，既有 Policy 和审批拒绝规则仍然生效。

在 MCP 客户端配置中，将 `ligule` 作为 stdio 子进程启动，并为它指定一个绝对项目目录。例如：

```json
{
  "mcpServers": {
    "ligule": {
      "command": "ligule",
      "args": ["mcp-server", "--project", "/absolute/path/to/project"]
    }
  }
}
```

Windows 路径示例：

```json
{
  "mcpServers": {
    "ligule": {
      "command": "ligule",
      "args": ["mcp-server", "--project", "C:\\Work\\project"]
    }
  }
}
```

每个 MCP Server 进程只授权启动时指定的一个项目。客户端通过 MCP `tools/list` 发现十四个工具及其参数 schema：

- `ligule_session_create`：在授权项目中创建会话。
- `ligule_session_open`：接回已有会话。列表中的会话需要先接回，之后才能提交任务或读取记录。
- `ligule_session_close`：释放空闲、队列为空且没有待决交互的会话。忙碌时返回 `control_session_busy`；先取消运行、等待停止，并显式清空队列后重试。关闭释放控制者的会话名额和记录锁，保留历史与已结束操作的查询（限当前进程最近 256 个操作）。关闭失败后会话暂停接受新工作，需重试清理。人工接管同样释放名额，原控制者不能重新抢回该会话。
- `ligule_session_list`：有界列出授权项目中的会话。
- `ligule_session_configure`：读取会话当前/待生效的设置和实际可用选项；操控者模式可修改会话设置。
- `ligule_interaction_reply`：对真实待决的审批或提问作一次性答复；只接受原会话和请求编号。
- `ligule_session_send`：空闲时开始新一轮，运行中按顺序排入下一轮消息，也可继续或清理队列。
- `ligule_run_start`：持久接受任务，返回包含 `runId` 的回执，以及当前进程内的 `operationId`。
- `ligule_run`：启动任务并等待终态；等待超时会返回当前状态，不会取消运行。
- `ligule_run_get`：按 `runId` 或 `requestKey` 查询重启、关闭会话后仍可读取的持久回执，可选分页读取经校验的终态结果。
- `ligule_run_status`：查询当前进程内操作的运行、完成、失败或取消状态。
- `ligule_run_await`：等待已知 `operationId`；超时同样不会取消运行。
- `ligule_session_read`：分页读取会话记录。
- `ligule_run_cancel`：按 `operationId` 取消相应任务。

推荐顺序是开始或继续工作前先创建或接回会话，再读取 `ligule_session_configure`。若希望服务端等待，可用 `ligule_run`；若要立即取回控制权，则用 `ligule_run_start`，之后通过 `ligule_run_await` 等待或用 `ligule_run_status` 轮询。两种等待超时都不会取消任务；根据 `phase`、`waitingFor` 和 `pendingInteractions` 继续等待或审阅后答复。完成后用 `ligule_session_read` 查看新增记录。状态通知通过 MCP logging 尽力发送；通知不可用时轮询仍可读取同一状态。需要停止时调用 `ligule_run_cancel`。工具参数以运行中的 `tools/list` schema 为准。进程重启后，可直接使用已有 `sessionId` 和 `runId`（或 `requestKey`）调用 `ligule_run_get`；无需先 `ligule_session_open`，也不会取得 Session 写锁。

## 操控者授权与会话设置

默认启动参数不包含操控者授权。此时普通审批请求和用户提问等待本地 Desktop/TUI 用户处理；Host 注册 `ask_user_question` 供本地界面使用，MCP 客户端不能直接回复。配置查询仍可用，设置修改与 MCP 交互答复返回 `control_operator_required`。只有本地 MCP 客户端配置明确加入 `--operator`，才能启用 MCP 回复和会话设置：

```json
{"command":"ligule","args":["mcp-server","--project","/absolute/path/to/project","--operator"]}
```

`--operator` 代表本机操控者明确授权这个 stdio 客户端。它允许回答真实待处理的 Policy 审批和用户提问，以及修改单个会话的 Mode、Policy、模型、生成参数和每轮循环上限；它不更改文件边界、工作区信任或硬拒绝规则。可选 Policy 只有 `ask`、`auto` 和 `none`；已保存的旧版 `never` 保持原有拒绝语义。审批不能覆盖非法工具参数或工作区边界。`ligule_run_status` 的待处理交互只含有界摘要，不会重复传输完整工具参数。可信本地 TUI 或 Desktop 可以在请求仍待处理时展开详情。Host 无法安全审阅请求时会返回明确的 unavailable/error 错误码，不会记作用户拒绝。

每条待决答复都绑定原始会话和 `requestId`。状态与事件中的 `source` 区分本机 TUI/Desktop 用户（`human`）和 MCP 操控者（`controller`）；两者对待决审批的明确批准都会清除拒绝计数并解除强制逐次审批，只有 `human` 答复可以保存审批记忆。操作结束、断连或请求失效后，迟到的答复会返回 `control_interaction_stale`，不会记作用户拒绝。

## 委派运行与结构化结果

`ligule_run` 与 `ligule_run_start` 接受可选 `delegation`。其中 `mode` 可选择具名或内联模式，但只能缩小当前会话的工具和提示片段范围，不能扩大会话、Permission、Policy 或 Grant 上限。`outputSchema` 可要求该轮提交符合受支持 JSON Schema 的结构化结果；模型必须调用 `ligule_delegation_result` 提交，通过校验后运行才会以有效结构化结果完成。无效提交可以在本轮现有迭代预算内纠正。如果运行最终只返回普通文本、没有有效提交，会以 `delegation_result_missing` 失败；结果为 `state: failed`、`stopReason: validation_failed`、`validation.status: invalid`。Loop 会在写入成功终态前把 Session 轮次记为失败。此前的工具副作用和 Session 记录都会保留，不会回滚或重放。取消和模型提供方失败仍保留各自的结果原因。未设置 `outputSchema` 时，普通运行完成行为不变。模式和结果契约只作用于本次运行，不会创建新会话或修改项目配置。内部 `subagent` 是模型可调用的工具，和 MCP 外控的一轮委派不是同一个会话。

### 任务预算与文件交付

`delegation.budget` 可选地收紧 `maxModelCalls`（总逻辑模型调用数）、`timeoutMs`（执行期限）、`requestTimeoutMs`（单次模型请求超时）和 `interactionWaitTimeoutMs`（累计交互等待时间）。项目 `[loop]` 的 `totalModelCalls`、`taskTimeoutMs`、`requestTimeoutMs`、`interactionWaitTimeoutMs` 决定上限，默认分别为已配置的 `modelCalls`、30 分钟、2 分钟和 12 小时。只有所有工作都因审批或用户提问而阻塞时执行期限才暂停；其他工作仍在执行时，待处理交互也会消耗独立的等待预算，重叠等待只计一次。执行期限最长 24 小时，单次请求最长 1 小时，交互等待最长 7 天。父循环和内部子代理共享预算；同一 Provider 请求内部的传输重试不重复计数。

任务快照提供 `executionElapsedMs`、`executionPaused`、`interactionWaitMs` 和 `interactionWaitTimeoutMs`。`deadlineAt` 是快照时根据剩余执行时间推算的期限；执行暂停期间它会向后移动，并非固定的墙钟时间。

预算耗尽、执行期限、单次请求超时和交互等待超时分别报告 `task_model_budget_exhausted`、`task_deadline_exceeded`、`task_request_timeout`、`task_interaction_timeout`，对应 `stopReason` 为 `budget_exhausted`、`deadline_exceeded`、`request_timeout`、`interaction_timeout`。`ligule_run_await` 的等待超时不会取消任务。`ligule_session_configure` 返回 `effective.taskLimits`，`status.get` 显示运行中或最近任务的快照。运行失败时也会保留已确认的 `usage`、`task` 和 `userSeq`；中断前已有正文会标记 `output.partial: true`。

`full` 工具模式提供 `present({files: [{path, description?}]})`，每次最多提交 16 个工作区内现有普通文件。工具校验工作区与文件边界，记录相对路径、媒体类型、字节数、SHA-256、说明及所属 Session。单文件最多 20 MiB，一次调用合计最多 64 MiB。运行成功时，`artifacts` 除 Session 引用外还可包含 `kind: file` 项；运行失败仍保留此前已确认的文件交付。这些元数据只描述当时磁盘上的文件，不会复制文件或保证永久可下载，之后的修改或删除也不会根据哈希重建。

### 持久回执与安全重试

`ligule_run`、`ligule_run_start` 可附带 1～128 字符的 `requestKey`，字符限定为 ASCII 字母、数字及 `.`、`_`、`:`、`-`。每个逻辑任务生成一个新键；响应丢失后沿用原键重试。同一工作区、Session 与授权调用方范围内，同键、相同输入及委派参数会复用原 `runId`；参数变化返回 `run_request_conflict`。之后默认设置变化不会改变原请求身份。不提供键则每次都是新任务。键不是跨会话访问凭据，接受记录仍在时不会自动过期。

Host 会先把 Session 用户事件同步保存，再返回接受回执。`runId` 可跨控制器重启读取；`operationId` 只用于当前进程的查询、等待与取消。`ligule_run_get` 可只读查询授权项目中已有 Session 的记录，不会打开写入方；Host 仍会校验项目归属、有效 Grant 和调用方可见的 Run 范围。调用时传入 `sessionId` 和 `runId`、`requestKey` 二者之一；不传 `offset` 只返回回执，传入后额外读取至多 8,192 个 UTF-16 字符的已校验终态 JSON，使用 `nextOffset` 继续读取。完整结果文件最多 16 MiB，跟随 Session 记录目录及其显式覆盖设置。结果文件缺失或变化会返回 `run_result_unavailable`。

只读回执查询不会接管写锁或运行模型。原所有者不可联系时，未完成接受记录的存活状态为未知；只有合法取得写锁的 Session 恢复流程才能把它标记为 `interrupted`。中断任务和同键重试不会自动重放工具；内存消息队列与待决审批也不会在重启后恢复。旧记录与不带键的调用保持兼容。

## Agent Control 项目授权

需要让 MCP 会话使用受控 Permission 时，先在受信任的 TUI 输入 `/control create`，或在 Desktop「设置 → 外部控制」创建绑定项目的 Grant。Grant 保存默认权限、权限上限、网络默认值与上限、允许的 Policy、是否允许普通 Operator 操作及到期时间。`full-access` 和不受限网络必须在创建界面分别确认。授权只适用于 Grant 绑定的项目；它不是远程客户端身份认证，也不解除操作系统 Sandbox 限制或 Policy 硬拒绝。

使用 Grant 启动 MCP Server：

```json
{"command":"ligule","args":["mcp-server","--project","/absolute/path/to/project","--grant","GRANT_ID","--operator"]}
```

MCP 会校验项目路径与 Grant 绑定一致，并将其默认 Permission、网络和 Policy 应用于新会话。`--operator` 只能在 Grant 已允许普通 Operator 操作时使用；这时 MCP 可在 Grant 上限内改会话设置并答复真实待决的审批或提问。未提供 Grant 时，单独的 `--operator` 不会授予或提升 Permission；提供 Grant 但不启用 `--operator` 时，只能使用 Grant 默认值，不能通过 MCP 修改这些设置。Host 会持续核验撤销、到期和项目绑定；失效后拒绝后续控制并释放会话锁。

可信 TUI/Desktop 接管外控会话时，会先取消正在运行的操作、清空尚未发送的队列并释放 Host 会话锁，再把会话交回本地用户。已完成的工具副作用不会被重放或撤销；旧进程的 `operationId` 在 Server 重启后不可恢复。

新会话可在 `ligule_session_create` 的 `initial` 中一次性设置 `mode`、`policy`、`model`、`thinking`、`outputTokens` 和 `loopIterations`。已打开会话使用 `ligule_session_configure` 的 `changes`。单次更新只能改一个类别：Mode、Policy、生成设置或循环上限；生成设置类别内部可同时改模型、思考档位和输出上限。`loopIterations` 是每轮用户任务允许的模型/工具循环次数，必须是正安全整数；默认值来自项目 `[loop].iterations`，未设置时为 64。项目 `[loop].maxParallelTools` 限制同时执行的独立工具调用数，范围为 1 至 32，默认值为 4；内部子代理继承父级上限。这些值属于项目配置，不是会话覆盖。会话覆盖不改项目配置，保存在 Session JSONL 中，并在重新接回时恢复。`loop.modelCalls` 仍使用项目配置，不会随 `loopIterations` 一起变化。混合类别的请求会被 schema 拒绝，避免部分生效。当前格式的记录会保存并恢复 Mode、Policy 覆盖、Policy 拒绝计数与强制逐次审批状态，以及模型/生成设置。运行期间的生成设置和循环上限在下一轮开始时生效，Policy 在之后的工具判定生效，不能改变已经等待中的审批。旧格式会话仍可读取，但不能修改 Permission 或 Policy。响应中的 `applies` 明确给出时机。

Node/Python 脚本调用需要逐次审批；`approval.request` 会包含规范脚本路径、SHA-256、解释器、工作区和 Permission，Operator 应向操作者展示这些信息。审批等待期间源文件或执行身份变化时，Host 拒绝执行并返回 `exec_script_binding_changed`。无法安全绑定的脚本、包装器、复合解释器调用和动态命令会 fail closed；它们不会因为 Operator 可以答复普通审批而获得绕过权限。

模型和服务选项来自当前 Host 配置。`thinking` 只列出已核实的模型能力；当前仅官方 DeepSeek Chat Completions 端点上列出的模型支持 `none/low/high/max`。兼容网关不会自动继承此能力。`effective.generation.outputTokens` 是当前请求预算；`maxOutputTokens` 是解析后的模型/服务输出上限，`contextTokens` 单独报告。例如，已核实的 DeepSeek Flash 输出上限是 393,216 Token；未知兼容端点继续使用保守默认上限。输出预算必须同时不超过服务上限和上下文窗口，否则 Host 返回稳定错误码。使用 `null` 清除模型、思考或输出上限的会话覆盖。

## 运行阶段与消息队列

`ligule_run_status` 保留 `running/done/failed/cancelled` 四种终态兼容状态，并返回阶段、等待类型、进度、待决交互及有界事件。每个操作保留最近 128 个事件；使用 `after` 游标增量读取，单次最多 50 条。若事件缓存已覆盖旧游标，`eventGap` 会提示需要从现有状态重新同步。运行和等待交互时状态仍是 `running`。

`ligule_session_send` 最多缓存 16 条下一轮消息，每条不超过 65,536 个字符。空闲会话立即开始一轮并返回 `operationId`；运行中的消息按接收顺序排队。运行正常完成后自动执行下一条，并在来源操作的事件流发布 `queue.started` 与新 `operationId`，即使新一轮很快结束也能查询。运行取消或失败（包括缺少有效委派结果）会暂停队列，调用 `continue` 才继续；可用 `cancel_queued` 删除指定条目，或用 `clear_queue` 清空剩余条目。该队列只在 Server 进程内存在，重启后不恢复，也不会重放不确定的副作用。正在等待审批或提问时，排队消息不会替代交互答复。

成功结果同时提供 `structuredContent` 和 JSON 文本 `content`。工具执行失败时返回 `isError: true`，从文本 `content` 中解析 JSON 的 `code` 字段，例如 `session_locked` 或 `operation_not_found`；失败结果没有成功形状的 `structuredContent`。未知工具或不符合 schema 的参数返回 MCP 协议错误。运行状态只包含固定摘要和错误码，模型正文与工具结果通过会话记录读取。

`ligule_session_read` 默认返回最近一页，页内记录按时间从早到晚排列。用响应里的 `nextBefore` 作为下一次读取的 `before`，即可逐页向更早记录读取。单次最多返回 50 条记录；每条 `json` 是 Host 记录的 JSON 文本片段，每段最多 8192 个 UTF-16 字符。响应尚未写入 Session 记录时，结果还可能包含独立的 `provisionalOutput` 快照，并标记 `provisional: true`。字段包括 `responseId`、可空的 `userSeq`、`updatedAt`、`text`、`reasoning`、`textCharacters`、`reasoningCharacters` 和 `truncated`。它不是助手正式记录，也不会作为模型输入。若正式助手记录已有相同 `responseId`，读取时会忽略残留快照。快照损坏或超限时返回 `provisionalOutputError: session_stream_invalid`，但仍可读取正式记录。快照可能落后于 Provider 流；进程突然终止时，尚未写入的最后一批内容可能丢失。

读取一个较大的完整记录时，先用 `at` 指定该记录的事件序号，再按响应里的 `nextOffset` 继续读取同一记录：

```json
{
  "sessionId": "SESSION_ID",
  "at": 42,
  "offset": 0
}
```

把每次响应中同一 `seq` 的 `json` 片段按 `offset` 顺序拼接；当 `nextOffset` 为 `null` 时，片段已经完整，可以对拼接结果执行 `JSON.parse`。后续请求继续使用同一个 `at`，并将 `offset` 设为上一段的 `nextOffset`。`at` 与 `before` 不能同时提供。完成当前记录后，再用 `nextBefore` 翻到更早的一页。

## 项目与权限

`--project` 必须是绝对路径。会话、运行和读取都限制在启动时授权的项目内；`ligule_session_list` 返回的会话需通过 `ligule_session_open` 接回后才能操作。项目目录标识会话归属，`boundary` 仍独立限制文件工具可访问的路径。

MCP Server 使用 Ligule 已有的配置、模型服务、工具和 Policy。未启动 `--operator` 时，普通人工审批等待本地 Desktop/TUI 用户处理，MCP 客户端不能直接答复；启动该选项后，只能答复真实待决请求。Server 不提供任意 Host RPC 或任意配置文件写入工具。它只使用本地 stdio，不开启网络监听。stdio 客户端与 Server 使用同一操作系统用户权限，请只配置可信的本地 MCP 客户端。

撤销工作区信任会立即停止当前 Host 中基于该信任启动的受管进程。其他 MCP Host 会每秒复核共享信任记录，并在检测到撤销后停止这些进程；新的项目代码命令在执行前也会重新检查信任。

没有 Grant 时，`--operator` 不会授予或提升会话 Permission，也不能更改 OS 资源边界。MCP 工具调用始终经过会话的 Permission 与 Policy 判定。受限 Shell 只在平台 Sandbox 满足所需能力时运行；Linux bubblewrap 按实测报告文件系统能力。Windows `workspace-write` 标为 `partial`，必须先明确授权项目并确认限制，同时将网络设为 `unrestricted`；它不能限制文件读取和网络，既有硬链接、可写祖先目录的 `FILE_DELETE_CHILD` 权限或并发 ACL 修改也可能越界，不适合运行恶意原生代码。Windows `read-only` 仅在实时探测确认所选 Shell 能进入实际工作区时使用 AppContainer，否则该档位下 Shell 不可用；可用时会阻止工作区写入和 Shell 联网，但系统公开可读文件仍可能被读取。`full-access` 需要在可信交互界面单独确认；这不会让 Policy 的硬拒绝可被覆盖。

任务状态和 `operationId` 只保存在当前 Server 进程中；每个进程保留最多 256 个操作记录。达到上限后，新任务会从已结束的操作中淘汰创建时间最早的一条；被淘汰的 `operationId` 不可再查询。如果所有保留的操作都仍在运行，新任务会以容量错误拒绝。Server 退出或重启后，旧 `operationId` 不可恢复。会话记录仍由 Host 持久保存，可重新启动 Server、接回会话并读取历史，但这不会恢复旧进程中的运行状态。

一个 Server 进程最多接管 64 个不同会话。重复接回已经由该进程接管的会话不占用额外名额。达到上限后，无法再创建或接管新会话；重启 Server 才会释放这些名额。没有运行的会话也会一直占用名额到 Server 退出。

客户端断开或 Server 收到终止信号时，Server 会取消仍在运行的任务、等待 Host 调用结束并释放会话锁与扩展资源。已写入会话记录的内容仍可在重启后读取，断开不会恢复未完成的任务或旧 `operationId`。

要在 Desktop 中查看 MCP 会话，Desktop 与 MCP Server 需使用相同的 `LIGULE_HOME` 和有效会话目录。Desktop 会话侧栏会列出同一目录中的会话；Server 持有会话锁时，侧栏条目可见，但 Desktop 不能同时打开该会话。客户端断开后 Server 释放锁，用户刷新侧栏即可打开已保存的会话记录。两个进程使用不同的数据根或会话目录时，会话列表彼此独立。

工具调用和记录内容会交给 MCP 客户端。请只连接可访问该项目数据的客户端，并在需要时检查其日志和数据保留方式。
