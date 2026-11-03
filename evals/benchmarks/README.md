# Agent capability benchmark

Runs a frozen `terminal-bench@2.0` subset through the existing Harbor adapter and keeps Harbor's independent verifier authoritative. The task plan is [plan.json](plan.json); the runner checks prerequisites, writes the exact Harbor job, and preserves raw logs. It never fabricates a score.

## Prerequisites

- Docker daemon reachable (`docker version`).
- `uv` on `PATH`; the runner resolves Harbor `0.25.0` into the uv cache.
- A built CLI tarball: `pnpm --filter ligule run pack-release`, then `--tarball <absolute path>` or `LIGULE_BENCH_TARBALL`.
- Provider settings: `LIGULE_API_KEY`, `LIGULE_BENCH_BASE_URL`, `LIGULE_BENCH_MODEL`; optionally `LIGULE_BENCH_API` (`messages` by default).
- Images without Node 24: set `LIGULE_BENCH_NODE_RUNTIME` to an official Linux Node 24 `.tar.gz` and `LIGULE_BENCH_NODE_RUNTIME_SHA256` to its official digest. Images that need a compiler for native npm modules: set `LIGULE_BENCH_BUILD_TOOLS=1`; the adapter installs only `build-essential`/`python3` when missing. `LIGULE_BENCH_APT_MIRROR=tsinghua` uses the adapter's temporary, signature-verified mirror when the default Debian mirror is unreachable.
- The frozen dataset locally. Download once outside tracked files:

```sh
uv run --no-project --with harbor==0.25.0 harbor datasets download terminal-bench@2.0 \
  -o testplace/benchmarks/datasets/terminal-bench@2.0
```

## Run

```sh
pnpm run bench:agent -- --tarball testplace/pack/ligule-0.1.2.tgz
pnpm run bench:agent -- --dataset-dir testplace/benchmarks/datasets/terminal-bench@2.0 --output testplace/benchmarks/agent-run
```

The run directory contains `run.json` (status, checks, tarball SHA-256, model identifiers without secrets), `job.json` (the exact Harbor job), `harbor/` (Harbor job output), and stdout/stderr logs.

Exit codes: `0` completed, `1` Harbor failed, `2` blocked because a prerequisite is missing. A blocked result lists every missing prerequisite; it is not a model score.

## Plan and scoring

The plan fixes the dataset version, task IDs, one attempt per task, concurrency, model-call/timeout budget, and the verifier authority. Harbor's task verifier runs in its own environment and decides pass/fail. The runner uses the existing `evals.harbor.ligule_agent:LiguleAgent` adapter and `--allow-full-access` behavior inside the task container; it does not create approvals or read verifier files.

Generate the maintainer report with the existing report tooling after the run. The report tool reads a separate input folder with a `manifest.json`; the runner preserves raw Harbor output but does not invent that manifest:

1. Create an input folder and copy `run.json` from the benchmark run.
2. Add `manifest.json` following [evals/report/README.md](../report/README.md) and [manifest.schema.json](../report/manifest.schema.json). Use `run.json.identity`, the plan, tarball SHA-256, dataset version, model/provider, and limits for `experiment`; set `verifier.result_schema` to `harbor.models.trial.result.TrialResult@0.25.0`, `reward_key`, and the numeric threshold.
3. For each executed trial under `harbor/<job>/<task>__<id>/`, add an `attempts` entry with the task ID and category, attempt number, trial name, Harbor task ID, the relative `result.json` path, the relative `agent/trajectory.json` path when present, and artifact paths. Paths must stay inside the input folder and cannot be symlinks. A planned but unstarted attempt keeps `result_file`, `trial_name`, and `harbor_task_id` null and provides `not_run_reason`.
4. Run:

```sh
uv run --no-project --with harbor==0.25.0 python evals/report/report.py <run-input-folder> --output-dir <report-folder>
```

The report tool validates every attempt against Harbor's result model and keeps pass/fail/not_run/infra_error separate. It does not read Harbor output directly.

`eval:smoke` validates the adapter, ATIF export, and report fixtures without Docker or an external provider; it is infrastructure validation, not a benchmark score. Absolute agent results are meaningful only with the recorded SHA, tarball digest, dataset version, model, budget, and platform.
