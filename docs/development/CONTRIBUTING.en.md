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

The MCP integration in `tests/mcp-server.test.js` uses a real SDK stdio client, a local HTTP model endpoint, persistent Session records, Policy decisions and child processes. Run it directly with `node --test --import ./tests/hooks/isolated-data-root.ts tests/mcp-server.test.js`. The standalone client in `tests/helpers/mcp-control.mjs` accepts explicit installed CLI and SDK paths so the same control calls can be checked outside the checkout. See the [Agent Control via MCP guide](../agent-control/guide.en.md) for tool and permission semantics. A deterministic model endpoint does not count as a real external model service test.

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

## Keep changes verifiable

Document behavior from the implementation and its tests. Keep user-facing claims consistent in the Chinese and English guides, and distinguish automated coverage from platform or human verification. Do not put credentials, personal session records, or generated `desktop/vendor/` files in commits. Update `pnpm-lock.yaml` when a dependency changes.

The default CI run covers the core tests and clean CLI consumer install on Windows and Linux, with Desktop runtime and window checks on Windows x64 and Linux x64. A manually dispatched run can also check native credentials and Desktop compatibility on macOS arm64 and x64; those macOS jobs are allowed to fail. The regular CI workflow does not build installers; the separate [Desktop release workflow](../../.github/workflows/desktop-publish.yml) builds Windows and Linux installers when dispatched for a reviewed release tag. CI artifacts are validation outputs, not public releases. The release recovery procedure is documented in the [maintainer release guide](RELEASE.md).

## Related guides

The [architecture guide](ARCHITECTURE.en.md) describes the dependency direction between the kernel and adapters. The [user guide](../guide.en.md) explains CLI, TUI, and desktop workflows.
