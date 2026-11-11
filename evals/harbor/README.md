# Harbor adapter

This adapter targets Harbor `0.25.0` and installs the exact Ligule npm tarball supplied through `ligule_tarball`. It subclasses Harbor's `BaseInstalledAgent` and declares `capabilities.atif = true`. The plan's optional `policy_mode` selects the CLI Policy mode; the existing Terminal-Bench plan leaves it unset and retains `never`, while plans that must exercise the normal Policy chain can set `auto`. The adapter runs inside the task environment with `--allow-full-access`; it never reads verifier files or writes task files on the Agent's behalf.

The Node helper is copied into the installed `ligule` package directory after npm installation, never into `/logs/agent` or an unrelated working directory. Installation probes both Core subpath exports from that exact package root and fails if they cannot be resolved. The helper then imports `@ligule/core/session/atif.js`, reads only the trial's explicit `LIGULE_HOME/sessions/<sessionId>.jsonl`, resolves the actual `runId` to its Session user event, restores validated spill files from that same session directory, and writes `trajectory.json` under Harbor's agent log directory. The exported trajectory is redacted by default. `--include-sensitive-content` is available only to direct local helper invocation; the adapter never enables it.

The ATIF export represents the selected Session turn, not a complete replay. Each persisted agent response is one logical model call in `llm_call_count`; hidden HTTP retries and system compaction work are not counted. Subagent trajectories and image references or payloads are not embedded; omissions appear in `extra.ligule.missing_features`, with per-call flags where applicable, so report totals are unknown when a subagent trajectory is missing. The adapter restores spill files only after validating them against the same Session directory; an unresolved spill reference fails the export.

The Session directory is an explicit child of a fresh per-run `LIGULE_HOME`. The selected Policy mode is written to the Session and reported in the evaluation Manifest. The full-access flag grants the Ligule process full local file, process, and network permission inside the Harbor task container; Ligule does not provide an additional OS sandbox for that run. In `auto`, policy-approved direct file operations and statically safe commands can run without a human terminal; commands requiring manual approval and hard-denied operations still fail closed. The adapter never synthesizes a human approval. For the run command, the adapter passes the selected API key and `LIGULE_HOME`; session, home, log, instruction, and installed CLI paths are explicit arguments. Configure proxy variables or `NODE_EXTRA_CA_CERTS` in the task's `[environment.env]` when those are needed; Harbor `AgentConfig.env` values are not forwarded to install commands. The API key exists in the Ligule process environment while it runs, so an untrusted same-UID background process in the task container could inspect `/proc/<pid>/environ`; use this adapter only with task images and tasks you trust. Harbor's separately configured task verifier remains the source of pass/fail scores.

## Adapter inputs

- `ligule_tarball`: absolute path to a built `ligule` npm tarball. The adapter verifies its package name, package version, and SHA-256 before upload, then verifies the uploaded bytes inside the task environment.
- `ligule_api`: `messages` or `chat-completions`.
- `ligule_base_url`: configured Provider endpoint.
- `ligule_model`: optional override; defaults to Harbor's selected `--model` value.
- `ligule_api_key_env`: environment variable name, default `LIGULE_API_KEY`. Provide its value through Harbor's agent environment/secret mechanism.
- `ligule_model_calls`, `ligule_timeout_ms`, `ligule_request_timeout_ms`: bounded request and execution limits.
- `ligule_policy_mode`: `never` or `auto`; the existing plan default is `never`. Prefer `auto` for new plans that must retain Policy decisions while running without a human approver.
- `ligule_output_tokens`: optional per-request output-token budget forwarded as `model.outputTokens`. The default remains Ligule's configured default; the selected provider/model still validates its supported limit.
- `ligule_node_runtime_tarball` and `ligule_node_runtime_sha256`: optional, paired inputs for Linux task images without Node.js 24+ and npm. Supply an official Node `.tar.gz` archive and the matching digest from Node's `SHASUMS256.txt`; keep both values in trusted local job configuration, not in task-controlled files. The adapter verifies the local and uploaded archive digests before extracting it into a private `/installed-agent/node-runtime` directory, uses that `bin` directory for npm and Ligule, then removes the uploaded archive. The digest check proves the bytes match the configured value; it does not prove where that value came from.
- `ligule_install_build_tools`: optional Debian/Ubuntu setup for packages with native npm modules. When true, the adapter checks for `make`, `g++`, and `python3`; if any are missing, it uses root `apt-get` to install only the corresponding `build-essential` or `python3` package before `npm install`. The image must have root access and the task network policy must allow the configured Debian package repositories. Leave false for task images that already have the toolchain.
- `ligule_setup_apt_mirror`: optional apt mirror selector. `tsinghua` generates a temporary, signature-verified source list for the detected Debian or Ubuntu release, uses it for the toolchain install, and removes it after the command. The task container's original apt sources are not changed.
- `ligule_setup_proxy_url`: optional unauthenticated HTTP(S) proxy used only by the `apt-get` setup command. Embedded credentials are rejected because Harbor records scoped command environment values in local trial logs. This proxy is not added to the task container's persistent environment, npm installation, or Ligule run.

## Harbor 0.25.0 schema check

Harbor 0.25.0's `harbor job schema` confirms `agents[]`, `environment`, timeout multipliers, attempt/concurrency limits, and the `AgentConfig.import_path`, `model_name`, `kwargs`, and `env` fields used below. `harbor task schema` places `docker_image`, `network_mode`, `allowed_hosts`, `workdir`, and task CPU/memory/storage values under the task's `[environment]` section. The job-level `environment` instead selects the provider and resource overrides. These are separate schemas.

## Machine-readable run example

The adapter's machine invocation is equivalent to:

```sh
ligule run --json --allow-full-access --config policy.mode=auto --config host.sessionDirectory='"/tmp/ligule-eval-<run-id>/sessions"' --config model.api='"messages"' --config model.baseURL='"https://provider.example/v1"' --config model.model='"<model-id>"' --config model.apiKeyEnv='"LIGULE_API_KEY"' --config loop.modelCalls=5 --config loop.totalModelCalls=5 --config loop.taskTimeoutMs=3600000 --config loop.requestTimeoutMs=120000 "<task instruction>"
```

This example documents the authorization and machine-result contract; the adapter builds and shell-quotes the arguments directly rather than evaluating this shell text. Policy auto mode still refuses dangerous commands and commands that require manual approval when no terminal is available. Those attempts remain failed results; the adapter does not approve them on a user's behalf.

## Local Harbor job configuration and dry-run

The example below follows the Harbor `0.25.0` `harbor job schema`: the custom agent is under `agents[]`, its Python class uses `import_path`, custom adapter parameters go in `kwargs`, and process environment references go in `env`. `AgentConfig.env` values support Harbor's `${VAR}` / `${VAR:-default}` syntax. The host must provide `LIGULE_API_KEY` directly or through a private `--env-file`; do not put the key value in the job file or command line.

Save the YAML as a private local file such as `job.local.yaml`, then replace the tarball path and model ID:

```yaml
job_name: ligule-local-dry-run
n_attempts: 1
n_concurrent_trials: 1
skip_credential_checks: true
timeout_multiplier: 1.0
agent_timeout_multiplier: 1.0
agent_setup_timeout_multiplier: 1.0
environment_build_timeout_multiplier: 1.0
agents:
  - import_path: evals.harbor.ligule_agent:LiguleAgent
    model_name: "<model-id>"
    skip_model_parsing: true
    kwargs:
      ligule_tarball: "<absolute path to the built tarball>"
      # Needed only if the selected task image lacks Node.js 24+ and npm.
      ligule_node_runtime_tarball: "<absolute path to official Node Linux x64 .tar.gz>"
      ligule_node_runtime_sha256: "<matching digest from official Node SHASUMS256.txt>"
      ligule_api: messages
      ligule_base_url: "https://provider.example.invalid/v1"
      ligule_api_key_env: LIGULE_API_KEY
      ligule_model_calls: 5
      ligule_timeout_ms: 3600000
      ligule_request_timeout_ms: 120000
    env:
      LIGULE_API_KEY: "${LIGULE_API_KEY}"
environment:
  type: docker
  delete: true
  cpu_enforcement_policy: limit
  memory_enforcement_policy: limit
  override_cpus: 2
  override_memory_mb: 4096
  override_storage_mb: 20480
```

`ligule_tarball` must be an absolute host path to the tarball for the intended Ligule Git SHA. Job-level `environment` has resource overrides but no network-mode or Node-version field. Those are defined by the local task's `task.toml` and image. For example, the `harbor task schema` confirms these task fields:

```toml
[environment]
docker_image = "<digest-pinned Linux image; install Node.js 24+ and npm or configure the official Node runtime archive above>"
network_mode = "allowlist"
allowed_hosts = ["<model-provider-host>", "registry.npmjs.org", "nodejs.org"]
workdir = "/workspace"

[verifier]
environment_mode = "separate"
```

Allow only the provider host and package registries needed by setup. Native npm modules may use `node-gyp` to fetch matching headers from `nodejs.org`. `--allow-agent-host` extends the agent phase's allowlist; it does not replace task-level setup networking. Keep the task's verifier configuration in `task.toml`; leave the job-level `verifier` override unset so the independent task verifier remains authoritative. The adapter does not read or edit task files.

From the Ligule repository root, with a local task directory and a private env file already prepared:

```powershell
$env:PYTHONPATH = (Resolve-Path .).Path
$JobConfig = (Resolve-Path .\job.local.yaml).Path
$TaskDir = (Resolve-Path .\path\to\local-task).Path
$PrivateEnvFile = (Resolve-Path .\path\to\private.env).Path
uv run --no-project --with harbor==0.25.0 harbor run --dry-run --config $JobConfig --path $TaskDir --env-file $PrivateEnvFile --n-attempts 1 --n-concurrent 1 --max-retries 0
```

`PYTHONPATH` makes the local `evals.harbor.ligule_agent:LiguleAgent` importable by Harbor on the host. The `--env-file` is resolved by Harbor before it expands `${LIGULE_API_KEY}` during configuration validation. `--dry-run` validates the job config, agent import, and local task metadata without running a verifier or trial. Harbor still runs environment-provider preflight; with `environment.type: docker`, the Docker daemon must be available even though dry-run does not start a container. In the current no-Docker environment, the config and custom agent import validated, then Harbor stopped at `Docker daemon is not running`; no container was started.

Harbor 0.25.0's `harbor agent schema evals.harbor.ligule_agent:LiguleAgent --json` reports that this adapter has no `options_model`; the dry-run correspondingly marks custom `kwargs` validation as skipped. Harbor's generic job schema still validates the field structure, while the adapter performs tarball identity/digest and numeric-bound checks during setup. Dry-run cannot verify the task image's Node/npm runtime, network reachability, tarball contents, or task verifier score.

## Offline checks

Build Core before running the Node test:

```sh
pnpm --filter @ligule/core run build
uv run --no-project --with harbor==0.25.0 python evals/harbor/test_adapter.py
node --test --test-concurrency=1 evals/harbor/export_session.test.mjs
node --test --test-concurrency=1 evals/harbor/cli-e2e.test.mjs
```

From the repository root, `pnpm run eval:smoke` runs the full TypeScript build, these Harbor adapter/ATIF/CLI fixtures, the report fixtures, and the Harbor `0.25.0` official ATIF validator. It does not fetch a benchmark task, start Docker, or call an external Provider. It requires `pnpm` and `uv`; Harbor `0.25.0` and its Python dependencies are resolved into a unique `testplace/tmp` cache, so network access to the Python package index is required when running the script.

The tests inspect a fixture npm tarball, the Harbor `0.25.0` class contract, non-root install ownership, CLI result filtering and environment allowlisting, process timeout termination, and a real Session written by Core's `createSessionLog`. The Node test creates a clean temporary npm-style package layout with the actual built Core manifest and `dist` under `ligule/node_modules/@ligule/core`; it verifies package-subpath import, spill restoration, privacy defaults, terminal-state agreement, and rejection of a missing spill file. The CLI end-to-end test starts the actual built CLI in a temporary workspace with a loopback-only mock Messages provider: the default read-only run cannot create the task file; the explicit full-access run creates it, executes a safe `whoami` command under `policy.mode=auto`, returns the machine-readable run result, and exports the real Session as ATIF. Set `LIGULE_CLI_E2E_PATH` and `LIGULE_CLI_E2E_CORE_PACKAGE` to run the same test against the CLI and bundled Core of an installed consumer tarball. A separate policy-denial test remains authoritative for commands requiring approvals. The adapter's post-install import probe runs at the same package root after npm has installed the supplied tarball. Neither the offline fixture nor this mock-provider test substitutes for a real verifier result. No Docker is started, no external Provider is invoked, no benchmark task is run, and no verifier result is claimed.

To validate the JSON emitted by the Node test with Harbor's official validator, set `LIGULE_ATIF_OUTPUT_PATH` to a temporary file outside the repository before running that test, then run:

```sh
uv run --no-project --with harbor==0.25.0 python -m harbor.utils.trajectory_validator <temporary-file>
```

Do not use a hand-written trajectory as evidence that the exporter passes validation.
