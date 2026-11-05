# Agent Control via MCP

The Ligule CLI can start a local MCP server over standard input and output. An external MCP client can use it to create or reopen sessions, submit work, check run status, read records, and cancel a run through the existing Host.

## Start

Use Node.js 24 or newer and install the Ligule CLI:

```sh
npm install -g ligule
```

First enter the target project directory, run `ligule` interactively, confirm workspace trust, and exit. The MCP server must use the same operating system user and `LIGULE_HOME` to read that trust record. It checks trust before reading project configuration and exits with `control_project_untrusted` for an untrusted project. It does not prompt over stdio or expose an MCP tool to grant trust. Workspace trust does not approve tool actions; existing Policy and approval denial rules still apply.

Configure your MCP client to start `ligule` as a stdio child process and provide an absolute project directory:

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

For example, on Windows:

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

Each MCP server process authorizes only the project supplied at startup. Use MCP `tools/list` to discover all fifteen tools and their input schemas:

- `ligule_session_create`: create a session in the authorized project.
- `ligule_session_open`: reopen an existing session. A session returned by the list tool must be opened before it can be used for a run or record read.
- `ligule_session_close`: release an idle session with an empty queue and no pending interactions. Busy sessions return `control_session_busy`; cancel the run, wait for it to stop, and explicitly clear its queue before retrying. Closing releases the controller's session slot and record lock while preserving history and completed operation queries (bounded to the current process's latest 256 operations). A failed close keeps the session unavailable for new work until cleanup is retried. Human takeover also releases the slot; the previous controller cannot reclaim that session.
- `ligule_session_list`: list a bounded number of sessions in the authorized project.
- `ligule_session_configure`: read effective/pending session settings and available choices; operator mode can change session-owned settings.
- `ligule_interaction_reply`: answer one real pending approval or question, bound to its session and request ID.
- `ligule_session_send`: start a round when idle, queue the next message while running, or continue and manage the queue.
- `ligule_run_start`: durably accept a task and return its persistent `runId` receipt with a process-local `operationId`.
- `ligule_run`: start a task and wait for a terminal result; a wait timeout returns the current state without cancelling the run.
- `ligule_run_get`: read a persistent run receipt by `runId` or `requestKey` after a restart or Session close; optionally page through a verified terminal result.
- `ligule_run_status`: check whether the process-local operation is running, done, failed, or cancelled.
- `ligule_run_await`: wait for a known `operationId`; a timeout also leaves the run active.
- `ligule_session_read`: read a page of session records.
- `ligule_usage_get`: read token usage for a session this controller owns, split into the agent and reviewer accounts. (Every figure is a partial sum of what endpoints reported: `requests` counts every request, requests that reported nothing are counted in `unknownInputRequests`/`unknownOutputRequests`, and a bucket is complete only when both are 0.)
- `ligule_run_cancel`: cancel the run identified by its `operationId`.

Recommended flow: create or reopen a session and read `ligule_session_configure` before starting or continuing work. Use `ligule_run` when the caller should wait for a bounded time, or `ligule_run_start` to return immediately. Then use `ligule_run_await` to wait for a known operation or `ligule_run_status` to poll it. Neither wait timeout cancels the run. Use `phase`, `waitingFor`, and `pendingInteractions` to decide whether to keep waiting or review and reply. Read new records with `ligule_session_read` after completion. MCP logging notifications are best-effort; polling exposes the same state when notifications are unavailable. Call `ligule_run_cancel` to stop a run. The running server's `tools/list` schemas define the arguments. After a restart, use `ligule_run_get` directly with the existing `sessionId` and `runId` (or `requestKey`); it does not require `ligule_session_open` and does not acquire the Session writer lock.

## Operator authorization and session settings

The default startup does not grant operator authority. In this mode, ordinary approval requests and user questions wait for the local Desktop/TUI user. Host registers `ask_user_question` for the local interface, while MCP clients cannot reply directly. Settings can be read; settings changes and MCP interaction replies fail with `control_operator_required`. Add `--operator` explicitly to the local MCP client configuration to enable MCP replies and session settings:

```json
{"command":"ligule","args":["mcp-server","--project","/absolute/path/to/project","--operator"]}
```

`--operator` means the local operator explicitly authorizes this stdio client. It permits answering real pending Policy decisions and user questions, and changing one session's mode, Policy, model, generation settings, and per-turn loop limit. It does not change workspace trust, file boundaries, or hard denials. The selectable Policy modes are `always`, `ask`, `auto`, and `never`; `never` skips the whole policy layer but keeps hard safety checks, and a legacy `none` or legacy `never` is read as `ask`. An approval cannot override invalid tool input or workspace boundaries. Pending interactions in `ligule_run_status` contain a bounded summary, not a duplicate of full tool arguments. The trusted local TUI or Desktop can expand the pending details while the request remains active. If Host cannot review a request safely, it returns an explicit unavailable/error code instead of recording a human refusal.

Every pending reply is bound to its original session and `requestId`. The `source` field in status and events distinguishes a local TUI/Desktop user (`human`) from the MCP operator (`controller`). An explicit approval from either clears denial counters and releases forced per-call approval; only a `human` reply can save approval memory. After the operation ends, the client disconnects, or the request becomes invalid, a late reply returns `control_interaction_stale` and is not recorded as a user refusal.

## Delegated runs and structured results

`ligule_run` and `ligule_run_start` accept an optional `delegation` object. Its `mode` may select a named or inline mode, but can only narrow the current session's tools and prompt fragments; it cannot expand the session, Permission, Policy, or Grant ceiling. `outputSchema` can require a structured result matching a supported JSON Schema. The model must submit it with `ligule_delegation_result`; the run is valid only after that value passes validation. An invalid submission can be corrected within the run's existing iteration budget. If the run ends with ordinary text and no valid submission, it fails with diagnostic `delegation_result_missing`; the result has `state: failed`, `stopReason: validation_failed`, and `validation.status: invalid`. The Session turn is recorded as failed before a success terminal record can be written. Earlier tool side effects and Session records remain; they are not rolled back or replayed. Cancellation and provider failures retain their own result reasons. Without `outputSchema`, ordinary run completion is unchanged. This contract applies to one run and does not create a session or edit project configuration. The internal `subagent` tool is a model-callable child run and is separate from one MCP-controlled run.

### Task limits and file deliveries

`delegation.budget` optionally tightens `maxModelCalls`, `timeoutMs` (execution deadline), `requestTimeoutMs` (one logical provider request) and `interactionWaitTimeoutMs` (cumulative pending interaction time). Project `[loop]` settings `totalModelCalls`, `taskTimeoutMs`, `requestTimeoutMs` and `interactionWaitTimeoutMs` set their ceilings; defaults are the configured `modelCalls`, 30 minutes, 2 minutes and 12 hours. Execution pauses only while all work is blocked on approval or user input. Pending interactions consume the independent waiting allowance even when other work is active, with overlapping waits counted once. Execution is capped at 24 hours, a request at one hour and interaction waiting at seven days. The shared budget covers the parent and internal subagents. Transport retries within one provider stream are not separate logical calls.

Task snapshots expose `executionElapsedMs`, `executionPaused`, `interactionWaitMs` and `interactionWaitTimeoutMs`. `deadlineAt` is the projected execution deadline at the time of the snapshot and moves forward while execution is paused; it is not a fixed wall-clock deadline.

Budget exhaustion, execution deadline, request timeout and interaction waiting timeout use `task_model_budget_exhausted`, `task_deadline_exceeded`, `task_request_timeout` and `task_interaction_timeout`, with respective `stopReason` values `budget_exhausted`, `deadline_exceeded`, `request_timeout` and `interaction_timeout`. A wait timeout from `ligule_run_await` does not cancel the task. `ligule_session_configure` shows `effective.taskLimits`, while `status.get` exposes the current or latest task snapshot. Run results report confirmed `usage`, `task` and `userSeq` when known, including failed runs; interrupted nonempty text is marked `output.partial: true`.

The `full` tool mode exposes `present({files: [{path, description?}]})`, accepting up to 16 existing workspace-relative regular files. Each file is checked against workspace and filesystem boundaries and recorded with its relative path, media type, byte count, SHA-256, description and owning Session. A file is limited to 20 MiB, and one call to 64 MiB. Successful run results may include `kind: file` entries in `artifacts` alongside Session references; failed runs retain artifacts already confirmed. This is a metadata snapshot, not a copied file or permanent download. Later file edits or deletion are not reversed.

### Durable receipts and request retries

`ligule_run` and `ligule_run_start` accept an optional `requestKey` of 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`. Generate a fresh key per logical task and retain it when retrying after a lost response. Within the same workspace, Session and authorized caller scope, the same key and the same input/delegation parameters reuse the original `runId`; a changed payload returns `run_request_conflict`. Changes to later default settings do not change the recorded request identity. Omit the key to start a new run on each call. Keys do not grant access to another Session or caller's result, and do not expire while their acceptance record remains.

The Host syncs the Session user event before it acknowledges acceptance. `runId` persists across controller restarts; `operationId` is only for status, waiting, and cancellation in the current process. `ligule_run_get` reads an existing Session in the authorized project without opening its writer; Host checks project ownership, the active Grant, and the caller's visible run scope. It needs the `sessionId` plus exactly one of `runId` or `requestKey`; without an `offset` it returns the receipt, and with `offset` it also returns up to 8,192 UTF-16 characters of verified terminal-result JSON, with `nextOffset` for continuation. The complete result sidecar is limited to 16 MiB and follows the Session record directory, including a configured session-directory override. A missing or changed result file reports `run_result_unavailable`.

A read-only receipt query never reopens a writer or executes a model. A persisted `accepted` receipt whose former owner is unavailable has unknown liveness; only writable Session recovery may mark it `interrupted`. Interrupted runs and requests with the same key are never replayed automatically. Existing sessions and callers without a key remain supported. The in-memory message queue and pending approvals do not survive a process restart.

## Agent Control project grants

To let an MCP session use a bounded Permission, create a project-bound Grant in the trusted TUI with `/control create`, or in Desktop under Settings → Agent Control. A Grant stores the default Permission, its maximum, default and maximum network access, allowed Policies, whether ordinary Operator actions are allowed, and an expiry. `full-access` and unrestricted networking require separate confirmations in the creating interface. A Grant applies only to its bound project; it is not remote-client authentication and does not override OS sandbox limits or hard Policy denials.

Start the MCP server with the Grant:

```json
{"command":"ligule","args":["mcp-server","--project","/absolute/path/to/project","--grant","GRANT_ID","--operator"]}
```

MCP verifies that the project path matches the Grant and applies its default Permission, network, and Policy to new sessions. `--operator` is accepted with a Grant only when that Grant allows ordinary Operator actions; then MCP can change session settings within the Grant's ceilings and answer real pending approvals or questions. Without a Grant, `--operator` alone does not grant or raise Permission. With a Grant but without `--operator`, MCP uses the Grant defaults and cannot change those settings. The Host keeps checking revocation, expiry, and project binding; an invalid Grant blocks further control and releases session locks.

When trusted TUI/Desktop takes over an externally controlled session, it first cancels the active operation, clears queued messages that have not been sent, and releases the Host session lock before returning the session to the local user. Completed tool side effects are not replayed or undone, and an old process's `operationId` cannot be recovered after restart.

Create a session with `initial` in `ligule_session_create` to set `mode`, `policy`, `model`, `thinking`, `outputTokens`, and `loopIterations` together. Use `changes` in `ligule_session_configure` for an existing session. A change call may update only one category: mode, Policy, generation settings, or the loop limit. The generation category can update model, thinking effort, and output budget together. `loopIterations` is the positive safe-integer cap on model/tool iterations for each user turn. It defaults to the project `[loop].iterations` value, or 64 when that is unset. The project `[loop].maxParallelTools` setting caps concurrently executing independent tool calls; it ranges from 1 to 32 and defaults to 4. Internal subagents inherit the parent cap. These are project settings, not per-session overrides. A session override does not edit project configuration; it is stored in Session JSONL and restored when the session is reopened. `loop.modelCalls` remains controlled by project configuration and is independent of `loopIterations`. The schema rejects mixed categories so an invalid request cannot partially apply. Current-format records store and restore Mode, Policy overrides, Policy denial counters and forced-approval state, and model/generation settings. Generation and loop-limit changes made during a run take effect at the next round; Policy changes affect later tool decisions and do not resolve an approval already waiting for a reply. Legacy session records remain readable but cannot change Permission or Policy. `applies` reports the timing.

Node/Python script calls require per-call approval. Their `approval.request` includes the canonical script path, SHA-256, interpreter, workspace, and Permission; Operators should show these details to the operator. If the source or execution identity changes while approval is pending, the Host refuses execution with `exec_script_binding_changed`. Script forms, wrappers, compound interpreter calls, and dynamic commands that cannot be bound safely fail closed; Operator replies cannot bypass this restriction.

Available models and services come from the loaded Host configuration. `thinking` only lists verified model capabilities; currently `none/low/high/max` is supported only for listed models at the official DeepSeek Chat Completions endpoint. Compatibility gateways do not inherit this capability. `effective.generation.outputTokens` is the current request budget; `maxOutputTokens` is the resolved model/provider ceiling, and `contextTokens` is reported separately. For example, the verified DeepSeek Flash ceiling is 393,216 tokens; unknown compatible endpoints retain their conservative default. Output tokens must fit the provider ceiling and context window; otherwise the Host returns a stable error code. Set model, thinking, or output-token overrides to `null` to clear that session override.

## Run phases and message queue

`ligule_run_status` retains the compatible `running/done/failed/cancelled` state values and returns phase, wait type, progress, pending interactions, and bounded events. Each operation retains its latest 128 events; use the `after` cursor for incremental reads, with up to 50 events per call. If the event cache has moved past a cursor, `eventGap` indicates that the client should resynchronize from current state. A run waiting for approval or a question remains `running`.

Branch on `state`, not on `phase`: `phase` is only the last progress stage and can still read `settling` after a run failed. `ligule_run_await` and `ligule_run_status` return the same status object, and polling can stop once `state` becomes `done`, `failed`, or `cancelled`; a timeout still returns a resumable `running`.

`ligule_session_send` holds at most 16 next-round messages, each up to 65,536 characters. An idle session starts a run immediately and returns its `operationId`; messages sent while running queue in arrival order. A successful run starts the next queued message automatically and publishes `queue.started` with the new `operationId` on the source operation's event stream, so the new run remains discoverable even if it finishes quickly. Cancellation or failure, including a missing valid delegated result, pauses the queue until `continue`; use `cancel_queued` to remove one item or `clear_queue` to remove all remaining items. The queue is process-local, is not restored after restart, and does not replay uncertain side effects. While an approval or question is pending, a queued message does not answer it.

Successful results provide both `structuredContent` and JSON text in `content`. A tool execution failure returns `isError: true`; parse the JSON `code` from the text `content`, such as `session_locked` or `operation_not_found`. Failed results omit the success-shaped `structuredContent`. Unknown tools and arguments that violate the schema return MCP protocol errors. Run status contains only fixed summaries and error codes; read session records for model text and tool results.

`ligule_session_read` returns the newest page by default, with records in chronological order within that page. Use the response's `nextBefore` as `before` to read earlier pages. `ligule_usage_get` returns `summary.agent` and `summary.reviewer`, each with `requests`, `input`, `output`, `cachedInput`, `uncachedInput`, `estimatedInput`, `unknownInputRequests` and `unknownOutputRequests`. `input` is what the endpoint reported and `cachedInput` is its cached share (they are never added together); a missing count stays `null` or is counted in `unknown*` rather than becoming zero. The call is read-only and only serves sessions owned by this controller.

A call returns at most 50 records. Each `json` value is a fragment of the Host record's JSON text, capped at 8,192 UTF-16 characters. While a response has not been committed to the Session record, the result may also include a separate `provisionalOutput` snapshot marked `provisional: true`. It contains `responseId`, nullable `userSeq`, `updatedAt`, `text`, `reasoning`, `textCharacters`, `reasoningCharacters`, and `truncated`. It is not an assistant record or model input. A matching persisted assistant `responseId` suppresses a leftover snapshot. A corrupt or oversized snapshot is reported as `provisionalOutputError: session_stream_invalid`; persisted records remain readable. The latest snapshot may lag the provider stream, and abrupt process termination can lose the last batch not yet written.

To read a large record in full, use `at` with the event sequence number, then follow `nextOffset` to fetch the rest of that same record:

```json
{
  "sessionId": "SESSION_ID",
  "at": 42,
  "offset": 0
}
```

Concatenate the `json` fragments for the same `seq` in `offset` order. When `nextOffset` is `null`, the record is complete and the concatenated text can be passed to `JSON.parse`. Continue using the same `at`, setting `offset` to the previous response's `nextOffset`. `at` and `before` cannot be supplied together. Finish the current record before using `nextBefore` to move to an earlier page.

## Project and permissions

`--project` requires an absolute path. Session, run, and read operations are restricted to the project authorized at startup. Sessions returned by `ligule_session_list` must be reopened with `ligule_session_open` before use. The project directory identifies session ownership; `boundary` remains a separate limit for paths available to file tools.

The MCP server uses Ligule's existing configuration, model service, tools, and Policy. Without `--operator`, ordinary requests needing human approval wait for the local Desktop/TUI user, and MCP cannot answer them directly. With it, MCP can answer only real pending requests. The server does not expose arbitrary Host RPC or configuration-file writes. It uses local stdio and does not open a network listener. The stdio client and server run with the same operating-system user permissions, so connect only trusted local MCP clients.

Revoking workspace trust immediately stops managed processes started from that trusted workspace in the local Host. Other MCP Hosts recheck the shared trust record once per second and stop those processes when revocation is detected; new project-code commands also recheck trust before execution.

Without a Grant, `--operator` does not grant or elevate session Permission and cannot change operating-system resource boundaries. MCP tool calls always pass through the session's Permission and Policy decisions. Restricted Shell runs only when the platform sandbox meets the required capability levels. Linux bubblewrap reports measured filesystem capabilities. Windows `workspace-write` is `partial`, requires explicit project trust, confirmation of its limits, and `unrestricted` network access; it cannot restrict reads or network and can be crossed through existing hard links, writable ancestor `FILE_DELETE_CHILD` permissions, or concurrent ACL changes. It is not for hostile native code. Windows `read-only` uses AppContainer only when a live probe confirms the selected Shell can enter the actual workspace; otherwise that profile cannot run Shell. When available, it blocks workspace writes and Shell networking but may still read public operating-system files. `full-access` must be confirmed separately in a trusted interactive interface; it does not make Policy hard denials overridable.

Run state and `operationId` values exist only in the current server process; each process retains at most 256 operation records. At capacity, a new run evicts the earliest created operation that has settled. An evicted ID can no longer be queried. If all retained operations are still running, a new run fails with a capacity error. An old `operationId` cannot be recovered after the server exits or restarts. Host persists session records, so a new server can reopen a session and read its history, but it cannot restore a run from the previous process.

One server process can take ownership of at most 64 distinct sessions. Reopening a session already owned by that process does not use another slot. Once the limit is reached, it cannot create or open another session until the server restarts. Idle sessions keep their slot until `ligule_session_close` releases it, or until the server restarts.

When the client disconnects or the server receives a termination signal, it cancels active runs, waits for Host calls to settle, and releases session locks and extension resources. Records already written remain available after restart; disconnect does not resume unfinished runs or preserve their old `operationId` values.

To view MCP sessions in Desktop, Desktop and the MCP server must use the same `LIGULE_HOME` and effective session directory. The Desktop session rail lists sessions from that directory. While the server holds a session lock, the rail entry is visible but Desktop cannot open the same session concurrently. After the client disconnects and the server releases the lock, refresh the rail to open the saved session record. Processes with different data roots or session directories have separate session lists.

Tool calls and session contents are sent to the MCP client. Connect only clients that are allowed to access the project data, and review their logging and retention behavior when needed.
