"""Build deterministic evaluation reports from Harbor 0.25.0 trial results."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import stat
from collections import Counter, defaultdict
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.models.trial.error_policy import FailureCause, policy_for
from harbor.models.trial.result import TrialResult
from harbor.models.trajectories import Trajectory


MANIFEST_SCHEMA = "ligule.eval-manifest.v1"
REPORT_SCHEMA = "ligule.eval-report.v2"
HARBOR_VERSION = "0.25.0"
POLICY_MODES = ("always", "ask", "auto", "never")
HARBOR_RESULT_SCHEMA = "harbor.models.trial.result.TrialResult@0.25.0"
MAX_JSON_EVIDENCE_BYTES = 256 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
GIT_SHA = re.compile(r"^[a-f0-9]{40}$")
SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_:-]{1,128}$")
SENSITIVE_KEY = re.compile(r"(?:secret|password|credential|bearer|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)", re.IGNORECASE)


class ReportInputError(ValueError):
    """Raised when an input cannot be safely or unambiguously reported."""


def _fail(message: str) -> None:
    raise ReportInputError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label}_must_be_object")
    return value


def _keys(value: dict[str, Any], required: set[str], label: str) -> None:
    missing = required - value.keys()
    extra = value.keys() - required
    if missing:
        _fail(f"{label}_missing_fields_{','.join(sorted(missing))}")
    if extra:
        _fail(f"{label}_unknown_fields_{','.join(sorted(extra))}")


def _text(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or value.strip() == "":
        _fail(f"{label}_must_be_nonempty_string")
    return value


def _nullable_text(value: Any, label: str) -> str | None:
    return _text(value, label, nullable=True)


def _number(value: Any, label: str, *, nullable: bool = False) -> float | int | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        _fail(f"{label}_must_be_finite_number")
    return value


def _timestamp(value: Any, label: str, *, nullable: bool = False) -> str | None:
    raw = _text(value, label, nullable=nullable)
    if raw is None:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReportInputError(f"{label}_must_be_iso8601") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        _fail(f"{label}_must_include_timezone")
    return raw


def _check_metadata(value: dict[str, Any], label: str, *, numeric: bool) -> None:
    for key, item in value.items():
        if not isinstance(key, str) or SENSITIVE_KEY.search(key):
            _fail(f"{label}_contains_sensitive_field_name")
        if numeric:
            if item is None:
                continue
            _number(item, f"{label}_{key}")
        elif item is not None and not isinstance(item, (str, bool)):
            _fail(f"{label}_{key}_must_be_string_boolean_or_null")


def _json_bytes(raw: bytes, label: str) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"non_finite_json_number_{value}")

    try:
        return json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise ReportInputError(f"{label}_invalid_json") from error


def _relative_file(root: Path, relative: Any, label: str) -> tuple[Path, str]:
    name = _text(relative, label)
    assert name is not None
    if "\\" in name:
        _fail(f"{label}_must_use_posix_relative_path")
    pure = PurePosixPath(name)
    if pure.is_absolute() or pure.as_posix() != name or any(part in {"", ".", ".."} for part in pure.parts):
        _fail(f"{label}_must_be_canonical_relative_path")
    candidate = root
    for index, part in enumerate(pure.parts):
        candidate = candidate / part
        try:
            info = candidate.lstat()
        except OSError as error:
            raise ReportInputError(f"{label}_missing") from error
        if candidate.is_symlink():
            _fail(f"{label}_contains_symlink")
        if index < len(pure.parts) - 1 and not stat.S_ISDIR(info.st_mode):
            _fail(f"{label}_parent_not_directory")
    info = candidate.lstat()
    if not candidate.is_file() or info.st_nlink != 1:
        _fail(f"{label}_must_be_unlinked_regular_file")
    resolved = candidate.resolve(strict=True)
    if not resolved.is_relative_to(root):
        _fail(f"{label}_outside_input_directory")
    return candidate, name


def _read_relative(root: Path, relative: Any, label: str) -> tuple[bytes, str]:
    candidate, name = _relative_file(root, relative, label)
    if candidate.stat().st_size > MAX_JSON_EVIDENCE_BYTES:
        _fail(f"{label}_exceeds_json_evidence_limit")
    return candidate.read_bytes(), name


def _hash_relative(root: Path, relative: Any, label: str) -> tuple[str, str]:
    candidate, name = _relative_file(root, relative, label)
    digest = hashlib.sha256()
    with candidate.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest(), name


def _check_manifest(raw: Any) -> dict[str, Any]:
    manifest = _object(raw, "manifest")
    _keys(manifest, {"schema_version", "experiment", "verifier", "attempts"}, "manifest")
    if manifest["schema_version"] != MANIFEST_SCHEMA:
        _fail("manifest_schema_version_unsupported")

    experiment = _object(manifest["experiment"], "experiment")
    experiment_fields = {
        "id", "git_sha", "working_tree_dirty", "runner_name", "runner_version",
        "dataset_id", "dataset_revision", "docker_image_digest", "model_id", "provider",
        "config_sha256", "tool_mode", "policy_mode", "permissions", "limits", "node_version", "os",
        "started_at", "finished_at", "expected_evaluation",
    }
    _keys(experiment, experiment_fields, "experiment")
    _text(experiment["id"], "experiment_id")
    if not isinstance(experiment["git_sha"], str) or not GIT_SHA.fullmatch(experiment["git_sha"]):
        _fail("experiment_git_sha_must_be_full_sha")
    if not isinstance(experiment["working_tree_dirty"], bool):
        _fail("experiment_working_tree_dirty_must_be_boolean")
    if experiment["runner_name"] != "harbor" or experiment["runner_version"] != HARBOR_VERSION:
        _fail("harbor_version_unsupported")
    for field in ("dataset_id", "dataset_revision", "tool_mode", "expected_evaluation"):
        _text(experiment[field], f"experiment_{field}")
    if experiment["policy_mode"] not in POLICY_MODES:
        _fail("experiment_policy_mode_invalid")
    for field in ("docker_image_digest", "model_id", "provider", "node_version", "os"):
        _nullable_text(experiment[field], f"experiment_{field}")
    image_digest = experiment["docker_image_digest"]
    if image_digest is not None and not re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest):
        _fail("experiment_docker_image_digest_invalid")
    digest = _nullable_text(experiment["config_sha256"], "experiment_config_sha256")
    if digest is not None and not SHA256.fullmatch(digest):
        _fail("experiment_config_sha256_invalid")
    permissions = _object(experiment["permissions"], "experiment_permissions")
    limits = _object(experiment["limits"], "experiment_limits")
    _check_metadata(permissions, "experiment_permissions", numeric=False)
    _check_metadata(limits, "experiment_limits", numeric=True)
    started_at = _timestamp(experiment["started_at"], "experiment_started_at", nullable=True)
    finished_at = _timestamp(experiment["finished_at"], "experiment_finished_at", nullable=True)
    if started_at is not None and finished_at is not None:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        finish = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
        if finish < start:
            _fail("experiment_finished_before_started")

    verifier = _object(manifest["verifier"], "verifier")
    _keys(verifier, {"result_schema", "reward_key", "pass_threshold"}, "verifier")
    if verifier["result_schema"] != HARBOR_RESULT_SCHEMA:
        _fail("harbor_result_schema_unconfirmed")
    _text(verifier["reward_key"], "verifier_reward_key")
    _number(verifier["pass_threshold"], "verifier_pass_threshold")

    attempts = manifest["attempts"]
    if not isinstance(attempts, list) or len(attempts) == 0:
        _fail("attempts_must_be_nonempty_array")
    seen: set[tuple[str, int]] = set()
    result_paths: set[str] = set()
    trial_names: set[str] = set()
    for index, raw_attempt in enumerate(attempts):
        attempt = _object(raw_attempt, f"attempt_{index}")
        _keys(attempt, {
            "task_id", "category", "attempt", "trial_name", "harbor_task_id",
            "result_file", "trajectory_file", "artifact_files", "not_run_reason",
        }, f"attempt_{index}")
        task_id = _text(attempt["task_id"], f"attempt_{index}_task_id")
        _text(attempt["category"], f"attempt_{index}_category")
        ordinal = attempt["attempt"]
        if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 1:
            _fail(f"attempt_{index}_ordinal_invalid")
        identity = (task_id, ordinal)
        if identity in seen:
            _fail("attempt_identity_duplicate")
        seen.add(identity)
        result_file = _nullable_text(attempt["result_file"], f"attempt_{index}_result_file")
        reason = _nullable_text(attempt["not_run_reason"], f"attempt_{index}_not_run_reason")
        if result_file is None:
            if reason is None:
                _fail(f"attempt_{index}_missing_result_requires_not_run_reason")
            if attempt["trial_name"] is not None or attempt["harbor_task_id"] is not None:
                _fail(f"attempt_{index}_not_run_must_not_have_harbor_identity")
            if attempt["trajectory_file"] is not None or attempt["artifact_files"]:
                _fail(f"attempt_{index}_not_run_must_not_have_artifacts")
        else:
            if reason is not None:
                _fail(f"attempt_{index}_run_must_not_have_not_run_reason")
            trial_name = _text(attempt["trial_name"], f"attempt_{index}_trial_name")
            if trial_name in trial_names:
                _fail("harbor_trial_name_duplicate")
            trial_names.add(trial_name)
            if result_file in result_paths:
                _fail("harbor_result_file_reused")
            result_paths.add(result_file)
            _object(attempt["harbor_task_id"], f"attempt_{index}_harbor_task_id")
        if attempt["trajectory_file"] is not None:
            _text(attempt["trajectory_file"], f"attempt_{index}_trajectory_file")
            if result_file is None:
                _fail(f"attempt_{index}_not_run_must_not_have_trajectory")
        artifacts = attempt["artifact_files"]
        if not isinstance(artifacts, list) or any(not isinstance(path, str) or not path for path in artifacts):
            _fail(f"attempt_{index}_artifact_files_invalid")
        if result_file is None and artifacts:
            _fail(f"attempt_{index}_not_run_must_not_have_artifacts")
    return manifest


def _duration_seconds(result: TrialResult) -> float | None:
    if result.started_at is None or result.finished_at is None:
        return None
    if result.started_at.tzinfo is None or result.finished_at.tzinfo is None:
        return None
    seconds = (result.finished_at - result.started_at).total_seconds()
    if seconds < 0:
        _fail("harbor_trial_finished_before_started")
    return seconds


def _contexts(result: TrialResult) -> list[Any]:
    if result.agent_result is not None:
        return [result.agent_result]
    return [step.agent_result for step in result.step_results or [] if step.agent_result is not None]


def _ligule_run_metadata(result: TrialResult) -> dict[str, list[str] | str]:
    states: list[str] = []
    observed_states: list[str | None] = []
    error_codes: list[str] = []
    known_states = {"completed", "failed", "cancelled", "interrupted", "unknown"}
    for context in _contexts(result):
        metadata = context.metadata if isinstance(context.metadata, dict) else {}
        ligule = metadata.get("ligule") if isinstance(metadata.get("ligule"), dict) else {}
        state = ligule.get("state")
        if isinstance(state, str) and state in known_states:
            observed_states.append(state)
            if state not in states:
                states.append(state)
        else:
            observed_states.append(None)
        for key in ("errorCode", "atifErrorCode"):
            code = ligule.get(key)
            if isinstance(code, str) and SAFE_ERROR_CODE.fullmatch(code) and code not in error_codes:
                error_codes.append(code)
    if "failed" in observed_states:
        run_state = "failed"
    elif "cancelled" in observed_states:
        run_state = "cancelled"
    elif "interrupted" in observed_states:
        run_state = "interrupted"
    elif observed_states and all(state == "completed" for state in observed_states):
        run_state = "completed"
    else:
        run_state = "unknown"
    return {
        "ligule_run_states": states,
        "ligule_run_state": run_state,
        "ligule_error_codes": error_codes,
    }


def _usage(result: TrialResult) -> dict[str, int | float | None]:
    contexts = _contexts(result)
    fields = ("n_input_tokens", "n_cache_tokens", "n_output_tokens", "cost_usd")
    values: dict[str, int | float | None] = {}
    for field in fields:
        field_values = [getattr(context, field) for context in contexts]
        for value in field_values:
            if value is None:
                continue
            if field == "cost_usd":
                if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
                    _fail("harbor_reported_cost_invalid")
            elif isinstance(value, bool) or not isinstance(value, int) or value < 0:
                _fail(f"harbor_{field}_invalid")
        values[field] = sum(field_values) if field_values and all(value is not None for value in field_values) else None
    input_tokens = values["n_input_tokens"]
    cache_tokens = values["n_cache_tokens"]
    if input_tokens is not None and cache_tokens is not None:
        if cache_tokens > input_tokens:
            _fail("harbor_cached_tokens_exceed_total_input_tokens")
        values["n_uncached_input_tokens"] = input_tokens - cache_tokens
    else:
        values["n_uncached_input_tokens"] = None
    return values


def _trajectory_metrics(raw: bytes | None, label: str) -> dict[str, Any]:
    if raw is None:
        return {
            "model_calls": None, "tool_calls": None, "tool_failures": None, "tool_retries": None,
            "context_compactions": None, "subagent_calls": None, "subagent_trajectories": None,
            "subagent_trajectory_ids": None, "subagent_trajectory_refs": None,
            "subagent_trajectory_missing_calls": None,
        }
    try:
        trajectory = Trajectory.model_validate_json(raw)
    except Exception as error:
        raise ReportInputError(f"{label}_invalid_harbor_atif_trajectory") from error
    if trajectory.agent.name != "ligule":
        _fail(f"{label}_trajectory_agent_not_ligule")

    root_calls = [call for step in trajectory.steps for call in (step.tool_calls or [])]
    trajectories = [trajectory]
    for current in trajectories:
        trajectories.extend(current.subagent_trajectories or [])
    all_calls = [call for current in trajectories for step in current.steps for call in (step.tool_calls or [])]
    agent_steps = [step for current in trajectories for step in current.steps if step.source == "agent"]
    failures = 0
    failures_known = True
    for current in trajectories:
        current_calls = [call for step in current.steps for call in (step.tool_calls or [])]
        outcomes: dict[str, str] = {}
        for step in current.steps:
            if step.observation is None:
                continue
            for observation in step.observation.results:
                if observation.source_call_id is None:
                    continue
                extra = observation.extra if isinstance(observation.extra, dict) else {}
                ligule = extra.get("ligule") if isinstance(extra.get("ligule"), dict) else {}
                outcome = ligule.get("outcome")
                if isinstance(outcome, str):
                    outcomes[observation.source_call_id] = outcome
        if not all(call.tool_call_id in outcomes and outcomes[call.tool_call_id] in {"completed", "failed"} for call in current_calls):
            failures_known = False
        else:
            failures += sum(outcomes[call.tool_call_id] == "failed" for call in current_calls)
    compactions = sum(
        1 for current in trajectories for step in current.steps
        if isinstance(step.extra, dict)
        and isinstance(step.extra.get("context_management"), dict)
        and step.extra["context_management"].get("type") == "compaction"
    )
    subagent_calls = [call.tool_call_id for call in root_calls if call.function_name == "subagent"]
    subagent_refs = []
    missing_subagents: set[str] = set()
    root_call_ids = set(subagent_calls)
    for step in trajectory.steps:
        for call in step.tool_calls or []:
            extra = call.extra if isinstance(call.extra, dict) else {}
            ligule = extra.get("ligule") if isinstance(extra.get("ligule"), dict) else {}
            if call.function_name == "subagent" and ligule.get("subagent_trajectory_missing") is True:
                missing_subagents.add(call.tool_call_id)
        if step.observation is None:
            continue
        for observation in step.observation.results:
            if observation.source_call_id not in root_call_ids:
                continue
            extra = observation.extra if isinstance(observation.extra, dict) else {}
            ligule = extra.get("ligule") if isinstance(extra.get("ligule"), dict) else {}
            if ligule.get("subagent_trajectory_missing") is True:
                missing_subagents.add(observation.source_call_id)
            references = observation.subagent_trajectory_ref or []
            if references:
                subagent_refs.append({
                    "call_id": observation.source_call_id,
                    "trajectory_ids": [reference.trajectory_id for reference in references if reference.trajectory_id is not None],
                    "external_reference_count": sum(reference.trajectory_path is not None for reference in references),
                })
    missing_subagent_trajectory = bool(missing_subagents) or any(
        isinstance(current.extra, dict)
        and isinstance(current.extra.get("ligule"), dict)
        and isinstance(current.extra["ligule"].get("missing_features"), list)
        and "subagent_trajectory" in current.extra["ligule"]["missing_features"]
        for current in trajectories
    )
    model_calls = sum(step.llm_call_count for step in agent_steps) if agent_steps and all(
        step.llm_call_count is not None for step in agent_steps
    ) and not missing_subagent_trajectory else None
    return {
        "model_calls": model_calls,
        "tool_calls": len(all_calls),
        "tool_failures": failures if failures_known else None,
        "tool_retries": None,
        "context_compactions": compactions,
        "subagent_calls": subagent_calls,
        "subagent_trajectories": len(trajectory.subagent_trajectories or []),
        "subagent_trajectory_ids": [child.trajectory_id for child in trajectory.subagent_trajectories or []],
        "subagent_trajectory_refs": subagent_refs,
        "subagent_trajectory_missing_calls": sorted(missing_subagents),
    }


def _classify(
    result: TrialResult,
    reward_key: str,
    threshold: float | int,
    ligule_run_state: str,
) -> tuple[str, str | None, float | int | None]:
    exception = result.exception_info
    rewards = result.verifier_result.rewards if result.verifier_result is not None else None
    reward = rewards.get(reward_key) if rewards is not None else None
    if reward is not None and (isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(reward)):
        _fail("harbor_verifier_reward_invalid")
    if exception is not None:
        cause = policy_for(exception.exception_type).cause
        if cause in {FailureCause.AGENT_EXHAUSTED_BUDGET, FailureCause.AGENT_REFUSED_TASK}:
            kind = "timeout" if exception.exception_type == "AgentTimeoutError" else (
                "task_refused" if cause == FailureCause.AGENT_REFUSED_TASK else "task_failed"
            )
            if result.reward_valid and reward is not None:
                completed = ligule_run_state == "completed"
                return ("pass" if completed and reward >= threshold else "fail", kind, reward)
            return "fail", kind, reward
        if exception.exception_type == "NonZeroAgentExitCodeError":
            return "infra_error", "agent_nonzero_exit", reward
        if cause == FailureCause.SANDBOX_FAILED:
            return "infra_error", "environment_failed", reward
        if cause == FailureCause.MODEL_PROVIDER_FAILED:
            return "infra_error", "provider_failed", reward
        if cause == FailureCause.HARBOR_FAILED:
            return "infra_error", "runner_failed", reward
        if cause == FailureCause.VERIFIER_FAILED:
            return "infra_error", "verifier_failed", reward
        if cause == FailureCause.CANCELLED:
            return "infra_error", "cancelled", reward
        return "infra_error", "unclassified", reward
    if result.verifier_result is None or rewards is None or reward_key not in rewards:
        return "infra_error", "verifier_failed", None
    if ligule_run_state in {"cancelled", "interrupted"}:
        return "infra_error", ligule_run_state, reward
    if reward < threshold or ligule_run_state == "failed":
        return "fail", "task_failed", reward
    if ligule_run_state != "completed":
        return "infra_error", "ligule_run_state_unknown", reward
    return "pass", None, reward


def _nearest_rank(values: list[float]) -> dict[str, float | int | None]:
    ordered = sorted(values)
    if not ordered:
        return {"count": 0, "p50": None, "p95": None, "method": "nearest-rank"}

    def percentile(percent: float) -> float:
        return ordered[max(0, math.ceil(percent * len(ordered)) - 1)]

    return {"count": len(ordered), "p50": percentile(0.50), "p95": percentile(0.95), "method": "nearest-rank"}


def _metric_summary(rows: list[dict[str, Any]], field: str) -> dict[str, Any]:
    known = [row[field] for row in rows if row[field] is not None]
    histogram = {str(key): count for key, count in sorted(Counter(known).items())}
    return {"known_count": len(known), "unknown_count": len(rows) - len(known), "distribution": _nearest_rank(known), "histogram": histogram}


def _total_summary(rows: list[dict[str, Any]], field: str) -> dict[str, Any]:
    known = [row[field] for row in rows if row[field] is not None]
    unknown_count = len(rows) - len(known)
    return {
        "known_subtotal": sum(known) if known else None,
        "unknown_count": unknown_count,
        "total": sum(known) if known and unknown_count == 0 else None,
    }


def _rates(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts = Counter(row["status"] for row in rows)
    denominator = len(rows)
    return {
        "attempts": denominator,
        "pass": counts["pass"],
        "fail": counts["fail"],
        "not_run": counts["not_run"],
        "infra_error": counts["infra_error"],
        "pass_rate": counts["pass"] / denominator if denominator else None,
    }


def _summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    categories: dict[str, list[dict[str, Any]]] = defaultdict(list)
    tasks: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        categories[row["category"]].append(row)
        tasks[row["task_id"]].append(row)
    failure_counts = Counter(row["failure_kind"] for row in rows if row["failure_kind"] is not None)
    error_denominator = len(rows)
    repeated_tasks = []
    for task_id, group in tasks.items():
        if len(group) < 2:
            continue
        rewards = [
            row["verifier_reward"] for row in group
            if row["verifier_reward_valid"] and row["verifier_reward"] is not None
        ]
        durations = [row["duration_seconds"] for row in group if row["duration_seconds"] is not None]
        repeated_tasks.append({
            "task_id": task_id,
            "attempts": len(group),
            "eligible_minimum_three": len(group) >= 3,
            "status_sequence": [row["status"] for row in group],
            "status_counts": {key: _rates(group)[key] for key in ("pass", "fail", "not_run", "infra_error")},
            "verifier_reward_distribution": {
                "known_count": len(rewards),
                "unknown_count": len(group) - len(rewards),
                **_nearest_rank(rewards),
            },
            "duration_seconds_distribution": {
                "unknown_count": len(group) - len(durations),
                **_nearest_rank(durations),
            },
            "failure_kinds": sorted({row["failure_kind"] for row in group if row["failure_kind"] is not None}),
        })
    return {
        **_rates(rows),
        "failure_kind_counts": {key: failure_counts[key] for key in sorted(failure_counts)},
        "failure_kind_rates": {
            key: {"count": failure_counts[key], "denominator": error_denominator,
                  "share": failure_counts[key] / error_denominator if error_denominator else None}
            for key in sorted(failure_counts)
        },
        "reported_ligule_error_code_counts": {
            key: count for key, count in sorted(Counter(
                code for row in rows for code in row["ligule_error_codes"]
            ).items())
        },
        "by_category": {key: _rates(value) for key, value in categories.items()},
        "elapsed_seconds": _metric_summary(rows, "duration_seconds"),
        "model_calls": _metric_summary(rows, "model_calls"),
        "tool_calls": _metric_summary(rows, "tool_calls"),
        "tool_failures": _metric_summary(rows, "tool_failures"),
        "tool_retries": _metric_summary(rows, "tool_retries"),
        "context_compactions": _metric_summary(rows, "context_compactions"),
        "input_tokens_including_cache": _total_summary(rows, "n_input_tokens"),
        "cache_tokens": _total_summary(rows, "n_cache_tokens"),
        "uncached_input_tokens": _total_summary(rows, "n_uncached_input_tokens"),
        "output_tokens": _total_summary(rows, "n_output_tokens"),
        "reported_cost_usd": _total_summary(rows, "cost_usd"),
        "repeated_tasks": repeated_tasks,
    }


def build_report(input_directory: Path) -> dict[str, Any]:
    try:
        installed_version = version("harbor")
    except PackageNotFoundError as error:
        raise ReportInputError("harbor_0_25_0_is_required") from error
    if installed_version != HARBOR_VERSION:
        _fail(f"harbor_version_mismatch_expected_{HARBOR_VERSION}_got_{installed_version}")

    root_path = input_directory.absolute()
    if root_path.is_symlink() or not root_path.is_dir():
        _fail("input_directory_must_be_regular_directory")
    root = root_path.resolve(strict=True)
    manifest_bytes, _ = _read_relative(root, "manifest.json", "manifest_file")
    manifest = _check_manifest(_json_bytes(manifest_bytes, "manifest"))
    experiment = manifest["experiment"]
    verifier = manifest["verifier"]

    input_hashes = {"manifest.json": hashlib.sha256(manifest_bytes).hexdigest()}
    rows: list[dict[str, Any]] = []
    for index, entry in enumerate(manifest["attempts"]):
        task_id = entry["task_id"]
        row: dict[str, Any] = {
            "task_id": task_id,
            "category": entry["category"],
            "attempt": entry["attempt"],
            "trial_name": entry["trial_name"],
            "status": "not_run",
            "failure_kind": None,
            "exception_type": None,
            "ligule_run_states": [],
            "ligule_run_state": None,
            "ligule_error_codes": [],
            "verifier_reward_key": verifier["reward_key"],
            "verifier_reward": None,
            "verifier_reward_valid": None,
            "duration_seconds": None,
            "n_input_tokens": None,
            "n_cache_tokens": None,
            "n_uncached_input_tokens": None,
            "n_output_tokens": None,
            "cost_usd": None,
            "model_calls": None,
            "tool_calls": None,
            "tool_failures": None,
            "tool_retries": None,
            "context_compactions": None,
            "subagent_calls": None,
            "subagent_trajectories": None,
            "subagent_trajectory_ids": None,
            "subagent_trajectory_refs": None,
            "subagent_trajectory_missing_calls": None,
            "not_run_reason": entry["not_run_reason"],
            "evidence": [],
        }
        result_path = entry["result_file"]
        if result_path is None:
            rows.append(row)
            continue

        raw_result, result_name = _read_relative(root, result_path, f"attempt_{index}_result")
        input_hashes[result_name] = hashlib.sha256(raw_result).hexdigest()
        try:
            result = TrialResult.model_validate_json(raw_result)
        except Exception as error:
            raise ReportInputError(f"attempt_{index}_not_harbor_0_25_trial_result") from error
        if result.trial_name != entry["trial_name"]:
            _fail(f"attempt_{index}_trial_name_mismatch")
        # Task IDs can contain container POSIX paths. Compare their serialized
        # JSON value so parsing on Windows cannot rewrite them as Windows paths.
        if json.loads(raw_result)["task_id"] != entry["harbor_task_id"]:
            _fail(f"attempt_{index}_harbor_task_id_mismatch")
        ligule_metadata = _ligule_run_metadata(result)
        status, failure_kind, reward = _classify(
            result,
            verifier["reward_key"],
            verifier["pass_threshold"],
            ligule_metadata["ligule_run_state"],
        )
        row.update({
            "status": status,
            "failure_kind": failure_kind,
            "exception_type": result.exception_info.exception_type if result.exception_info is not None else None,
            "verifier_reward": reward,
            "verifier_reward_valid": result.reward_valid and reward is not None,
            "duration_seconds": _duration_seconds(result),
            **_usage(result),
            **ligule_metadata,
        })
        row["not_run_reason"] = None
        row["evidence"].append({"kind": "harbor_trial_result", "path": result_name})

        trajectory_path = entry["trajectory_file"]
        trajectory_raw = None
        if trajectory_path is not None:
            trajectory_raw, trajectory_name = _read_relative(root, trajectory_path, f"attempt_{index}_trajectory")
            input_hashes[trajectory_name] = hashlib.sha256(trajectory_raw).hexdigest()
            trajectory_info = _trajectory_metrics(trajectory_raw, f"attempt_{index}")
            row.update(trajectory_info)
            row["evidence"].append({"kind": "harbor_atif_trajectory", "path": trajectory_name})
        else:
            row.update(_trajectory_metrics(None, f"attempt_{index}"))

        for artifact_path in entry["artifact_files"]:
            artifact_hash, artifact_name = _hash_relative(root, artifact_path, f"attempt_{index}_artifact")
            input_hashes[artifact_name] = artifact_hash
            row["evidence"].append({"kind": "artifact", "path": artifact_name})
        rows.append(row)

    report_material = json.dumps(input_hashes, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "schema_version": REPORT_SCHEMA,
        "source": {
            "manifest_sha256": input_hashes["manifest.json"],
            "evidence_sha256": hashlib.sha256(report_material).hexdigest(),
            "evidence_files": input_hashes,
            "harbor_result_schema": HARBOR_RESULT_SCHEMA,
        },
        "experiment": experiment,
        "verifier": verifier,
        "summary": _summarize(rows),
        "attempts": rows,
    }


def render_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    pass_rate = "unknown" if summary["pass_rate"] is None else f"{summary['pass_rate']:.1%}"
    lines = [
        f"# Evaluation report: {report['experiment']['id']}",
        "",
        f"- Dataset: `{report['experiment']['dataset_id']}` revision `{report['experiment']['dataset_revision']}`",
        f"- Harbor: `{report['experiment']['runner_version']}`; result schema `{report['source']['harbor_result_schema']}`",
        f"- Model: `{report['experiment']['model_id'] or 'unknown'}` via `{report['experiment']['provider'] or 'unknown'}`",
        f"- Planned attempts: {summary['attempts']}; denominator includes fail, not_run, and infra_error.",
        f"- Pass rate: {summary['pass']}/{summary['attempts']} = {pass_rate}.",
        f"- Input evidence SHA-256: `{report['source']['evidence_sha256']}`",
        "",
        "## Status counts",
        "",
        "| pass | fail | not_run | infra_error | denominator |",
        "| ---: | ---: | ---: | ---: | ---: |",
        f"| {summary['pass']} | {summary['fail']} | {summary['not_run']} | {summary['infra_error']} | {summary['attempts']} |",
        "",
        "## Aggregate metrics",
        "",
        "| Metric | Known values | Unknown | Result |",
        "| --- | ---: | ---: | --- |",
    ]
    metrics = (
        ("Elapsed seconds p50/p95", "elapsed_seconds", "distribution"),
        ("Model calls p50/p95", "model_calls", "distribution"),
        ("Tool calls p50/p95", "tool_calls", "distribution"),
        ("Tool failures p50/p95", "tool_failures", "distribution"),
        ("Tool retries p50/p95", "tool_retries", "distribution"),
        ("Context compactions p50/p95", "context_compactions", "distribution"),
    )
    for label, key, result_key in metrics:
        metric = summary[key]
        dist = metric[result_key]
        value = "unknown" if dist["count"] == 0 else f"{dist['p50']} / {dist['p95']}"
        lines.append(f"| {label} | {metric.get('known_count', dist['count'])} | {metric['unknown_count']} | {value} |")
    for label, key in (
        ("Input tokens (includes cache)", "input_tokens_including_cache"),
        ("Cached input tokens", "cache_tokens"),
        ("Uncached input tokens", "uncached_input_tokens"),
        ("Output tokens", "output_tokens"),
        ("Reported cost USD", "reported_cost_usd"),
    ):
        metric = summary[key]
        total = "unknown" if metric["total"] is None else str(metric["total"])
        known = "unknown" if metric["known_subtotal"] is None else str(metric["known_subtotal"])
        lines.append(f"| {label} | {known} | {metric['unknown_count']} | {total} |")
    lines.extend(["", "## By category", "", "| Category | Pass | Fail | Not run | Infrastructure error | Denominator | Pass rate |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"])
    for category, counts in summary["by_category"].items():
        lines.append(f"| {_md(category)} | {counts['pass']} | {counts['fail']} | {counts['not_run']} | {counts['infra_error']} | {counts['attempts']} | {counts['pass_rate']:.1%} |")
    lines.extend(["", "## Failure kind shares", "", "| Failure kind | Count | Denominator | Share |", "| --- | ---: | ---: | ---: |"])
    if summary["failure_kind_rates"]:
        for kind, rate in summary["failure_kind_rates"].items():
            lines.append(f"| {_md(kind)} | {rate['count']} | {rate['denominator']} | {rate['share']:.1%} |")
    else:
        lines.append(f"| — | 0 | {summary['attempts']} | 0.0% |")
    lines.extend(["", "## Attempts", "", "| Task | Category | Attempt | Status | Failure kind | Harbor exception | Ligule run state | Run error code | Reward | Seconds | Tokens in/out | Tools | Evidence |", "| --- | --- | ---: | --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- |"])
    for row in report["attempts"]:
        if row["verifier_reward"] is None:
            reward = "unknown"
        elif row["verifier_reward_valid"]:
            reward = str(row["verifier_reward"])
        else:
            reward = f"{row['verifier_reward']} (invalid)"
        seconds = "unknown" if row["duration_seconds"] is None else f"{row['duration_seconds']:.3f}"
        token_pair = "unknown" if row["n_input_tokens"] is None or row["n_output_tokens"] is None else f"{row['n_input_tokens']} / {row['n_output_tokens']}"
        tools = "unknown" if row["tool_calls"] is None else str(row["tool_calls"])
        run_state = row["ligule_run_state"] or "not_run"
        error_codes = ", ".join(row["ligule_error_codes"]) or "unknown"
        evidence = ", ".join(item["path"] for item in row["evidence"]) or _md(row["not_run_reason"] or "unknown")
        lines.append(f"| {_md(row['task_id'])} | {_md(row['category'])} | {row['attempt']} | {row['status']} | {_md(row['failure_kind'] or '—')} | {_md(row['exception_type'] or '—')} | {_md(run_state)} | {_md(error_codes)} | {reward} | {seconds} | {token_pair} | {tools} | {_md(evidence)} |")
    lines.extend(["", "## Repeated tasks", "", "| Task | Attempts | At least three | Status sequence | Reward p50/p95 | Seconds p50/p95 | Failure kinds |", "| --- | ---: | --- | --- | --- | --- | --- |"])
    if summary["repeated_tasks"]:
        for group in summary["repeated_tasks"]:
            rewards = group["verifier_reward_distribution"]
            durations = group["duration_seconds_distribution"]
            reward_range = "unknown" if rewards["count"] == 0 else f"{rewards['p50']} / {rewards['p95']}"
            duration_range = "unknown" if durations["count"] == 0 else f"{durations['p50']} / {durations['p95']}"
            failures = ", ".join(group["failure_kinds"]) or "—"
            status_sequence = ", ".join(group["status_sequence"])
            lines.append(f"| {_md(group['task_id'])} | {group['attempts']} | {'yes' if group['eligible_minimum_three'] else 'no'} | {status_sequence} | {reward_range} | {duration_range} | {_md(failures)} |")
    else:
        lines.append("| — | 0 | no repeated task | — | — |")
    lines.extend(["", "Token counts and costs remain unknown whenever Harbor did not report complete attributable values. Cost is copied only from Harbor's `AgentContext.cost_usd`; this report does not infer prices. Tool retry counts remain unknown because the accepted result schema does not provide a typed retry total.", ""])
    return "\n".join(lines)


def _md(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def write_report(input_directory: Path, output_directory: Path) -> tuple[Path, Path]:
    input_root = input_directory.resolve(strict=True)
    output_root = output_directory.absolute()
    output_resolved = output_root.resolve(strict=False)
    if output_resolved == input_root or input_root in output_resolved.parents:
        _fail("output_directory_must_be_outside_input_directory")
    if output_root.exists() or output_root.is_symlink():
        _fail("output_directory_already_exists")
    report = build_report(input_directory)
    try:
        output_root.mkdir(parents=True, exist_ok=False)
    except FileExistsError as error:
        raise ReportInputError("output_directory_already_exists") from error
    json_path = output_root / "report.json"
    markdown_path = output_root / "report.md"
    json_content = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    markdown_content = render_markdown(report)
    try:
        with json_path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(json_content)
        with markdown_path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(markdown_content)
    except FileExistsError as error:
        raise ReportInputError("report_output_file_already_exists") from error
    return json_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_directory", type=Path, help="Folder containing manifest.json and Harbor result evidence")
    parser.add_argument("--output-dir", type=Path, required=True, help="Output directory outside the input evidence folder")
    args = parser.parse_args()
    try:
        json_path, markdown_path = write_report(args.input_directory, args.output_dir)
    except ReportInputError as error:
        parser.error(str(error))
    print(json_path)
    print(markdown_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
