# Evaluation report

Generate deterministic JSON and Markdown summaries from an explicit experiment manifest and actual Harbor trial `result.json` files. The input folder is read only. No model, provider, Docker, or benchmark task is started.

## Harbor result contract

The reader supports exactly Harbor `0.25.0` and validates every trial with Harbor's `TrialResult` Pydantic model. The manifest must set `verifier.result_schema` to `harbor.models.trial.result.TrialResult@0.25.0`, and its runner version must be `0.25.0`. Other versions and unconfirmed schemas are rejected.

Generated JSON uses `schema_version: "ligule.eval-report.v2"`. Version 2 keeps Harbor's `exception_type` and Ligule's Run metadata as separate fields. For a `NonZeroAgentExitCodeError`, `failure_kind` is `agent_nonzero_exit`; consumers that previously treated `agent_crashed` as an enum value should branch on `schema_version` and handle the new value. Harbor's typed result does not expose a numeric process exit-code field, so the report does not infer one from free-form exception messages.

The reward key and pass threshold are explicit manifest inputs. The report preserves Harbor's raw verifier reward and `reward_valid` decision, but an attempt is a `pass` only when the reward reaches the threshold and Ligule's recorded Run state is `completed`. A `failed` Run cannot pass even when Harbor has a valid reward; `cancelled` and `interrupted` Runs remain infrastructure errors. The output keeps the raw `ligule_run_states` and a derived `ligule_run_state` separate from the combined `status`.

Reports do not assume that a missing Ligule state means `completed`: the row uses `ligule_run_state: "unknown"` and a passing Harbor reward is classified as `infra_error` with `failure_kind: "ligule_run_state_unknown"`. A planned attempt that never started has `ligule_run_state: null` and status `not_run`. Agent budget exhaustion/refusal without a completed Ligule Run is a failure; timeout/refusal type remains visible even when Harbor supplies a valid reward. A `NonZeroAgentExitCodeError` remains an infrastructure error with `failure_kind: "agent_nonzero_exit"`; the row separately preserves Harbor's exception type and Ligule's run state and error codes, so a known Ligule failure is not reported as an undifferentiated crash. Sandbox, provider, Harbor, verifier, and cancellation errors remain `infra_error` with a distinct `failure_kind`. An absent result is accepted as `not_run` only when the manifest provides a reason. A manifest path to a missing result is an error.

## Input folder

Place `manifest.json` at the root; [manifest.schema.json](manifest.schema.json) describes its machine-readable input contract. Each executed attempt references its Harbor result JSON, optional ATIF trajectory, and zero or more local artifacts by canonical relative paths. Paths cannot leave the folder, follow symlinks, or refer to hard-linked files. The result's `trial_name` and serialized `task_id` must match the manifest.

The manifest uses `schema_version: "ligule.eval-manifest.v1"` and contains:

- `experiment`: experiment ID, full Ligule Git SHA and dirty flag, Harbor version, dataset ID and revision, image digest, model and provider, config SHA-256, tool mode, actual `policy_mode` (the existing Terminal-Bench plan defaults to `"never"`; plans can select `"auto"`), permissions, limits, Node/OS versions, experiment timestamps, and expected evaluation.
- `verifier`: the exact Harbor result schema, reward key, and numeric pass threshold.
- `attempts`: an ordered array with task ID, category, attempt number, Harbor trial name and task ID, result path, optional trajectory path, artifact paths, and `not_run_reason`.

Every field is required. Use JSON `null` for unavailable environment, model, configuration, or timestamp values. A planned but unstarted attempt has `result_file`, `trial_name`, and `harbor_task_id` set to `null`, plus a non-empty `not_run_reason`. Do not add an asserted `status` or score to the manifest.

## Output and unknown values

The report retains every manifest attempt in input order. Pass-rate denominators include pass, fail, not_run, and infra_error. Category summaries use the same denominator rule. Failure-kind shares use the full planned-attempt denominator. All p50/p95 values use the nearest-rank method. Repeated-task summaries include the status sequence, valid verifier-reward and elapsed-time p50/p95, unknown counts, and distinct failure kinds; only groups with at least three attempts are marked eligible for the plan's repeated-run comparison. Ligule Run error codes are included only from the adapter's `AgentContext.metadata.ligule` allowlisted fields and are validated against a short code pattern.

Duration comes from timezone-aware Harbor start/end timestamps. Token and cost totals are complete only when every planned attempt has that metric; unrun attempts remain unknown. The JSON also includes any known subtotal and an unknown count. Harbor input-token semantics include cached tokens, so uncached input is reported only when both input and cache counts are present. Cost is copied from Harbor `AgentContext.cost_usd` and is never reconstructed from a guessed price. Model-call totals count persisted Ligule agent response steps (`llm_call_count: 1` per step); they do not count hidden HTTP retries or system compaction work. A missing count or missing subagent trajectory makes the attempt's total unknown. Tool calls, known tool outcomes, compactions, and subagent call/trajectory references are read only from a validated Ligule ATIF trajectory. Tool retries remain `null` because the supported Harbor result/ATIF schemas do not carry a typed retry total.

Reports omit generation timestamps and hash the manifest and referenced evidence, so identical ordered inputs produce byte-identical outputs.

## Run

```sh
uv run --no-project --with harbor==0.25.0 python evals/report/report.py <input-folder> --output-dir <report-folder>
uv run --no-project --with harbor==0.25.0 python evals/report/test_report.py
```

The offline tests create Harbor-validated result files and a real folder fixture under `testplace/tmp`; they do not call paid services.

Run the full no-paid-service smoke from the repository root with `pnpm run eval:smoke`. It builds the TypeScript workspace, runs the Harbor/ATIF/CLI and report fixtures, and validates a generated trajectory with Harbor `0.25.0`; it does not download tasks, start Docker, or contact a model provider. It requires `pnpm`, `uv`, and package-index network access when the per-run temporary Harbor cache is cold.
