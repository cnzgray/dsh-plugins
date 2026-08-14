# dsh-plugins

个人维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH / Cordis）插件合集。每个插件是一个独立的 npm 包，通过 `dsh plugin` 安装即可自动挂载（bundle 机制，无需手动改配置）。

## 插件列表

| 包 | 说明 | npm |
|---|---|---|
| [`packages/claude-auto-memory`](packages/claude-auto-memory) | 把 Claude Code 的 `~/.claude/projects/<encoded>/memory/MEMORY.md` 在会话开始时桥接进 DSH，附 `/claude-memory` 状态命令 | `@cnzgray/dsh-claude-auto-memory` |

## 安装

```bash
dsh plugin --profile web add @cnzgray/dsh-claude-auto-memory
dsh web   # 重启生效
```

## 开发

```bash
# 本地插件直接链接进 profile（改源码后重启 dsh web 生效）
dsh plugin --profile web add ./packages/<插件目录>

# 校验装配树（不启动）
dsh --profile web --dump-config | grep -A3 <插件 id>
```

新插件从复制 `packages/claude-auto-memory/` 开始：改 `package.json` 的 `name`、`cordis.patch.yml` 里的 `name`（bundle entry 指向真实包名）与 `id`。

## License

MIT
