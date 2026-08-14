// Claude Code rules bridge for DeepSeek Harness (Cordis plugin).
//
// Bridges Claude Code's .claude/rules/*.md and *.mdc rule files into DSH,
// mirroring the omp extension of the same name:
//
//  - Discovery: `.claude/rules/` scanned from the session cwd (walked up to
//    $HOME) plus `~/.claude/rules/`. Frontmatter:
//      - paths | globs | applyTo → file-match globs (merged)
//      - alwaysApply             → always injected at session start
//      - description             → metadata for the /claude-rules listing
//    - alwaysApply rules → injected once at session start (baseline).
//    - Path-scoped rules → injected dynamically on read/edit/write tool
//      results when the touched file matches the globs.
//
// CLAUDE.md / AGENTS.md are intentionally NOT handled here: the built-in
// `@deepseek-ai/dsh-agent-instructions` already implements the project-root
// baseline and on-touch nested loading, and its behavior is preferred.
//
// DSH seams (all root-realm, unfiltered listeners receive every agent's
// scoped events):
//   - `agent/session-start` → discover + `agent.inject()` baseline.
//   - `tools/result`        → match + `agent.inject()` dynamic context
//     (queues for the next pre-step, exactly like dsh-agent-instructions).
//   - `ctx.commands.register` → `/claude-rules` status command.
//   - `ctx.tools.register`    → `claude_rules` on-demand index/reader tool.
//
// All file reads are SYNCHRONOUS on purpose (same discipline as
// claude-auto-memory): the baseline injection must complete inside the
// `agent/session-start` emit dispatch so it cannot race the driver's first
// pre-step claim, and each dynamic injection must complete inside the
// `tools/result` dispatch so it lands before the next pre-step. Files are
// small (capped), so blocking is negligible.
//
// Zero runtime imports from @deepseek-ai/* (same discipline as
// claude-auto-memory): the message is a plain frozen data object
// (id = crypto.randomUUID(), matching createUserMessage) and ctx/agent/tools/
// commands arrive via apply(ctx). Glob matching uses the `picomatch` npm
// dependency (same options as the omp bridge; resolved from the package's own
// node_modules — `npm install` in this directory for local `link:` dev).
// Frontmatter stays hand-rolled to avoid a yaml dependency.
//
// Token cap: 12 KB per injected block, 6 KB per rule file.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import picomatch from "picomatch";

export const name = "claude-rules-bridge";
// Mount once the slash-command registry is available (web profile mounts it).
export const inject = ["commands"];

const MAX_BYTES = 12_000;
const MAX_RULE_BYTES = 6_000; // per-rule ceiling so one giant file can't dominate
const TRACKED_TOOLS = new Set(["read", "write", "edit"]);
const GLOB_OPTIONS = { bash: true, dot: true };

const HOME = homedir();

// ───────────────────────────────────────────────────────────────────────────
// Rule discovery (ported from the omp bridge, sync fs)
// ───────────────────────────────────────────────────────────────────────────

function toArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string" && v.length) return [v];
  return [];
}

function parseFrontmatter(yaml) {
  const out = {};
  const lines = yaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const [, k, raw] = m;
    const v = raw.trim();
    if (v === "") {
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const it = lines[j].match(/^\s*-\s*(.*)$/);
        if (!it) break;
        items.push(it[1].trim().replace(/^["']|["']$/g, ""));
        j++;
      }
      out[k] = items.length > 0 ? items : "";
      i = j;
      continue;
    }
    if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else if (v.startsWith("[") && v.endsWith("]")) {
      out[k] = v
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else out[k] = v.replace(/^["']|["']$/g, "");
    i++;
  }
  return out;
}

function parseRule(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let fm = {};
  let body = raw;
  if (m) {
    fm = parseFrontmatter(m[1]);
    body = m[2].trim();
  }
  const globs = [...toArray(fm.paths), ...toArray(fm.globs), ...toArray(fm.applyTo)];
  return {
    name: basename(filePath).replace(/\.(md|mdc)$/, ""),
    filePath,
    body: body.length > MAX_RULE_BYTES ? body.slice(0, MAX_RULE_BYTES) + "\n\n[...truncated]" : body,
    globs,
    alwaysApply: fm.alwaysApply === true,
    description: typeof fm.description === "string" ? fm.description : "",
  };
}

function scanRulesDir(dir, out, seen) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/\.(md|mdc)$/.test(entry)) continue;
    const fp = join(dir, entry);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const r = parseRule(fp);
    if (r) out.push(r);
  }
}

/** Walk cwd up to $HOME + scan the user-home ~/.claude/rules/. */
export function discoverRules(cwd) {
  const out = [];
  const seen = new Set();
  let dir = resolve(cwd);
  for (;;) {
    scanRulesDir(join(dir, ".claude", "rules"), out, seen);
    const parent = dirname(dir);
    if (parent === dir || dir === HOME) break;
    dir = parent;
  }
  scanRulesDir(join(HOME, ".claude", "rules"), out, seen);
  return out;
}

// ── Glob matching (picomatch, same options as the omp bridge) ─────────────
// Matched against the cwd-relative path and the basename (`**/*.ts` matches
// `a.ts` at the root; `*.md` applies to md files at any depth).

export function matchesGlobs(globs, relPath, base) {
  let positive = false;
  for (const g of globs) {
    const neg = g.startsWith("!");
    const isMatch = picomatch(neg ? g.slice(1) : g, GLOB_OPTIONS);
    if (isMatch(relPath) || isMatch(base)) {
      if (neg) return false;
      positive = true;
    }
  }
  return positive;
}

// ───────────────────────────────────────────────────────────────────────────
// Block builders
// ───────────────────────────────────────────────────────────────────────────

function buildAlwaysBlock(rules) {
  if (rules.length === 0) return "";
  const blocks = [];
  let used = 0;
  for (const r of rules) {
    const piece = `<!-- claude-rules: ${r.filePath} -->\n${r.body}`;
    if (used + piece.length > MAX_BYTES) break;
    blocks.push(piece);
    used += piece.length;
  }
  if (blocks.length === 0) return "";
  return [
    "## Project Rules (always-applied from .claude/rules/)",
    "",
    "Rules below are unconditionally in effect. Source of truth: `<repo>/.claude/rules/*.md`.",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

function buildDynamicBlock(matched, targetRel) {
  const blocks = [];
  const included = [];
  let used = 0;
  for (const m of matched) {
    const piece = `<!-- claude-rules: ${m.filePath} -->\n${m.body}`;
    if (used + piece.length > MAX_BYTES) break;
    blocks.push(piece);
    included.push(m);
    used += piece.length;
  }
  if (blocks.length === 0) return null;
  return {
    block: ["## Project Rules (matched for " + targetRel + ")", "", blocks.join("\n\n---\n\n")].join("\n"),
    included,
  };
}

function buildIndexText(state) {
  const scoped = state.rules.filter((r) => !r.alwaysApply && r.globs.length > 0);
  const always = state.rules.filter((r) => r.alwaysApply);
  const lines = [];
  if (scoped.length > 0) {
    lines.push("## Project Rules Index (.claude/rules/, path-scoped)");
    lines.push(...scoped.map((r) => `- ${r.name} — ${r.globs.join(", ")} — ${r.filePath}`));
  }
  if (always.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## Project Rules (always-applied, in session baseline)");
    lines.push(...always.map((r) => `- ${r.name} — ${r.filePath}`));
  }
  if (lines.length === 0) {
    lines.push(
      "No .claude/rules/ files found from cwd up to $HOME or in ~/.claude/rules/. " +
        "Path-scoped rules are injected dynamically on read/edit/write of matching files."
    );
  }
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Matching (ported from the omp bridge)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Path-scoped rules matching an absolute target path. Files outside cwd get
 * none (returns []). Globs are matched against the cwd-relative path and the
 * basename; `alwaysApply` rules are already in the session baseline and are
 * never injected dynamically.
 */
export function matchForPath(absPath, cwd, state) {
  const rel = relative(cwd, absPath).split(sep).join("/");
  const base = basename(absPath);
  if (rel.startsWith("..")) return []; // outside cwd: no project rules
  const out = [];
  for (const r of state.rules) {
    if (r.alwaysApply || r.globs.length === 0) continue; // alwaysApply already in the baseline
    if (matchesGlobs(r.globs, rel, base)) out.push({ filePath: r.filePath, body: r.body, kind: "rule" });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-agent session state
// ───────────────────────────────────────────────────────────────────────────

function makeState() {
  return {
    rules: [],
    // Per-session dedupe key: `${ruleFilePath}\0${absTargetPath}`. Reset on reload.
    injectedKeys: new Set(),
    loadedCwd: undefined,
  };
}

const states = new Map(); // agent.id -> state

function stateFor(agent) {
  let s = states.get(agent.id);
  if (!s) {
    s = makeState();
    states.set(agent.id, s);
  }
  return s;
}

function agentCwd(agent) {
  return agent?.session?.header?.cwd ?? process.cwd();
}

/** Discover rules for a cwd and reset session dedupe. */
function reloadState(state, cwd) {
  state.rules = discoverRules(cwd);
  state.injectedKeys = new Set();
  state.loadedCwd = cwd;
}

/** User-role, plugin-sourced message shaped exactly like createUserMessage. */
function makeMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name },
  });
}

function frame(text) {
  return [`<claude-rules-bridge>`, text.trimEnd(), `</claude-rules-bridge>`].join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// apply(ctx)
// ───────────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const log = ctx.logger(name);

  // Baseline: discover at session start (covers startup, resume, clear, and
  // compact) and inject alwaysApply rules. Fully synchronous so the baseline
  // is queued before the driver's first pre-step claim — in effect from the
  // first agent request.
  ctx.on("agent/session-start", ({ agent }) => {
    try {
      const cwd = agentCwd(agent);
      const state = stateFor(agent);
      reloadState(state, cwd);
      const always = buildAlwaysBlock(state.rules.filter((r) => r.alwaysApply));
      if (!always) return;
      agent.inject(makeMessage(frame(always)));
      log.info(`[rules] baseline: ${state.rules.length} rules (${cwd})`);
    } catch (error) {
      log.warn("[rules] baseline failed: %o", error);
    }
  });

  // Dynamic injection on successful read/edit/write results.
  // Nested (code-mode) touches bubble through opaque parent execution tokens
  // until the top-level result settles.
  const executionTouches = new Map(); // token -> { agent, path }[]
  ctx.on("tools/result", (exec, result) => {
    const touches = executionTouches.get(exec.token) ?? [];
    executionTouches.delete(exec.token);
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const path = filePathFromExecution(exec);
      if (path !== undefined) touches.push({ agent: exec.agent, path });
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent);
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches);
        else parentTouches.push(...touches);
      }
      return;
    }
    for (const touch of touches) projectTouch(touch.agent, touch.path, log);
  });

  // Slash command: /claude-rules (list or reload).
  ctx.commands.register({
    name: "claude-rules",
    description: "List .claude/rules/ files. Subcommand: reload",
    handler({ agent }) {
      const state = stateFor(agent);
      const cwd = agentCwd(agent);
      if (state.loadedCwd !== cwd) {
        // Never loaded for this cwd yet — discover on demand.
        try {
          reloadState(state, cwd);
        } catch (error) {
          return { kind: "error", text: `[rules] reload failed: ${error?.message ?? error}` };
        }
      }
      if (state.rules.length === 0) {
        return {
          kind: "error",
          text: `[rules] none found\ncwd: ${cwd}\nNo .claude/rules/ in cwd walk-up or ~/.claude/rules/.`,
        };
      }
      const lines = state.rules.map((r) => {
        const flags = [
          r.alwaysApply ? "alwaysApply" : null,
          r.globs.length ? `globs=[${r.globs.join(",")}]` : null,
        ]
          .filter(Boolean)
          .join(" ");
        return `- ${r.name}  ${flags}\n  ${r.filePath}`;
      });
      return {
        kind: "success",
        text: [`[rules] ${state.rules.length} rules`, ...lines].join("\n"),
      };
    },
  });

  // Model-facing on-demand index/reader tool: `claude_rules`.
  // Use ctx.get() — the service value — because bare property access (`ctx.tools`)
  // throws unless the service is declared in `inject`.
  const tools = ctx.get("tools");
  if (tools !== undefined) {
    tools.register({
      name: "claude_rules",
      description:
        "List path-scoped .claude/rules rules (no args), or read one rule's full content " +
        "(args: name). Matching rules are auto-injected into read/edit/write tool results.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description: "Optional rule name to read in full.",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            // DSH's enforced JSON-schema subset only allows `required` on
            // object-typed nodes; text is always returned, so keep it loose.
            text: { type: "string" },
          },
        },
        render(args, value) {
          return [{ type: "text", text: value.text }];
        },
      },
      execute(args, exec) {
        const agent = exec?.agent;
        const state = stateFor(agent);
        const cwd = agentCwd(agent);
        if (state.loadedCwd !== cwd) reloadState(state, cwd);
        const inputName = (args?.name ?? "").trim();
        if (!inputName) {
          return { text: buildIndexText(state) };
        }
        const rule = state.rules.find((r) => r.name === inputName);
        if (rule) {
          return { text: `<!-- claude-rules: ${rule.filePath} -->\n${rule.body}` };
        }
        const available = state.rules.map((r) => r.name).join(", ") || "none";
        return {
          text: `Unknown rule: ${inputName}\nAvailable: ${available}\n(Path-scoped rules are injected dynamically on read/edit/write of matching files.)`,
        };
      },
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Extract the touched file path from a read/write/edit execution's args. */
function filePathFromExecution(exec) {
  if (!TRACKED_TOOLS.has(exec.name)) return undefined;
  const args = exec.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  if (typeof args.file_path !== "string") return undefined;
  const filePath = args.file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

/** Compose + inject one dynamic context message for a touched path. Sync so it lands before the next pre-step. */
function projectTouch(agent, rawPath, log) {
  try {
    const cwd = agentCwd(agent);
    const absPath = resolve(cwd, rawPath);
    const rel = relative(cwd, absPath);
    if (rel.startsWith("..")) return; // outside cwd: nothing
    const state = stateFor(agent);
    if (state.loadedCwd !== cwd) reloadState(state, cwd);
    const matched = matchForPath(absPath, cwd, state);
    if (matched.length === 0) return;

    const keys = [];
    const seenRules = new Set(); // one event, one injection per rule file
    const toInject = [];
    for (const m of matched) {
      if (seenRules.has(m.filePath)) continue;
      seenRules.add(m.filePath);
      const key = `${m.filePath}\0${absPath}`;
      if (state.injectedKeys.has(key)) continue;
      state.injectedKeys.add(key);
      keys.push(key);
      toInject.push(m);
    }
    if (toInject.length === 0) return;
    const built = buildDynamicBlock(toInject, relative(cwd, absPath));
    if (!built) {
      for (const k of keys) state.injectedKeys.delete(k);
      return;
    }
    agent.inject(makeMessage(frame(built.block)));
  } catch (error) {
    log.warn("[rules] dynamic injection failed: %o", error);
  }
}
