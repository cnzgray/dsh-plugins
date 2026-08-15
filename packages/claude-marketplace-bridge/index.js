// Claude Code plugin marketplace bridge for DeepSeek Harness (Cordis plugin).
//
// Port of the pi-claude-plugins extension
// (https://www.npmjs.com/package/pi-claude-plugins, MIT, Ross Z) into DSH's
// native seams, improved in two ways:
//   - skills   -> ctx.skills.registerProvider()  (DSH first-class skill provider)
//   - commands -> ctx.commands.register() + agent.steer() (markdown prompt-template runner)
//   - discovery follows ~/.claude/plugins/installed_plugins.json `installPath`
//     entries (Claude's authoritative installed-plugin layout under
//     ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/), instead of
//     guessing plugin identity from marketplace clone directory names.
//   - skill names are namespaced as `<plugin>-<skill>` (Claude Code's
//     "plugin:skill" identity, kebab-encoded because DSH skill names only
//     allow `[a-z0-9-]`).
//
// Enablement mirrors Claude Code: installed_plugins.json scope (user /
// project) plus settings.json enabledPlugins. Only enabled plugins contribute
// skills; command files are registered for every installed plugin and
// re-checked per invocation (fail closed) because DSH registration is static
// while Claude enablement is cwd-scoped.
//
// Zero runtime imports from @deepseek-ai/*: only Node builtins plus the `yaml`
// package (the same frontmatter parser DSH's own filesystem skill provider
// uses). Everything runs host-side, exactly like packages/claude-auto-memory.

import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";

const name = "claude-marketplace-bridge";
const inject = ["skills", "commands"];

const INSTALLED_PLUGINS_PATH = join(homedir(), ".claude", "plugins", "installed_plugins.json");
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "build", "dist", "out"]);
const MAX_SCAN_DEPTH = 8;
// `skills` plus model-variant roots some marketplaces use (`skills-default`,
// `skills-opus`, ...) are all treated as skill roots.
const SKILLS_DIR_RE = /^skills(?:-[a-z0-9]+)*$/;
const COMMANDS_DIR = "commands";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Imported marketplace skills rank below project/custom/user skill roots
// (100..500) but above bundled system skills (600), so the user's own skills
// always win a name collision while marketplace imports still beat built-ins.
const CLAUDE_MARKETPLACE_RANK = 550;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function shouldIgnoreEntry(name, isDirectory) {
  if (name.startsWith(".")) return true;
  if (isDirectory && IGNORED_DIRECTORY_NAMES.has(name)) return true;
  return false;
}

async function readEntries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function normalizePath(value) {
  const normalized = resolve(value).replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function isSameOrDescendant(parent, target) {
  return target === parent || target.startsWith(`${parent}/`);
}

// ---------------------------------------------------------------------------
// Claude Code enablement: installed_plugins.json + settings.json
// ---------------------------------------------------------------------------

async function loadPluginEnabledStates() {
  const parsed = await readJsonSafe(CLAUDE_SETTINGS_PATH);
  return parsed && typeof parsed === "object" ? parsed.enabledPlugins ?? {} : {};
}

/**
 * Every installed plugin entry from installed_plugins.json, before scope /
 * disable filtering.
 * @returns {Promise<Array<{pluginKey: string, pluginName: string, marketplace: string, installPath: string | undefined, scope: string | undefined, projectPath: string | undefined}>>}
 */
async function installedPluginEntries() {
  const parsed = await readJsonSafe(INSTALLED_PLUGINS_PATH);
  const plugins = parsed && typeof parsed === "object" && parsed.plugins ? parsed.plugins : {};
  const entries = [];
  for (const [pluginKey, rows] of Object.entries(plugins)) {
    if (!Array.isArray(rows)) continue;
    const at = pluginKey.lastIndexOf("@");
    const pluginName = at > 0 ? pluginKey.slice(0, at) : pluginKey;
    const marketplace = at > 0 ? pluginKey.slice(at + 1) : pluginKey;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      entries.push({
        pluginKey,
        pluginName,
        marketplace,
        installPath: typeof row.installPath === "string" ? row.installPath : undefined,
        scope: typeof row.scope === "string" ? row.scope : undefined,
        projectPath: typeof row.projectPath === "string" ? row.projectPath : undefined
      });
    }
  }
  return entries;
}

/** Plugin entries enabled for a cwd: not disabled, and scope matches (user always, project only inside projectPath). */
async function enabledPluginEntries(cwd) {
  const all = await installedPluginEntries();
  const disabled = await loadPluginEnabledStates();
  const normalizedCwd = normalizePath(cwd);
  return all.filter((entry) => {
    if (disabled[entry.pluginKey] === false) return false;
    if (entry.scope === "user") return true;
    if (entry.scope === "project" && entry.projectPath !== undefined) {
      return isSameOrDescendant(normalizePath(entry.projectPath), normalizedCwd);
    }
    return true;
  });
}

/** Quick enabled-key membership set for the command runtime check. */
async function enabledPluginKeySet(cwd) {
  return new Set((await enabledPluginEntries(cwd)).map((entry) => entry.pluginKey));
}

// ---------------------------------------------------------------------------
// Plugin install scanning: recursive, bounded, manifest-aware attribution
// ---------------------------------------------------------------------------

/** One discovered filesystem resource inside a plugin install. */
function collectFind(kind, path, directory) {
  return { kind, path, directory };
}

/**
 * Recursively scan one installed plugin directory for skill bundles
 * (`<skills-dir>/<skill>/SKILL.md`) and command markdown (`commands/*.md`).
 * `skills-*` variant roots are included; hidden and build directories are
 * pruned; symlinked directories are not followed.
 */
async function scanPluginInstall(installPath) {
  const finds = [];
  async function walk(dir, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    const entries = await readEntries(dir);
    for (const entry of entries) {
      if (shouldIgnoreEntry(entry.name, entry.isDirectory())) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const full = join(dir, entry.name);
        if (SKILLS_DIR_RE.test(entry.name)) {
          const skillDirs = await readDirectoriesNoSymlink(full);
          for (const skillDir of skillDirs) {
            const skillPath = join(skillDir, "SKILL.md");
            if (await fileExists(skillPath)) finds.push(collectFind("skill", skillPath, skillDir));
          }
        } else if (entry.name === COMMANDS_DIR) {
          for (const md of await readMarkdownFiles(full)) {
            finds.push(collectFind("command", md, full));
          }
        } else {
          await walk(full, depth + 1);
        }
      }
    }
  }
  await walk(installPath, 0);
  return finds;
}

async function readDirectoriesNoSymlink(dir) {
  const entries = await readEntries(dir);
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || shouldIgnoreEntry(entry.name, true)) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

async function readMarkdownFiles(dir) {
  const entries = await readEntries(dir);
  const out = [];
  for (const entry of entries) {
    if (entry.isFile() && !entry.isSymbolicLink() && !shouldIgnoreEntry(entry.name, false) && entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Cache of `.claude-plugin/plugin.json` name by plugin directory (per process). */
const manifestNameCache = new Map();

async function readManifestName(pluginDir) {
  let cached = manifestNameCache.get(pluginDir);
  if (cached === undefined) {
    const parsed = await readJsonSafe(join(pluginDir, ".claude-plugin", "plugin.json"));
    cached = parsed && typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined;
    manifestNameCache.set(pluginDir, cached);
  }
  return cached;
}

/**
 * Attribute a find inside a plugin install to the nearest ancestor directory
 * whose `.claude-plugin/plugin.json` name matches an installed plugin key
 * (`<name>@<marketplace>`); fall back to the scanned plugin's own key. This
 * handles "bundle" installs (a plugin install containing several sub-plugins)
 * without mislabeling them.
 */
async function resolveOwner(installRoot, findDir, marketplace, installedKeys) {
  let current = resolve(findDir);
  const root = resolve(installRoot);
  while (current !== root && (current === root || current.startsWith(root + sep))) {
    const name = await readManifestName(current);
    if (name !== undefined && installedKeys.has(`${name}@${marketplace}`)) {
      return { pluginKey: `${name}@${marketplace}`, pluginName: name };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** Discover skills + commands from every enabled plugin install, attributed per plugin. */
async function discoverResources(cwd) {
  const enabled = await enabledPluginEntries(cwd);
  const installedKeys = new Set((await installedPluginEntries()).map((e) => e.pluginKey));
  const skills = [];
  const commands = [];
  const seenSkills = new Set();
  const seenCommands = new Set();
  for (const entry of enabled) {
    if (entry.installPath === undefined) continue;
    const finds = await scanPluginInstall(entry.installPath);
    for (const find of finds) {
      const owner = (await resolveOwner(entry.installPath, find.directory, entry.marketplace, installedKeys)) ?? {
        pluginKey: entry.pluginKey,
        pluginName: entry.pluginName
      };
      if (find.kind === "skill") {
        const dedupe = `${owner.pluginKey}\u0000${find.path}`;
        if (seenSkills.has(dedupe)) continue;
        seenSkills.add(dedupe);
        skills.push({ ...find, ...owner, marketplace: entry.marketplace });
      } else {
        const dedupe = `${owner.pluginKey}\u0000${find.path}`;
        if (seenCommands.has(dedupe)) continue;
        seenCommands.add(dedupe);
        commands.push({ ...find, ...owner, marketplace: entry.marketplace });
      }
    }
  }
  return { skills, commands };
}

/** Discover command files from every installed plugin (for static registration; enablement is re-checked at runtime). */
async function discoverAllCommands() {
  const all = await installedPluginEntries();
  const installedKeys = new Set(all.map((e) => e.pluginKey));
  const commands = [];
  const seen = new Set();
  for (const entry of all) {
    if (entry.installPath === undefined) continue;
    const finds = await scanPluginInstall(entry.installPath);
    for (const find of finds) {
      if (find.kind !== "command") continue;
      const owner = (await resolveOwner(entry.installPath, find.directory, entry.marketplace, installedKeys)) ?? {
        pluginKey: entry.pluginKey,
        pluginName: entry.pluginName
      };
      const dedupe = `${owner.pluginKey}\u0000${find.path}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      commands.push({ ...find, ...owner, marketplace: entry.marketplace });
    }
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (SKILL.md and command .md share the same shape)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0) return undefined;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return undefined;
  const start = firstLineEnd + 1;
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return {
        data: raw.slice(start, lineStart),
        body: nextNewline < 0 ? "" : raw.slice(nextNewline + 1)
      };
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  return undefined;
}

function parseYamlFrontmatter(raw, log, subject) {
  const fm = parseFrontmatter(raw);
  if (!fm) {
    log.warn(`${subject} ignored: missing YAML frontmatter`);
    return undefined;
  }
  let data;
  try {
    data = parseYaml(fm.data);
  } catch (error) {
    log.warn(`${subject} ignored: invalid YAML frontmatter: ${error.message}`);
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    log.warn(`${subject} ignored: frontmatter must be a mapping`);
    return undefined;
  }
  return { data, body: fm.body };
}

function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseInvocationPolicy(data) {
  const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
  const userInvocable = frontmatterBoolean(data, "user-invocable");
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false
  };
}

function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true":
      case "yes":
      case "on":
        return true;
      case "false":
      case "no":
      case "off":
        return false;
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

function parseSkillFrontmatter(raw, log, subject) {
  const parsed = parseYamlFrontmatter(raw, log, subject);
  if (!parsed) return undefined;
  const skillName = stringField(parsed.data, "name");
  const description = stringField(parsed.data, "description");
  if (skillName === undefined || description === undefined) {
    log.warn(`${subject} ignored: frontmatter requires name and description`);
    return undefined;
  }
  if (!SKILL_NAME.test(skillName)) {
    log.warn(`${subject} ignored: invalid skill name "${skillName}"`);
    return undefined;
  }
  let invocation;
  try {
    invocation = parseInvocationPolicy(parsed.data);
  } catch (error) {
    log.warn(`${subject} ignored: invalid invocation frontmatter: ${error.message}`);
    return undefined;
  }
  return {
    name: skillName,
    description,
    whenToUse: optionalString(parsed.data, "whenToUse"),
    invocation,
    content: parsed.body.trim()
  };
}

// ---------------------------------------------------------------------------
// Skill provider: ctx.skills.registerProvider()
// ---------------------------------------------------------------------------

const skillProviderName = "claude-marketplace-bridge";

/** The DSH skill name: Claude's `plugin:skill` identity, kebab-encoded as `plugin-skill`. */
function qualifiedSkillName(pluginName, skillName) {
  return `${pluginName}-${skillName}`;
}

function skillSource(owner) {
  return `claude-marketplace-bridge:${owner.pluginKey}`;
}

async function readSkillFile(resource, log) {
  let raw;
  try {
    raw = await readFile(resource.path, "utf8");
  } catch {
    return undefined;
  }
  const subject = `skill ${resource.path}`;
  const parsed = parseSkillFrontmatter(raw, log, subject);
  if (!parsed) return undefined;
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    content: parsed.content,
    directory: resource.directory
  };
}

function createSkillProvider(log, matcher) {
  return {
    name: skillProviderName,
    async list(options) {
      const resources = await discoverResources(options.cwd ?? process.cwd());
      const candidates = [];
      // Deterministic: process by path so same-name duplicates (e.g. model-variant
      // `skills-default`/`skills-opus`/`skills-kimi` roots) keep the first file.
      const orderedSkills = [...resources.skills].sort((a, b) => a.path.localeCompare(b.path));
      const seenNames = new Set();
      for (const resource of orderedSkills) {
        const parsed = await readSkillFile(resource, log);
        if (!parsed) continue;
        const candidateName = qualifiedSkillName(resource.pluginName, parsed.name);
        if (seenNames.has(candidateName)) continue;
        seenNames.add(candidateName);
        if (matcher.blocks(candidateName, resource.pluginKey, resource.marketplace)) continue;
        candidates.push({
          name: candidateName,
          description: parsed.description,
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          invocation: parsed.invocation,
          provider: skillProviderName,
          source: skillSource(resource),
          rank: CLAUDE_MARKETPLACE_RANK,
          locator: resource,
          resourceBase: { kind: "directory", path: parsed.directory },
          path: resource.path
        });
      }
      return candidates;
    },
    async get(candidate) {
      const resource = candidate.locator;
      const parsed = await readSkillFile(resource, log);
      if (!parsed) return undefined;
      return {
        name: qualifiedSkillName(resource.pluginName, parsed.name),
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: parsed.invocation,
        source: candidate.source,
        provider: skillProviderName,
        resourceBase: { kind: "directory", path: parsed.directory },
        path: resource.path,
        content: parsed.content
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Blocklist matching (blockedCommands / blockedSkills)
// ---------------------------------------------------------------------------

/**
 * Minimal glob: only `*` (any run of characters, including none). Used for
 * command/skill-name patterns like `git-*`; deliberately dependency-free.
 */
function globMatch(pattern, value) {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  let index = 0;
  for (const part of parts) {
    if (part === "") continue;
    const found = value.indexOf(part, index);
    if (found === -1) return false;
    index = found + part.length;
  }
  return true;
}

/**
 * Build a matcher from a blocklist of entries with unambiguous shapes:
 *   - `@<marketplace>`        -> block every resource from that marketplace
 *   - `<name>@<marketplace>`  -> block every resource of that plugin key
 *   - `<name>` (or `/name`)   -> block by name (command name, or the
 *     qualified `<plugin>-<skill>` name for skills); `*` wildcards allowed
 * Each rule records whether it ever matched, so callers can warn about
 * entries that block nothing (typos, stale rules).
 */
function createBlockMatcher(entries) {
  const rules = [];
  for (const raw of entries) {
    let entry = typeof raw === "string" ? raw.trim() : "";
    if (!entry) continue;
    if (entry.startsWith("@")) {
      rules.push({ kind: "marketplace", value: entry.slice(1), matched: false });
      continue;
    }
    if (entry.includes("@")) {
      rules.push({ kind: "pluginKey", value: entry, matched: false });
      continue;
    }
    entry = entry.replace(/^\//, "");
    if (entry.includes("*")) {
      rules.push({ kind: "glob", value: entry.toLowerCase(), matched: false });
      continue;
    }
    rules.push({ kind: "name", value: entry.toLowerCase(), matched: false });
  }
  const blocks = (name, pluginKey, marketplace) => {
    const normalized = (name ?? "").toLowerCase();
    let blocked = false;
    for (const rule of rules) {
      let hit = false;
      switch (rule.kind) {
        case "name":
          hit = normalized === rule.value;
          break;
        case "pluginKey":
          hit = pluginKey === rule.value;
          break;
        case "marketplace":
          hit = marketplace === rule.value;
          break;
        case "glob":
          hit = globMatch(rule.value, normalized);
          break;
      }
      if (hit) {
        rule.matched = true;
        blocked = true;
      }
    }
    return blocked;
  };
  const unmatched = () => rules.filter((rule) => !rule.matched).map((rule) => rule.value);
  return { blocks, unmatched };
}

// ---------------------------------------------------------------------------
// Command bridge: ctx.commands.register() + agent.steer()
// ---------------------------------------------------------------------------

function sanitizeCommandName(fileName) {
  const base = basename(fileName, ".md");
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Claude's command template variables: $ARGUMENTS, $1..$9, $CWD. */
function renderTemplate(body, rawInput, cwd) {
  const trimmed = rawInput.trim();
  const args = trimmed ? trimmed.split(/\s+/) : [];
  return body
    .replace(/\$ARGUMENTS/g, trimmed)
    .replace(/\$CWD/g, cwd)
    .replace(/\$(\d)/g, (_, index) => {
      const n = Number(index);
      return n >= 1 && n <= args.length ? args[n - 1] : "";
    });
}

/** A frozen user-role message shaped exactly like createUserMessage. */
function makeMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name }
  });
}

async function loadCommandMeta(path, log) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { description: undefined };
  }
  const parsed = parseYamlFrontmatter(raw, log, `command ${path}`);
  if (!parsed) return { description: undefined };
  return { description: optionalString(parsed.data, "description") };
}

async function registerCommands(ctx, log, commands, matcher) {
  const seen = new Set();
  let registered = 0;
  let skipped = 0;
  const blocked = [];

  for (const command of commands) {
    const commandName = sanitizeCommandName(command.path);
    if (!commandName) {
      skipped += 1;
      continue;
    }
    if (matcher.blocks(commandName, command.pluginKey, command.marketplace)) {
      blocked.push(commandName);
      continue;
    }
    if (seen.has(commandName)) {
      log.warn(`command "${commandName}" from ${command.path} skipped: duplicate name`);
      skipped += 1;
      continue;
    }
    const { description } = await loadCommandMeta(command.path, log);
    try {
      ctx.commands.register({
        name: commandName,
        description: description ?? `Claude Code command from ${command.pluginKey}`,
        handler: async ({ agent, rawInput }) => {
          const cwd = agent.session.header.cwd ?? process.cwd();
          const enabledKeys = await enabledPluginKeySet(cwd);
          if (!enabledKeys.has(command.pluginKey)) {
            return {
              kind: "error",
              text: `[claude-marketplace-bridge] "${commandName}" belongs to plugin "${command.pluginKey}", which is not enabled in this workspace`
            };
          }
          let raw;
          try {
            raw = await readFile(command.path, "utf8");
          } catch (error) {
            return { kind: "error", text: `[claude-marketplace-bridge] failed to read ${command.path}: ${error.message}` };
          }
          const fm = parseFrontmatter(raw);
          const body = (fm ? fm.body : raw).trim();
          if (!body) {
            return { kind: "error", text: `[claude-marketplace-bridge] ${command.path} is empty` };
          }
          const prompt = renderTemplate(body, rawInput ?? "", cwd);
          agent.steer(makeMessage(prompt));
          return { kind: "success", text: `Running Claude command "${commandName}"…` };
        }
      });
      seen.add(commandName);
      registered += 1;
    } catch (error) {
      log.warn(`command "${commandName}" from ${command.path} not registered: ${error.message}`);
      skipped += 1;
    }
  }

  if (blocked.length > 0) {
    log.info(`[claude-marketplace-bridge] blocked ${blocked.length} command(s): ${[...new Set(blocked)].join(", ")}`);
  }
  log.info(`[claude-marketplace-bridge] registered ${registered} command(s), skipped ${skipped}`);
  return { registered, blocked };
}

// ---------------------------------------------------------------------------
// Plugin apply
// ---------------------------------------------------------------------------

function apply(ctx, config = {}) {
  const log = ctx.logger(name);
  const blockedCommands = Array.isArray(config.blockedCommands) ? config.blockedCommands : [];
  const blockedSkills = Array.isArray(config.blockedSkills) ? config.blockedSkills : [];
  // Separate matchers: a rule in blockedCommands only ever blocks commands, a
  // rule in blockedSkills only ever blocks skills (add the entry to both lists
  // to block both surfaces).
  const commandMatcher = createBlockMatcher(blockedCommands);
  const skillMatcher = createBlockMatcher(blockedSkills);
  // Filled once async command registration settles; status shows what is known so far.
  const blockedCommandNames = [];

  // Skills: register a first-class provider on ctx.skills.
  ctx.skills.registerProvider(() => createSkillProvider(log, skillMatcher));

  // Commands: register every command file from every installed plugin;
  // enablement is re-checked per invocation against the current workspace.
  void (async () => {
    try {
      const commands = await discoverAllCommands();
      log.info(`[claude-marketplace-bridge] found ${commands.length} command file(s) across installed plugins (enablement checked per invocation)`);
      const outcome = await registerCommands(ctx, log, commands, commandMatcher);
      blockedCommandNames.push(...outcome.blocked);
      // Second pass over skills so skill-only block rules are marked before the
      // unmatched warning (the skill catalog itself loads lazily per session).
      const resources = await discoverResources(process.cwd());
      for (const resource of resources.skills) {
        const parsed = await readSkillFile(resource, log);
        if (!parsed) continue;
        skillMatcher.blocks(qualifiedSkillName(resource.pluginName, parsed.name), resource.pluginKey, resource.marketplace);
      }
      const unmatched = [...commandMatcher.unmatched(), ...skillMatcher.unmatched()];
      if (unmatched.length > 0) {
        log.warn(`[claude-marketplace-bridge] blocklist entries matched nothing (check spelling or stale rules): ${unmatched.join(", ")}`);
      }
    } catch (error) {
      log.error(`[claude-marketplace-bridge] failed to initialize command bridge: ${error.message}`);
    }
  })();

  // Status command.
  ctx.commands.register({
    name: "claude-marketplace-bridge",
    description: "Show Claude Code marketplace bridge status",
    handler: async ({ agent }) => {
      const cwd = agent.session.header.cwd ?? process.cwd();
      try {
        const resources = await discoverResources(cwd);
        let blockedSkillsCount = 0;
        for (const resource of resources.skills) {
          const parsed = await readSkillFile(resource, log);
          if (!parsed) continue;
          if (skillMatcher.blocks(qualifiedSkillName(resource.pluginName, parsed.name), resource.pluginKey, resource.marketplace)) {
            blockedSkillsCount += 1;
          }
        }
        const lines = [
          `[claude-marketplace-bridge] ${resources.skills.length} skill(s), ${resources.commands.length} command(s) from enabled Claude plugins`,
          `  blocked: ${blockedCommandNames.length} command(s), ${blockedSkillsCount} skill(s)`,
        ];
        const byPlugin = new Map();
        for (const r of resources.skills) {
          const list = byPlugin.get(r.pluginKey) ?? { skills: [], commands: [] };
          list.skills.push(r.path);
          byPlugin.set(r.pluginKey, list);
        }
        for (const r of resources.commands) {
          const list = byPlugin.get(r.pluginKey) ?? { skills: [], commands: [] };
          list.commands.push(r.path);
          byPlugin.set(r.pluginKey, list);
        }
        for (const [pluginKey, list] of [...byPlugin.entries()].sort()) {
          lines.push(`  ${pluginKey}: ${list.skills.length} skill(s), ${list.commands.length} command(s)`);
        }
        return { kind: "success", text: lines.join("\n") };
      } catch (error) {
        return { kind: "error", text: `[claude-marketplace-bridge] discovery failed: ${error.message}` };
      }
    }
  });

  if (blockedCommands.length > 0 || blockedSkills.length > 0) {
    log.info(`[claude-marketplace-bridge] blocklist: ${blockedCommands.length} command rule(s), ${blockedSkills.length} skill rule(s)`);
  }
  log.info(`[claude-marketplace-bridge] mounted (skills provider "${skillProviderName}", rank ${CLAUDE_MARKETPLACE_RANK})`);
}

export { apply, inject, name };
