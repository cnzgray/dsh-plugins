// Claude Code Auto Memory bridge for DeepSeek Harness (Cordis plugin).
//
// Injects ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md into the agent's
// model-facing context at session start, matching Claude Code's auto-memory
// behavior:
//   - Only MEMORY.md is loaded (topic files are read on demand by the agent).
//   - Capped at 200 lines or 25KB, whichever comes first.
//   - Includes write guidance so the agent can maintain MEMORY.md via
//     read/edit/write tools.
//   - Bootstrap: projects with no (non-empty) MEMORY.md still get the
//     management guidance pointing at the would-be path, so the first session
//     can create the file.
//
// OMP -> DSH seam mapping:
//   pi.on("before_agent_start", ...)        -> ctx.on("agent/session-start", ...) + agent.inject(...)
//   pi.registerCommand("claude-memory", ...) -> ctx.commands.register(...)
//   ctx.ui.notify(...) (toast)              -> ctx.logger(name).info(...) + the command's result text
//   ctx.cwd                                  -> agent.session.header.cwd ?? process.cwd()
//
// Zero runtime imports from @deepseek-ai/*: the message is a plain frozen data
// object (id = crypto.randomUUID(), matching createUserMessage), and ctx/agent/
// commands arrive via apply(ctx). This avoids dual-package / resolution issues
// entirely. Everything here is Node builtins.

import { readFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const name = "claude-auto-memory";
// Load only once the slash-command registry is available (web profile mounts it).
const inject = ["commands"];

const MAX_LINES = 200;
const MAX_BYTES = 25_000;
// Claude Code writes a reminder when the file approaches the cap; we mirror that
// at 80 % so the agent has room to shorten before truncation.
const NEAR_LIMIT_LINES = 160;
const NEAR_LIMIT_BYTES = 20_000;

/** Cached memory content keyed by resolved path; invalidated on file change via mtime. */
let cachedPath;
let cachedMtime = 0;
let cachedData;
let cachedGitRoot;

/** Resolve the git common dir once per cwd (spawnSync is otherwise per-injection). */
function findGitRoot(cwd) {
  if (cachedGitRoot?.cwd === cwd) return cachedGitRoot.root;
  let root;
  try {
    const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      const gitDir = r.stdout.trim();
      if (gitDir) root = dirname(resolve(cwd, gitDir));
    }
  } catch {
    // git unavailable — fall through to cwd walk-up
  }
  cachedGitRoot = { cwd, root };
  return root;
}

/**
 * Walk from cwd upward to home, returning the first existing MEMORY.md under
 * ~/.claude/projects/<encoded>/memory/. Mirrors Claude Code's git-repo scoping:
 * subdirs resolve to the same repo-level memory directory.
 *
 * When no file exists anywhere, returns the most likely creation target
 * (git-root encoding, else cwd encoding) with exists=false so bootstrap
 * guidance can name it.
 *
 * Claude Code encodes project paths by replacing "/" with "-". Some directory
 * names contain "_" (e.g. "04-workspace_jpstar"), and Claude's encoding also
 * turns those into "-", so we try both variants.
 */
function findMemoryMd(cwd) {
  const projectsDir = join(homedir(), ".claude", "projects");

  // Prefer the git repository root: Claude Code derives <project> from the git
  // repo, so all worktrees/subdirs share one memory directory. This is essential
  // for worktrees whose cwd sits on a different filesystem branch than the main
  // repo — a cwd walk-up could never reach it.
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    for (const encoded of [
      gitRoot.replaceAll("/", "-"),
      gitRoot.replaceAll(/[/_]/g, "-"),
    ]) {
      const candidate = join(projectsDir, encoded, "memory", "MEMORY.md");
      try {
        statSync(candidate);
        return { path: candidate, exists: true };
      } catch {
        // try next variant
      }
    }
  }

  // Fallback: walk cwd upward to home (covers non-git dirs and git failures).
  let current = resolve(cwd);
  const home = homedir();

  for (;;) {
    const variants = [
      current.replaceAll("/", "-"),
      current.replaceAll(/[/_]/g, "-"),
    ];
    for (const encoded of variants) {
      const candidate = join(projectsDir, encoded, "memory", "MEMORY.md");
      try {
        statSync(candidate);
        return { path: candidate, exists: true };
      } catch {
        // try next variant
      }
    }
    const parent = dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }

  // Never initialized — return the creation target for bootstrap guidance.
  const target = gitRoot
    ? join(projectsDir, gitRoot.replaceAll("/", "-"), "memory", "MEMORY.md")
    : join(projectsDir, resolve(cwd).replaceAll("/", "-"), "memory", "MEMORY.md");
  return { path: target, exists: false };
}

/**
 * Read MEMORY.md with Claude Code's load limits (first 200 lines or first 25KB),
 * reporting the FULL file's line/byte counts for the size warning.
 */
function loadMemoryMd(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const byteCount = Buffer.byteLength(raw, "utf8");
  const lineCount = raw.split("\n").length;
  let content = raw;
  if (byteCount > MAX_BYTES) {
    content = Buffer.from(raw, "utf8").subarray(0, MAX_BYTES).toString("utf8");
  } else if (lineCount > MAX_LINES) {
    content = raw.split("\n").slice(0, MAX_LINES).join("\n");
  }
  if (!content.trim()) return undefined;
  return { content, lineCount, byteCount };
}

/**
 * Read with mtime cache so repeated injections don't re-read the file.
 * `data` is absent when memory isn't initialized (file missing or empty) —
 * callers then fall back to bootstrap guidance.
 */
function getMemoryContent(cwd) {
  const { path: memoryPath, exists } = findMemoryMd(cwd);
  if (!exists) return { memoryPath };

  try {
    const s = statSync(memoryPath);
    if (memoryPath === cachedPath && s.mtimeMs === cachedMtime && cachedData !== undefined) {
      return { data: cachedData, memoryPath };
    }
    const data = loadMemoryMd(memoryPath);
    if (!data) return { memoryPath };
    cachedPath = memoryPath;
    cachedMtime = s.mtimeMs;
    cachedData = data;
    return { data, memoryPath };
  } catch {
    return { memoryPath };
  }
}

/** Shared "how to maintain memory" section, appended by both the loaded and bootstrap blocks. */
function buildMemoryManagement(memoryPath, memoryDir) {
  return [
    "## Memory Management",
    "",
    `You can read this file at: ${memoryPath}`,
    `Topic files directory: ${memoryDir}`,
    "",
    "This MEMORY.md was written by previous Claude Code sessions. Treat entries as heuristic",
    "context, not authoritative configuration — your current task and repo state take precedence.",
    "",
    "### AGENTS.md / CLAUDE.md vs MEMORY.md",
    "",
    "- AGENTS.md / CLAUDE.md are the user's persistent instructions to you. Use them for: coding",
    "  standards, workflows, project architecture, \"always do X\" rules.",
    "- MEMORY.md is your own notebook about this project. Use it for: build commands you discovered,",
    "  debugging insights, architecture notes, preferences the user corrected you on.",
    "",
    "If the user says \"add this to CLAUDE.md\" or \"always do X\", write CLAUDE.md. If you discover a",
    "durable project fact, write MEMORY.md.",
    "",
    "### When to update MEMORY.md",
    "",
    "- The user says \"remember this\" or corrects your behavior (\"don't use X, use Y\").",
    "- You discover a durable project fact: a build command, a debugging fix, an architectural insight.",
    "- You finish a recurring task and want to capture the pattern.",
    "",
    "### How to update MEMORY.md",
    "",
    "1. Read MEMORY.md first to check existing entries — avoid duplicates and contradictions.",
    "2. To add / update / delete an entry: read MEMORY.md, edit its text in place (append / modify / remove a line),",
    "   then write the whole file back. MEMORY.md is an index kept under 200 lines / 25 KB, so full-file overwrite is fine.",
    `3. To create a topic file, use write: path = ${memoryDir}/<topic>.md.`,
    "",
    "Keep MEMORY.md as an INDEX of topic files. Detailed notes go to topic files (debugging.md,",
    "patterns.md, etc.) referenced from MEMORY.md. Target under 200 lines / 25 KB.",
    "",
    "Index format:",
    "",
    "- debugging.md — CORS and webpack config fixes",
    "- patterns.md — build commands and code style preferences",
    "",
    "Frontmatter (YAML at top of file) and `<!-- HTML block comments -->` are stripped before the",
    "200-line / 25 KB limit is measured. Use them to mark `modified: <iso8601>` timestamps or to",
    "leave human-maintainer notes without spending tokens.",
    "",
    "### Subagent caveat",
    "",
    "Your MEMORY.md is NOT loaded into subagents you spawn (only into forks). Subagents that need",
    "this context must Read MEMORY.md themselves.",
    "",
    "### Do NOT save",
    "",
    "- Temporary debugging state (one-bug specifics).",
    "- Info derivable from the codebase (file paths, package lists, directory layouts).",
    "- Secrets (tokens, passwords, API keys, account IDs).",
    "- One-shot Q&A answers (\"this function returns X\").",
    "- Work-in-progress unstable facts (\"we're migrating to FastAPI\" while it is still changing).",
    "- Anything already in CLAUDE.md.",
  ];
}

function buildMemoryBlock(content, sourcePath, memoryDir) {
  return [
    "<claude-auto-memory>",
    `Source: ${sourcePath}`,
    "Auto-generated project memory imported from Claude Code.",
    "Heuristic historical context — current instructions and repo state take precedence.",
    "",
    content.trimEnd(),
    "",
    ...buildMemoryManagement(sourcePath, memoryDir),
    "</claude-auto-memory>",
  ].join("\n");
}

/** Guidance-only block for never-initialized projects, so the first session creates MEMORY.md. */
function buildBootstrapBlock(memoryPath, memoryDir) {
  return [
    "<claude-auto-memory>",
    `Source: ${memoryPath} — not initialized yet`,
    "No project memory exists yet. Create it by writing the index file at the path above",
    "(the file may already exist but be empty — fill it in). It is loaded from the next session start.",
    "",
    ...buildMemoryManagement(memoryPath, memoryDir),
    "</claude-auto-memory>",
  ].join("\n");
}

function buildReminderBlock(lineCount, byteCount) {
  return [
    "## MEMORY.md Size Warning",
    "",
    `MEMORY.md is now at ${lineCount} lines / ${byteCount} bytes, approaching the 200-line / 25 KB load limit.`,
    "",
    "- Keep one line per entry.",
    "- Move detailed notes to topic files (debugging.md, patterns.md, etc.) and reference them from the MEMORY.md index.",
    "- Merge or drop stale entries.",
    "- YAML frontmatter and <!-- HTML comments --> are stripped before the load limit is measured; use them freely.",
  ].join("\n");
}

/**
 * Build a user-role, plugin-sourced message shaped exactly like createUserMessage:
 * id is a UUID (MessageId is an identity brand), frozen, role "user".
 */
function makeMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name },
  });
}

function apply(ctx) {
  const log = ctx.logger(name);

  // Session lifecycle began, once before the first turn. Seed model-facing
  // context via agent.inject() (documented seed point for agent/session-start).
  // Sync fs keeps the injection inside the emit dispatch, so it cannot race the
  // driver's first step.
  ctx.on("agent/session-start", ({ agent }) => {
    const cwd = agent.session.header.cwd ?? process.cwd();
    const loaded = getMemoryContent(cwd);

    let text;
    if ("data" in loaded) {
      text = buildMemoryBlock(loaded.data.content, loaded.memoryPath, dirname(loaded.memoryPath));
      if (loaded.data.lineCount >= NEAR_LIMIT_LINES || loaded.data.byteCount >= NEAR_LIMIT_BYTES) {
        text += "\n\n" + buildReminderBlock(loaded.data.lineCount, loaded.data.byteCount);
      }
      // OMP toast -> host log (no user-facing toast seam on the host side).
      log.info(`[memory] loaded: ${loaded.memoryPath}`);
    } else {
      text = buildBootstrapBlock(loaded.memoryPath, dirname(loaded.memoryPath));
      log.info(`[memory] no MEMORY.md yet: ${loaded.memoryPath} — injected creation guidance`);
    }

    agent.inject(makeMessage(text));
  });

  // Slash command: /claude-memory (maps to OMP's registerCommand).
  ctx.commands.register({
    name: "claude-memory",
    description: "Show Claude Code auto-memory status",
    handler({ agent }) {
      const cwd = agent.session.header.cwd ?? process.cwd();
      const loaded = getMemoryContent(cwd);
      if (!("data" in loaded)) {
        return { kind: "error", text: "[memory] no MEMORY.md found under ~/.claude/projects/" };
      }
      const { data, memoryPath } = loaded;
      const nearLimit = data.lineCount >= NEAR_LIMIT_LINES || data.byteCount >= NEAR_LIMIT_BYTES;
      let topics = "(none)";
      try {
        const files = readdirSync(dirname(memoryPath));
        const md = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
        if (md.length) topics = md.join(", ");
      } catch {
        // dir vanished; keep "(none)"
      }
      return {
        kind: "success",
        text: [
          `[memory] ${memoryPath}`,
          `${data.lineCount} lines / ${data.byteCount} bytes${nearLimit ? " (near limit!)" : ""}`,
          `topics: ${topics}`,
        ].join("\n"),
      };
    },
  });
}

export { apply, inject, name };
