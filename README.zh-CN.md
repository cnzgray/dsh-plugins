# dsh-plugins

[English](README.md) | 简体中文

个人维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH / Cordis）插件索引。每个插件现在都是独立仓库，并以独立 npm 包发布；通过 `dsh plugin add` 安装即可自动挂载（bundle 机制，无需手动改配置）。

## 插件列表

| 插件 | 仓库 | npm | 说明 |
|---|---|---|---|
| claude-auto-memory | [cnzgray/dsh-claude-auto-memory](https://github.com/cnzgray/dsh-claude-auto-memory) | `@cnzgray/dsh-claude-auto-memory` | 把 Claude Code 的 `~/.claude/projects/<encoded>/memory/MEMORY.md` 在会话开始时桥接进 DSH，附 `/claude-memory` 状态命令 |
| claude-rules-bridge | [cnzgray/dsh-claude-rules-bridge](https://github.com/cnzgray/dsh-claude-rules-bridge) | `@cnzgray/dsh-claude-rules-bridge` | 把 Claude Code 的 `.claude/rules/*.md`（及 `*.mdc`）规则桥接进 DSH：always-apply 规则会话开始注入、路径作用域规则在 read/edit/write 时动态注入，附 `/claude-rules` 命令与 `claude_rules` 工具（CLAUDE.md/AGENTS.md 交给内置 `dsh-agent-instructions`） |
| claude-marketplace-bridge | [cnzgray/dsh-claude-marketplace-bridge](https://github.com/cnzgray/dsh-claude-marketplace-bridge) | `@cnzgray/dsh-claude-marketplace-bridge` | 把 Claude Code 已安装的插件市场通过 `installed_plugins.json` installPath 桥接进 DSH：SKILL.md 技能注册为原生 `ctx.skills` provider（`<插件>-<技能>` 命名）、命令 `.md` 注册为斜杠命令，遵守作用域 / `settings.json` 启用状态（pi-claude-plugins 改进移植） |

## 插件索引

本仓库发布 [`index.json`](index.json)，即 [DSH 插件市场索引](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)，通过 GitHub raw 托管：

```text
https://raw.githubusercontent.com/cnzgray/dsh-plugins/main/index.json
```

在 DSH 中打开 **插件**，在实验性插件里启用 **自定义插件索引**，进入 **发现** 标签，选择 **添加索引源**，粘贴上面的 URL。

索引由 npm 自动生成，不手工编辑：

- GitHub Actions 每 6 小时运行一次，也支持手动触发或其他仓库事件触发。
- 自动发现 npm 用户 `cnzgray` 发布的包，以及 `discovery.include` 中列出的包，读取 registry 清单，列出所有声明 `dsh.bundle` 且 `engines.dsh` 合法的已发布版本；跳过已废弃和私有版本。
- 已有包的新版本和新发布的包会在下次运行时自动出现，本仓库不维护包名或版本清单。
- 展示文案、分类与标签在 [`plugins.json`](plugins.json) 中配置；删除覆盖项后，下次运行会回退到 npm 清单。

要让插件进入索引，已发布版本的 package.json 必须同时声明：

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.0-rc.2" }
}
```

`engines.dsh` 是硬性要求：索引中任何一个版本缺少它，DSH 都会拒绝整个索引。早期发布、尚未声明该字段的包需要重新发布后才会出现。

立即刷新：**Actions → Update plugin index → Run workflow**；或用有写权限的 token 向本仓库发送 `plugin-published` 事件：

```bash
gh api repos/cnzgray/dsh-plugins/dispatches -f event_type=plugin-published
```

本地生成与校验：

```bash
npm ci
npm run build:index
npm run check
```

## 安装

```bash
dsh plugin --profile web add @cnzgray/dsh-claude-auto-memory
dsh web   # 重启生效
```

## 开发

每个插件都是独立仓库 —— clone 下来，装好它自己的依赖，再链接进 profile：

```bash
cd dsh-claude-auto-memory
npm install                                  # 一次性，在仓库根目录执行
dsh plugin --profile web add ./             # 改源码 → 重启 `dsh web`
```

发布按仓库进行：推送带作用域的 tag（`@cnzgray/<包名>@<semver>`），该仓库自带的 `publish` 工作流会通过 npm Trusted Publishing（OIDC）发布到 npm。

## License

MIT
