# dsh-plugins

[English](README.md) | 简体中文

个人维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH / Cordis）插件合集。每个插件是一个独立的 npm 包，通过 `dsh plugin` 安装即可自动挂载（bundle 机制，无需手动改配置）。

## 插件列表

| 包 | 说明 | npm |
|---|---|---|
| [`packages/claude-auto-memory`](packages/claude-auto-memory) | 把 Claude Code 的 `~/.claude/projects/<encoded>/memory/MEMORY.md` 在会话开始时桥接进 DSH，附 `/claude-memory` 状态命令 | `@cnzgray/dsh-claude-auto-memory` |
| [`packages/claude-rules-bridge`](packages/claude-rules-bridge) | 把 Claude Code 的 `.claude/rules/*.md`（及 `*.mdc`）规则桥接进 DSH：always-apply 规则会话开始注入、路径作用域规则在 read/edit/write 时动态注入，附 `/claude-rules` 命令与 `claude_rules` 工具（CLAUDE.md/AGENTS.md 交给内置 `dsh-agent-instructions`） | `@cnzgray/dsh-claude-rules-bridge` |
| [`packages/claude-marketplace-bridge`](packages/claude-marketplace-bridge) | 把 Claude Code 已安装的插件市场（`~/.claude/plugins/marketplaces`）桥接进 DSH：SKILL.md 技能注册为原生 `ctx.skills` provider、命令 `.md` 注册为斜杠命令，遵守 `installed_plugins.json` / `settings.json` 启用状态（pi-claude-plugins 移植） | `@cnzgray/dsh-claude-marketplace-bridge` |

## 安装

```bash
dsh plugin --profile web add @cnzgray/dsh-claude-auto-memory
dsh web   # 重启生效
```

## 开发

```bash
# 本地插件直接链接进 profile（改源码后重启 dsh web 生效）
dsh plugin --profile web add ./packages/<插件目录>

# 校验装配树（不启动）
dsh --profile web --dump-config | grep -A3 <插件 id>
```

新插件从复制 `packages/claude-auto-memory/` 开始：改 `package.json` 的 `name`、`cordis.patch.yml` 里的 `name`（bundle entry 指向真实包名）与 `id`。

## License

MIT
