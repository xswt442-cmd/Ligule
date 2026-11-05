# Evaluation and benchmark suites

This directory holds the measurement code that is not part of the product packages.
It is split by what it measures, not by who calls it; each runner keeps its own
prerequisites and exit codes, and neither runner imports the other.

| Directory | Command | What it measures |
| --- | --- | --- |
| [perf/](perf/README.md) | `pnpm run bench:perf` | Deterministic harness scenarios (CLI first round, Session JSONL parse/read/list, shell output, MCP receipt lifecycle). Samples and summaries land under `testplace/benchmarks/`. |
| [agent/](agent/README.md) | `pnpm run bench:agent` | The frozen `terminal-bench@2.0` plan, run through Harbor with its independent verifier. |
| [harbor/](harbor/) | — | The Ligule agent adapter and session exporter that `agent/` drives. |
| [report/](report/) | — | Manifest and report generation shared by the agent runner. |

## Layout rule

`perf/` and `agent/` are siblings: the performance harness never runs containers, and
the agent benchmark never measures local timings. `harbor/` and `report/` stay shared,
because both are part of one agent-run pipeline and are imported by `agent/`.

Run both suites' tests with `pnpm run test:bench`. Historical run output belongs in
`testplace/benchmarks/`, which is not tracked; nothing under this directory writes a
run directory into the repository.

## 目录说明

这里的代码不属于产品包，只负责测量，按“测什么”分层：`perf/` 跑确定性的性能场景，
`agent/` 跑冻结的 Terminal-Bench 计划（由 Harbor 的独立 Verifier 判分），`harbor/` 与
`report/` 是 agent 流水线的适配器与报告生成，两个 Runner 互不引用。历史运行产物放在
不纳入版本库的 `testplace/benchmarks/`。
