<div align="center">
  <img src="tui/docs/app-icon.png" alt="Ligule" width="88" height="88">
  <h1>Ligule</h1>
  <p>A CLI, TUI, and desktop AI assistant built on a shared Agent Core</p>
  <p>
    <a href="README.md">简体中文</a> ·
    <a href="desktop/README.en.md">Desktop</a> ·
    <a href="tui/README.en.md">CLI / TUI</a> ·
    <a href="core/README.en.md">Core</a>
  </p>
  <p>
    <a href="https://github.com/xswt442-cmd/ligule/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xswt442-cmd/ligule/actions/workflows/ci.yml/badge.svg?branch=main"></a>
    <a href="https://img.shields.io/npm/v/ligule"><img alt="npm" src="https://img.shields.io/npm/v/ligule?label=CLI%20%2F%20TUI&color=4d6bfe"></a>
    <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/static/v1?label=node&message=%3E%3D24&color=339933&logo=node.js&logoColor=white"></a>
    <a href="https://github.com/xswt442-cmd/ligule/releases/latest"><img alt="Desktop release" src="https://img.shields.io/github/v/release/xswt442-cmd/ligule?label=Desktop&color=657483"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-22c55e.svg"></a>
  </p>
</div>

## Downloads

Get the desktop app from [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/latest). Windows packages use NSIS; Linux packages include AppImage and deb.

Install the CLI and TUI from npm:

```sh
npm install -g ligule
```

## Features

- **Shared project context:** sessions belong to workspaces, with branching from completed turns and Markdown export.
- **Controlled tool use:** files, commands, Skills, and MCP follow Permission boundaries, Policy risk checks, and approvals.
- **Three interfaces:** use the CLI for scripts and one-off tasks, or the TUI and desktop app for ongoing work.
- **Shared Agent Core:** the Host coordinates models and tools; the Kernel validates and enforces Policy; recoverable Session JSONL records execution.
- **Agent Control:** pre-authorize project-bound permission ceilings for local MCP controllers, which can manage sessions without exceeding the grant or bypassing hard denials. After a controller restart, `ligule_run_get` reads an authorized durable receipt without reacquiring the Session writer lock.

## Agent framework

The CLI/TUI and desktop app share the [Agent Core](core/README.en.md). The Node.js Host coordinates models, configuration, and sessions; the Kernel validates tool arguments, resolved targets, and Policy decisions. Session records support recovery without automatically replaying unresolved tool calls. Electron uses a separate Host process with the same execution semantics.

## Quick start

The CLI and TUI require Node.js 24 or newer. Run a one-off task from a project directory:

Before the first run, configure a model service and credentials. See [Configure a model service](docs/guide.en.md#configure-a-model-service); Desktop users can add one in Settings → Model services.

```sh
cd /path/to/your-project
ligule run "Review the project structure and suggest improvements"
```

Run `ligule` to start the terminal UI. The desktop app prepares a default workspace on first launch; you can change it in Settings.

## Interface preview

![Desktop new session](docs/assets/desktop-first-session.png)

![TUI commands and keyboard help](docs/assets/tui-help.png)

## Configuration

Configure services and models in Desktop Settings. The CLI/TUI use the same configuration. See the [user guide](docs/guide.en.md) for configuration fields, credential sources, and model selection. Set `LIGULE_HOME` to an absolute path to change the user data root.

## Documentation

- [简体中文使用手册](docs/guide.zh-CN.md) · [User guide](docs/guide.en.md)
- [Agent Control（MCP）指南](docs/agent-control/guide.zh-CN.md) · [Agent Control guide (English)](docs/agent-control/guide.en.md)
- [架构说明](docs/development/ARCHITECTURE.zh-cn.md) · [Architecture](docs/development/ARCHITECTURE.en.md)
- [贡献与验证](docs/development/CONTRIBUTING.zh-cn.md) · [Contributing and checks](docs/development/CONTRIBUTING.en.md)
- [CLI/TUI changelog](tui/CHANGELOG.md) · [Desktop changelog](desktop/CHANGELOG.md)
- [Maintainer release procedure](docs/development/RELEASE.md)

## License

[MIT](LICENSE)
