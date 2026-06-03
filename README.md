# pi-fast-context

`pi-fast-context` 是一个 Pi 原生 extension package，把 Fast Context / Windsurf Devstral 代码库语义搜索注册成 Pi native tool。

它参考 `fast-context-skill` 的核心搜索实现，但不走 MCP server，也不让模型 shell-out 调 CLI；Pi 会直接加载 extension 并注册工具。

## 能力

- 注册 Pi 原生工具：`fast_context_search`
- 通过 `/fast-context-config` 交互式配置 Windsurf API Key 和搜索默认参数
- 通过 `/fast-context-status` 查看 key 来源、masked key、配置文件和搜索参数
- 通过 `/fast-context-test` 手动测试 key，并可运行轻量搜索
- Key 解析优先级：

```text
FAST_CONTEXT_API_KEY / WINDSURF_API_KEY 环境变量
  > 项目配置 .pi/fast-context.json
  > 全局配置 ~/.pi/agent/fast-context.json
  > Windsurf state.vscdb 自动提取
```

## 安装 / 本地加载

```bash
npm install
pi -e .
```

或作为 Pi package 安装：

```bash
pi install ./path/to/pi-fast-context
```

## 快速开始

1. 加载 extension 后运行：

```text
/fast-context-status
```

2. 如果没有自动发现 Windsurf key，运行：

```text
/fast-context-config
```

可选择：

- 全局配置：`~/.pi/agent/fast-context.json`
- 项目配置：`.pi/fast-context.json`

3. 可选测试：

```text
/fast-context-test
```

4. Agent 在需要语义发现时调用：

```text
fast_context_search
```

## 工具

### `fast_context_search`

参数：

```ts
{
  query: string;
  project_root_path?: string;
}
```

建议用法：

- 相关文件、实现流程、架构关系、行为或测试未知时，用它做语义发现
- 查询应是简洁自然语言 + 可选关键字
- 返回结果只是候选文件、行范围、grep keywords；修改代码前必须再用 Pi 普通 `read`/`bash` 等工具读取验证

不要用于：

- 精确标识符搜索
- exhaustive references
- 目录列表
- 读取已知文件
- 修改文件

## 命令

| 命令 | 说明 |
|---|---|
| `/fast-context-config` | 交互式配置 |
| `/fast-context-config project` | 编辑项目配置 `.pi/fast-context.json` |
| `/fast-context-config global` | 编辑全局配置 `~/.pi/agent/fast-context.json` |
| `/fast-context-config clear` | 删除项目或全局配置 |
| `/fast-context-status` | 查看配置、key 来源和默认搜索参数 |
| `/fast-context-test` | 测试 key，可选运行轻量搜索 |

## 配置字段

| 字段 | 环境变量 | 默认值 | 说明 |
|---|---|---:|---|
| `apiKey` | `FAST_CONTEXT_API_KEY` / `WINDSURF_API_KEY` | - | Windsurf API Key |
| `dbPath` | `FAST_CONTEXT_DB_PATH` | auto | 自定义 Windsurf `state.vscdb` 路径 |
| `treeDepth` | `FAST_CONTEXT_TREE_DEPTH` | `0` | repo tree 深度，0 为自动 |
| `maxTurns` | `FAST_CONTEXT_MAX_TURNS` | `3` | 搜索轮数 |
| `maxCommands` | `FAST_CONTEXT_MAX_COMMANDS` | `8` | 每轮最多本地命令数 |
| `maxResults` | `FAST_CONTEXT_MAX_RESULTS` | `10` | 返回文件数量 |
| `timeoutSecs` | `FAST_CONTEXT_TIMEOUT_SECS` | `30` | 请求超时秒数 |
| `excludePaths` | `FAST_CONTEXT_EXCLUDE_PATHS` | `[]` | 额外排除路径，逗号分隔 |
| `repoMapMode` | `FAST_CONTEXT_REPO_MAP_MODE` | `bootstrap_hotspot` | `classic` 或 `bootstrap_hotspot` |
| `bootstrapEnabled` | `FAST_CONTEXT_BOOTSTRAP_ENABLED` | `true` | 是否启用 bootstrap phase |
| `bootstrapTreeDepth` | `FAST_CONTEXT_BOOTSTRAP_TREE_DEPTH` | `1` | bootstrap tree depth |
| `hotspotTopK` | `FAST_CONTEXT_HOTSPOT_TOP_K` | `4` | hotspot 目录数量 |
| `hotspotTreeDepth` | `FAST_CONTEXT_HOTSPOT_TREE_DEPTH` | `2` | hotspot subtree depth |
| `hotspotMaxBytes` | `FAST_CONTEXT_HOTSPOT_MAX_BYTES` | `122880` | hotspot repo map 字节预算 |
| `bootstrapMaxTurns` | `FAST_CONTEXT_BOOTSTRAP_MAX_TURNS` | `2` | bootstrap 最大轮数 |
| `bootstrapMaxCommands` | `FAST_CONTEXT_BOOTSTRAP_MAX_COMMANDS` | `6` | bootstrap 每轮命令数 |

## 开发验证

```bash
npm run check
```

Smoke test：

```bash
npx tsc --outDir .tmp-build
node --input-type=module -e "import ext from './.tmp-build/index.js'; const c={tools:[],commands:[],events:[]}; ext({registerTool:t=>c.tools.push(t.name),registerCommand:n=>c.commands.push(n),on:n=>c.events.push(n)}); console.log(c)"
rm -rf .tmp-build
```

## 注意

- 核心协议来自 Windsurf Devstral 逆向实现，Windsurf 改协议后可能失效。
- Key 默认不会作为 LLM 工具单独暴露；只通过配置命令和 status 面板 masked 展示。
- vendored core 仍保留 TLS fallback 行为：网络/TLS 失败时可能设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- 当前版本主要把 Pi `signal` 用于工具边界，vendored core 内部 fetch 尚未完整接入外部取消信号。

## License

MIT. 见 `LICENSE` 和 `NOTICE.md`。
