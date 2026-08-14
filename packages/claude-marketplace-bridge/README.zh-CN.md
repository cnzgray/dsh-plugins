# @cnzgray/dsh-claude-marketplace-bridge（DeepSeek Harness 插件）

English | [简体中文](README.zh-CN.md)

把 **Claude Code 已安装的插件市场** 桥接进 DeepSeek Harness（DSH / Cordis）。这是 [pi-claude-plugins](https://www.npmjs.com/package/pi-claude-plugins) 扩展（MIT）移植到 DSH 原生机制上的实现：

- **skills** → 注册为 DSH 一等公民的 `ctx.skills` provider（`skill-filesystem` 同款），像普通技能一样出现在模型的技能目录里
- **commands** → 注册为真正的 DSH 斜杠命令；命令的 markdown 正文作为提示词模板，通过 `agent.steer()` 交给模型

只加载 Claude 里当前**已启用**的插件，同时遵守：

- `~/.claude/plugins/installed_plugins.json`（user / project 作用域）
- `~/.claude/settings.json`（`enabledPlugins`）

## 会加载什么

### Skills

（当所属插件已启用时）来自：

- `~/.claude/plugins/marketplaces/*/skills/*/SKILL.md`
- `~/.claude/plugins/marketplaces/*/plugins/*/skills/*/SKILL.md`

frontmatter 里的 `name`、`description`、`whenToUse`、`disable-model-invocation` / `user-invocable` 都会被识别。导入的技能 rank 为 `550`：低于你自己的项目/自定义/用户技能根目录（100–500），高于内置系统技能（600）——重名时你自己的技能永远优先。

### Commands

来自：

- `~/.claude/plugins/marketplaces/*/commands/*.md`
- `~/.claude/plugins/marketplaces/*/plugins/*/commands/*.md`

每个 `.md` 变成一个斜杠命令（文件名 → `/名字`，小写 kebab-case）。执行时读取模板，替换 `$ARGUMENTS`、`$1`…`$9` 和 `$CWD`，然后把结果作为一条用户消息交给 agent。命令 `description:` frontmatter 会显示在命令列表里。

## 启用状态如何生效

Claude 的 `installed_plugins.json` 键形如 `frontend-design@claude-plugins-official` 或 `minimax-skills@minimax-skills`。只有「已安装 **且** 未在 `settings.json` 里显式禁用」的资源才会暴露：

- `user` 作用域 → 始终启用
- `project` 作用域 → 仅当当前工作区位于该 `projectPath` 内时启用

**Skills** 每次按当前 `cwd` 查询时重新评估。**Commands** 在启动时注册全部命令文件（DSH 命令注册表是静态的），每次调用时再按当前工作区重新检查启用状态——不在启用范围内就 fail closed，给出明确提示。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add @cnzgray/dsh-claude-marketplace-bridge

# 或本地路径
dsh plugin --profile web add ./packages/claude-marketplace-bridge

# 不启动，先验证组装后的配置树
dsh --profile web --dump-config | grep -A3 claude-marketplace-bridge

# 重启 web profile（会结束当前 GUI 会话）
dsh web
```

需要 `skills` 和 `commands` 两个服务（自带的 `web` / `headless` profile 都已挂载）。

## 验证

- 启动时宿主日志显示 `found N command file(s) under ~/.claude/plugins/marketplaces` 以及 skills provider 挂载行。
- 已启用的市场技能出现在模型的技能目录里（如技能 UI 或 `skill` 工具）。
- 输入 `/claude-marketplace-bridge` 显示按插件归类的已加载技能/命令汇总。
- 运行导入的命令（如 `/review`）执行其模板。

## 说明

- **只读实时桥接**：直接读 Claude Code 现有的 `~/.claude/plugins/`，不做拷贝或迁移。在 Claude 里启用/禁用插件后，重启 `dsh web` 生效（技能按会话查询即时重估；命令在启动时注册）。
- **不执行 Claude 插件的 hooks / 运行时逻辑**——只导入能干净映射到 DSH 的文件资源：`SKILL.md` 技能和命令 markdown。插件的 agents、hooks、MCP server、非 markdown 命令格式不在范围内（与 pi-claude-plugins 的局限一致）。
- **零 `@deepseek-ai/*` 运行时依赖**：只用 Node 内置模块加 `yaml` 包（DSH 官方 skill provider 用的同一个 frontmatter 解析库）。
- 插件源码在 profile 之外，`cordis-plugin-hmr` 不会监听它。改代码后需重启 `dsh web`。

## 文件

- 入口：`index.js`
- 包清单：`package.json` / `cordis.patch.yml`

## License

MIT
