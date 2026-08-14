# @cnzgray/dsh-claude-auto-memory (DeepSeek Harness plugin)

[简体中文](README.zh-CN.md) | English

Bridges Claude Code's auto memory (`~/.claude/projects/<encoded>/memory/MEMORY.md`) into DeepSeek Harness (DSH / Cordis) at session start.

- Injects MEMORY.md once per `agent/session-start` (enters conversation history, visible for the whole session)
- Capped at 200 lines / 25 KB (whichever comes first), appends a size warning at 80%
- Uninitialized projects still get the creation guidance injected (bootstrap)
- `/claude-memory` command shows status (path / lines / bytes / topic list)

## Installation & loading

This package declares `dsh.bundle`, so `dsh plugin add` automatically adds it to the profile's bundle layer stack and mounts the entry — **no manual yml edits needed**:

```bash
# From npm (after publishing)
dsh plugin --profile web add @cnzgray/dsh-claude-auto-memory

# Or from a local path / git repo (monorepo subdir) / tarball
dsh plugin --profile web add ./packages/claude-auto-memory
dsh plugin --profile web add github:cnzgray/dsh-plugins/packages/claude-auto-memory

# Verify the assembled tree without starting
dsh --profile web --dump-config | grep -A3 claude-auto-memory

# Restart the web profile (kills the current GUI session)
dsh web
```

## Verification

- On a new session start, the host log should show `[memory] loaded: <path>` or the bootstrap notice.
- Typing `/claude-memory` in the input box should show the memory file status.

## Notes

- This plugin is a **live read-only bridge**: it reads Claude Code's existing `~/.claude/projects/` — no copying or migration. Updates on the Claude Code side take effect at the next session (the mtime cache expires and re-reads).
- The plugin source lives outside the profile; `cordis-plugin-hmr` (`root: ['.']`) won't watch it. Restart `dsh web` after code changes.
- For native DSH memory (without depending on Claude Code files), see the official [deepseek-ai/deepseek-harness Discussion #525](https://github.com/deepseek-ai/deepseek-harness/discussions/525).
