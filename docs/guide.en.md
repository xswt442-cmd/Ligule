# ligule user guide

[简体中文](guide.zh-CN.md) · [English](guide.en.md)

ligule provides a command line, a terminal UI, and a desktop UI. All three use the same configuration and session records.

## Get started

- [Start your first conversation](#start-your-first-conversation)
- [Install and launch](#install-and-launch)
- [Workspaces and data](#workspaces-and-data)
- [Configure a model service](#configure-a-model-service)

## Daily use

- [Sessions and input](#sessions-and-input)
- [Tool modes and internal subagents](#tool-modes-and-internal-subagents)
- [Approvals and settings](#approvals-and-settings)
- [Branches and export](#branches-and-export)

## Recovery and reference

- [Recovery and cancellation](#recovery-and-cancellation)
- [Language, appearance, and shortcuts](#language-appearance-and-shortcuts)
- [Common errors](#common-errors)

### Start your first conversation

1. Choose the CLI and TUI, or the desktop app. Install the CLI and TUI with `npm install -g ligule`; install the desktop package for your operating system and architecture.
2. Configure a model service: use “Settings → Model services” in the desktop app, or follow [Configure a model service](#configure-a-model-service) for the CLI and TUI.
3. From a project directory, run `ligule run "Review the project structure and suggest improvements"` for one turn or run `ligule` to open the TUI. In the desktop app, select a workspace, start a conversation, and send a message.

### Install and launch

The command line package requires Node.js 24 or newer. Install the CLI and TUI from npm:

```sh
npm install -g ligule
```

After installation, run `ligule --version` to check the CLI and TUI version. The desktop app uses Electron; install the package for your operating system and architecture.

From a project directory, run `ligule run "Review the project structure and suggest improvements"` to make one request. For daily use, run `ligule` to open the terminal UI or launch the installed ligule desktop app. `ligule tui` remains available as a compatibility command. The terminal UI requires an interactive terminal; use `ligule run` in scripts and pipelines.

CLI one-off runs are read-only by default. Use `ligule run --allow-full-access "..."` only when you explicitly want full local file, process, and network permissions for that run. Shell commands execute as the current OS user without an OS sandbox. The flag is valid only for `run`; project configuration and model output cannot enable it, and it does not bypass Policy approvals, denial rules, or dangerous-command hard denials.

Run `ligule --help` to list commands. `ligule sessions` lists sessions for the current project, `ligule workspaces` lists registered workspaces, and `ligule tools`, `ligule skills`, and `ligule extensions` show loaded capabilities.

### Workspaces and data

The command line and terminal UI use the current directory as the default workspace. On first launch, the desktop app creates and registers `ligule/default-workspace` under the system Documents directory. New sessions then use the selected default workspace. Add other workspaces from the desktop sidebar to view their sessions. The workspace menu can hide a sidebar entry or remove its registration. Clear the default selection first; removal is blocked while a session is running in that directory. Removing a registration leaves the project directory, files, and session records untouched. Add the workspace again to view its existing sessions.

Before loading project configuration, guides, or skills in a new directory, the terminal UI asks whether you trust it, with Exit selected by default. Trust and continue remembers that exact directory; subdirectories require their own confirmation. Use `/trust` for details or `/trust revoke` to revoke trust and exit. Trust does not approve tools or change approval rules or access boundaries. Project `AGENTS.md` files use the existing instruction loader and cannot grant system permissions. Each launch displays the Ligule mark, version, workspace, and help hint.

Each session belongs to one workspace. The terminal UI prepares a new session when it starts. The desktop app restores the last session at launch, or prepares a new one when there is no previous session. Session records are stored under `workspaces/<readable-workspace-path>--<short-hash>/sessions/` in the data root. The path label keeps workspace folders recognizable; the hash prevents different paths from colliding. The Desktop workspace menu for a new conversation has a Browse button that opens the system folder picker; you can also enter a path directly.

The default data root is `~/.ligule`. Set `LIGULE_HOME` to an absolute path to move it; a relative path returns `data_root_invalid`. User configuration is in `~/.ligule/config.toml`, shared project configuration is in `.ligule/config.toml`, and local project configuration is in `.ligule/config.local.toml`. The data root also stores the workspace registry `workspaces.json`, the workspace trust record `trust.json` (the earlier `tui-trust.json` remains readable), MCP server trust in `mcp-trust.json`, external agent grants in `agent-control.json`, the extension enable-disable registry `extensions-state.json`, terminal input history, desktop preferences in `desktop.json`, and credential references (the keys themselves live in the operating system credential store, not in the data root). Besides the `.jsonl` records, a session directory holds rebuildable derived files: the compaction block file `<id>.checkpoint.json`, oversized-content spill files `result-*.json` and `summary-*.txt`, and the listing index `index.json`. They rebuild from the record when damaged or missing and are safe to delete. Older sessions remain discoverable in the former shared `sessions/` directory and project `.ligule/sessions/`; listing them is read-only, and opening one copies its record and sidecars into the new workspace folder while preserving the originals. WebView's `ligule.ui` value is a first-screen cache. Drafts and queues are separate between the terminal UI and desktop app.

The `delete` file tool uses only the operating system recycle bin. Windows uses the system Recycle Bin and Linux delegates to GIO's system trash operation. If a backend reports an error, Ligule compares the target object's identity and top-level metadata at the original path with its pre-operation snapshot. A match returns the backend error; if Ligule cannot confirm a match, it returns `delete_outcome_unknown` so you can inspect both the workspace and system trash before retrying. This check does not verify file contents or recursively inspect directory contents. The operating system handles recovery; Ligule has no managed-trash list, restore, or permanent-delete workflow. Delete commands issued through Shell remain Shell operations governed by Permission, Policy, and Approval; they are not redirected to the recycle bin. Existing `.ligule-trash` directories are left in place and are neither migrated nor cleaned; Ligule search continues to skip this historical directory. Old `trashBackend` or `limits.trashDirectory` settings return `trash_legacy_config_unsupported` and should be removed.

Search uses the bundled ripgrep by default. A custom `ripgrepPath` selects executable code and can only be set in user configuration or command-line `--config` flags. Declaring it in shared or local project configuration fails with `search_backend_source_untrusted`. Move the custom path to user configuration, or remove the field to use the bundled backend.

### Configure a model service

In the desktop app, open “Model services” under “Settings” to add multiple services and models, then choose a default. The terminal UI and command line read the same configuration. To configure multiple services manually, add this block to a configuration file:

```toml
[model]
services = [
  { id = "deepseek", name = "DeepSeek", api = "chat-completions", baseURL = "https://api.deepseek.com/v1", apiKeyEnv = "DEEPSEEK_API_KEY", models = ["deepseek-flash"] },
]
selection = { provider = "deepseek", model = "deepseek-flash" }
```

Enable content-free structured event logs and optionally select a local Trace Collector in user configuration:

```toml
[telemetry]
enabled = true
otlpEndpoint = "http://127.0.0.1:4318/v1/traces"
```

`otlpEndpoint` accepts only OTLP/HTTP protobuf `/v1/traces` URLs on `localhost`, `127.0.0.1`, or `::1`, for example a local Phoenix instance. Export is off by default and project configuration cannot enable it. Ligule does not inherit `OTEL_*` headers or credentials. Logs and traces omit prompts, reasoning, tool arguments/results, paths, and secrets. Export failure does not affect the run; local JSONL is a structured event log, not OpenTelemetry Logs.

Set each service's `api` to `chat-completions` or `messages`; `models` lists its available models. Put the API key in the environment variable named by `apiKeyEnv`. The desktop model services page can also save a key in the operating system credential store. A non-empty environment variable takes priority. Linux uses Secret Service and reports an error when it is unavailable. The legacy single-service fields `model.api`, `model.baseURL`, and `model.model` remain supported; if that configuration omits `apiKeyEnv`, ligule reads `LIGULE_API_KEY`.

The default service and model apply to new sessions. Use the model menu beside the composer to select a model for the current desktop session. In the terminal UI, press Ctrl+P or use `/model` to open the model list, or use `/model <service> <model>` to switch directly. A session selection does not change the global default. If you switch models while a session is running, the change applies after the current turn.

Use `/credentials` in the terminal UI to check the current model's credential reference and source: environment, OS credential store, or not set. It never displays the key. `provider_credential_missing` means that reference has no key in the launching environment or the credential store for the current data root. Restart the terminal program after changing environment variables, or save a key through Desktop Model services. Both interfaces must use the same `LIGULE_HOME` to access the same stored credentials.

#### Model output budget

Each service under Desktop “Settings → Model services” has a model configuration table. Add or remove models and edit their display names, context windows, and maximum output tokens. Blank limits inherit existing configuration; enter full positive integers such as `128000`. Display names do not change the model ID sent to the service. Services supporting discovery can fetch an available-model list and let you choose which entries to add; existing names and limits are preserved. Discovery retains all valid unique candidates within the response-size limit; each saved service supports up to 128 models. Discovery does not infer token limits. Apply catalog edits with “Save service”.

Per-model settings use the optional `modelSettings` list within the service. Each `id` references an ID in `models`, for example `modelSettings = [{ id = "custom-model", name = "My model", contextTokens = 128000, outputTokens = 16384 }]`. The selected model's context window controls compaction and its output budget controls actual requests and participates in the compaction pressure threshold (reservation capped at a quarter of the window). Identically named models in different services keep independent settings. Existing ID-only catalogs remain compatible.

`model.outputTokens` sets the maximum output-token budget for each request. The default remains 8192. Set `outputTokens = 16384` under `[model]`, or use the existing `config.set` interface. The value must be a positive integer within verified model limits, explicitly configured capability limits, and the context window.

The default output budget must also fit the configured context window. If the context window is smaller than that default, explicitly set an output budget no larger than the window. Invalid configurations fail explicitly rather than silently reducing the budget.

Higher built-in limits currently cover `deepseek-flash` and `deepseek-v4-pro` at the official `https://api.deepseek.com` endpoint, for Chat Completions and Anthropic-compatible Messages. Other endpoints and unverified models retain the conservative 8192 limit without a per-model declaration. A per-model `outputTokens` setting can declare a higher budget supported by a custom service; enter a value supported by that service. Declarations cannot raise verified official ceilings, configured capability limits, or the selected model's context window. An excessive budget fails with `provider_output_budget_unsupported`; an invalid value fails with `provider_output_budget_invalid`. There is no silent reduction. Switching models or services recalculates the applicable limits.

The legacy `model.capabilities.maxOutputTokens` can still only lower the adapter's declared limit: writing 16384 there does not raise the original 8192 ceiling. Use `model.outputTokens` for a higher request budget and check for a lower legacy capability override. Configuration changes apply at turn boundaries; an active turn keeps its existing budget.

Model settings are validated against the complete effective configuration before saving. A rejected setting leaves the configuration file unchanged. User-layer changes also validate the shared defaults on their own, other loaded projects, and explicitly selected session models; higher-priority project or command-line settings retain their precedence. Initial setup may save incomplete model fields so the remaining fields can be filled in.

Both APIs support `model.capabilities.streaming = false`. Requests then use ordinary JSON responses, with the same completion, output-budget, tool validation, and cancellation rules as streaming responses. This setting changes response delivery, not tool permissions or automatic retry scope.

Conversation, compaction, and internal subagent requests send credentials only to an API type, service root URL, and credential reference explicitly bound in user configuration or command-line flags. Project configuration may select models from a bound service; overriding its URL or key reference cannot borrow existing credentials. An unbound target returns `provider_credential_unbound`. Save the service in user configuration or explicitly select its target through command-line flags. Bindings and generation settings are adopted together at turn boundaries.

### Sessions and input

In the terminal UI, type `/` to browse commands and filter by name or description. Use the arrow keys to select, Tab to complete the draft, and Enter to execute. Commands such as `/policy `, `/queue `, and `/permission ` offer fixed argument suggestions; permission upgrades still require separate confirmation. Press Escape to dismiss suggestions, or use `/help` for categorized help and your current shortcuts.

The terminal welcome area is left-aligned and shows the mark, version, workspace, and help entry. Run phases come only from Host-confirmed status. The composer has a bounded height while longer drafts remain editable. Command and file suggestions appear near the composer; selection menus, session lists, full history, and approvals take the place of ordinary editing while open. Tool calls show the tool name and target summary first; press Ctrl+O to view full arguments, results, and session history. The interface uses ANSI color roles that follow the terminal's current palette. When a window is too small to show the approval information, approval is disabled and the UI asks you to enlarge it.

While answering a question, the composer edits the current answer. Use PageUp/PageDown to read long questions and options without changing the answer draft. Answers and ordinary session drafts have separate editing state. Finishing a question restores the ordinary draft and caret; exiting saves the ordinary draft and queued messages. Shortcuts can be customized with `/bind`; hints show the current bindings.

In the terminal UI, use `/sessions` or `/resume` without arguments to browse this workspace's sessions. Type a name, ID, or tool mode to filter, use the arrow keys to select, Enter to resume, and Escape to close. Search text stays out of your chat draft. You can also resume directly with `/resume <id> [mode]`, using a unique ID prefix. In the desktop app, switch sessions from the sidebar. The conversation menu provides rename, archive, restore, branch, export, view subtasks, refresh, and compact context actions.

Long conversations compact automatically as they approach the window: earlier history is replaced by a model-written summary, each pass forms a verifiable block, and the original events always stay in the record. At the soft threshold the model receives a one-time reminder and can inspect context pressure, list blocks, read back a range's original events or an overflow file through the `compact` tool, and compact a chosen range with a summary it writes itself. The hard threshold still compacts automatically, and the "compact context" action remains available at any time. The declared output budget participates in the pressure threshold (reservation capped at a quarter of the window). Branches inherit the compacted blocks, so summarized details remain reachable in the record and exports.

When a tool result exceeds its output limit, a session with `compact` can read the referenced result with `action: "spill"` and its `name`. If the returned page is truncated, use its `offsetBytes` to continue; offsets identify UTF-8 byte boundaries.

Type `@` in the composer to find files in the current workspace. Selecting a file suggestion inserts its path into the draft without sending the message. Press Enter to send; press Shift+Enter for a new line. Messages sent while a session is running are queued and sent in order. Cancelling a turn pauses the queue. View the queue, resume sending, or move queued messages back into the draft. Restoring a terminal session keeps pending messages in a paused queue without sending them automatically.

The desktop app saves drafts and queues separately for each workspace and session, and restores them when reopened. The terminal UI saves its draft and queue for each workspace and session. Both interfaces share the history of sent messages.

Desktop question cards retain unsubmitted choices and supplementary text for their session, including when you switch away and return. When observing an externally controlled session, Desktop shows Agent Control status and guidance input only after the Host confirms that an Agent Control runtime is available; the guidance draft survives session switches. If an ordinary Host merely holds the writer lock, Desktop provides read-only observation instead of treating the lock as Agent Control access.

While running, terminal and desktop status show the phase confirmed by the Host: preparing context, requesting the model, executing tools, compacting, waiting for approval or input, or settling. Time without progress measures the interval since actual model output or tool activity; it does not prove a failure. After a command exits, the Agent may request the model again. There is no fixed inactivity timeout that automatically cancels a turn.

A response completes only after a normal protocol ending with useful text or tool calls. Truncated output, reasoning-only or blank responses, and incomplete streams fail the turn. Partial text remains in the record, and executed tools are not automatically replayed. Inspect the record before explicitly submitting another task or cancelling the active one.

| Error code | Meaning |
| --- | --- |
| `provider_output_exhausted` | The provider reached its output budget; the response is incomplete |
| `provider_empty_response` | Normal ending without useful text or tool calls |
| `provider_stream_incomplete` | Missing protocol terminator, finish reason, or complete frame |
| `provider_stream_interrupted` | Reading the response body was interrupted |
| `provider_finish_reason_invalid` | Unsupported provider finish reason |
| `provider_tool_call_invalid` | Missing or duplicated call identity, or missing tool name |
| `provider_tool_args_invalid` | Tool arguments are invalid JSON; the batch was not executed |
| `exec_script_binding_unavailable` | The script or interpreter could not be safely bound to approval, so execution was refused |
| `exec_script_binding_changed` | The script, interpreter, workspace, or Permission changed after approval, so execution was refused |
| `session_permission_format_unsupported` / `session_policy_format_unsupported` | The legacy session format cannot store this setting; the session record was not changed |

HTTP errors show the status and necessary fixed classification, without raw gateway bodies or malformed tool arguments. Retryable transport failures and configured retryable HTTP 429/5xx responses follow the configured attempt and backoff limits before a successful response body is read. An interruption after body reading begins does not automatically replay the whole request. Explicit user cancellation remains `cancelled`.

### Tool modes and internal subagents

On Windows, `full` includes `screenshot` for one capture of the primary `screen` or `active-window`, with an optional `{x, y, width, height}` region relative to that target. It reads the existing display without opening windows or changing focus. Active-window capture returns visible compositor pixels within that window; a window spanning monitors, changed window/display geometry, a locked screen or a missing interactive desktop fails explicitly. Each capture runs in an owned process with a 12-second deadline, a 512 MiB process memory limit and a 40-million-pixel bound. Results immediately supply an image and `shotId`; `read_image({shotId})` rereads the stored capture.

Screen capture requires independent consent. In an existing Desktop conversation using `full`, choose “Capture disabled” and confirm; the same control revokes permission, including an in-flight capture. TUI `/screen on` explains the scope, `/screen on confirm` grants it to the current Session and its internal children, and `/screen off` revokes it. CLI `run`, `resume` and `tui` accept `--allow-screen-capture` as explicit consent for that process. Ordinary per-Session consent is not restored on reopen; an explicit startup option or an active screen-enabled grant retains its own scope. MCP requires a separately confirmed Screen capture grant created in the trusted interface; `--operator` and Permission profiles cannot enable it, and the startup flag is rejected for MCP. Consent does not widen tool modes, shell permissions or Policy rules. Stored captures remain governed by Session ownership and image retention.

The `full` mode also includes `read_image`: use either `{path: "diagram.png"}` within the file boundary or `{shotId: "…"}` to reread a stored image owned by this Session. PNG, JPEG, WebP and GIF inputs are decoded and normalized to PNG; animated inputs use the first frame. Limits are 20 MiB input, 40 million input pixels, a 2048-pixel output edge and 8 MiB output. Session JSONL stores references; providers load and check image bytes when constructing requests. Workspace images are stored under the data root's `screenshots/`, with a 256 MiB quota. Referenced images and images whose source Session still exists have no fixed expiration; unreferenced media may be cleaned up after 30 days once its source Session no longer exists. Branches inherit only images present in their copied history; internal subagents own separate images. Missing, expired or modified images fail explicitly. Markdown exports copy available images into a sibling `.assets` directory with relative links and report unavailable files separately; exported copies are managed by the user.

The `full` mode includes `read_document` for PDF pages, DOCX paragraph/table blocks, XLSX cells, and PPTX slide text/tables within the file boundary. Use `read` for plain text. `{path, start, count}` defaults to the first 20 units; `start` is 1-based and `count` is at most 20. XLSX defaults to rows and the first ten columns. Select cells with `{path, sheet, range: {startRow, endRow, startColumn, endColumn}}`, up to 200 rows and 10,000 cells. Results include source locations, sheet names, warnings and `truncated`; follow the returned `continuation`, including an intra-block text `offset`. Formulas retain their expression and cached result without recalculation.

For PDF, `{path, renderPage: 2}` renders one page through the persistent `document` image path and requires image input support. Textless pages recommend rendering instead of being treated as blank. Output edges are at most 2048 pixels; source raster images are limited to 40 million pixels. The tool performs no OCR, Office image/chart rendering, macro/script execution, external-link fetching or embedded-object execution. Limits are 20 MiB input, 24,000 UTF-8 extracted text bytes and 200 PDF pages/PPTX slides. Office ZIPs allow at most 2,000 entries and 64 MiB of actual inflated data. Isolated workers have a default 15-second deadline and a 192 MiB V8 heap limit; Windows also applies a 512 MiB process memory limit. Cancellation waits for worker exit. `limits.documentBytes`, `limits.documentOutputBytes` and `limits.documentTimeoutMs` can lower these bounds; the text budget must be at least 256 bytes. Password-protected PDFs report `document_password_required`; encrypted or legacy Office containers report `document_encrypted_or_legacy`. Password arguments are not accepted. Corrupt files and resource-limit failures are explicit errors.

Desktop offers a Preview image button for successful tool results. It reads an image already referenced by the Session and creates a transient WebP thumbnail with a maximum 512-pixel edge and 256 KiB size. Externally controlled and closed Sessions can be viewed without takeover or renewed capture consent; previewing never captures the current screen. Missing, expired or altered images report errors. Thumbnails are not written into records, and display resources are released when switching Sessions or unmounting the component.

Image input defaults to the verified official DeepSeek `deepseek-flash` route and its documented legacy vision alias. Unknown routes reject images. Declare a model explicitly with `modelSettings = [{id = "custom-model", imageInput = true}]`; `false` disables images, while omission selects automatic detection. Desktop exposes Automatic / Supported / Unsupported for each model. Switching to a model without image support rejects requests whose context still contains images; choose an image-capable model or start a new Session. Each request supports up to eight images and 16 MiB of normalized image bytes. Image-bearing records require a reader that understands their non-ignorable image events; older programs refuse to reopen them.

The `full` mode includes `todo_write`. It replaces the current turn's complete task list using `items: [{content, status}]`, where status is `pending`, `in_progress`, or `completed`; an empty list clears it. Lists allow up to 40 unique non-blank items, 400 characters per item and 8,000 UTF-8 content bytes in total. Snapshots persist as Session metadata and remain in history; the active list clears at turn end and starts empty on the next turn. Internal subagents keep separate lists. This tool grants no workspace write permission and is absent from the shipped `minimal` mode.

The `full` mode offers `web_search` only when its configuration and credential are available. It is absent from the shipped `minimal` mode, whose nine tools remain unchanged. In user configuration, set `serviceId` to an existing service ID under `[model].services`:

```toml
[search]
provider = "deepseek"
serviceId = "deepseek"
```

The service must use the official `https://api.deepseek.com` address. The `/v1` and Anthropic-compatible `/anthropic/v1` API roots are also supported. Search reuses that service's `apiKeyEnv` reference: a non-empty environment variable takes priority, followed by the operating system credential store. Do not put a plaintext key in chat or configuration files. Only user configuration, an explicit command-line configuration, or managed configuration can enable Search and select its service; shared and local project configuration cannot enable Search or replace its service or credential binding. `web_search` is not registered when Search is unconfigured, the service is invalid, the credential is missing or malformed, or the credential store is unavailable. The `search` field in `status.get` shows `configured`, `available`, an optional `serviceId`, and an error `code`. External controllers can read the same status from `effective.search` in the `ligule_session_configure` response. `available` means only that configuration is valid and a present credential has the required format; it does not confirm remote account authentication. Search settings and the service binding are read when a Session is created. Restart the Host after changing them to ensure new Sessions use the updated configuration. Each search request resolves the same credential reference again.

For `web_search`, `query` must be non-empty text of 1–128 Unicode characters. The optional `count` ranges from 1 to 10 and defaults to 5. Requests go only to the fixed official Search API; the model cannot provide a URL or key. Page content is not requested by default, and result pages are not fetched automatically. Responses contain titles, URLs, snippets, summaries, available dates, and `received`, `returned`, and `truncated` counts. Titles, snippets, summaries, and URLs are limited to 256, 512, 1,024, and 2,048 UTF-8 bytes respectively. Total results obey `limits.resultBytes` (16,000 bytes by default, with a 24,000-byte hard cap); budgets below 1,024 bytes reject the search. There is no cursor; narrow or rephrase a query when results are truncated. Requests use the configured `fetchBytes` and `fetchTimeoutMs` limits, capped at 2 MiB per response and 30 seconds; redirects are not followed. Network Permission, Policy, and Agent Control Grants still apply. HTTP errors use fixed error codes and do not echo response bodies or keys: `search_credential_rejected`, `search_payment_required`, `search_rate_limited`, `search_forbidden`, `search_timeout`, and `search_service_unavailable`.

A tool mode selects the tool manifest and prompt fragments visible to the model. It does not change Permission, Policy, or an Agent Control Grant. The bundled `minimal` mode is the default; `full` includes every tool registered in the current Host. Mode files are resolved in project, user, then bundled order; a higher-priority file replaces the complete lower-priority file with the same name.

#### Minimal user DIY examples

Create `skills/release-check/SKILL.md` under the data root. Use `ligule skills` to inspect discovery, then ask the model to activate the named Skill:

```markdown
---
name: release-check
description: Check a proposed release against the repository's release guide.
---
Read the release guide first. Report the exact files and checks that need attention.
```

Skills and their supporting files are instructions disclosed to the model on demand; they grant no permission. An open Session keeps the Skill registry it discovered at creation. Removing the file affects subsequent discovery.

A user mode in `<data-root>/modes/read-review.toml` can offer only the read tool:

```toml
tools = ["read"]
prompt = []
```

Selecting `read-review` only makes the already registered `read` tool visible to the model; it does not change Permission, Policy, or a Grant. Select another mode to stop using it.

Place a plain-text prompt template in `<data-root>/prompts/review.md` and invoke it as `/review core/src` in an interactive input:

```markdown
---
description: Review a requested source area.
argument-hint: [scope]
---
Review $ARGUMENTS against the repository's documented contracts.
```

The expanded text is recorded as ordinary user input; the template does not execute code or bypass tool decisions.

Place a TOML file in the `tools/` directory of the data root to declare your own command tool: `description` explains the purpose, `command` is the executable without arguments, the `args` array uses `{parameter}` placeholders (one whole entry each) that are replaced by the values the model provides, and `parameters` describes the argument schema (the same supported subset as built-in tools). A placeholder replaces exactly one argument entry, so model input never enters shell syntax; execution goes through the same permission and approval chain as Shell commands, and declaring a tool grants no additional permission. Declared tools are not part of any mode by default: list the name in a mode file (or use `tools = "*"`) to offer them to the model. Invalid files are reported as diagnostics and skipped without blocking other tools.

For example, declare a read-only workspace status query in `tools/git-summary.toml`:

```toml
description = "Show a short summary of Git changes in the workspace."
command = "git"
args = ["status", "--short"]
parameters = { type = "object", properties = {} }
```

Add `git-summary` to a Mode's `tools` list, then create a Session or switch to that mode to offer it to the model. Git commands still require a trusted workspace and per-call approval.

Code extensions install into the `extensions/` directory of the data root: either a single `.js` file or one directory containing an `index.js` entry (one directory, one package). Extensions run as code inside the Host process and load only in full-access sessions with unrestricted network; `ligule extensions` lists the paths that would load and their diagnostics. An installed extension can be disabled through `/extensions [on|off <name>]` in the TUI or the toggle on the Desktop settings tools page, recorded in `extensions-state.json` in the data root and effective the next time the Host starts; extension paths declared by configuration layers are not affected by the registry.

An extension that registers only a prompt fragment can look like this (for example, `extensions/review-hint.js`):

```js
export default function reviewHint(host) {
  host.registerPrompt({
    name: 'review-hint',
    text: 'Check file boundaries and preserve the current permission policy.',
  });
}
```

Select `review-hint` in a Mode's `prompt` list to include the fragment. The extension itself is still executable JavaScript with Host process privileges; it is not sandboxed. Install only code from a source you trust, and load it only in a Session that meets the Permission conditions above. Disable an installed extension with `/extensions off review-hint`; the change takes effect on the next Host start.

When the selected mode includes the `subagent` tool, the model can delegate independent work to internal child runs. Each child runs in the same Host process with its own persistent Session record. A parent can run three children at once by default; `[loop].maxConcurrentSubagents` can set this limit from 1 to 8 when the Session is created. Children cannot create further children. They inherit the parent Provider, Permission, and Policy decision chain. A child mode can only narrow the parent's tool set, and model-call, output, thinking, and loop budgets cannot exceed the parent limits. Independent tool calls run concurrently up to the project `[loop].maxParallelTools` limit, which defaults to 4 and ranges from 1 to 32; child runs inherit this limit. This tool limit can constrain child concurrency further. When an output schema is requested, the child must submit a value that passes validation; invalid submissions can be corrected within the existing iteration budget. A child that ends without a valid submission fails, while its Session record and completed tool side effects remain. Use `/sub <seq>` in the TUI or the subtask list in Desktop to inspect child records; Markdown export includes them. Failed or cancelled children still retain an inspectable Session reference.

Project `[loop]` can set `totalModelCalls`, `taskTimeoutMs`, `requestTimeoutMs` and `interactionWaitTimeoutMs` for a shared task budget (defaults: `modelCalls`, 30 minutes, 2 minutes and 12 hours). Parent runs, internal subagents and automatic compaction share the budget. The execution deadline pauses only while all work is blocked on approval or user input. Pending interactions consume a separate cumulative wall-clock allowance, including when other work continues; overlapping waits count once. A delegated run can only tighten the limits with `delegation.budget`; execution is capped at 24 hours, one model request at one hour, and interaction waiting at seven days. Client wait timeouts do not cancel tasks. Failed runs retain confirmed usage and partial text when available.

When a provider reports usage, the Session retains available input, output and cache-token fields with their original field names. Missing or invalid counts remain unknown. Chat Completions cache hits and misses are recorded without inferring a provider from a compatible endpoint. For Messages responses, the input total is recorded only when the uncached, cache-read and cache-creation counts are all known. Daily account billing totals cannot be attributed to a single run from these records alone.

The `full` mode provides `present` for up to 16 existing workspace-relative regular files. It verifies both workspace and file boundaries and records each file's media type, byte count, SHA-256 and optional description. The per-file limit is 20 MiB and the per-call total is 64 MiB. Results include file artifacts alongside the Session reference, even when a later model request fails. No copy is made: source files changed or deleted later cannot be reconstructed from the digest.

Images referenced by Session history, or whose source Session still exists, remain readable beyond 30 days. Only expired unreferenced images whose source Session no longer exists are eligible for explicit bounded cleanup; the 256 MiB workspace storage quota still applies.

File deliveries appear in CLI output, the TUI transcript, and Desktop result cards. The Desktop card can check the recorded SHA-256 against the current file, preview up to 8 KiB of safe text or a resized static image, copy the relative path, and explicitly reveal an available file in its folder. Unsupported formats expose metadata only; HTML, SVG, scripts, and executables are never rendered as active application pages. Host `artifact.list` can page by Session or `runId`; `artifact.inspect`, `artifact.preview`, and trusted-native `artifact.resolve` require a registered `artifactKey`. File states distinguish `available`, `modified`, `missing`, and `denied` (and unsupported previews). A file that changed after delivery is not silently replaced in the record.

Use `ligule storage inspect` for bounded recursive Workspace usage (up to 1,000 entries and 16 directory levels per category; incomplete scans are flagged). In an interactive, trusted terminal, `ligule storage cleanup` pages through Session references (at most 100 records/16 MiB per page, with a cursor valid only in this Host), previews at most 100 candidates, and requires typing `delete`. Candidates include expired, unreferenced screenshots and Ligule v1 owner-marked browser residue or registered cache/tmp derivatives older than 30 days without an active lease. No disk cache is created merely to populate these categories. Unknown legacy directories, live browser leases, browser directories with an existing source Session, Session records, result sidecars, and delivered source files remain protected. Apply rechecks file identities and Session references; a multi-page history changed during scanning requires a fresh preview, and incomplete proof never authorizes deletion. `LIGULE_HOME` still chooses the shared user-data root.

### Approvals and settings

Desktop Settings has eight sections: General, Model services, Permissions and security, Tools and plugins, Agent Control, Notifications, Keyboard shortcuts, and About. General combines language, workspace, color palette, and display preferences. Permissions and security manages the default Policy, approval rules, workspace trust, isolation status, and the active session's permission profile and network access. The composer's permission popover only changes the profile and its confirmations; network, isolation details, and project trust live in that settings section.

Tools and plugins lets you inspect a Mode and its tools, all registered tools, MCP servers, extensions, and Skills. Selecting a Mode changes only the catalog being viewed; it does not change the active conversation. Use the composer's tool menu to change a session Mode. Selecting the workspace and Grant to inspect or use as a new-grant draft changes only the page selection or draft target; it does not change a running external session. Creating and revoking Grants remain explicit actions. Observe, answer, message, or take over an external session from that session's view. Model settings edit defaults or project configuration and do not replace the model selected by a running session.

The default approval mode asks before each tool call. In the terminal UI, press `y` to allow a requested call or `n` to refuse it. In the desktop app, use the Allow or Refuse buttons on the approval card. Large file changes show their byte count, SHA-256, and a short preview; expand the card to retrieve and inspect the full pending content before deciding. Hard denials, unavailable approval channels, timeouts, and cancellation have distinct results; they are not presented as a user refusal. Only a trusted user's explicit refusal is recorded as one.

There are four modes: `always`, `ask`, `auto`, and `never`. In the terminal UI, use `/policy always|ask|auto|never`, or `/policy reset` to restore the configured default; the desktop menu beside the composer offers the same four. `always` sends every tool call through deny rules and then waits for its own approval, so remembered approvals and allow rules never skip the prompt. `ask` consults the rule table first and waits for a trusted decision when no rule applies. `auto` lets the rule table, guards, and the command parser decide and still asks about uncertain calls. `never` skips the whole policy layer: allow/ask/deny rules no longer take part and approvals never appear, while workspace boundaries, interactive-channel limits, script binding, hard denials, permission isolation, and grant ceilings stay active. A legacy `none` or legacy `never` in configuration and session records is read as `ask`; only records written by this version with the semantics marker are treated as the new `never`, and historical events keep their recorded value. The tool and approval menus beside the desktop composer can change the current session; before sending the first message in a new conversation, you can also choose its tool mode and approval mode. Choosing “Never ask” opens a confirmation first. “Approval rules” in Settings can save the default mode to user or project-local configuration. A one-time allow is not saved; a remembered rule can be scoped to the session, project, or user, and project rules take precedence over user rules. Remembered file approvals default to the exact file; choosing a workspace scope is a separate explicit choice and remains limited to that operation type. Saved approval modes and rules affect the next decision immediately.

A user configuration or command line may enable a reviewer with a `[reviewer]` table. It is off by default and only runs under `auto`, when the deterministic policy cannot recognise the shape of the command: one read-only model call then decides about that single call, using the model of the running round. The reviewer has no model or endpoint of its own: it follows the service and credential the session already selected, and the model changes only at the round boundaries the host already defines, so one configuration cannot send a saved key anywhere else. The keys are `enabled` (must be the boolean `true`) and the budgets `maxInputTokens` (default 2000), `maxOutputTokens` (default 400), `timeoutMs` (default 20000), `maxPerRun` (default 8) and `maxTotalTokens` (default 40000); a project configuration can only tighten the budgets, never enable the reviewer. The old `model`, `baseURL`, `api` and `apiKeyEnv` keys were removed and now fail session creation with `reviewer_route_removed` instead of taking effect silently. The reviewer may only answer `allow`, `deny` or `ask-human`: `deny` and `ask-human` both stop the call, and a timeout, an exhausted budget, a failed request or an unusable reply always falls back to asking a human, never to an approval. Deny rules, rules that ask, hard denials, forced manual approval, private networks and external access are never handed to the model. Each decision, its reason code and its duration are recorded as a `policyReview` event in the session JSONL (marked skippable, never part of the model context). Without a `[reviewer]` table, or with `enabled` not true, `auto` behaves exactly as before. The reviewer takes its evidence from the raw session events only, never from summaries or tool output: the constraints that are still in force, the limits that were tightened or revoked (a narrowed permission, a new deny rule, an inactive grant) and a few related executions each carry the sequence number of their event, and the `policyReview` event records those numbers so a decision can be traced back to the record behind it. When the constraints alone do not fit the input budget the call goes to a human instead of trimming them. A reply only counts when it ended with a normal finish (`finish.stop`): a reply cut short (`length`, `max_tokens`), aborted by a tool call, or a stream that simply ends is always sent to a human, and that request's usage is still recorded. The reply must be exactly one JSON object: a reply that merely contains one among prose is invalid, and so are repeated keys, unknown fields and values outside the documented set — all of them go to a human. If the approval mode or the rules change while the reviewer is thinking, that verdict is discarded and the decision falls back to the deterministic path, and the budget is reserved as input estimate plus maximum output before the request leaves, so parallel reviews cannot both see the same headroom.

The terminal UI shows this session's token usage with `/usage`, with the main agent and the reviewer kept apart. Cached tokens are a subset of the input and are never added to it again; an input or output the endpoint did not report stays unknown rather than being counted as zero. When the session has review records, `/usage` also shows the last verdict with its reason code and evidence count; without a review it says nothing. The desktop app and external control read the same aggregate through the host's `usage.get`, so no surface has to recompute it.

Permission controls the operating-system resources a session can access. Policy separately decides whether an allowed operation needs approval or must be refused. In the TUI, enter `/permission`; in Desktop, open the permissions menu beside the composer to view or change the current session's Permission. For a new conversation, choose its file/command profile and network mode before sending the first message. `read-only` denies file-tool writes; `workspace-write` allows file tools to write within the configured path boundary; `full-access` relaxes operating-system isolation for commands and requires a second confirmation. Built-in file tools remain subject to their path boundary. Network access is configured separately as `policy`, `disabled`, or `unrestricted`; unrestricted access also requires confirmation. When a new conversation starts, the Host applies the selected profile; confirmed increases are validated and recorded with their trusted-UI source. Permission status reports platform file-read, file-write, network, and process isolation capabilities, along with whether Shell is available.

Node/Python scripts are never automatically allowed. Per-call approval shows the script path, SHA-256, interpreter, workspace, and Permission; the Host refuses execution if any of them changes while approval is pending. Shell scripts, wrappers, compound commands, or dynamic commands that cannot be bound safely are refused. Git commands require a trusted workspace and per-call approval because repository configuration can run hooks, helpers, or aliases. Legacy session records remain readable but cannot change Permission or Policy; create a new session to adjust those settings.

Revoking workspace trust immediately stops managed servers started from that trusted workspace in the local Host. Other Hosts periodically check the shared trust record and stop those processes when trust is revoked. Project-code commands also recheck trust before execution.

Use `/control create` in the TUI or Settings → Agent Control in Desktop to create an Agent Control Grant for one project. A Grant sets default and maximum Permission and network access, allowed Policies, expiry, and whether ordinary Operator actions are allowed. Full access and unrestricted networking require separate confirmations. Start the MCP server with `--grant <id>` to use the Grant; `--operator` can answer ordinary approvals or change session settings within the Grant only when it allows those actions. Revoked or expired grants block further control; they do not bypass OS sandbox limits or hard Policy denials.

When you switch Desktop to a session controlled by an external Agent, the bottom composer becomes an external-session input. It shows the current model, tool mode, Policy, Permission, and the Grant defaults and ceilings. Messages sent there are routed to the corresponding external session.

Shell runs only when the platform backend can meet the isolation requirements of the selected profile; it is denied when those capabilities are insufficient or the sandbox is unavailable. Linux currently uses bubblewrap; see the live capability status because filesystem isolation is reported as `partial`. Windows uses a per-run `WRITE_RESTRICTED` token for `workspace-write`, reported as `partial`; it requires explicit project trust, confirmation of the limits, and `unrestricted` network access. Windows cannot restrict command reads or network access, and existing hard links, writable ancestor `FILE_DELETE_CHILD` permissions, or concurrent ACL changes can cross the workspace boundary. It is not a container for hostile native code. Windows `read-only` uses AppContainer only when a live probe confirms the selected Shell can enter the actual workspace; otherwise Shell is unavailable in that profile. When available, AppContainer blocks workspace writes and Shell networking but may still read public operating-system files. macOS currently has no supported process-ownership or operating-system sandbox backend, so Shell is unavailable under all profiles. Under `full-access`, Shell runs with the current operating-system user's permissions and requires `unrestricted` network access and available process management. This profile does not bypass Policy denial rules or hard denials for dangerous operations. Loaded extensions are trusted code; direct operating-system access from an extension does not pass through Host Policy. Close extensions and restart Host before lowering permissions.

When saving model settings, choose the user or project-local configuration layer. Running sessions apply model configuration changes after the current turn. Higher-priority configuration still takes precedence. If you leave a settings page with unsaved changes, the app asks whether to discard them. The About page provides the application version, help, license information, and diagnostics.

The user or project configuration key `limits.execTimeoutMs` sets the maximum duration of one Shell command. It defaults to 120,000 ms and accepts values from 1 to 600,000 ms (10 minutes). This is separate from the per-request model timeout; Shell commands continue to use the selected Permission, Policy, and process-cleanup rules.

### Branches and export

In the terminal UI, use `/branch` to branch from the current record or `/branch <seq>` to branch from a completed turn. In the desktop app, choose “Branch conversation” from the conversation menu to copy the current record, or use the branch action on a completed turn in the transcript. A branch creates a new session and leaves the original unchanged.

Use `/export <path>` in the terminal UI to export the current session and its subtasks as Markdown. In the desktop app, choose “Export Markdown” from the conversation menu and select a save location. The app reports the result for each file. Existing subtask files are not overwritten; the main session is written to the selected path.

In the terminal UI, press Ctrl+O to browse the full history, use `/show <seq>` to view one complete record, and `/sub <seq>` to view a subtask record. In the desktop app, expand records in the transcript or open the subtask list from the conversation menu.

### Recovery and cancellation

Cancel a running turn by pressing Esc in the terminal UI or the Stop button in the desktop app. The interface marks turns as completed, cancelled, failed, or interrupted.

When the desktop app shows a connection banner, select “Reconnect” to restart the backend and reopen the current session. Unanswered approvals and questions are voided; **once the session writer lock has been reclaimed**, queued messages move back to the draft for explicit submission. Ordinary session switches and resumes keep queued messages paused without sending them automatically. If another Host still holds the writer lock, Desktop opens a read-only observation; you can view progress and reopen the session after the lock clears. After leaving the terminal UI, use `/resume <id> [mode]` to continue a session.

`tool_outcome_unknown` means a tool call may or may not have completed when its process exited unexpectedly. Check the file or external state before deciding whether to repeat the action. `session_locked` means another process still holds the session; close that process before resuming. After leaving the terminal UI, first run `ligule`, then enter `/resume <id or unique prefix>`. You can also run `ligule resume <id> "<message to send>"` from the command line. `host_model_config_missing` means the model service configuration is incomplete; check the model fields in `~/.ligule/config.toml` or fill them in under desktop “Model services”. `provider_credential_missing` means the environment variable or system credential store does not contain the key. `credential_store_unavailable` means the system credential store could not be used; on Linux, check Secret Service.

### Language, appearance, and shortcuts

In Desktop Settings under General, choose Follow system, 简体中文, or English, and adjust the palette, font size, sidebar width, and panel position. The six palettes are Ink, Parchment, Sky, Graphite, Forest, and Dusk. Set the CLI and terminal UI language with `--lang zh`, `--lang zh-CN`, `--lang en`, or `--lang auto`; `zh-CN` and `zh` both select Simplified Chinese.

Common terminal UI shortcuts: Enter sends; Shift+Enter or Ctrl+N inserts a new line; Esc cancels the turn; Ctrl+C exits; Ctrl+O browses history; Ctrl+R searches input history; Ctrl+G opens the draft in an external editor; Ctrl+Z and Ctrl+Y undo or redo draft edits. Ctrl+P selects a model, Ctrl+T selects a tool mode, and Ctrl+A selects an approval mode. Panel hints show the active bindings. Use `/bind` to view or change shortcuts. Normal exit saves drafts and queues; restored queues remain paused, and `/quit` is not restored as a draft.

`/help` opens a categorized panel in place of the ordinary composer without writing help into the session transcript. Left and Right switch between commands, keys, and prompt templates. Up, Down, PageUp, and PageDown browse the content; Esc closes the panel and returns to the draft. Choice lists also use Up, Down, Enter, and Esc. All these bindings can be changed with `/bind`.

Terminal colors follow the current palette. Set a nonempty `NO_COLOR` to disable colors; an explicit `FORCE_COLOR` takes priority.

Common desktop shortcuts: Ctrl+K opens the command palette; Ctrl+B hides or shows the sidebar; Ctrl+Shift+C copies the latest answer; Enter or Ctrl+Enter sends; Shift+Enter inserts a new line. Esc closes an open panel first, then cancels a running turn. View or change shortcuts under “Keyboard shortcuts” in Settings.

The desktop app provides five kinds of system notifications: a question needs an answer, an action needs approval, a turn completes, a turn fails, or the connection is interrupted. In Settings under Notifications, enable or disable all notifications and each kind separately. Clicking a notification opens its conversation. App permission and system notification settings affect delivery. Notifications show the conversation name and status without prompts, tool commands, or keys. Native notification clicks across all target platforms are outside the verified support scope.

When the tray is available, closing the window hides it while background sessions continue. The tray menu follows the interface language: “打开 ligule” / “Open ligule” restores the window, and “退出 ligule” / “Quit ligule” lists affected sessions and asks whether to interrupt work before quitting. If the tray is unavailable, closing the window asks for confirmation before quitting.

### Local MCP and permissions

`mcp.servers.<name>` supports stdio servers: `command` names one executable, `args` is an argument array, and `cwd` is an optional working directory. Values in `env` must use `${ENVIRONMENT_VARIABLE}` references. Servers start on demand. The model reads a tool definition and digest through `mcp.inspect`, then submits JSON arguments matching that definition through `mcp.call`. Changed definitions require disclosure again.

`/mcp add <name> <executable> [args…]` and `/mcp remove <name>` in the TUI, and the server form on the Desktop settings tools page, write configuration into the user defaults layer; add environment references and a working directory in the config file. Writes and removals only touch the user defaults layer — other layers and trust records are unaffected.

Use `/mcp list` in the TUI to inspect configured servers and trust status. `/mcp trust <server> <session|project|user>` shows the program, arguments, working directory, and environment variable names; review them and confirm with `/mcp confirm`. Use `/mcp tools <server>` to inspect its tools and `/mcp revoke <server> <scope>` to revoke trust at that scope. The MCP pages in Desktop Settings also edit server configuration, show launch details, and let you trust or revoke at session, project, or user scope. Trust is bound to the server configuration digest; changes require trust again. Trust only allows Ligule to start the local program; it does not approve tool calls.

MCP calls enter Host Policy as `mcp:<server>/<tool>`. A configured server runs as an external process. The file tools' `boundary` does not provide an operating system sandbox for that process or restrict arbitrary server resources. Configure trusted servers and control their access with server-specific directory restrictions, operating system isolation, and Policy. File tool boundaries do not define external process permissions.

Cancelling a turn cancels the pending MCP request; check any side effects already produced by the server. Unexpected disconnection fails the call without automatic reconnection or replay. Check the external state, reconnect the desktop Host or restart the terminal UI, and disclose the tools again. A Skill's MCP dependency check only verifies that the server is configured; it does not establish connectivity or grant permission to call its tools.

### Managed browser

Ligule launches Playwright MCP as the managed MCP server `ligule-browser`. Browser settings are accepted only from the user, command-line flag, or managed configuration layer under `[browser]`; project and directory configuration cannot choose the browser executable. Both paths in this example must be absolute:

```toml
[browser]
provider = "playwright-mcp"
entryPoint = "/absolute/path/to/node_modules/@playwright/mcp/cli.js"
executablePath = "/absolute/path/to/chromium"
```

`entryPoint` must point to `cli.js` from the supported `@playwright/mcp` version **0.0.83**. `executablePath` names the Chromium executable. Ligule starts it headless and isolated; each Session and derived child task uses its own browser context and storage directory. The browser process is outside Ligule's OS network sandbox, so it can reach networks available to that operating-system process.

The current Session must have `full-access` Permission, `unrestricted` networking, and full process-management capability reported by the platform. Browser operations are refused when networking is `policy` or `disabled`. The `ligule-browser` MCP server must also be trusted in a trusted interface for its exact configuration digest. An external Agent's Grant must allow that server and each exact MCP tool it calls. Trust and Grants do not bypass Policy.

The browser exposes only `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_wait_for`, `browser_take_screenshot`, `browser_close`, and `browser_handle_dialog`. Navigation accepts only HTTP(S) URLs without embedded usernames or passwords. Screenshots return the current viewport only. The interface rejects `filename`, full-page or element screenshot parameters, and capabilities such as script evaluation, file upload, extension installation, and viewport resizing.

In the TUI, `/browser` shows configuration, availability, Permission, paused state, and MCP connection state. `/browser stop` pauses the browser and terminates its processes for the current Session and derived tasks. `/browser resume` only clears the pause; it does not launch an instance. Stop is available while a turn is running. An externally controlled read-only Session cannot use either action locally; take over or close that external Session first. Desktop's Browser Stop has the same Session scope. A human stop, turn cancellation, Session close, or revocation of effective MCP trust terminates the corresponding browser process. After resume, the next browser tool call connects it when needed.

### Common errors

- `tui_terminal_required`: Run `ligule` in an interactive terminal; use `ligule run` in a script.
- `tui_dependency_missing`: Some optional terminal UI dependencies are missing. Check that npm installed optional dependencies.
- `data_root_invalid`: `LIGULE_HOME` must be an absolute path. Without it, ligule uses `~/.ligule`.
- `provider_model_required` or `provider_base_url_required`: Check the service URL, API type, and model name.
- `resume_mode_changed`: Resume with the mode the session used, or run `/resume <id> <mode>` in the terminal UI.
- `delete_target_is_link`: The delete tool refuses a final symbolic link or junction and leaves its target unchanged. Name the actual target explicitly if you intend to move it into the trash.
- `recycle_backend_missing`: This platform has no usable system recycle bin; the source remains in place.
- `recycle_backend_failed`: The system recycle bin failed, and the target object's identity and top-level metadata still match the pre-operation snapshot. File contents and directory descendants are not checked; inspect them and the system trash before retrying.
- `delete_outcome_unknown`: The backend reported an error and Ligule could not confirm a match with the target object's pre-operation identity and top-level metadata; inspect the workspace and system trash before retrying.
- `delete_target_changed`: The target changed while it was being checked; inspect it before retrying.
- `trash_legacy_config_unsupported`: Remove the old `trashBackend` and `limits.trashDirectory` fields from user/project configuration.
- Run `ligule --help` for command-line help or `/help` in the terminal UI for its commands and shortcuts.
