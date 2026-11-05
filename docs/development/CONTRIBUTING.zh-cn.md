# 贡献与验证

[简体中文](CONTRIBUTING.zh-cn.md) · [English](CONTRIBUTING.en.md)

仓库包含 Node.js 运行时、TUI 和 Electron 桌面应用。开始修改前，请阅读仓库根目录的 [Agent 指南](../../AGENTS.md)及目标目录中的 `AGENTS.md`。[架构说明](ARCHITECTURE.zh-cn.md)介绍组件归属和数据流；[术语表](GLOSSARY.zh-cn.md)统一项目用语。

## 安装与验证

使用 Node.js 24 或更新版本；仓库固定使用 pnpm 12.9.1。从仓库根目录安装锁定的依赖并运行核心检查：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check:syntax
pnpm check-pack
pnpm verify-install
```

`pnpm test` 会构建 `dist/` 并运行自动化测试；`pnpm check-pack` 检查 CLI npm 包产物；`pnpm verify-install` 会将该产物安装到干净的消费者环境并运行真实搜索。消费者安装使用 npm，以验证 CLI 的 npm 安装路径。

Core 包内测试位于 `core/tests/`，TUI 测试位于 `tui/tests/`，跨模块集成测试位于仓库根目录的 `tests/`。桌面前端检查脚本位于 `desktop/frontend/tests/checks/`，开发辅助文件保留在 `desktop/frontend/dev/`。运行完整套件请使用 `pnpm test`，其中包含 Core、TUI 和跨模块测试。

测试使用 TypeScript（`*.test.ts`），由 Node 24 的类型剥离直接运行；`pnpm build` 会类型检查 Core、TUI、集成与 Benchmark 项目。共享 Host 辅助位于 `core/tests/helpers/`；TUI 测试使用轻量的 `tui/tests/helpers/tui-host.ts` 适配层。少数平台运行器与 fixture 因 Electron 运行时、原生 shim 或外部工具契约保留为 `.mjs` 或 `.cjs`。

`tests/mcp-server.test.ts` 通过真实 SDK stdio 客户端、本地 HTTP 模型端点、持久 Session 记录、Policy 与子进程验证外控。可单独运行 `node --experimental-strip-types --test --import ./tests/hooks/isolated-data-root.ts tests/mcp-server.test.ts`。`tests/helpers/mcp-control.mjs` 独立客户端接受明确的已安装 CLI 和 SDK 路径，可在检出目录之外检查相同控制调用。工具与权限语义见 [Agent Control（MCP）指南](../agent-control/guide.zh-CN.md)。确定性模型端点测试不代表真实外部模型服务验收。

## 桌面开发

准备本机运行树、Electron 二进制和前端检查：

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

跨平台安装包、真实窗口和平台原生验收使用对应平台的 Electron 运行时。运行验收前，确认构建目标、运行时架构与当前操作系统一致；只根据实际执行结果记录平台覆盖情况。

## 基准测试

`pnpm run bench:perf` 运行确定性的 Harness 场景（CLI 首轮任务、Session JSONL 解析/读取/列表、Shell 输出、MCP 回执生命周期），原始样本与 JSON/Markdown 摘要写入 `testplace/benchmarks/`。`pnpm run bench:agent` 通过 Harbor 适配器运行冻结的 `terminal-bench@2.0` 计划；需要 Docker、CLI tarball、提供方设置、冻结数据集，以及为没有 Node 的镜像准备的 Node 24 Linux 运行时。`bench:perf` 记录 Git SHA 与平台；`bench:agent` 另外记录 tarball 摘要、模型/API 与预算。缺少前置条件时报告 `BLOCKED`，不会当作得分。详见 [evals/perf/README.md](../../evals/perf/README.md) 与 [evals/agent/README.md](../../evals/agent/README.md)。

## 让改动可核验

从实现和测试描述行为。保持中文与英文使用手册中的用户可见行为一致，并区分自动化覆盖、平台验证和人工验证。提交中不要加入凭据、个人会话记录或生成的 `desktop/vendor/` 文件。依赖变动要同时更新包清单和 `pnpm-lock.yaml`。

默认 CI 会运行核心测试与 CLI 干净消费者安装，并在 Windows x64、Linux x64 检查 Desktop 运行树和窗口。手动启动的 CI 可以额外检查 macOS arm64 与 x64 的原生凭据和 Desktop 兼容性；macOS 检查允许失败。常规 CI 不构建安装包；经审核的发行 Tag 通过独立的 [Desktop 发行工作流](../../.github/workflows/desktop-publish.yml)手动启动后，才会构建 Windows 与 Linux 安装包。CI 产物用于验证，不代表公开发行。发行故障处理见[维护者发行说明](RELEASE.md)。

## 相关文档

[架构说明](ARCHITECTURE.zh-cn.md)介绍内核和适配器的依赖方向；[使用手册](../guide.zh-CN.md)介绍 CLI、TUI 和桌面端的用户操作。
