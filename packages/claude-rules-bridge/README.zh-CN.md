# @cnzgray/dsh-claude-rules-bridge

把 [Claude Code](https://code.claude.com/docs/en/memory) 的 `.claude/rules/*.md` 与 `*.mdc` 规则文件桥接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH / Cordis），与 omp 扩展 `claude-rules-bridge` 对齐：

- **发现** — 从会话 cwd 向上走到 `$HOME`，加上 `~/.claude/rules/`。Frontmatter：
  - `paths` / `globs` / `applyTo` → 文件匹配 glob（合并）
  - `alwaysApply` → 会话开始时总是注入
  - `description` → `/claude-rules` 列表的元数据
- **alwaysApply 规则** → 会话开始注入一次（从第一次请求即生效）。
- **路径作用域规则** → 在 `read` / `write` / `edit` 工具结果命中 glob 时动态注入。

> `CLAUDE.md` / `AGENTS.md` **不在此插件处理**——内置 `@deepseek-ai/dsh-agent-instructions` 已经实现了项目根基线与触碰时嵌套加载，采用其行为。

## 行为

| 层 | 时机 | 内容 |
| --- | --- | --- |
| 基线 | `agent/session-start`（覆盖 startup、resume、clear、compact） | `.claude/rules/` 中的 `alwaysApply` 规则（cwd→`$HOME` 向上 + `~/.claude/rules/`） |
| 动态 | 成功的 `read` / `write` / `edit` 工具结果 | 命中触碰文件 glob 的路径作用域规则（cwd 相对路径 + 文件名） |

- **cwd 之外**的文件不获得任何规则。
- 每会话去重：每条规则每个目标路径只注入一次；resume/compact 重新加载会重置会话状态。
- Token 上限：每个注入块 12 KB，每个规则文件 6 KB。

## Seams

全部使用 DSH 原生接缝，根作用域监听（可收到每个 agent 的 scoped 事件）：

- `agent/session-start` → `agent.inject()` 基线（与 `@cnzgray/dsh-claude-auto-memory` 相同模式）。
- `tools/result` → `agent.inject()` 动态上下文消息，由下一次 pre-step 认领（与 `@deepseek-ai/dsh-agent-instructions` 相同机制）。
- `ctx.commands.register` → `/claude-rules` 状态命令。
- `ctx.tools.register` → `claude_rules` 按需索引/阅读工具。

运行时零 `@deepseek-ai/*` 依赖；唯一运行时依赖是 `picomatch`（声明在 `package.json` 中）。从 npm 安装时 `dsh plugin add`（pnpm）会自动装好传递依赖。本地 `link:` 开发时，在包目录内先跑一次 `npm install`，插件的 `import picomatch` 即可解析。

## 安装

```bash
dsh plugin --profile web add @cnzgray/dsh-claude-rules-bridge
dsh web   # 重启生效
```

本地开发：

```bash
npm install   # 一次性，在 packages/claude-rules-bridge/ 内执行（为 link: 开发安装 picomatch）
dsh plugin --profile web add ./packages/claude-rules-bridge
# 改源码 → 重启 `dsh web`
```

## 用法

- `/claude-rules` — 列出发现的规则（子命令：`reload`）。
- `claude_rules` 工具 — 模型可按需列出索引或读取某条规则全文；匹配是 read/edit/write 时自动发生的。

## 规则示例

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "**/*.api.ts"
description: API endpoint rules
---
- 每个 API endpoint 都必须包含输入校验。
```

```markdown
---
alwaysApply: true
---
- 使用 2 空格缩进。
```

## License

MIT
