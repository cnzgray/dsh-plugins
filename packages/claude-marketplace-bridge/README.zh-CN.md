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

发现逻辑遵循 Claude 权威的已安装插件布局——`installed_plugins.json` 里的 `installPath`（`~/.claude/plugins/cache/<市场>/<插件>/<版本>/`），对每个已启用插件的安装目录做有界递归扫描，找 `skills/<技能>/SKILL.md`（也兼容 `skills-default` / `skills-opus` 这类模型变体目录）。安装目录内自带 `.claude-plugin/plugin.json` 的（如"捆绑式"插件），按 manifest 名归属到对应插件 key。

**命名采用 `<插件>-<技能>` 前缀**——即 Claude Code 的 `插件:技能` 身份，因 DSH 技能名只允许 `[a-z0-9-]`（不含冒号），用 kebab 编码：

| 市场布局 | 目录里的名字 |
|---|---|
| `ponytail` 顶层技能 `ponytail-audit` | `ponytail-ponytail-audit` |
| `claude-plugins-official` 插件 `claude-md-management` 的技能 `claude-md-improver` | `claude-md-management-claude-md-improver` |
| `cnzgray-marketplace` 插件 `cexll` 的技能 `do` | `cexll-do` |

frontmatter 里的 `name`、`description`、`whenToUse`、`disable-model-invocation` / `user-invocable` 都会被识别。导入的技能 rank 为 `550`：低于你自己的项目/自定义/用户技能根目录（100–500），高于内置系统技能（600）——重名时你自己的技能永远优先。同一插件内的同名技能（如 `skills-default`/`skills-opus`/`skills-kimi` 三份）按路径排序保留第一个。

### Commands

来自同一次 install-path 扫描：安装目录里任意位置的 `commands/*.md`（同样按 manifest 规则归属）。

每个 `.md` 变成一个斜杠命令（文件名 → `/名字`，小写 kebab-case）。执行时读取模板，替换 `$ARGUMENTS`、`$1`…`$9` 和 `$CWD`，然后把结果作为一条用户消息交给 agent。命令 `description:` frontmatter 会显示在命令列表里。

## 启用状态如何生效

Claude 的 `installed_plugins.json` 键形如 `frontend-design@claude-plugins-official` 或 `minimax-skills@minimax-skills`。只有「已安装 **且** 未在 `settings.json` 里显式禁用」的资源才会暴露：

- `user` 作用域 → 始终启用
- `project` 作用域 → 仅当当前工作区位于该 `projectPath` 内时启用

**Skills** 每次按当前 `cwd` 查询时重新评估。**Commands** 在启动时注册全部命令文件（DSH 命令注册表是静态的），每次调用时再按当前工作区重新检查启用状态——不在启用范围内就 fail closed，给出明确提示。

## 屏蔽命令 / 技能

在 profile 的补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）里通过插件的 `config` 配置黑名单：

```yaml
- id: claude-marketplace-bridge
  config:
    blockedCommands:
      - review                        # 按命令名屏蔽（斜杠可省）
      - /git-commit
      - git-*                         # 命令名通配
      - code-review@claude-plugins-official   # 屏蔽某插件的全部命令
      - @cnzgray-marketplace          # 屏蔽某市场的全部命令
    blockedSkills:
      - ponytail-ponytail             # 按 <插件>-<技能> 限定名屏蔽技能
      - frontend-design@claude-plugins-official  # 屏蔽某插件的全部技能
      - @cnzgray-marketplace          # 屏蔽某市场的全部技能
```

条目形式（无歧义）：

| 条目 | 匹配 |
|---|---|
| `名字` 或 `/名字` | 命令名，或技能的 `<插件>-<技能>` 限定名 |
| `模式*` | 同名通配（`*` = 任意字符序列） |
| `插件@市场` | 该插件 key 的全部资源 |
| `@市场` | 该市场的全部资源 |

`blockedCommands` 只管命令、`blockedSkills` 只管技能——想两个面都屏蔽就把条目同时加进两个列表。匹配不到任何资源的规则会在启动时告警（拼写错误 / 过期规则）。屏蔽数量显示在 `/claude-marketplace-bridge` 里。命令在启动时注册，改黑名单需重启 `dsh web`。

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

- 启动时宿主日志显示 `found N command file(s) across installed plugins` 以及 skills provider 挂载行。
- 已启用的市场技能以 `<插件>-<技能>` 名字出现在模型的技能目录里（如技能 UI 或 `skill` 工具）。
- 输入 `/claude-marketplace-bridge` 显示按插件归类的已加载技能/命令汇总。
- 运行导入的命令（如 `/review`）执行其模板。

## 说明

- **只读实时桥接**：直接读 Claude Code 现有的 `~/.claude/plugins/`，不做拷贝或迁移。在 Claude 里启用/禁用插件后，重启 `dsh web` 生效（技能按会话查询即时重估；命令在启动时注册）。
- **不执行 Claude 插件的 hooks / 运行时逻辑**——只导入能干净映射到 DSH 的文件资源：`SKILL.md` 技能和命令 markdown。插件的 agents、hooks、MCP server、非 markdown 命令格式不在范围内（与 pi-claude-plugins 的局限一致）。
- **捆绑式市场怪癖**：如果某个插件的安装目录里含有其他插件的内容（如 `cnzgray-marketplace` 的 `cexll` 打包了 `omo-workflow`、`development-essentials`），这些技能会同时以捆绑插件前缀出现——`cexll-omo-*` 会和 `omo-omo-*` 并存。这和 Claude Code 看到的内容一致；禁用捆绑插件即可去掉。
- **零 `@deepseek-ai/*` 运行时依赖**：只用 Node 内置模块加 `yaml` 包（DSH 官方 skill provider 用的同一个 frontmatter 解析库）。
- 插件源码在 profile 之外，`cordis-plugin-hmr` 不会监听它。改代码后需重启 `dsh web`。

## 文件

- 入口：`index.js`
- 包清单：`package.json` / `cordis.patch.yml`

## License

MIT
