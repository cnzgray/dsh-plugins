# dsh-plugins

[简体中文](README.zh-CN.md) | English

A personal collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH / Cordis) plugins. Each plugin is an independent npm package that mounts automatically when installed via `dsh plugin` (bundle mechanism, no manual config edits required).

## Plugins

| Package | Description | npm |
|---|---|---|
| [`packages/claude-auto-memory`](packages/claude-auto-memory) | Bridges Claude Code's `~/.claude/projects/<encoded>/memory/MEMORY.md` into DSH at session start, plus a `/claude-memory` status command | `@cnzgray/dsh-claude-auto-memory` |
| [`packages/claude-rules-bridge`](packages/claude-rules-bridge) | Bridges Claude Code's `.claude/rules/*.md` (and `*.mdc`) rules into DSH: always-apply rules at session start, path-scoped rules injected dynamically on read/edit/write, plus a `/claude-rules` command and `claude_rules` tool (CLAUDE.md/AGENTS.md are left to the built-in `dsh-agent-instructions`) | `@cnzgray/dsh-claude-rules-bridge` |
| [`packages/claude-marketplace-bridge`](packages/claude-marketplace-bridge) | Bridges Claude Code's installed plugin marketplaces into DSH via `installed_plugins.json` install paths: SKILL.md skills as a native `ctx.skills` provider with `<plugin>-<skill>` names and command `.md` files as slash commands, honoring scope / `settings.json` enablement (improved port of pi-claude-plugins) | `@cnzgray/dsh-claude-marketplace-bridge` |

## Installation

```bash
dsh plugin --profile web add @cnzgray/dsh-claude-auto-memory
dsh web   # restart to take effect
```

## Development

```bash
# Link a local plugin straight into the profile (edit source, restart `dsh web`, done)
dsh plugin --profile web add ./packages/<plugin-dir>

# Verify the assembled tree without starting
dsh --profile web --dump-config | grep -A3 <plugin id>
```

Start a new plugin by copying `packages/claude-auto-memory/`: change the `name` in `package.json`, and the `name` (the bundle entry must point to the real package name) and `id` in `cordis.patch.yml`.

## License

MIT
