# 维护者发行说明

Ligule 分为两条独立发行线，版本可分别推进：

| 产品 | 版本来源 | 标签 | 发布渠道 | 正式资产 |
| --- | --- | --- | --- | --- |
| CLI / TUI | `tui/package.json`、`tui/src/version.ts`、`tui/CHANGELOG.md` | `cli-vX.Y.Z` | npm `ligule` + GitHub Release Notes | npm 包；GitHub 仅发布说明，不附安装包 |
| Desktop | `desktop/package.json`、`desktop/CHANGELOG.md` | `desktop-vX.Y.Z` | GitHub Release | Windows x64 NSIS、Linux x64 AppImage 与 deb |

`@ligule/core` 是私有 workspace 包，不设独立产品版本、Tag 或 Changelog。Core 修改分别按产品实际打入的 Core 代码记录在对应产品 Changelog 中；不得提前登记尚未包含的修复。前端私有包版本不代表产品版本。单独调整版本时不改写依赖锁文件。macOS 构建只作为手动可选检查，当前不属于正式资产；包使用 ad-hoc 签名，未进行公证。

## 发行流程

1. **版本准备随功能或修复的 PR 一起完成，不创建版本专用 PR。** 决定随某次合并发行时，把对应产品的版本号（`node scripts/release-version.js prepare cli minor` 等命令的产物：`package.json`、`tui/src/version.ts`）与中英双语 Changelog 条目放进该功能或修复的同一个 PR，随正常审查与 CI 合并进 `main`。合并完成后该提交即具备发布资格；功能 PR 收尾时把「是否随本次合并发行」当作一项检查，未准备版本号的合并不具备发布资格。不为版本准备再额外创建 `release/*` 分支或版本专用 PR。
2. **在 CI 通过的 `main` 头部打 Tag，发布自动衔接。** 运行 [`tag.yml`](../../.github/workflows/tag.yml)，选择 `product=cli|desktop` 与精确 `version=X.Y.Z`（在 `main` 上执行）。工作流核验版本与 Manifest、双语 Changelog、Tag 不存在、提交等于当前 `main` 头部、该提交的 `main` push CI 成功，创建 annotated `cli-vX.Y.Z` 或 `desktop-vX.Y.Z` Tag，并按产品自动分发发布工作流（`GITHUB_TOKEN` 推送的 Tag 不触发 push 工作流，因此分发走 `workflow_dispatch`）。若 CI 未通过、`main` 前进、版本不匹配或 Tag 已存在，**失败关闭，不做自动版本提交、强制 Tag 或跳过检查**。不采用监听 Manifest 变化的全自动发版：日常合并不等于立即发布，两条产品线各自选择发行时机，发布仍保留人工启动与审批。
3. **CLI/TUI：** Tag 创建后 [`npm-publish.yml`](../../.github/workflows/npm-publish.yml) 被自动分发；重试或补发时可手动 dispatch 并输入 `cli-vX.Y.Z`。工作流核验 Tag 属于 `main` 历史（`main` 此后前进不受影响）、该准确 SHA 的 `main` CI 成功，重新打包并双平台安装验证；发布使用 npm Trusted Publishing/OIDC。**审批直接绑定发布 Job**（`npm-publish` Environment）：打包与验证全部通过后，必需审核者批准，发布 Job 才获得 OIDC 凭据并发布 npm。**仅在 npm 发布流程成功且 Registry 可查后**，工作流使用标签提交的 `tui/CHANGELOG.md` 创建独立的 `CLI/TUI vX.Y.Z` GitHub Release（标题只含产品与版本；**不附安装包，也不抢占 Desktop 的 Latest 标记**）。重试时保留已有公开 Release，不自动覆盖已有正文或重新执行已存在版本的 npm 发布。
4. **Desktop 草稿：** Tag 创建后 [`desktop-publish.yml`](../../.github/workflows/desktop-publish.yml) 被自动分发（`publish=false`）。工作流从标签提交构建 Windows 与 Linux 三种安装包、校验发行资产并创建或补齐 GitHub Release 草稿。
5. **公开 Desktop：** 检查草稿说明、三种安装包和 SHA-256 后，再手动 dispatch 同一工作流并设置 `publish=true`。工作流重新核对标签、历史草稿运行与全部资产，检查 `desktop-publish` Environment 已配置必需审核者，然后等待该 Environment 审批；获批后才公开 Release。

**打 Tag 前最后核对：** 确认本地 `dev`、`main` 与远端分支已同步，工作区干净；`main` 最新提交的完整 push CI 成功，两个产品的 Manifest 版本与中英 Changelog 对应，目标 Tag 都尚不存在。使用上面的 `tag.yml` 分别创建产品标签，而不是手工推送轻量 Tag：该工作流还会校验精确 SHA 并自动分发后续流程。**创建 CLI Tag 会立即启动 npm 打包验证并最终等待 `npm-publish` Environment 审批；创建 Desktop Tag 会启动安装包构建和 Release 草稿流程，但不会公开 Desktop。** 不要把“Tag 已创建”或“草稿已生成”当成产品已正式发布。

## 发行故障处理与回退

- **发行前工作流失败：** 先查看对应 GitHub Actions 运行记录和失败步骤。CLI 可在 `main` 上重新手动启动 [`npm-publish.yml`](../../.github/workflows/npm-publish.yml)，输入原有 `cli-vX.Y.Z` Tag；工作流会重新打包、验证并比较 Registry 内容，已存在且内容相同的 npm 版本不会重复发布。Desktop 可在 `main` 上重新手动启动 [`desktop-publish.yml`](../../.github/workflows/desktop-publish.yml)，输入原有 `desktop-vX.Y.Z` Tag 并设 `publish=false`；工作流只会补齐经过校验的草稿资产，遇到已公开 Release、意外资产或同名不同内容时会失败并要求人工检查。修正源码后应走新版本和新 Tag。
- **CLI 已发布但 Release Notes 步骤失败：** 确认 npm 上对应版本与待发布 tarball 内容一致，再用原 `cli-vX.Y.Z` 手动重跑 `npm-publish.yml`；工作流会跳过已发布的相同版本，并在 Registry 可查后补发缺少的 GitHub Release Notes。若内容有误，发布一个修正版本；npm 已发布版本不替换。
- **公开版本需要临时回退：** 先完成下方的数据备份和记录兼容检查，再安装旧版。CLI 可通过 `npm install -g ligule@<已验证的旧版本>` 安装先前已发布版本；Desktop 从 GitHub Releases 下载并安装先前已验证版本。若旧版本无法读取当前记录，应停止旧版本并恢复备份，或升级到包含修复的新版本。公开 Tag 不移动、不重写；公开 Release 的安装包和校验资产不删除、不替换。需要修正内容时发布新版本。
- **回退前备份：** 正常退出 TUI 和 Desktop，确认相关 Host 已退出、会话锁已释放。复制完整数据根（默认 `~/.ligule`，或 `LIGULE_HOME` 指向的绝对目录）；另行备份项目中的 `.ligule/` 配置，以及显式配置的 `host.sessionDirectory`。检查备份包含会话 `.jsonl` 和其引用的溢出文件；检查点与列表索引可由记录重建。密钥保存在操作系统凭据库，数据根仅保存密钥引用，切换运行环境前确认仍可访问所需凭据。保留备份直到回退版本能正常读取会话并完成基本操作。
- **记录格式兼容前提：** 发行版本回退前，先确认旧版支持备份中会话记录的格式版本和事件种类。当前记录格式版本定义于 `core/src/session/format.ts`；读取器会拒绝高于自身支持版本的记录，并要求版本 2 的 `sessionPermission`、`sessionPolicy` 事件由支持格式 2 的读取器处理。不要让较旧 Host 直接打开较新版本产生的唯一数据副本；先备份，且只在确认格式兼容后对副本验证。恢复或回切后，保留原备份，不手工改写 JSONL 记录。

## Release Notes 内容与下载表规范

- **两条产品线各自维护 Changelog：** `tui/CHANGELOG.md` 对应 CLI/TUI，`desktop/CHANGELOG.md` 对应 Desktop。每个正式版本要有简体中文与英文的**具体变化说明**，优先按功能、交互、安全与兼容性分组；不允许只写“优化体验、修复问题”等没有场景的空泛句子。小型修复可只写实际变动，不必凑条数。
- Release 正文标题只写产品名和版本，例如 `Desktop vX.Y.Z`，不加“更新说明 / Release highlights”。正文按 `### 简体中文`、`### English` 分区；安装、下载和校验信息均放在对应语言区块中，不在末尾追加中英混排的内容。
- **CLI/TUI：** 说明交互模式、工作区/会话行为与可靠性变化；`scripts/release-notes.js` 将 Node.js 版本、安装命令、使用方式和 npm 链接分别放进简体中文与英文区块，不上传重复安装包。
- **Desktop：** 说明架构变动、工作区/审批与保存导出、原生运行时以及实际提供的安装资产；`scripts/release-notes.js` 在两个语言区块内分别生成本地化下载表。正式 Release 的直链必须来自先通过 SHA-256 和来源校验的 `desktop-release-manifest.json`；不要根据版本号猜测安装包名称，更不能保留“稍后上传草稿附件”的占位文案。
- Desktop 的 `publish=false` 草稿工作流通过 `node --experimental-strip-types scripts/desktop-release-manifest.ts verify` 校验资产，再调用 `node scripts/release-notes.js desktop-vX.Y.Z --manifest dist-release/desktop-release-manifest.json`。预览时不提供 manifest 只生成各语言的支持平台表和附件区链接，**不会伪造文件直链**。每个语言区块内分别提供 `SHA256SUMS` 与 manifest 链接；只列出该版本实际发布的目标和架构。
- 已公开 Release 的说明如需修订，应验证对应真实 Tag、安装包资产和目标 Registry 后修改 Release 正文；不移动 Tag、不覆盖二进制，不会因此重新发布 npm 包。

版本、更新记录和发布渠道必须保持产品隔离。不要重用标签或 npm 版本。重试前先检查 [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases) 与 [npm 包](https://www.npmjs.com/package/ligule)。正式发布前须为 `npm-publish` 和 `desktop-publish` GitHub Environments 配置必需审核者。

随包 Node 运行时及其归档校验值以 [`desktop/node-pin.json`](../../desktop/node-pin.json) 为准。修改运行时版本时更新该文件并验证各目标安装包。

打包前构建当前 Core，并在对应平台重新执行 `pnpm run prepare-runtime`。Desktop 部署、构建与运行树检查，以及 CLI npm staging，逐文件核对 Core 的编译输出、模式、README 和许可证；任何缺失、多余或内容差异均拒绝继续。该检查确认产品实际包含当前构建的 Core，不能代替安装后行为验收。

CLI tarball 内置私有 Core 的代码与资源，以及无运行依赖的 SheetJS 纯 JavaScript 解析器和许可证；该解析器不携带平台原生二进制。其余运行依赖写入公开包清单，由 npm 为安装系统选择原生依赖。CI 与正式发布均在 Windows、Linux 空消费者中安装同一份 Linux 构建的 tarball，检查搜索、原生绑定、命令语法、文档读取和 MCP，不能用各平台独立打包来替代跨平台发行物验证。
