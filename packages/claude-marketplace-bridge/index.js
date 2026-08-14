// Claude Code plugin marketplace bridge for DeepSeek Harness (Cordis plugin).
//
// Port of the pi-claude-plugins extension
// (https://www.npmjs.com/package/pi-claude-plugins, MIT, Ross Z) into DSH's
// native seams:
//   - skills   -> ctx.skills.registerProvider()  (DSH first-class skill provider)
//   - commands -> ctx.commands.register() + agent.steer() (markdown prompt-template runner)
//
// It reads Claude Code's installed plugin marketplace layout under
// ~/.claude/plugins/marketplaces and honors the same enablement rules:
//   - ~/.claude/plugins/installed_plugins.json (user / project scope)
//   - ~/.claude/settings.json (enabledPlugins)
//
// Zero runtime imports from @deepseek-ai/*: only Node builtins plus the `yaml`
// package (the same frontmatter parser DSH's own filesystem skill provider
// uses). Everything runs host-side, exactly like packages/claude-auto-memory.

import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";

const name = "claude-marketplace-bridge";
const inject = ["skills", "commands"];

const MARKETPLACES_DIR = join(homedir(), ".claude", "plugins", "marketplaces");
const INSTALLED_PLUGINS_PATH = join(homedir(), ".claude", "plugins", "installed_plugins.json");
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "build", "dist", "out"]);

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Imported marketplace skills rank below project/custom/user skill roots
// (100..500) but above bundled system skills (600), so the user's own skills
// always win a name collision while marketplace imports still beat built-ins.
const CLAUDE_MARKETPLACE_RANK = 550;

// ---------------------------------------------------------------------------
// Claude Code marketplace layout helpers (ported from pi-claude-plugins)
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

async function readDirectories(dir) {
  const entries = await readEntries(dir);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !shouldIgnoreEntry(entry.name, true))
    .map((entry) => join(dir, entry.name));
}

async function readMarkdownFiles(dir) {
  const entries = await readEntries(dir);
  return entries
    .filter((entry) => entry.isFile() && !shouldIgnoreEntry(entry.name, false) && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name));
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(value) {
  const normalized = resolve(value).replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function isSameOrDescendant(parent, target) {
  return target === parent || target.startsWith(`${parent}/`);
}

async function loadPluginEnabledStates() {
  let raw;
  try {
    raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed.enabledPlugins ?? {} : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the set of enabled plugin keys (`<name>@<marketplace>`) for a cwd,
 * mirroring Claude Code's rules:
 *   - a plugin explicitly disabled in settings.json is skipped;
 *   - user-scoped installs are always enabled;
 *   - project-scoped installs only when cwd is inside their projectPath.
 */
async function loadEnabledPluginKeys(cwd) {
  let raw;
  try {
    raw = await readFile(INSTALLED_PLUGINS_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  const plugins = parsed && typeof parsed === "object" && parsed.plugins ? parsed.plugins : {};
  const pluginEnabledStates = await loadPluginEnabledStates();
  const normalizedCwd = normalizePath(cwd);
  const enabled = new Set();

  for (const [pluginKey, entries] of Object.entries(plugins)) {
    if (pluginEnabledStates[pluginKey] === false) continue;
    if (!Array.isArray(entries)) continue;
    const isEnabledForCwd = entries.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (entry.scope === "user") return true;
      if (entry.scope === "project" && typeof entry.projectPath === "string") {
        return isSameOrDescendant(normalizePath(entry.projectPath), normalizedCwd);
      }
      return true;
    });
    if (isEnabledForCwd) enabled.add(pluginKey);
  }
  return enabled;
}

/**
 * Scan every marketplace for enabled skills and command markdown files.
 * @returns {Promise<{skills: Array<{path: string, directory: string, pluginKey: string, marketplace: string}>, commands: Array<{path: string, pluginKey: string, marketplace: string}>}>}
 */
async function findResources(cwd) {
  const enabledPluginKeys = await loadEnabledPluginKeys(cwd);
  const marketplaceDirs = await readDirectories(MARKETPLACES_DIR);
  const skills = [];
  const commands = [];

  for (const marketplaceDir of marketplaceDirs) {
    const marketplaceName = basename(marketplaceDir);
    const marketplacePluginKey = `${marketplaceName}@${marketplaceName}`;
    const isMarketplacePluginEnabled = enabledPluginKeys.has(marketplacePluginKey);

    // Top-level marketplace skills: <m>/skills/<skill>/SKILL.md
    const topLevelSkillDirs = await readDirectories(join(marketplaceDir, "skills"));
    for (const skillDir of topLevelSkillDirs) {
      const pluginKey = `${basename(skillDir)}@${marketplaceName}`;
      if (!isMarketplacePluginEnabled && !enabledPluginKeys.has(pluginKey)) continue;
      const skillPath = join(skillDir, "SKILL.md");
      if (await fileExists(skillPath)) {
        skills.push({ path: skillPath, directory: skillDir, pluginKey, marketplace: marketplaceName });
      }
    }

    // Marketplace-level commands: <m>/commands/*.md
    if (isMarketplacePluginEnabled) {
      for (const path of await readMarkdownFiles(join(marketplaceDir, "commands"))) {
        commands.push({ path, pluginKey: marketplacePluginKey, marketplace: marketplaceName });
      }
    }

    // Nested plugins: <m>/plugins/<p>/{skills,commands}
    const pluginDirs = await readDirectories(join(marketplaceDir, "plugins"));
    for (const pluginDir of pluginDirs) {
      const pluginKey = `${basename(pluginDir)}@${marketplaceName}`;
      if (!enabledPluginKeys.has(pluginKey)) continue;
      const pluginSkillDirs = await readDirectories(join(pluginDir, "skills"));
      for (const skillDir of pluginSkillDirs) {
        const skillPath = join(skillDir, "SKILL.md");
        if (await fileExists(skillPath)) {
          skills.push({ path: skillPath, directory: skillDir, pluginKey, marketplace: marketplaceName });
        }
      }
      for (const path of await readMarkdownFiles(join(pluginDir, "commands"))) {
        commands.push({ path, pluginKey, marketplace: marketplaceName });
      }
    }
  }

  return { skills, commands };
}

/**
 * Scan every marketplace for command markdown files, regardless of enablement.
 * Commands are registered globally (DSH registration is static, while Claude
 * enablement is cwd-scoped), so the handler re-checks enablement against the
 * current workspace on every invocation — fail closed when disabled.
 * @returns {Promise<Array<{path: string, pluginKey: string, marketplace: string}>>}
 */
async function findCommands() {
  const marketplaceDirs = await readDirectories(MARKETPLACES_DIR);
  const commands = [];
  for (const marketplaceDir of marketplaceDirs) {
    const marketplaceName = basename(marketplaceDir);
    const marketplacePluginKey = `${marketplaceName}@${marketplaceName}`;
    for (const path of await readMarkdownFiles(join(marketplaceDir, "commands"))) {
      commands.push({ path, pluginKey: marketplacePluginKey, marketplace: marketplaceName });
    }
    const pluginDirs = await readDirectories(join(marketplaceDir, "plugins"));
    for (const pluginDir of pluginDirs) {
      const pluginKey = `${basename(pluginDir)}@${marketplaceName}`;
      for (const path of await readMarkdownFiles(join(pluginDir, "commands"))) {
        commands.push({ path, pluginKey, marketplace: marketplaceName });
      }
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

function skillSource(resource) {
  return `claude-marketplace-bridge:${resource.marketplace}:${resource.pluginKey}`;
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

function createSkillProvider(log) {
  return {
    name: skillProviderName,
    async list(options) {
      const resources = await findResources(options.cwd ?? process.cwd());
      const candidates = [];
      for (const resource of resources.skills) {
        const parsed = await readSkillFile(resource, log);
        if (!parsed) continue;
        candidates.push({
          name: parsed.name,
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
        name: parsed.name,
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

async function registerCommands(ctx, log, commands) {
  const seen = new Set();
  let registered = 0;
  let skipped = 0;

  for (const command of commands) {
    const commandName = sanitizeCommandName(command.path);
    if (!commandName) {
      skipped += 1;
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
        description: description ?? `Claude Code command from ${command.marketplace}`,
        handler: async ({ agent, rawInput }) => {
          const cwd = agent.session.header.cwd ?? process.cwd();
          const enabledKeys = await loadEnabledPluginKeys(cwd);
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

  log.info(`[claude-marketplace-bridge] registered ${registered} command(s), skipped ${skipped}`);
  return registered;
}

// ---------------------------------------------------------------------------
// Plugin apply
// ---------------------------------------------------------------------------

function apply(ctx) {
  const log = ctx.logger(name);

  // Skills: register a first-class provider on ctx.skills.
  ctx.skills.registerProvider(() => createSkillProvider(log));

  // Commands: register every command markdown file found on disk; enablement
  // is re-checked per invocation against the current workspace (see handler).
  void (async () => {
    try {
      const commands = await findCommands();
      log.info(`[claude-marketplace-bridge] found ${commands.length} command file(s) under ${MARKETPLACES_DIR} (enablement checked per invocation)`);
      await registerCommands(ctx, log, commands);
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
        const resources = await findResources(cwd);
        const lines = [
          `[claude-marketplace-bridge] ${resources.skills.length} skill(s), ${resources.commands.length} command(s) from ${MARKETPLACES_DIR}`,
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

  log.info(`[claude-marketplace-bridge] mounted (skills provider "${skillProviderName}", rank ${CLAUDE_MARKETPLACE_RANK})`);
}

export { apply, inject, name };
