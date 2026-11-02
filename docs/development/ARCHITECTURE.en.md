# Architecture

[简体中文](ARCHITECTURE.zh-cn.md) · [English](ARCHITECTURE.en.md)

The workspace has three source modules: `core/` is the shared Agent Core, `tui/` is the CLI/TUI product, and `desktop/` is the Electron product. Dependencies point `tui → core ← desktop`; Core itself keeps Kernel, Host, Session, Model, Policy, and Tools as distinct concepts. The products ship independently through npm `ligule` and GitHub Releases. Core has no independent release. The [kernel](../../core/src/kernel/kernel.ts) executes registered tools and applies the decision chain. The [Host](../../core/src/host/host.ts) assembles that kernel with a project environment, model provider, session log, and client protocol.

This guide is for contributors reading or changing the repository. It explains component ownership, dependency direction, one request's execution path, and session recovery. The linked source files remain authoritative for protocol fields and module details.

The user configuration layer can enable bounded local JSONL event logging with `[telemetry].enabled = true`; optional `otlpEndpoint` exports bounded OpenTelemetry traces to a loopback-only OTLP/HTTP protobuf endpoint. It is disabled by default, project configuration cannot enable it, and storage or export failure does not affect Agent execution. Local JSONL storage has a fixed safety cap of four 64 KiB segments plus the bounded manifests; segment retention is not a user-level setting because changing the count requires a safe manifest transition. A local storage failure disables that telemetry writer and emits a sanitized error code through the Host logger; `flush()` reports the failure to direct callers. Events and traces omit prompts, reasoning, tool arguments/results, file paths, and credentials. Session JSONL remains the recovery source of truth; the local JSONL is a structured application event log, not OpenTelemetry Logs, and Ligule does not include a trace viewer.

The CLI npm package bundles the private Core's compiled code, modes, and metadata. Core's external runtime dependencies are merged into the public package manifest, so npm installs the native dependencies for the consumer's system. Packing excludes the build machine's external dependency tree, and the same tarball is verified on Windows and Linux.

## Source and package dependencies

Source imports and npm installation describe different graphs. The module-level directions are:

| Source layer | Dependency direction |
| --- | --- |
| Core | Host composes Kernel, Session, Model, Capability, and Tools; Core does not import TUI/Desktop clients or React, Ink, and Electron packages. |
| CLI/TUI | The adapter depends on the public `@ligule/core` interfaces. |
| Desktop frontend | The renderer owns its UI modules and may import `desktop/electron/api.ts` only as a type-only protocol contract. |
| Electron Main | Main owns windows, IPC, security, and the runtime launcher; it communicates with the separate Node Host over framed IPC and does not import Core business code. |

Run `pnpm check:dependencies` to scan these source imports with the locked `dependency-cruiser@18.7.0` and workspace TypeScript version. The rules reject Core-to-client imports, Electron Main-to-Core imports, runtime dependency cycles, runtime imports of `npm-dev` dependencies from Core/TUI/Electron Main/Renderer, and runtime renderer imports of the Electron API contract. Electron Main may import the `electron` host API supplied by the packaged Electron runtime; this is the only npm-dev runtime exception. Type-only cycles, type-only imports, and renderer ambient type references are not runtime violations. The scan excludes tests, generated `dist`, vendored code, and `testplace`; full graph output is not committed.

The check configuration is [dependency-cruiser.cjs](../../dependency-cruiser.cjs); [check-dependencies.mjs](../../scripts/check-dependencies.mjs) runs the source scan and positive and controlled negative fixtures.

The CLI release manifest is assembled by [`releaseManifest()`](../../scripts/pack-release.js) from `tui/package.json` plus Core `dependencies` and `optionalDependencies`. The tarball bundles the private `@ligule/core` runtime and dependency-free `xlsx`; external dependencies are installed on the consumer platform, including only the applicable optional native packages. TUI `devDependencies` may remain as manifest metadata but are not installed transitively by npm consumers. Desktop is a separate product manifest and is not part of the CLI tarball. The CI release workflows call `pnpm --filter ligule run check-pack` and `pnpm --filter ligule run verify-install <tarball>` from a clean checkout. When running those checks in an existing workspace, use new `testplace/tmp` work roots so the scripts do not replace existing `testplace/pack` artifacts:

Representative direct dependency families and their source use are:

| Area | Source and packages | Install behavior |
| --- | --- | --- |
| MCP and schemas | `core/src/capability/mcp.ts`, `core/src/host/mcp-server.ts`; MCP SDK and AJV | Core production dependencies, installed by npm in the consumer. |
| Shell parsing and search | `core/src/capability/command.ts`, `powershell.ts`, `ripgrep.ts`; Tree-sitter grammars and `@vscode/ripgrep` | Production dependencies; native grammars and search binaries are selected for the consumer platform. |
| Documents and media | `core/src/capability/document-parser.ts`, `media.ts`, `artifact.ts`; Office/PDF parsers, `yauzl`, `sharp`, Canvas | Parsers load when used. Native image modules are consumer-installed; `xlsx` is bundled because it has no runtime dependencies or platform binaries. |
| Credentials and process integration | `core/src/kernel/credentials.ts`, `core/src/capability/mcp-posix.ts`, `win32-job.ts`, `screen-capture-worker.ts`; keyring, `koffi`, `node-screenshots` | Keyring is a production dependency. `koffi` and `node-screenshots` are optional native dependencies; without Koffi, POSIX MCP fails closed rather than launching without process-group ownership. |
| Telemetry | `core/src/kernel/telemetry-otlp.ts`; OpenTelemetry API, resources, trace SDK and OTLP exporter | Regular Core dependencies even when telemetry is disabled; the OTLP sink is created only when configured. |
| Terminal UI | `tui/src/tui/start.ts` and its React/Ink, Markdown and width helpers | Optional npm dependencies loaded only when entering TUI; the CLI reports the missing TUI packages if they were omitted. |

Desktop has separate manifests: `desktop/electron/` uses the packaged Electron host API, and `desktop/frontend/` dependencies are bundled into the renderer by Vite. Neither set is part of the CLI npm tarball. The manifests and lockfile remain the version authority; this table summarizes representative runtime roles rather than duplicating every package version.

```sh
pnpm --filter ligule run check-pack -- --work-root testplace/tmp/package-check-example-1
pnpm --filter ligule run verify-install -- testplace/tmp/package-check-example-1/ligule-0.1.0.tgz --work-root testplace/tmp/install-check-example-1
```

Replace the example directory names with unused names; pass the tarball path produced in the check-pack work root to `verify-install`. Both checks must use the same actual archive; do not infer the final package from workspace manifests alone.

### Extracted Core seams

These modules hold shared data rules or projections; Host and Kernel remain owners of lifecycle and execution:

| Module | Responsibility and boundary |
| --- | --- |
| [`errors.ts`](../../core/src/errors.ts) and [`kernel/error.ts`](../../core/src/kernel/error.ts) | `errors.ts` owns shared error types and diagnostics; `kernel/error.ts` preserves compatibility exports. |
| [`data-root.ts`](../../core/src/data-root.ts) and [`workspace-identity.ts`](../../core/src/workspace-identity.ts) | Resolve the user data root and canonical workspace identity; configuration storage and workspace registries keep their own state. |
| [`kernel/observe.ts`](../../core/src/kernel/observe.ts) and [`session/spill.ts`](../../core/src/session/spill.ts) | Keep per-run file observations and oversized result sidecars in their respective Kernel and Session layers. |
| [`host/session-initial-settings.ts`](../../core/src/host/session-initial-settings.ts) | Parse and validate initial generation limits; Host retains Grant checks, provider selection, trust updates, and Session creation. |
| [`host/tool-catalog.ts`](../../core/src/host/tool-catalog.ts) | Assemble a disposable, non-executable settings catalog and close temporary registries; it does not own a live Session. |
| [`host/run-records.ts`](../../core/src/host/run-records.ts) | Project persisted Run receipts and event windows; Host remains responsible for caller scope and authorization. |
| [`media.ts`](../../core/src/media.ts) | Define image-reference validation and shared limits without taking storage or Session ownership. |
| [`tui.ts`](../../core/src/tui.ts) | Provide the supported Core facade used by the CLI/TUI adapter; implementations stay in their owning modules. |

## Runtime and execution

- [Runtime map](#runtime-map)
- [Kernel, plugins, tools, and capabilities](#kernel-plugins-tools-and-capabilities)
- [One Agent Loop turn](#one-agent-loop-turn)

## Session data and recovery

- [Session records and recovery](#session-records-and-recovery)
- [Session data flow](#session-data-flow)

## Host and clients

- [Host protocol and clients](#host-protocol-and-clients)
- [Related guides](#related-guides)

### Runtime map

```mermaid
flowchart LR
  CLI[CLI] -->|in process| Host[Node Host]
  TUI[React and Ink] -->|in memory protocol| Host
  External[Local MCP client] -->|stdio MCP| MCP[MCP adapter]
  MCP --> Control[Process-local control]
  Control --> Host
  Web[React desktop UI] <-->|sandboxed Preload and IPC| Main[Electron Main]
  Main <-->|newline-delimited frames| Child[Node Host process]
  Child --> HostLogic[Host and kernel]
  Host --> Project[Project environment]
  Host --> Loop[Agent Loop]
  Host --> Session[Session JSONL]
  Loop --> Provider[Model provider]
  Loop --> Kernel[Kernel]
  Kernel --> Policy[Decision chain]
  Kernel --> Registry[Tool registry]
  Registry --> Tool[Registered tools]
  Tool --> Capability[Platform and I/O capabilities]
  Provider --> Endpoint[HTTP model endpoint]
```

`ligule run` and the default `ligule` invocation (or the compatible `ligule tui` command) create a Host in the Node process that owns the interface. The TUI sends protocol messages over an in-memory connection. The desktop frontend communicates with Electron Main through a fixed sandboxed Preload API; Main forwards protocol frames to the independent Node Host and manages windows, native interactions, and process lifecycle. The Host owns sessions, project state, policy, and model requests. See the [CLI](../../tui/src/cli.ts), [TUI adapter](../../tui/src/tui/start.ts), [frame transport](../../core/src/host/connection.ts), [Electron IPC](../../desktop/electron/ipc.ts), and [Preload API](../../desktop/electron/preload.ts).

The [project environment loader](../../core/src/host/environment.ts) supplies configuration layers and extension sources to CLI and Desktop Host entries. The [provider factory](../../core/src/host/provider.ts) validates the selected model wire format, capabilities and retry settings; an unconfigured Host accepts settings requests and rejects model runs explicitly. The [session mode transaction](../../core/src/host/session-mode.ts) owns restriction installation, prompt fragments, rollback, and the persisted mode fact. Host keeps session locks, active turns, routing and resource cleanup. TUI record projection lives in [transcript.ts](../../tui/src/tui/transcript.ts); Desktop's [stream buffer](../../desktop/frontend/src/session-stream.ts) separates partial output by session.

`ligule mcp-server --project <absolute-root>` exposes local control tools through the [MCP adapter](../../core/src/host/mcp-server.ts). The [control facade](../../core/src/host/control.ts) calls the same Host, tracks process-local operations, and limits session operations to the project authorized at startup. By default, it denies operations that require approval. With `--operator`, clients can reply to real pending approvals and questions and change supported session settings; hard denials cannot be overridden. Trusted TUI/Desktop clients can create project-bound [Agent Control Grants](../../core/src/host/agent-control.ts); `--grant <id>` bounds session Permission, network access, and Policy to the Grant's defaults and ceilings, which the Host revalidates on requests. Disconnect cancels runs and releases session locks. Session JSONL persists session records, while operation IDs and the message queue exist only in the current process. See the [Agent Control via MCP guide](../agent-control/guide.en.md).

### Delegated runs and external sessions

A run can carry a `DelegationSpec` with an optional `mode` and `outputSchema`, validated by the shared [delegation contract](../../core/src/delegation.ts). The internal `subagent` tool and MCP `ligule_run` / `ligule_run_start` share structured-output validation and the `RunResult` result type. An external MCP run continues in its original session; it does not automatically create a child session.

An internal subagent creates a derived Kernel and Loop in the same Host process, with its own Session JSONL record named from the parent Session ID plus `.sub-N`. It inherits the parent configuration, Provider, plugin tools, Permission, and Policy decision chain, but does not register the `subagent` tool. A parent turn can run at most three children concurrently. A child mode can only narrow the parent's available tools, and model-call, output, thinking, and loop budgets cannot exceed the parent limits. Its RunResult and Session reference return as the parent tool result, so failed or cancelled child records remain inspectable.

An external client reaches the authorized Host Session through local stdio MCP and the Control facade. Trusted TUI/Desktop clients use local Agent Control IPC to observe status, answer interactions, or take over a task. The Host remains the Session writer; session locks prevent two Hosts from writing the same record at once. Reply results and control events use `source=human` or `source=controller` to distinguish local users from MCP operators; only local-user replies can save approval memory. Takeover cancels the active external turn, clears unsent controller messages, releases the Host session lock, and emits an ownership-transfer event. Revoking workspace trust makes the local Host stop managed processes started from that trust; other Hosts recheck the shared trust record and stop those processes when revocation is detected. Session JSONL stores messages and tool events. Operation IDs, the event cache, pending requests, and the message queue belong to the Control process; after a restart, reopen a Session for live status, interactions, record reads, or further work, and do not reuse old operation IDs. An authorized durable receipt can instead be read with `ligule_run_get` without opening the Session writer. `run.wait` requires an explicit origin but does not authorize itself from that field. A trusted local UI can read both human and controller Receipts in its Session; the authenticated Agent Control bridge can read human Receipts and controller Receipts from its active Grant; other Hosts can read only their controller scope. The Host derives the scope from the persisted Run and verifies it against the caller context. A `requestKey` that matches multiple visible scopes returns `run_request_key_ambiguous`; use the unique `runId` to select a Receipt. The Host checks the matching receipt before returning a result.

```mermaid
flowchart LR
  Parent[Parent Kernel and Session] -->|subagent tool| Child[Derived Kernel and child Session JSONL]
  Child -->|RunResult and child Session reference| Parent
  MCP[Local stdio MCP] --> Control[Control facade and process-local run state]
  UI[TUI / Desktop] -->|Local Agent Control IPC| Control
  Control --> Host[Host for the authorized project]
  Host --> Log[(Session JSONL)]
```

### Kernel, plugins, tools, and capabilities

The kernel starts with an empty tool registry. The Host installs plugins through the [assembly loader](../../core/src/kernel/assembly.ts); a plugin registers tools and returns cleanup actions. The selected [tool mode](../../core/src/kernel/modes.ts) restricts which registered tools enter the model manifest and selects named prompt fragments. It does not implement tools or provide an approval decision.

A tool is the model-callable contract: a name, description, JSON parameter schema, and execution function. Its implementation may call code under [`core/src/capability/`](../../core/src/capability/), which performs environment-sensitive work such as path checks, shell selection, process management, network resolution, or clipboard access. A capability implementation is not automatically a model-callable tool. When policy records a `capability` label, that value names the operation used for that decision.

Every model tool call passes through [`kernel.call`](../../core/src/kernel/kernel.ts). The kernel checks registration and arguments, resolves declared command or network targets, then asks the decision chain to evaluate the call. The chain applies restrictions, guards, configured rules, automatic approval checks, and user approval in its defined order ([policy implementation](../../core/src/kernel/policy.ts)). Only an allowed call reaches the tool implementation. The kernel records the verdict and a result for completed, rejected, or failed calls; the model manifest contains only the tool name, description, and parameter schema.

Configured stdio MCP servers are launched in a dedicated process group on POSIX systems and in a Windows Job Object on Windows. Revoke, cancellation, and Host shutdown close the protocol transport, send a bounded graceful stop, then force-stop remaining owned processes. Cleanup failures remain visible and can be retried. POSIX process groups cover descendants that stay in the server's group; a descendant that deliberately moves into another process group with `setpgid` or starts a new session with `setsid` is outside that ownership boundary. POSIX MCP startup fails closed if the Node.js process-group launcher or Koffi's native `setsid` support is unavailable.

The built-in `delete` tool calls only the operating system recycle bin; Linux uses GIO's system trash operation. After a backend error, Ligule compares the object identity and top-level metadata at the original path with its pre-operation snapshot. A match returns the backend error; a failed match returns `delete_outcome_unknown`, instructing users to inspect the workspace and system trash before retrying. This check does not compare file contents or recursively verify directory contents. Ligule does not maintain its own trash listing or recovery storage. Shell delete commands continue through the Shell Permission, Policy, and Approval path.

`write` compares the file against the last full read immediately before replacing its content. The comparison and write are separate filesystem operations, so a concurrent external writer can still race that check. This tool does not provide an atomic compare-and-swap guarantee.

`edit` reads the current file, locates one unique anchor, and then writes the replacement in a separate operation. An external writer can change the file between those steps, so the anchor check does not prevent a concurrent edit from being overwritten.

The Host keeps Permission and Policy as separate per-session state. Before Policy runs, Permission checks each tool's resource-access category for reads, writes, command execution, network, or external processes. Policy then decides whether to ask for approval or refuse. The interactive TUI and Desktop can change session Permission; enabling `full-access` and `unrestricted` network requires separate confirmation. Command execution probes the selected Shell and platform capabilities through [`permission-capabilities.ts`](../../core/src/capability/permission-capabilities.ts). Linux uses bubblewrap and reports its measured filesystem isolation. When a restricted command uses Node from a hidden directory, the sandbox read-only maps only that executable and the distribution's npm/Corepack files to a fixed path; the user home and package-manager caches remain hidden. Windows `workspace-write` uses a per-run `WRITE_RESTRICTED` token and temporary workspace ACLs; it is `partial`, requires explicit project trust, risk confirmation, and unrestricted network access, and cannot confine reads or network. Hard links, writable ancestor `FILE_DELETE_CHILD` permissions, and concurrent ACL changes remain escape risks. Windows `read-only` uses AppContainer only if the selected Shell can enter the actual workspace; otherwise Kernel preflight refuses it. When available, it blocks workspace writes and Shell networking, while public readable system files remain visible. Project scripts and Git commands require workspace trust; Git commands also require per-call approval because repository configuration can run hooks, helpers, or aliases. `full-access` Shell runs with the current operating-system user's permissions and requires unrestricted networking and available process management. MCP `--operator` does not manage Permission, and Policy hard denials cannot be overridden by approval.

The `fetch` tool resolves addresses before Policy evaluation and pins each socket to an approved IP. It follows only same-origin redirects; each redirected resolution must remain within the original approved IP set. The result records the addresses actually contacted. Special-purpose IPv4/IPv6 ranges use the IANA `Forwardable` and `Globally Reachable` attributes to map into existing policy classes: forwardable but non-global destinations use `private` and require approval, non-destination or non-forwardable ranges use `unspecified` and are denied, and explicitly globally reachable assignments remain `public`. `shownBytes` counts source response bytes retained before UTF-8 decoding.

The default `minimal` mode also offers `managed_process` for commands such as development servers that must outlive one tool call. Start commands use the `exec` capability and retain its Permission, Script Binding, workspace trust, and Policy checks, including existing `exec` deny rules. Start requires an HTTP loopback health URL and waits for a 2xx response before returning a Session-scoped handle, port, and ready state; failed probes use bounded backoff, and cancellation or process exit interrupts the wait. Status, bounded logs, and explicit stop are scoped to the same Session; logs return at most 16 KiB. If a stop cannot confirm process exit, the result reports failure with `terminationPending: true`; if the process has exited but Exec or Guardian resource cleanup is unconfirmed, it reports `cleanupPending: true`; both flags can be true when both facts remain unconfirmed. When startup and process-tree termination both fail, the start error retains its original code and reports both failures; the status view exposes them separately as `startupFailure` and `terminationFailure`. Later close/stop calls reuse an in-flight Lease request and retry failed resource cleanup with a bound. Up to 128 confirmed terminal entries are retained by completion order; entries with unknown liveness or unfinished cleanup are never evicted. Ordinary `exec` still waits for the command to finish and lets Guardian clean descendants. Managed processes stay in the Guardian/Job Object process tree and stop on run cancellation, Permission change, Session/Host close, or Grant revocation; Grants revoked or expired elsewhere are revalidated once per second. The health URL only limits Host probing; the command and active platform Permission determine the actual listen address and network access.

The [Agent Loop](../../core/src/kernel/loop.ts) performs one user turn and any model/tool iterations it requires:

1. Append the user event and the effective turn settings to the session.
2. Render the system prompt, build the registered tool manifest, and project the session into model messages.
3. If configured, compact the request before sending it or once after a provider reports an oversized request.
4. Stream a model response and append its reasoning, text, and tool calls to the session.
5. Run each tool call through the kernel, append its result, then continue the loop when the model requested more work.
6. Append one terminal turn event for completion, cancellation, or failure.

The [model adapters](../../core/src/model/) implement the supported HTTP message formats. The Host selects a provider from the effective model service and reads credentials only when making a request.

HTTP adapters require their protocol terminator and a supported finish reason. They emit a `finish` event; the Loop rejects output exhaustion and empty responses before declaring completion. Complete tool-call batches are parsed and schema-checked before execution. Schema refusals become tool results that the model can handle; invalid provider JSON or an incomplete stream fails the turn without replaying tools. Compaction summaries apply the same completion checks before writing a checkpoint.

`model.outputTokens` is the request budget, distinct from legacy capability reductions. Services retain their compatible string `models` list and optionally attach `modelSettings` entries keyed by model ID. The selected entry supplies its display name, context window, and request output budget. A per-model output declaration can raise the conservative default for an unknown endpoint; it cannot raise verified endpoint/model ceilings or explicit capability reductions. Legacy configurations without that declaration retain their conservative ceiling. The [budget resolver](../../core/src/model/output-budget.ts) validates the effective limits; the same selected context window controls Host compaction. Provider reconstruction and session generation adoption keep changes at turn boundaries.

Host run progress is ephemeral, scoped to one active session/run, and derived from Loop, compaction, and approval/input events. `status.get` and `progress` notifications expose phase/timestamps/counts; active progress snapshots also carry the TaskBudget state so TUI and Desktop can display remaining execution time, cumulative interaction wait, and the Host's pause decision without polling the full status view. Activity notifications are coalesced while the Host snapshot retains actual event times. Terminal cleanup clears progress. No progress heartbeat is written into Session JSONL, and no default inactivity timer cancels runs.

### One Agent Loop turn

```mermaid
sequenceDiagram
  actor User
  participant Adapter as CLI / TUI / desktop adapter
  participant Host as Node Host
  participant Loop as Agent Loop
  participant Session as Session record
  participant Provider as Model service
  participant Kernel as Kernel and policy chain
  participant Tool as Tool and platform capability
  User->>Adapter: Submit a message
  Adapter->>Host: run.start
  Host->>Session: Append user event and turn settings
  Host->>Loop: Run with session, provider, and kernel
  Loop->>Session: Read model view
  Loop->>Provider: Send prompt, tool manifest, and messages
  Provider-->>Loop: Stream text, reasoning, and tool calls
  Loop->>Session: Append assistant content and tool calls
  alt The model requests a tool
    Loop->>Kernel: Validate and request a verdict
    Kernel->>Kernel: Check restrictions, rules, and approval
    opt User approval is required
      Kernel->>Host: Wait for approval in this session
      Host-->>Adapter: approval.request
      Adapter-->>User: Show approval card
      User-->>Adapter: Allow or refuse
      Adapter->>Host: approval.respond
      Host-->>Kernel: Return the verdict
    end
    Kernel->>Tool: Run an allowed tool
    Tool-->>Kernel: Return result
    Kernel->>Session: Record verdict and tool result
    Loop->>Provider: Continue with the tool result
  else The model completes the turn
    Loop->>Session: Append completed, cancelled, or failed status
  end
  Host-->>Adapter: Status, events, and final result
  Adapter-->>User: Show session updates
```

The loop appends the user input and effective turn settings, builds the model view, streams a response, and records each assistant event. Tool calls pass through kernel validation and policy before execution. The loop records their results and continues while the model requests more work. It appends one terminal status when the turn completes, is cancelled, or fails.

Calls declared serial and tools that complete the run form ordering barriers. Consecutive independent calls run in a rolling pool capped by project `[loop].maxParallelTools`, which ranges from 1 to 32 and defaults to 4; internal subagents inherit the parent cap. On cancellation or an internal kernel/runtime error, the loop stops starting queued calls, waits for started calls to settle and clean up, then writes exactly one `tool_skipped` result for each unstarted call ID. Started tool effects are not rolled back. Overflow recovery is limited to one compaction retry per `run`; the allowance belongs to that run, so a later turn in the same Session receives a fresh allowance.

### Session records and recovery

The append-only [session JSONL record](../../core/src/session/session.ts) is the source of truth for a conversation. Its first line identifies the record and project; later lines hold user and assistant messages, tool calls and results, turn state, model selection, Permission, Policy overrides, denial counters, and other events. Policy snapshots are ignorable to older readers and stay out of model messages and checkpoints. Session locks prevent two processes from writing the same record at once.

While a Provider response streams, [`stream-draft.ts`](../../core/src/session/stream-draft.ts) writes a separate provisional `<sessionId>.stream.json` snapshot. The first text or reasoning delta is saved immediately; later writes occur after 250 ms or 16 KiB of new content. Each channel keeps at most its last 8,192 UTF-16 characters and reports its total character count and whether earlier content was truncated. The bounded JSON snapshot is at most 128 KiB and is replaced atomically after a flushed temporary write. It is not a Session event, does not enter `modelView()`, and is removed once the assistant response is persisted. A later writer never deletes leftover temporary snapshot files whose ownership it cannot establish. Host session read/observe and MCP `ligule_session_read` expose it separately as `provisionalOutput` with `provisional: true`; if the snapshot is invalid, they return `provisionalOutputError: session_stream_invalid` while still returning persisted records. A matching persisted `responseId` suppresses the leftover snapshot. A forced process termination can lose the latest batch that has not reached a snapshot write. The UI does not automatically restore or render this field; it is available through the protocol.

By default, records and sidecars live at `dataRoot()/workspaces/<readable-path>--<stable-hash>/sessions/`. Read-only listing and search include the former shared and project-local locations without migrating files; opening a legacy session copies it into the workspace folder and preserves the source.

The model view is a projection of the record, not a second transcript. Reasoning, labels, turn metadata, and usage remain available for display or recovery but are excluded from model messages where the projection rules require it. A branch copies a record or a prefix ending at a completed turn; it leaves the parent unchanged.

Compaction blocks are derived files; all blocks of a session live in one file that each compaction replaces atomically. Before use, ligule verifies each block's format, covered sequence range, and digest against the session events. If any validation fails or the file is absent, it rebuilds the model view from the JSONL record ([block validation](../../core/src/session/checkpoint.ts)). Compaction only appends blocks and never rewrites the record, so original events remain readable ([compaction](../../core/src/session/compaction.ts)). Through the `compact` tool the model inspects pressure and blocks, reads back originals, and may compact a chosen range with a summary it writes itself; the soft threshold injects a one-time ephemeral reminder while the hard threshold still compacts automatically. Oversized tool output and summaries are stored in sidecar files; the record and blocks retain the references needed to read or export the complete content.

When a session is reopened, recovery repairs dispatched tool calls that have no recorded result with an explicit unknown outcome. It does not replay them. This preserves a valid model projection without repeating an operation whose external effect may already have happened.

Harbor evaluation exports a selected persisted Session turn through [`sessionTurnToAtif()`](../../core/src/session/atif.ts) as ATIF-v1.8. This is an evaluation projection, not a complete execution replay: each persisted assistant response counts as one logical LLM call; hidden HTTP retries and system compaction are not counted. Subagent trajectories and image payloads are not embedded. Spill content is restored only after validation against the same Session directory; preview-only content is marked `spill_content_missing`, and unresolved references fail export. Omissions appear in `extra.ligule.missing_features` and per-call flags, so metrics that require missing evidence remain unknown. See the [Harbor adapter notes](../../evals/harbor/README.md).

### Session data flow

```mermaid
flowchart TD
  Config[User and project configuration] --> Environment[Project environment snapshot]
  Environment --> Provider[Model service and credential lookup]
  Environment --> Policy[Approval rules and tool mode]
  Client[CLI / TUI / desktop UI] --> Protocol[Host protocol]
  Protocol --> Host[Node Host]
  Host --> Log[Append-only session JSONL]
  Host --> Loop[Agent Loop]
  Log --> Projection[Model message projection]
  Projection --> Loop
  Loop --> Provider
  Loop --> Kernel[Kernel policy and tool execution]
  Kernel --> Log
  Log --> Checkpoint[Validated checkpoint]
  Log --> Spill[Tool-result sidecar]
  Log --> Export[Export and history browsing]
  Spill --> Export
```

Configuration layers are combined into a snapshot while the Host creates a project environment. The session JSONL is the source for messages and tool outcomes. Checkpoints and spill files contain derived data that can be validated or retrieved. History browsing and export read the record and available sidecars; a UI cache is not the source of session facts. The user data root and project workspace separately own user-level data and project attribution.

Configuration edits hold the target file lock through version checking, TOML editing, effective-configuration validation, and atomic replacement. The Host validates model changes before persistence, including shared defaults without project overrides, shared user changes in other loaded projects, and explicit session model selections. Rejected edits do not modify the file. Valid changes still apply at the existing session turn boundary. Both streaming SSE and non-streaming JSON adapters emit the same completion, usage, text, reasoning, and tool-call events into the Loop.

### Host protocol and clients

The Host protocol defines methods, request parameters, approval requests, question requests, and notifications in one [protocol table](../../core/src/host/protocol.ts). [`connection.ts`](../../core/src/host/connection.ts) carries newline-delimited JSON messages. The Host validates method parameters before dispatch and owns all session state; clients use protocol methods to create or open sessions, start and cancel turns, read records, answer requests, and change supported settings.

The CLI's single-turn commands call the Host directly. The TUI uses the same protocol over an in-memory connection. The desktop UI uses a TypeScript client through the fixed Preload API and Electron IPC; Main forwards frames without interpreting Host methods or session data. These transports differ, while the Host methods and kernel behavior remain shared.

### Related guides

The [glossary](GLOSSARY.en.md) defines shared terms. [Contributing and checks](CONTRIBUTING.en.md) lists development commands and validation scope. The [user guide](../guide.en.md) explains CLI, TUI, and desktop workflows.
