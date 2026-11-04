from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier

from harbor.models.trial.result import TrialResult

from report import ReportInputError, write_report


WORKSPACE = Path(__file__).resolve().parents[3]
TEMP_ROOT = Path(os.environ.get("LIGULE_EVAL_TEMP_DIR", WORKSPACE / "testplace" / "tmp"))


def harbor_result(
    task_name: str,
    trial_name: str,
    *,
    reward: float | None,
    exception_type: str | None = None,
    elapsed_seconds: int = 60,
    usage: bool = True,
    ligule_metadata: dict[str, object] | None = None,
) -> bytes:
    started = datetime(2026, 10, 28, 8, tzinfo=timezone.utc)
    agent_context = ({
        "n_input_tokens": 100,
        "n_cache_tokens": 25,
        "n_output_tokens": 40,
        "cost_usd": None,
    } if usage else None)
    if ligule_metadata is not None:
        agent_context = {**(agent_context or {}), "metadata": {"ligule": ligule_metadata}}
    data = {
        "task_name": task_name,
        "trial_name": trial_name,
        "trial_uri": f"file:///harbor/jobs/fixture/{trial_name}",
        "task_id": {"path": task_name},
        "task_checksum": "f" * 64,
        "config": {"task": {"path": task_name}},
        "agent_info": {
            "name": "ligule",
            "version": "0.1.1-dev",
            "model_info": {"name": "fixture-model", "provider": "fixture-provider"},
        },
        "verifier_result": None if reward is None else {"rewards": {"reward": reward}},
        "agent_result": agent_context,
        "started_at": started.isoformat(),
        "finished_at": (started + timedelta(seconds=elapsed_seconds)).isoformat(),
    }
    if exception_type is not None:
        data["exception_info"] = {
            "exception_type": exception_type,
            "exception_message": "fixture exception",
            "exception_traceback": "fixture traceback",
            "occurred_at": (started + timedelta(seconds=elapsed_seconds)).isoformat(),
        }
    return TrialResult.model_validate(data).model_dump_json(indent=2).encode("utf-8")


def trajectory() -> bytes:
    value = {
        "schema_version": "ATIF-v1.8",
        "agent": {"name": "ligule", "version": "0.1.1-dev"},
        "steps": [
            {"step_id": 1, "source": "user", "message": "inspect the fixture"},
            {
                "step_id": 2,
                "source": "agent",
                "message": "read the file",
                "llm_call_count": 2,
                "tool_calls": [{"tool_call_id": "call-1", "function_name": "read", "arguments": {}}],
                "observation": {"results": [{
                    "source_call_id": "call-1",
                    "extra": {"ligule": {"outcome": "failed"}},
                }]},
            },
            {
                "step_id": 3,
                "source": "system",
                "message": "Context compaction recorded.",
                "extra": {"context_management": {"type": "compaction"}},
            },
        ],
    }
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def trajectory_with_missing_subagent() -> bytes:
    value = json.loads(trajectory())
    agent = value["steps"][1]
    agent["tool_calls"].append({
        "tool_call_id": "call-subagent",
        "function_name": "subagent",
        "arguments": {},
        "extra": {"ligule": {"subagent_trajectory_missing": True}},
    })
    agent["observation"]["results"].append({
        "source_call_id": "call-subagent",
        "extra": {"ligule": {"outcome": "completed", "subagent_trajectory_missing": True}},
    })
    value["extra"] = {"ligule": {"missing_features": ["subagent_trajectory"]}}
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def manifest() -> dict[str, object]:
    task_id = {"path": "task-alpha"}
    return {
        "schema_version": "ligule.eval-manifest.v1",
        "experiment": {
            "id": "fixture-eval",
            "git_sha": "a" * 40,
            "working_tree_dirty": False,
            "runner_name": "harbor",
            "runner_version": "0.25.0",
            "dataset_id": "fixture-dataset",
            "dataset_revision": "sha256:fixture-revision",
            "docker_image_digest": None,
            "model_id": "fixture-model",
            "provider": "fixture-provider",
            "config_sha256": None,
            "tool_mode": "read-only",
            "policy_mode": "never",
            "permissions": {"filesystem": "read-only", "network": "disabled"},
            "limits": {"model_calls": 3, "timeout_ms": 60000},
            "node_version": None,
            "os": "fixture-os",
            "started_at": "2026-10-28T08:00:00Z",
            "finished_at": "2026-10-28T08:30:00Z",
            "expected_evaluation": "independent Harbor verifier",
        },
        "verifier": {
            "result_schema": "harbor.models.trial.result.TrialResult@0.25.0",
            "reward_key": "reward",
            "pass_threshold": 1.0,
        },
        "attempts": [
            {
                "task_id": "alpha", "category": "build", "attempt": 1,
                "trial_name": "alpha-attempt-1", "harbor_task_id": task_id,
                "result_file": "trials/alpha-1/result.json",
                "trajectory_file": "trials/alpha-1/trajectory.json",
                "artifact_files": ["trials/alpha-1/artifacts/diff.txt"], "not_run_reason": None,
            },
            {
                "task_id": "alpha", "category": "build", "attempt": 2,
                "trial_name": "alpha-attempt-2", "harbor_task_id": task_id,
                "result_file": "trials/alpha-2/result.json", "trajectory_file": None,
                "artifact_files": [], "not_run_reason": None,
            },
            {
                "task_id": "alpha", "category": "build", "attempt": 3,
                "trial_name": "alpha-attempt-3", "harbor_task_id": task_id,
                "result_file": "trials/alpha-3/result.json", "trajectory_file": None,
                "artifact_files": [], "not_run_reason": None,
            },
            {
                "task_id": "beta", "category": "debug", "attempt": 1,
                "trial_name": "beta-attempt-1", "harbor_task_id": {"path": "task-beta"},
                "result_file": "trials/beta-1/result.json", "trajectory_file": None,
                "artifact_files": [], "not_run_reason": None,
            },
            {
                "task_id": "gamma", "category": "debug", "attempt": 1,
                "trial_name": None, "harbor_task_id": None, "result_file": None,
                "trajectory_file": None, "artifact_files": [], "not_run_reason": "not started",
            },
        ],
    }


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")


class ReportTests(unittest.TestCase):
    def test_model_call_total_is_unknown_when_a_subagent_trajectory_is_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-subagent-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            attempt = dict(value["attempts"][0])
            attempt["artifact_files"] = []
            value["attempts"] = [attempt]
            write_json(root / "manifest.json", value)
            write_json(root / "trials/alpha-1/result.json", json.loads(harbor_result(
                "task-alpha", "alpha-attempt-1", reward=1.0,
                ligule_metadata={"state": "completed"},
            )))
            (root / "trials/alpha-1/trajectory.json").write_bytes(trajectory_with_missing_subagent())

            report_json, _ = write_report(root, Path(temporary) / "output")
            row = json.loads(report_json.read_text(encoding="utf-8"))["attempts"][0]

            self.assertEqual(row["subagent_trajectory_missing_calls"], ["call-subagent"])
            self.assertIsNone(row["model_calls"])

    def test_actual_session_atif_is_counted_by_report(self) -> None:
        atif_path = os.environ.get("LIGULE_ATIF_OUTPUT_PATH")
        if not atif_path or not Path(atif_path).is_file():
            self.skipTest("eval:smoke supplies the real Session-to-ATIF fixture")
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-session-atif-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            attempt = dict(value["attempts"][0])
            attempt["artifact_files"] = []
            value["attempts"] = [attempt]
            write_json(root / "manifest.json", value)
            write_json(root / "trials/alpha-1/result.json", json.loads(harbor_result(
                "task-alpha", "alpha-attempt-1", reward=0.0,
                ligule_metadata={"state": "failed", "errorCode": "task_failed"},
            )))
            (root / "trials/alpha-1/trajectory.json").write_bytes(Path(atif_path).read_bytes())

            report_json, _ = write_report(root, Path(temporary) / "output")
            row = json.loads(report_json.read_text(encoding="utf-8"))["attempts"][0]

            self.assertEqual(row["status"], "fail")
            self.assertEqual(row["ligule_run_state"], "failed")
            self.assertEqual(row["model_calls"], 2)

    def test_failed_ligule_run_cannot_pass_from_a_valid_harbor_reward(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-failed-run-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            attempt = dict(value["attempts"][0])
            attempt["trajectory_file"] = None
            attempt["artifact_files"] = []
            value["attempts"] = [attempt]
            write_json(root / "manifest.json", value)
            write_json(root / "trials/alpha-1/result.json", json.loads(harbor_result(
                "task-alpha",
                "alpha-attempt-1",
                reward=1.0,
                exception_type="AgentTimeoutError",
                ligule_metadata={"state": "failed", "errorCode": "agent_timeout"},
            )))

            report_json, _ = write_report(root, Path(temporary) / "output")
            report = json.loads(report_json.read_text(encoding="utf-8"))

            self.assertEqual(report["attempts"][0]["status"], "fail")
            self.assertEqual(report["attempts"][0]["failure_kind"], "timeout")
            self.assertTrue(report["attempts"][0]["verifier_reward_valid"])
            self.assertEqual(report["attempts"][0]["verifier_reward"], 1.0)
            self.assertEqual(report["summary"]["pass_rate"], 0.0)

    def test_failed_ligule_run_without_harbor_exception_cannot_pass(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-failed-run-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            attempt = dict(value["attempts"][0])
            attempt["trajectory_file"] = None
            attempt["artifact_files"] = []
            value["attempts"] = [attempt]
            write_json(root / "manifest.json", value)
            write_json(root / "trials/alpha-1/result.json", json.loads(harbor_result(
                "task-alpha",
                "alpha-attempt-1",
                reward=1.0,
                ligule_metadata={"state": "failed", "errorCode": "loop_model_budget_exhausted"},
            )))

            report_json, _ = write_report(root, Path(temporary) / "output")
            report = json.loads(report_json.read_text(encoding="utf-8"))
            row = report["attempts"][0]

            self.assertEqual(row["status"], "fail")
            self.assertEqual(row["failure_kind"], "task_failed")
            self.assertEqual(row["ligule_run_state"], "failed")
            self.assertEqual(row["ligule_error_codes"], ["loop_model_budget_exhausted"])
            self.assertEqual(row["verifier_reward"], 1.0)
            self.assertEqual(report["summary"]["pass_rate"], 0.0)

    def test_missing_or_unknown_ligule_state_cannot_claim_a_clean_pass(self) -> None:
        for suffix, ligule_metadata in (("missing", None), ("unknown", {"state": "unknown"})):
            with self.subTest(state=suffix), tempfile.TemporaryDirectory(
                prefix="ligule-eval-report-unknown-run-", dir=TEMP_ROOT
            ) as temporary:
                root = Path(temporary) / "input"
                root.mkdir()
                value = manifest()
                attempt = dict(value["attempts"][0])
                attempt["trajectory_file"] = None
                attempt["artifact_files"] = []
                value["attempts"] = [attempt]
                write_json(root / "manifest.json", value)
                write_json(root / "trials/alpha-1/result.json", json.loads(harbor_result(
                    "task-alpha",
                    "alpha-attempt-1",
                    reward=1.0,
                    ligule_metadata=ligule_metadata,
                )))

                report_json, _ = write_report(root, Path(temporary) / "output")
                report = json.loads(report_json.read_text(encoding="utf-8"))
                row = report["attempts"][0]

                self.assertEqual(row["status"], "infra_error")
                self.assertEqual(row["failure_kind"], "ligule_run_state_unknown")
                self.assertEqual(row["ligule_run_state"], "unknown")
                self.assertEqual(row["verifier_reward"], 1.0)
                self.assertEqual(report["summary"]["pass_rate"], 0.0)

    def test_nonzero_agent_exit_preserves_harbor_and_ligule_failure_axes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-nonzero-exit-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            attempts = []
            cases = [
                ("loop_model_budget_exhausted", "failed"),
                ("loop_model_budget_exhausted", "failed"),
                ("loop_model_budget_exhausted", "failed"),
                ("loop_model_budget_exhausted", "failed"),
                ("provider_output_exhausted", "failed"),
                ("provider_output_exhausted", "failed"),
                ("task_request_timeout", "failed"),
                (None, None),
                (None, "unknown"),
                (None, "unknown"),
            ]
            for index, (error_code, run_state) in enumerate(cases, start=1):
                trial_name = f"alpha-attempt-{index}"
                result_file = f"trials/alpha-{index}/result.json"
                attempt = dict(value["attempts"][0])
                attempt.update({
                    "attempt": index,
                    "trial_name": trial_name,
                    "result_file": result_file,
                    "trajectory_file": None,
                    "artifact_files": [],
                })
                attempts.append(attempt)
                metadata = None if run_state is None and error_code is None else {
                    **({} if run_state is None else {"state": run_state}),
                    **({} if error_code is None else {"errorCode": error_code}),
                }
                write_json(root / result_file, json.loads(harbor_result(
                    "task-alpha",
                    trial_name,
                    reward=0.0,
                    exception_type="NonZeroAgentExitCodeError",
                    ligule_metadata=metadata,
                )))
            value["attempts"] = attempts
            write_json(root / "manifest.json", value)

            report_json, _ = write_report(root, Path(temporary) / "output")
            report = json.loads(report_json.read_text(encoding="utf-8"))

        self.assertEqual(report["summary"]["attempts"], 10)
        self.assertEqual(report["schema_version"], "ligule.eval-report.v2")
        self.assertEqual(report["summary"]["failure_kind_counts"], {"agent_nonzero_exit": 10})
        self.assertEqual(report["summary"]["reported_ligule_error_code_counts"], {
            "loop_model_budget_exhausted": 4,
            "provider_output_exhausted": 2,
            "task_request_timeout": 1,
        })
        for row in report["attempts"]:
            self.assertEqual(row["status"], "infra_error")
            self.assertEqual(row["failure_kind"], "agent_nonzero_exit")
            self.assertEqual(row["exception_type"], "NonZeroAgentExitCodeError")
        self.assertTrue(all(row["ligule_run_state"] == "failed" for row in report["attempts"][:7]))
        self.assertEqual(report["attempts"][0]["ligule_error_codes"], ["loop_model_budget_exhausted"])
        self.assertEqual([row["ligule_run_state"] for row in report["attempts"][7:]], ["unknown", "unknown", "unknown"])
        self.assertEqual([row["ligule_error_codes"] for row in report["attempts"][7:]], [[], [], []])

    def test_harbor_posix_task_id_is_compared_without_host_path_normalization(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-posix-task-id-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            attempt = dict(value["attempts"][0])
            attempt["trajectory_file"] = None
            attempt["artifact_files"] = []
            harbor_task_id = {"path": "/app/task-alpha"}
            attempt["harbor_task_id"] = harbor_task_id
            value["attempts"] = [attempt]
            write_json(root / "manifest.json", value)
            result = json.loads(harbor_result(
                "task-alpha",
                "alpha-attempt-1",
                reward=1.0,
                ligule_metadata={"state": "completed"},
            ))
            result["task_id"] = harbor_task_id
            write_json(root / "trials/alpha-1/result.json", result)

            report_json, _ = write_report(root, Path(temporary) / "output")
            report = json.loads(report_json.read_text(encoding="utf-8"))

            self.assertEqual(report["attempts"][0]["status"], "pass")

    def test_real_harbor_folder_fixture_produces_deterministic_reports(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            fixture = manifest()
            write_json(root / "manifest.json", fixture)
            write_json(root / "trials/alpha-1/result.json", json.loads(harbor_result(
                "task-alpha", "alpha-attempt-1", reward=1.0,
                ligule_metadata={"state": "completed"},
            )))
            (root / "trials/alpha-1/trajectory.json").write_bytes(trajectory())
            (root / "trials/alpha-1/artifacts/diff.txt").parent.mkdir(parents=True)
            (root / "trials/alpha-1/artifacts/diff.txt").write_text("verified fixture artifact\n", encoding="utf-8")
            write_json(root / "trials/alpha-2/result.json", json.loads(harbor_result(
                "task-alpha", "alpha-attempt-2", reward=0.0, elapsed_seconds=120,
                ligule_metadata={"state": "completed"},
            )))
            write_json(root / "trials/alpha-3/result.json", json.loads(harbor_result(
                "task-alpha", "alpha-attempt-3", reward=None, exception_type="AgentTimeoutError",
                elapsed_seconds=300, usage=False,
                ligule_metadata={"state": "failed", "errorCode": "agent_timeout"},
            )))
            write_json(root / "trials/beta-1/result.json", json.loads(harbor_result("task-beta", "beta-attempt-1", reward=None, exception_type="SandboxBuildFailedError", elapsed_seconds=10, usage=False)))

            output_one = Path(temporary) / "output-one"
            output_two = Path(temporary) / "output-two"
            output_three = Path(temporary) / "output-three"
            json_one, markdown_one = write_report(root, output_one)
            json_two, markdown_two = write_report(root, output_two)
            script = Path(__file__).with_name("report.py")
            subprocess.run(
                [sys.executable, str(script), str(root), "--output-dir", str(output_three)],
                check=True,
                capture_output=True,
                text=True,
            )
            json_three = output_three / "report.json"
            markdown_three = output_three / "report.md"

            self.assertEqual(json_one.read_bytes(), json_two.read_bytes())
            self.assertEqual(markdown_one.read_bytes(), markdown_two.read_bytes())
            self.assertEqual(json_one.read_bytes(), json_three.read_bytes())
            self.assertEqual(markdown_one.read_bytes(), markdown_three.read_bytes())
            report = json.loads(json_one.read_text(encoding="utf-8"))
            self.assertEqual([row["status"] for row in report["attempts"]], ["pass", "fail", "fail", "infra_error", "not_run"])
            self.assertEqual(report["attempts"][0]["ligule_run_state"], "completed")
            self.assertEqual(report["attempts"][1]["ligule_run_state"], "completed")
            self.assertEqual(report["summary"]["attempts"], 5)
            self.assertEqual(report["summary"]["pass_rate"], 0.2)
            self.assertEqual(report["summary"]["failure_kind_rates"]["timeout"]["denominator"], 5)
            self.assertEqual(report["summary"]["failure_kind_rates"]["timeout"]["share"], 0.2)
            self.assertEqual(report["summary"]["by_category"]["build"]["attempts"], 3)
            self.assertEqual(report["summary"]["elapsed_seconds"]["distribution"]["p50"], 60.0)
            self.assertEqual(report["summary"]["elapsed_seconds"]["distribution"]["p95"], 300.0)
            self.assertEqual(report["attempts"][2]["failure_kind"], "timeout")
            self.assertEqual(report["attempts"][2]["ligule_run_state"], "failed")
            self.assertEqual(report["attempts"][2]["ligule_error_codes"], ["agent_timeout"])
            self.assertEqual(report["attempts"][3]["failure_kind"], "environment_failed")
            self.assertIsNone(report["attempts"][4]["ligule_run_state"])
            self.assertEqual(report["summary"]["input_tokens_including_cache"]["known_subtotal"], 200)
            self.assertIsNone(report["summary"]["input_tokens_including_cache"]["total"])
            self.assertIsNone(report["summary"]["reported_cost_usd"]["total"])
            self.assertEqual(report["attempts"][0]["tool_calls"], 1)
            self.assertEqual(report["attempts"][0]["model_calls"], 2)
            self.assertEqual(report["attempts"][0]["tool_failures"], 1)
            self.assertEqual(report["attempts"][0]["context_compactions"], 1)
            self.assertIsNone(report["attempts"][0]["tool_retries"])
            self.assertEqual(report["summary"]["repeated_tasks"][0]["eligible_minimum_three"], True)
            repeated = report["summary"]["repeated_tasks"][0]
            self.assertEqual(repeated["status_sequence"], ["pass", "fail", "fail"])
            self.assertEqual(repeated["verifier_reward_distribution"]["unknown_count"], 1)
            self.assertEqual(repeated["duration_seconds_distribution"]["p50"], 120.0)
            markdown = markdown_one.read_text(encoding="utf-8")
            self.assertIn("| Status | Failure kind | Harbor exception | Ligule run state |", markdown)
            self.assertIn("| pass | — | — | completed |", markdown)
            self.assertIn("| not_run | — | — | not_run |", markdown)
            self.assertIn("denominator includes fail, not_run, and infra_error", markdown)

            partial_output = Path(temporary) / "partial-output"
            partial_output.mkdir()
            original_json = b"preserve existing report\n"
            (partial_output / "report.json").write_bytes(original_json)
            with self.assertRaisesRegex(ReportInputError, "output_directory_already_exists"):
                write_report(root, partial_output)
            self.assertEqual((partial_output / "report.json").read_bytes(), original_json)
            self.assertFalse((partial_output / "report.md").exists())

            race_output = Path(temporary) / "concurrent-output"
            barrier = Barrier(2)

            def concurrent_writer() -> tuple[Path, Path] | ReportInputError:
                barrier.wait()
                try:
                    return write_report(root, race_output)
                except ReportInputError as error:
                    return error

            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = list(executor.map(lambda _index: concurrent_writer(), range(2)))
            self.assertEqual(sum(isinstance(outcome, tuple) for outcome in outcomes), 1)
            self.assertEqual(sum(isinstance(outcome, ReportInputError) for outcome in outcomes), 1)
            self.assertTrue((race_output / "report.json").is_file())
            self.assertTrue((race_output / "report.md").is_file())

    def test_unconfirmed_harbor_result_schema_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-schema-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            value["verifier"]["result_schema"] = "unknown"
            write_json(root / "manifest.json", value)
            with self.assertRaisesRegex(ReportInputError, "harbor_result_schema_unconfirmed"):
                write_report(root, Path(temporary) / "output")

    def test_policy_must_match_the_adapter_policy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-policy-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            value["experiment"]["policy_mode"] = "none"
            write_json(root / "manifest.json", value)
            with self.assertRaisesRegex(ReportInputError, "experiment_policy_mode_invalid"):
                write_report(root, Path(temporary) / "output")

    def test_missing_result_file_is_not_silently_counted_as_not_run(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ligule-eval-report-missing-", dir=TEMP_ROOT) as temporary:
            root = Path(temporary) / "input"
            root.mkdir()
            value = manifest()
            write_json(root / "manifest.json", value)
            with self.assertRaisesRegex(ReportInputError, "attempt_0_result_missing"):
                write_report(root, Path(temporary) / "output")


if __name__ == "__main__":
    unittest.main()
