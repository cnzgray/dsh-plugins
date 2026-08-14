# @cnzgray/dsh-claude-auto-memory (DeepSeek Harness plugin)

把 Claude Code 的自动记忆（`~/.claude/projects/<encoded>/memory/MEMORY.md`）在会话开始时桥接进 DeepSeek Harness（DSH / Cordis）。

- 每次 `agent/session-start` 注入一次 MEMORY.md（进入对话历史，全程可见）
- 上限 200 行 / 25 KB（先到先截断），80% 时追加 size warning
- 未初始化项目仍注入创建引导（bootstrap）
- 提供 `/claude-memory` 命令查看状态（路径 / 行数 / 字节数 / topic 列表）

## 安装与装载

本包声明了 `dsh.bundle`，`dsh plugin add` 会自动把它加入 profile 的 bundle 层栈并挂载 entry，**无需手动改任何 yml**：

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add @cnzgray/dsh-claude-auto-memory

# 或从本地路径 / git 仓库（monorepo 子目录）/ tarball 安装
dsh plugin --profile web add ./packages/claude-auto-memory
dsh plugin --profile web add github:cnzgray/dsh-plugins/packages/claude-auto-memory

# 校验装配后的树（不启动）
dsh --profile web --dump-config | grep -A3 claude-auto-memory

# 重启 web profile（会杀掉当前 GUI 会话）
dsh web
```

## 验证

- 新会话开始时，宿主日志应出现 `[memory] loaded: <path>` 或 bootstrap 提示。
- 在输入框输入 `/claude-memory` 应显示记忆文件状态。

## 注意

- 该插件是**实时只读桥**：它读的是 Claude Code 已存在的 `~/.claude/projects/`，不会复制/迁移，Claude Code 侧更新后下次会话即生效（mtime 缓存会失效重读）。
- 插件源码在 profile 之外，`cordis-plugin-hmr`（`root: ['.']`）不会监视它；改代码后需重启 `dsh web`。
- 想要 DSH 原生记忆（不依赖 Claude Code 的文件），参考官方 [deepseek-ai/deepseek-harness Discussion #525](https://github.com/deepseek-ai/deepseek-harness/discussions/525)。
