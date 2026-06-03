# pi-fast-context

`pi-fast-context` 是一个 Pi 原生 extension package，把 Fast Context / Windsurf Devstral 代码库语义搜索注册成 Pi native tool。

它参考 `fast-context-skill` 的核心搜索实现，但不走 MCP server，也不让模型 shell-out 调 CLI；Pi 会直接加载 extension 并注册工具。

## 能力

- 注册一个 LLM 原生工具：`fast_context_search`
- 注册人工命令：`/fast-context-config`、`/fast-context-status`、`/fast-context-import-key`
- 支持带详情预览的 TUI 配置 Windsurf API Key 和搜索默认参数
- 支持从 Windsurf 本地 `state.vscdb` 自动提取 API Key，并在确认后持久化保存
- 支持 Pi tool rendering 和搜索进度更新

Key 解析优先级：

```text
FAST_CONTEXT_API_KEY / WINDSURF_API_KEY 环境变量
  > 项目配置 .pi/fast-context.json
  > 全局配置 ~/.pi/agent/fast-context.json
  > Windsurf state.vscdb 自动提取
```

## 安装

### 方式一：从 GitHub 安装（推荐）

```bash
pi install git:github.com/justhil/pi-fast-context
```

也可以使用 HTTPS URL：

```bash
pi install https://github.com/justhil/pi-fast-context
```

安装后重启 Pi，或在当前 Pi 会话里执行 `/reload`。

### 方式二：项目级安装

如果只想在当前项目启用：

```bash
pi install -l git:github.com/justhil/pi-fast-context
```

`-l` 会写入项目配置 `.pi/settings.json`。如果要和团队共享这个安装项，需要把对应 `.pi/settings.json` 纳入你的项目仓库；不要提交 `.pi/fast-context.json` 这类包含密钥的配置。

### 方式三：临时试用，不写入配置

```bash
pi -e git:github.com/justhil/pi-fast-context
```

本地开发目录里也可以：

```bash
pi -e .
```

### 方式四：本地 clone 后安装

```bash
git clone https://github.com/justhil/pi-fast-context.git
cd pi-fast-context
npm install
npm run check
pi install .
```

### npm 安装

当前版本尚未发布到 npm。发布后可使用：

```bash
pi install npm:pi-fast-context
```

## 前置条件

- Node.js 18+
- 已安装 Pi CLI
- 至少满足下面之一：
  - 设置 `FAST_CONTEXT_API_KEY` 或 `WINDSURF_API_KEY`
  - 已安装 Windsurf 桌面端并登录过一次，让本地 `state.vscdb` 中存在 API Key
  - 通过 `/fast-context-config` 手动写入 API Key

## 快速开始

1. 查看当前状态：

```text
/fast-context-status
```

2. 如果没有自动发现 Windsurf key，优先自动导入并保存：

```text
/fast-context-import-key
```

也可以运行完整配置向导：

```text
/fast-context-config
```

可选择：

- 自动导入 Windsurf API Key（推荐保存全局）
- 全局配置：`~/.pi/agent/fast-context.json`
- 项目配置：`.pi/fast-context.json`

3. 确认状态正常后，Agent 在需要语义发现时会调用：

```text
fast_context_search
```

## 配置方式

### TUI 配置

```text
/fast-context-config
```

常用子命令：

```text
/fast-context-config import
/fast-context-config project
/fast-context-config global
/fast-context-config clear
```

也可以直接运行：

```text
/fast-context-import-key
```

导入逻辑：

1. 只在人工 slash command 中执行，不会由 `fast_context_search` 自动触发。
2. 从 Windsurf 本地 `state.vscdb` 读取 API Key。
3. 默认推荐保存到全局配置 `~/.pi/agent/fast-context.json`。
4. 如果选择保存到项目配置 `.pi/fast-context.json`，会二次确认。
5. 所有 TUI/status 输出只展示 masked key；完整 key 不进入 LLM tool result、details 或 system prompt。
6. 如果当前进程存在 `FAST_CONTEXT_API_KEY` / `WINDSURF_API_KEY`，环境变量仍然拥有最高优先级。

### 环境变量配置

PowerShell：

```powershell
$env:FAST_CONTEXT_API_KEY="your-windsurf-api-key"
pi
```

bash / zsh：

```bash
export FAST_CONTEXT_API_KEY="your-windsurf-api-key"
pi
```

也兼容：

```bash
export WINDSURF_API_KEY="your-windsurf-api-key"
```

### 配置文件位置

| Scope | Path |
|---|---|
| 全局 | `~/.pi/agent/fast-context.json` |
| 项目 | `.pi/fast-context.json` |

配置文件会尽力以 `0600` 权限写入；Windows 上权限语义可能由系统 ACL 决定。不要把包含 API Key 的 `.pi/fast-context.json` 提交到 Git。

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
| `/fast-context-config` | 交互式配置，带字段说明和详情预览 |
| `/fast-context-config import` | 从 Windsurf `state.vscdb` 自动导入并保存 API Key |
| `/fast-context-config project` | 编辑项目配置 `.pi/fast-context.json` |
| `/fast-context-config global` | 编辑全局配置 `~/.pi/agent/fast-context.json` |
| `/fast-context-config clear` | 删除项目或全局配置 |
| `/fast-context-import-key` | 自动导入 Windsurf API Key 的快捷命令 |
| `/fast-context-status` | 查看配置、key 来源和默认搜索参数 |

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
npm install
npm run check
```

Smoke test：

```bash
npx tsc --outDir .tmp-build
node --input-type=module -e "import ext from './.tmp-build/index.js'; const c={tools:[],commands:[],events:[]}; ext({registerTool:t=>c.tools.push(t.name),registerCommand:n=>c.commands.push(n),on:n=>c.events.push(n)}); console.log(c)"
rm -rf .tmp-build
```

打包预览：

```bash
npm pack --dry-run --json
```

## 安全说明

- Pi packages 会以本机权限执行 extension 代码，安装第三方 package 前应审查源码。
- `fast_context_search` 不单独暴露 key 检查工具给 LLM；key 只通过人工命令配置和 masked 展示。
- 自动导入和持久化 key 只发生在 `/fast-context-config import` 或 `/fast-context-import-key` 这类人工命令中，不会由 LLM tool 调用触发。
- 默认推荐把 key 保存到全局配置；项目配置保存 key 会二次确认。
- Fast Context 内置默认排除 `.pi/`、`.env*`、常见 key/cert 文件，并在本地 restricted executor 中硬拒读这些 secret/config 路径。
- 不要提交 `.pi/fast-context.json`、`.env`、Windsurf API Key 或任何包含 secret 的日志。

## 注意

- 核心协议来自 Windsurf Devstral 逆向实现，Windsurf 改协议后可能失效。
- vendored core 仍保留 TLS fallback 行为：网络/TLS 失败时可能设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- 当前版本主要把 Pi `signal` 用于工具边界，vendored core 内部 fetch 尚未完整接入外部取消信号。

## License

MIT. 见 `LICENSE` 和 `NOTICE.md`。
