# dsh-plugins

[简体中文](README.zh-CN.md) | English

Index of personal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH / Cordis) plugins. Every plugin now lives in its own repository and ships as an independent npm package; `dsh plugin add` mounts it automatically (bundle mechanism, no manual config edits required).

## Plugins

| Plugin | Repository | npm | What it does |
|---|---|---|---|
| claude-auto-memory | [cnzgray/dsh-claude-auto-memory](https://github.com/cnzgray/dsh-claude-auto-memory) | `@cnzgray/dsh-claude-auto-memory` | Bridges Claude Code's `~/.claude/projects/<encoded>/memory/MEMORY.md` into DSH at session start, plus a `/claude-memory` status command |
| claude-rules-bridge | [cnzgray/dsh-claude-rules-bridge](https://github.com/cnzgray/dsh-claude-rules-bridge) | `@cnzgray/dsh-claude-rules-bridge` | Bridges Claude Code's `.claude/rules/*.md` (and `*.mdc`) rules into DSH: always-apply rules at session start, path-scoped rules injected dynamically on read/edit/write, plus a `/claude-rules` command and `claude_rules` tool (CLAUDE.md/AGENTS.md are left to the built-in `dsh-agent-instructions`) |
| claude-marketplace-bridge | [cnzgray/dsh-claude-marketplace-bridge](https://github.com/cnzgray/dsh-claude-marketplace-bridge) | `@cnzgray/dsh-claude-marketplace-bridge` | Bridges Claude Code's installed plugin marketplaces into DSH via `installed_plugins.json` install paths: SKILL.md skills as a native `ctx.skills` provider with `<plugin>-<skill>` names and command `.md` files as slash commands, honoring scope / `settings.json` enablement (improved port of pi-claude-plugins) |

## Plugin index

This repository publishes [`index.json`](index.json), a [DSH plugin market index](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md), served from GitHub's raw host:

```text
https://raw.githubusercontent.com/cnzgray/dsh-plugins/main/index.json
```

Open **Plugins**, enable **Custom plugin indexes** under Experimental plugins, open the **Discover** tab, choose **Add index source**, and paste that URL.

The index is generated from npm, not edited by hand:

- A scheduled GitHub Actions workflow runs every six hours and can also be triggered manually or by another repository.
- It discovers packages published by the npm user `cnzgray`, plus any names listed in `discovery.include`, reads their registry manifests, and lists every published version that declares `dsh.bundle` and a valid `engines.dsh` range. Deprecated and private versions are omitted.
- New versions of an existing package and newly published packages appear on the next run. No package or version list is maintained in this repository.
- Display text, categories, and labels live in [`plugins.json`](plugins.json). Removing an override makes the next run fall back to the npm manifest.

To make a package eligible, its published manifest must declare both fields:

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.0-rc.2" }
}
```

`engines.dsh` is mandatory: DSH rejects an index that lists a version without it. Packages published before that requirement was introduced are skipped until they are republished.

Refresh immediately with **Actions → Update plugin index → Run workflow**, or dispatch `plugin-published` to this repository with a token that can write to it:

```bash
gh api repos/cnzgray/dsh-plugins/dispatches -f event_type=plugin-published
```

Generate and validate locally:

```bash
npm ci
npm run build:index
npm run check
```

## Installation

```bash
dsh plugin --profile web add @cnzgray/dsh-claude-auto-memory
dsh web   # restart to take effect
```

## Development

Each plugin is a standalone repository — clone it, install its own dependencies, then link it into a profile:

```bash
cd dsh-claude-auto-memory
npm install                                  # once, in the repo root
dsh plugin --profile web add ./             # edit source → restart `dsh web`
```

Publishing is per repository: push a scoped tag (`@cnzgray/<package-name>@<semver>`) and its own `publish` workflow publishes to npm through npm Trusted Publishing (OIDC).

## License

MIT
