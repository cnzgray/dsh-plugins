# @cnzgray/dsh-claude-marketplace-bridge (DeepSeek Harness plugin)

[简体中文](README.zh-CN.md) | English

Bridges **Claude Code's installed plugin marketplace** into DeepSeek Harness (DSH / Cordis). A port of the [pi-claude-plugins](https://www.npmjs.com/package/pi-claude-plugins) extension (MIT) onto DSH's native seams:

- **skills** → registered as a first-class `ctx.skills` provider (`skill-filesystem` style), so they show up in the model's skill catalog like any other skill
- **commands** → registered as real DSH slash commands; the command's markdown body runs as a prompt template through `agent.steer()`

It only loads Claude plugins that are currently **enabled**, honoring both:

- `~/.claude/plugins/installed_plugins.json` (user / project scope)
- `~/.claude/settings.json` (`enabledPlugins`)

## What gets loaded

### Skills

Discovery follows Claude's authoritative installed-plugin layout — `installed_plugins.json` `installPath` entries under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` — and recursively scans each enabled plugin install for `skills/<skill>/SKILL.md` (plus model-variant roots like `skills-default` / `skills-opus` used by some marketplaces). Skills inside a plugin install that carries its own `.claude-plugin/plugin.json` (e.g. "bundle" plugins) are attributed to the matching plugin key by manifest name.

**Naming is namespaced as `<plugin>-<skill>`** — Claude Code's `plugin:skill` identity, kebab-encoded because DSH skill names only allow `[a-z0-9-]` (no colons):

| Marketplace layout | Example catalog name |
|---|---|
| `ponytail` top-level skill `ponytail-audit` | `ponytail-ponytail-audit` |
| `claude-plugins-official` plugin `claude-md-management` with skill `claude-md-improver` | `claude-md-management-claude-md-improver` |
| `cnzgray-marketplace` plugin `cexll` with skill `do` | `cexll-do` |

`name`, `description`, `whenToUse`, `disable-model-invocation` / `user-invocable` frontmatter are honored. Imported skills rank at `550`: below your own project / custom / user skill roots (100–500) but above bundled system skills (600), so your own skills always win a name collision. Same-name duplicates within one plugin (e.g. the `skills-default`/`skills-opus`/`skills-kimi` triplets) collapse to the first file by path.

### Commands

From the same install-path scan: `commands/*.md` anywhere inside an installed plugin (attributed by the same manifest rule).

Each `.md` becomes a slash command (filename → `/name`, lowercase kebab). Running it reads the template, substitutes `$ARGUMENTS`, `$1`…`$9` and `$CWD`, and hands the result to the agent as a user turn. Command `description:` frontmatter is used for the command list.

## How enablement works

Claude's `installed_plugins.json` keys look like `frontend-design@claude-plugins-official` or `minimax-skills@minimax-skills`. A resource is exposed when its key is installed **and** not explicitly disabled in `settings.json`:

- `user` scope → always enabled
- `project` scope → enabled only when the current workspace is inside that `projectPath`

For **skills** this is evaluated per lookup against the current `cwd`. For **commands**, all command files are registered once at startup (DSH's command registry is static), and enablement is re-checked on every invocation — a command from a plugin that isn't enabled in the current workspace fails closed with a clear message.

## Blocking commands / skills

Configure a blocklist in the profile's patch layer (`~/.dsh/profiles/web/cordis.patch.yml`) via the plugin's `config`:

```yaml
- id: claude-marketplace-bridge
  config:
    blockedCommands:
      - review                        # command by name (leading / optional)
      - /git-commit
      - git-*                         # wildcard on command names
      - code-review@claude-plugins-official   # every command of one plugin
      - @cnzgray-marketplace          # every command of one marketplace
    blockedSkills:
      - ponytail-ponytail             # skill by qualified <plugin>-<skill> name
      - frontend-design@claude-plugins-official  # every skill of one plugin
      - @cnzgray-marketplace          # every skill of one marketplace
```

Entry shapes (unambiguous):

| Entry | Matches |
|---|---|
| `name` or `/name` | a command name, or a skill's qualified `<plugin>-<skill>` name |
| `pattern*` | wildcard (`*` = any run of characters) over the same names |
| `name@marketplace` | everything from that plugin key |
| `@marketplace` | everything from that marketplace |

`blockedCommands` only ever blocks commands; `blockedSkills` only ever blocks skills — add an entry to both lists to block both surfaces. Rules that match nothing are warned at startup (typos / stale rules). Blocked counts appear in `/claude-marketplace-bridge`. Because commands are registered at startup, changing the blocklist requires restarting `dsh web`.

## Installation

```bash
# From npm (after publishing)
dsh plugin --profile web add @cnzgray/dsh-claude-marketplace-bridge

# Or from a local path
dsh plugin --profile web add ./packages/claude-marketplace-bridge

# Verify the assembled tree without starting
dsh --profile web --dump-config | grep -A3 claude-marketplace-bridge

# Restart the web profile (kills the current GUI session)
dsh web
```

Needs the `skills` and `commands` services (both are mounted by the shipped `web` / `headless` profiles).

## Verification

- Host log at startup shows `found N command file(s) across installed plugins` and a skills-provider mount line.
- Enabled marketplace skills appear in the model's skill catalog under `<plugin>-<skill>` names (e.g. via the skills UI or `skill` tool).
- Typing `/claude-marketplace-bridge` shows a per-plugin summary of loaded skills/commands.
- Running an imported command (e.g. `/review`) executes its template.

## Notes

- **Live read-only bridge**: reads Claude Code's existing `~/.claude/plugins/` directly — no copying or migration. Enable/disable a Claude plugin, then restart `dsh web` (skills re-evaluate per session lookup; commands are registered at startup).
- **Does not execute Claude plugin hooks / runtime code** — only filesystem resources that map cleanly into DSH: `SKILL.md` skills and command markdown. Plugin agents, hooks, MCP servers, and non-markdown command formats are out of scope (same limitation as pi-claude-plugins).
- **Bundle-marketplace quirk**: if one plugin's install contains other plugins' content (e.g. the `cnzgray-marketplace` `cexll` plugin ships `omo-workflow` and `development-essentials`), those skills load under the bundle's prefix as well — `cexll-omo-*` appears next to `omo-omo-*`. This mirrors what Claude Code itself sees in that install; disable the bundle plugin to drop them.
- **Zero `@deepseek-ai/*` runtime imports**: only Node builtins plus the `yaml` package (the same frontmatter parser DSH's own skill provider uses).
- The plugin source lives outside the profile; `cordis-plugin-hmr` won't watch it. Restart `dsh web` after code changes.

## Files

- Entry point: `index.js`
- Bundle manifest: `package.json` / `cordis.patch.yml`

## License

MIT
