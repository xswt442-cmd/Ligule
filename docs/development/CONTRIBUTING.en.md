# Contributing

[简体中文](CONTRIBUTING.zh-cn.md) · [English](CONTRIBUTING.en.md)

The repository contains the Node.js runtime, TUI, and Electron desktop app. Read the root [Agent guide](../../AGENTS.md) and the local `AGENTS.md` for the directory you are changing before editing it. The [architecture guide](ARCHITECTURE.en.md) describes ownership and data flow; the [glossary](GLOSSARY.en.md) defines shared terms.

## Set up and validate

Use Node.js 24 or newer. The workspace pins pnpm to 12.9.1. From the repository root, install the locked dependencies and run the core checks:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check:syntax
pnpm check-pack
pnpm verify-install
```

`pnpm test` builds `dist/` and runs the automated test suite; `pnpm check-pack` inspects the CLI npm artifact; `pnpm verify-install` installs it into a clean consumer and performs a real search. The consumer install uses npm to verify the CLI's npm installation path.

Core's package tests live under `core/tests/`, TUI tests under `tui/tests/`, and cross-package integration tests under the repository-level `tests/`. Desktop frontend check scripts live under `desktop/frontend/tests/checks/`; development support stays under `desktop/frontend/dev/`. Run the complete suite with `pnpm test` to include Core, TUI, and cross-package tests.

Tests are TypeScript (`*.test.ts`) and run with Node 24 type stripping; `pnpm build` typechecks the Core, TUI, integration, and benchmark projects. Shared Host fixtures live in `core/tests/helpers/`; TUI tests use the thin `tui/tests/helpers/tui-host.ts` adapter. A few platform runners and fixtures stay `.mjs` or `.cjs` where the Electron runtime, native shim, or external tool contract requires it.

The MCP integration in `tests/mcp-server.test.ts` uses a real SDK stdio client, a local HTTP model endpoint, persistent Session records, Policy decisions and child processes. Run it directly with `node --experimental-strip-types --test --import ./tests/hooks/isolated-data-root.ts tests/mcp-server.test.ts`. The standalone client in `tests/helpers/mcp-control.mjs` accepts explicit installed CLI and SDK paths so the same control calls can be checked outside the checkout. See the [Agent Control via MCP guide](../agent-control/guide.en.md) for tool and permission semantics. A deterministic model endpoint does not count as a real external model service test.

## Desktop development

Prepare the local runtime tree and Electron binary, then run the frontend checks:

```sh
pnpm run build:core
pnpm run prepare-runtime
pnpm --filter ligule-desktop exec install-electron
pnpm exec tsc -p desktop/electron/tsconfig.json
node --experimental-strip-types --test desktop/electron/tests/host.test.ts desktop/electron/tests/security.test.ts
pnpm --filter ligule-desktop-frontend run check
pnpm --filter ligule-desktop-frontend run build
pnpm --filter ligule-desktop run dev
```

Cross-platform installers, real-window checks, and native acceptance require the matching Electron runtime. Before running acceptance, confirm that the build target and runtime architecture match the operating system; report platform coverage from checks actually run.

## Benchmarks

`pnpm run bench:perf` runs the deterministic harness scenarios (CLI first round, Session JSONL parse/read/list, shell output, MCP receipt lifecycle) and writes raw samples plus JSON/Markdown summaries under `testplace/benchmarks/`. `pnpm run bench:agent` runs the frozen `terminal-bench@2.0` plan through the Harbor adapter; it requires Docker, a CLI tarball, provider settings, the frozen dataset, and a Node 24 Linux runtime for images without Node. Both commands record the Git SHA, tarball digest, model/API, budget, and platform. A blocked prerequisite is reported as `BLOCKED`, never as a score. See [benchmarks/README.md](../../benchmarks/README.md) and [evals/benchmarks/README.md](../../evals/benchmarks/README.md).

## Keep changes verifiable

Document behavior from the implementation and its tests. Keep user-facing claims consistent in the Chinese and English guides, and distinguish automated coverage from platform or human verification. Do not put credentials, personal session records, or generated `desktop/vendor/` files in commits. Update `pnpm-lock.yaml` when a dependency changes.

The default CI run covers the core tests and clean CLI consumer install on Windows and Linux, with Desktop runtime and window checks on Windows x64 and Linux x64. A manually dispatched run can also check native credentials and Desktop compatibility on macOS arm64 and x64; those macOS jobs are allowed to fail. The regular CI workflow does not build installers; the separate [Desktop release workflow](../../.github/workflows/desktop-publish.yml) builds Windows and Linux installers when dispatched for a reviewed release tag. CI artifacts are validation outputs, not public releases. The release recovery procedure is documented in the [maintainer release guide](RELEASE.md).

## Related guides

The [architecture guide](ARCHITECTURE.en.md) describes the dependency direction between the kernel and adapters. The [user guide](../guide.en.md) explains CLI, TUI, and desktop workflows.
