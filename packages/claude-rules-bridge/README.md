# @cnzgray/dsh-claude-rules-bridge

Bridges [Claude Code](https://code.claude.com/docs/en/memory)'s `.claude/rules/*.md` and `*.mdc` rule files into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH / Cordis), mirroring the omp extension `claude-rules-bridge`:

- **Discovery** — `.claude/rules/` scanned from the session cwd (walked up to `$HOME`) plus `~/.claude/rules/`. Frontmatter:
  - `paths` / `globs` / `applyTo` → file-match globs (merged)
  - `alwaysApply` → always injected at session start
  - `description` → metadata for the `/claude-rules` listing
- **alwaysApply rules** → injected once at session start (in effect from the first agent request).
- **Path-scoped rules** → injected dynamically on `read` / `write` / `edit` tool results when the touched file matches the globs.

> `CLAUDE.md` / `AGENTS.md` are **not** handled here — the built-in `@deepseek-ai/dsh-agent-instructions` already implements the project-root baseline and on-touch nested loading, and its behavior is preferred.

## Behavior

| Layer | When | Content |
| --- | --- | --- |
| Baseline | `agent/session-start` (covers startup, resume, clear, compact) | `alwaysApply` rules from `.claude/rules/` (cwd → `$HOME` walk-up + `~/.claude/rules/`) |
| Dynamic | successful `read` / `write` / `edit` tool result | path-scoped rules matching the touched file's globs (cwd-relative path + basename) |

- Files **outside cwd** get no rules.
- Per-session dedupe: each rule is injected once per target path; a resume/compact reload resets the session state.
- Token caps: 12 KB per injected block, 6 KB per rule file.

## Seams

DSH-native seams, all from a root-realm listener (receives every agent's scoped events):

- `agent/session-start` → `agent.inject()` the baseline (same pattern as `@cnzgray/dsh-claude-auto-memory`).
- `tools/result` → `agent.inject()` a dynamic context message that the next pre-step claims (the same mechanism `@deepseek-ai/dsh-agent-instructions` uses).
- `ctx.commands.register` → `/claude-rules` status command.
- `ctx.tools.register` → `claude_rules` on-demand index/reader tool.

Zero runtime imports from `@deepseek-ai/*`; the only runtime dependency is `picomatch` (declared in `package.json`). When installed from npm, `dsh plugin add` (pnpm) installs it transitively. For local `link:` development, run `npm install` inside the package directory once so the plugin's `import picomatch` resolves.

## Installation

```bash
dsh plugin --profile web add @cnzgray/dsh-claude-rules-bridge
dsh web   # restart to take effect
```

Local development:

```bash
npm install   # once, inside packages/claude-rules-bridge/ (installs picomatch for link: dev)
dsh plugin --profile web add ./packages/claude-rules-bridge
# edit source → restart `dsh web`
```

## Usage

- `/claude-rules` — list discovered rules (subcommand: `reload`).
- `claude_rules` tool — the model can list the index or read one rule's full content on demand; matching is automatic via read/edit/write.

## Example rule

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "**/*.api.ts"
description: API endpoint rules
---
- Every API endpoint must include input validation.
```

```markdown
---
alwaysApply: true
---
- Use 2-space indentation.
```

## License

MIT
