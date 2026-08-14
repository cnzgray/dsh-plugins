# dsh-plugins

[简体中文](README.zh-CN.md) | English

A personal collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH / Cordis) plugins. Each plugin is an independent npm package that mounts automatically when installed via `dsh plugin` (bundle mechanism, no manual config edits required).

## Plugins

| Package | Description | npm |
|---|---|---|
| [`packages/claude-auto-memory`](packages/claude-auto-memory) | Bridges Claude Code's `~/.claude/projects/<encoded>/memory/MEMORY.md` into DSH at session start, plus a `/claude-memory` status command | `@cnzgray/dsh-claude-auto-memory` |

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
