import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type Component, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
	deleteStoredConfig,
	discoverWindsurfDbKey,
	formatTimeout,
	getConfigFilePath,
	hasEnvApiKey,
	loadConfig,
	maskSecret,
	persistApiKey,
	readStoredConfig,
	resolveApiKey,
	type FastContextConfig,
	type FastContextConfigScope,
	type RepoMapMode,
	type StoredFastContextConfig,
	validateConfig,
	writeStoredConfig,
} from "./config.js";
import { compactPath, normalizeProjectPath } from "./path-normalizer.js";

const SEARCH_PARAMS = Type.Object({
	query: Type.String({
		description: `Natural-language description of the code you are looking for.

Recommended format: concise natural language + optional exact keywords.

Examples:
- "Where is the authentication flow implemented?"
- "Find the extension tool registration and config commands. Keywords: registerTool registerCommand"
- "What files define the checkout state machine?"`,
	}),
	project_root_path: Type.Optional(Type.String({
		description: "Absolute or relative project root. If omitted, pi's current working directory is used.",
	})),
});

type SearchParams = Static<typeof SEARCH_PARAMS>;

type SearchDetails = {
	query?: string;
	projectRoot?: string;
	startedAt?: number;
	status?: string;
	stage?: string;
	frame?: number;
	keySource?: string;
	config?: Record<string, unknown>;
};

type CoreModule = {
	searchWithContent: (opts: {
		query: string;
		projectRoot: string;
		apiKey?: string;
		maxTurns: number;
		maxCommands: number;
		maxResults: number;
		treeDepth: number;
		timeoutMs: number;
		excludePaths: string[];
		repoMapMode: RepoMapMode;
		bootstrapEnabled: boolean;
		bootstrapTreeDepth: number;
		hotspotTopK: number;
		hotspotTreeDepth: number;
		hotspotMaxBytes: number;
		bootstrapMaxTurns: number;
		bootstrapMaxCommands: number;
		onProgress?: (message: string) => void;
	}) => Promise<string>;
};

type ConfigTheme = {
	fg: (color: "accent" | "muted" | "dim" | "warning", text: string) => string;
	bold: (text: string) => string;
};

type UiContext = {
	cwd: string;
	hasUI?: boolean;
	ui: {
		select: (title: string, items: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
		custom?: <T>(
			factory: (tui: TUI, theme: ConfigTheme, keybindings: unknown, done: (result: T) => void) => Component | Promise<Component>,
			options?: { overlay?: boolean },
		) => Promise<T>;
	};
};

const CONFIG_ENV_NAMES = [
	"FAST_CONTEXT_API_KEY",
	"WINDSURF_API_KEY",
	"FAST_CONTEXT_DB_PATH",
	"FAST_CONTEXT_TREE_DEPTH",
	"FAST_CONTEXT_MAX_TURNS",
	"FAST_CONTEXT_MAX_COMMANDS",
	"FAST_CONTEXT_MAX_RESULTS",
	"FAST_CONTEXT_TIMEOUT_SECS",
	"FAST_CONTEXT_EXCLUDE_PATHS",
	"FAST_CONTEXT_REPO_MAP_MODE",
	"FAST_CONTEXT_BOOTSTRAP_ENABLED",
	"FAST_CONTEXT_BOOTSTRAP_TREE_DEPTH",
	"FAST_CONTEXT_HOTSPOT_TOP_K",
	"FAST_CONTEXT_HOTSPOT_TREE_DEPTH",
	"FAST_CONTEXT_HOTSPOT_MAX_BYTES",
	"FAST_CONTEXT_BOOTSTRAP_MAX_TURNS",
	"FAST_CONTEXT_BOOTSTRAP_MAX_COMMANDS",
];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(frame: number | undefined): string {
	return SPINNER_FRAMES[(frame ?? 0) % SPINNER_FRAMES.length] ?? "·";
}

function firstLine(value: unknown, maxLength = 96): string {
	const text = typeof value === "string" ? value.trim().split(/\r?\n/)[0] ?? "" : "";
	if (!text) return "semantic code search";
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function formatElapsed(startedAt: number | undefined): string {
	if (!startedAt) return "";
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function stageFromProgress(message: string): string {
	const lower = message.toLowerCase();
	if (lower.includes("jwt")) return "auth";
	if (lower.includes("rate")) return "rate-limit";
	if (lower.includes("bootstrap")) return "bootstrap";
	if (lower.includes("repo map")) return "repo-map";
	if (lower.includes("turn")) return "searching";
	if (lower.includes("answer")) return "answer";
	return "working";
}

function progressStatus(message: string): string {
	const stage = stageFromProgress(message);
	return `fast-context: ${stage}`;
}

let statusSeq = 0;
let activeStatusOwner = 0;

function beginStatus(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }, initial: string) {
	const owner = ++statusSeq;
	activeStatusOwner = owner;
	ctx.ui.setStatus("fast-context", initial);
	const clear = () => {
		if (activeStatusOwner === owner) {
			ctx.ui.setStatus("fast-context", undefined);
			activeStatusOwner = 0;
		}
	};
	return {
		progress(message: string) {
			if (activeStatusOwner === owner) ctx.ui.setStatus("fast-context", progressStatus(message));
		},
		finish(message: string, clearAfterMs = 1600) {
			if (activeStatusOwner !== owner) return;
			ctx.ui.setStatus("fast-context", message);
			setTimeout(clear, clearAfterMs);
		},
		clear,
	};
}

function parseScopeArg(args: string): FastContextConfigScope | undefined {
	const lower = args.trim().toLowerCase();
	if (lower.includes("global")) return "global";
	if (lower.includes("project") || lower.includes("local")) return "project";
	return undefined;
}

function scopeName(scope: FastContextConfigScope): string {
	return scope === "global" ? "全局" : "项目";
}

function envOverrideSummary(): string {
	const count = CONFIG_ENV_NAMES.filter((name) => process.env[name]?.trim()).length;
	return count ? `${count} override(s)` : "none";
}

function padLabel(label: string, width = 13): string {
	return label.padEnd(width, " ");
}

function kv(label: string, value: string | number | boolean | undefined): string {
	return `${padLabel(label)} ${value === undefined || value === "" ? "-" : value}`;
}

function section(title: string, rows: string[]): string {
	return [`─ ${title}`, ...rows.map((row) => `  ${row}`)].join("\n");
}

function configCount(scope: FastContextConfigScope, cwd: string): string {
	const count = Object.keys(readStoredConfig(scope, cwd)).length;
	return count ? `${count} setting(s)` : "not set";
}

function updateConfigStatus(ctx: UiContext): void {
	const config = loadConfig(ctx.cwd);
	ctx.ui.setStatus("fast-context", validateConfig(config).length > 0 ? "fast-context: invalid config" : undefined);
}

function nextActionText(issues: string[], keyInfo: Awaited<ReturnType<typeof resolveApiKey>>): string {
	if (issues.length) return "fix config with /fast-context-config";
	if (!keyInfo.apiKey) return "run /fast-context-config import, set env key, or log in to Windsurf";
	if (keyInfo.source === "windsurf-db") return "ready; run /fast-context-import-key to persist discovered key";
	return "ready; use fast_context_search";
}

function statusPanel(cwd: string, projectRoot: string, config: FastContextConfig, keyInfo: Awaited<ReturnType<typeof resolveApiKey>>): string {
	const issues = validateConfig(config);
	return [
		"fast-context status",
		"",
		section("health", [
			kv("config", issues.length ? "invalid" : "ok"),
			kv("key", keyInfo.apiKey ? "found" : "missing"),
			kv("next", nextActionText(issues, keyInfo)),
		]),
		"",
		section("key", [
			kv("source", keyInfo.source),
			kv("masked", maskSecret(keyInfo.apiKey)),
			kv("dbPath", keyInfo.dbPath || config.dbPath || "auto"),
			...(keyInfo.error ? [kv("error", keyInfo.error)] : []),
			...(keyInfo.hint ? [kv("hint", keyInfo.hint)] : []),
		]),
		"",
		section("config", [
			kv("project", configCount("project", cwd)),
			kv("global", configCount("global", cwd)),
			kv("env", envOverrideSummary()),
			kv("envKey", hasEnvApiKey() ? "active" : "not set"),
		]),
		"",
		section("search defaults", [
			kv("treeDepth", config.treeDepth),
			kv("maxTurns", config.maxTurns),
			kv("maxCommands", config.maxCommands),
			kv("maxResults", config.maxResults),
			kv("timeout", formatTimeout(config.timeoutMs)),
			kv("repoMapMode", config.repoMapMode),
			kv("bootstrap", config.bootstrapEnabled ? "on" : "off"),
			kv("excludes", config.excludePaths.length ? config.excludePaths.join(", ") : "none"),
		]),
		"",
		section("paths", [
			kv("projectRoot", projectRoot),
			kv("projectCfg", getConfigFilePath("project", cwd)),
			kv("globalCfg", getConfigFilePath("global", cwd)),
		]),
		...(issues.length ? ["", section("issues", issues.map((issue) => `! ${issue}`))] : []),
	].join("\n");
}

type ConfigFieldKind = "string" | "secret" | "number" | "boolean" | "list" | "repoMapMode";

type ConfigField = {
	key: keyof StoredFastContextConfig;
	env: string;
	label: string;
	kind: ConfigFieldKind;
	description: string;
	defaultValue?: string | number | boolean;
	min?: number;
	max?: number;
};

type ConfigSelectItem = {
	value: string;
	label: string;
	description?: string;
	details?: string;
};

const CUSTOM_CANCEL = "__fast_context_custom_cancel__";

const BASIC_CONFIG_FIELDS: ConfigField[] = [
	{ key: "apiKey", env: "FAST_CONTEXT_API_KEY / WINDSURF_API_KEY", label: "Windsurf API Key", kind: "secret", description: "手动保存 Windsurf API Key。推荐保存到全局配置；项目配置保存 key 需要额外确认。" },
	{ key: "dbPath", env: "FAST_CONTEXT_DB_PATH", label: "Windsurf state.vscdb 路径", kind: "string", description: "自定义 Windsurf 本地 state.vscdb 路径。留空时按系统默认位置自动查找。", defaultValue: "auto" },
	{ key: "treeDepth", env: "FAST_CONTEXT_TREE_DEPTH", label: "Repo tree 深度", kind: "number", description: "传给 Fast Context 的仓库树深度。0 表示自动选择，通常最稳。", defaultValue: 0, min: 0, max: 6 },
	{ key: "maxTurns", env: "FAST_CONTEXT_MAX_TURNS", label: "搜索轮数", kind: "number", description: "远程模型最多推理/搜索轮数。越高越全，但更慢。", defaultValue: 3, min: 1, max: 10 },
	{ key: "maxCommands", env: "FAST_CONTEXT_MAX_COMMANDS", label: "每轮命令数", kind: "number", description: "每轮允许远程模型请求的本地只读命令数量。", defaultValue: 8, min: 1, max: 20 },
	{ key: "maxResults", env: "FAST_CONTEXT_MAX_RESULTS", label: "返回文件数量", kind: "number", description: "最多返回多少个候选文件和行范围。", defaultValue: 10, min: 1, max: 50 },
	{ key: "timeoutSecs", env: "FAST_CONTEXT_TIMEOUT_SECS", label: "请求超时秒数", kind: "number", description: "Windsurf 请求超时时间。大仓库或慢网络可调高。", defaultValue: 30, min: 1 },
	{ key: "excludePaths", env: "FAST_CONTEXT_EXCLUDE_PATHS", label: "额外排除路径", kind: "list", description: "逗号分隔的额外排除路径。内置默认会排除 .pi、.env、常见 key/cert 文件。", defaultValue: "none" },
	{ key: "repoMapMode", env: "FAST_CONTEXT_REPO_MAP_MODE", label: "Repo map 模式", kind: "repoMapMode", description: "classic 为传统树；bootstrap_hotspot 会先探索再重点展开热点目录，通常推荐。", defaultValue: "bootstrap_hotspot" },
];

const ADVANCED_CONFIG_FIELDS: ConfigField[] = [
	{ key: "bootstrapEnabled", env: "FAST_CONTEXT_BOOTSTRAP_ENABLED", label: "启用 bootstrap", kind: "boolean", description: "先跑轻量探索来提取关键词和热点目录。", defaultValue: true },
	{ key: "bootstrapTreeDepth", env: "FAST_CONTEXT_BOOTSTRAP_TREE_DEPTH", label: "bootstrap tree depth", kind: "number", description: "bootstrap 阶段仓库树深度。", defaultValue: 1, min: 1, max: 3 },
	{ key: "hotspotTopK", env: "FAST_CONTEXT_HOTSPOT_TOP_K", label: "hotspot 目录数", kind: "number", description: "重点展开多少个热点目录。", defaultValue: 4, min: 1, max: 8 },
	{ key: "hotspotTreeDepth", env: "FAST_CONTEXT_HOTSPOT_TREE_DEPTH", label: "hotspot tree depth", kind: "number", description: "热点目录展开深度。", defaultValue: 2, min: 1, max: 4 },
	{ key: "hotspotMaxBytes", env: "FAST_CONTEXT_HOTSPOT_MAX_BYTES", label: "hotspot 字节预算", kind: "number", description: "优化 repo map 的字节预算。", defaultValue: 120 * 1024, min: 16384 },
	{ key: "bootstrapMaxTurns", env: "FAST_CONTEXT_BOOTSTRAP_MAX_TURNS", label: "bootstrap 最大轮数", kind: "number", description: "bootstrap 探索阶段最多轮数。", defaultValue: 2, min: 1, max: 5 },
	{ key: "bootstrapMaxCommands", env: "FAST_CONTEXT_BOOTSTRAP_MAX_COMMANDS", label: "bootstrap 每轮命令数", kind: "number", description: "bootstrap 阶段每轮最多命令数。", defaultValue: 6, min: 1, max: 12 },
];

function selectTheme(theme: ConfigTheme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

function fixedDetailLines(value: string, width: number, lineCount = 5): string[] {
	const maxWidth = Math.max(20, width - 4);
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.slice(0, lineCount)
		.map((line) => truncateToWidth(line, maxWidth, "…"));
	while (lines.length < lineCount) lines.push("");
	return lines;
}

async function basicSelectConfigItem(ctx: UiContext, title: string, items: ConfigSelectItem[]): Promise<string | undefined> {
	const labels = items.map((item) => item.label);
	const choice = await ctx.ui.select(title, labels);
	return items.find((item) => item.label === choice)?.value;
}

async function selectConfigItem(ctx: UiContext, title: string, items: ConfigSelectItem[], maxVisible = 8, options: { custom?: boolean } = {}): Promise<string | undefined> {
	if (options.custom === false || !ctx.ui.custom) {
		return basicSelectConfigItem(ctx, title, items);
	}
	const customChoice = await ctx.ui.custom<string>((tui, theme, _keybindings, done) => {
		const listItems: SelectItem[] = items.map((item) => ({ value: item.value, label: item.label, description: item.description }));
		const list = new SelectList(listItems, Math.min(maxVisible, Math.max(1, listItems.length)), selectTheme(theme), {
			minPrimaryColumnWidth: 28,
			maxPrimaryColumnWidth: 72,
		});
		const detailByValue = new Map(items.map((item) => [item.value, item.details || item.description || ""]));
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(CUSTOM_CANCEL);
		return {
			render(width: number): string[] {
				const selected = list.getSelectedItem();
				const details = selected ? detailByValue.get(selected.value) ?? "" : "";
				return [
					theme.fg("accent", theme.bold(title)),
					"",
					...fixedDetailLines(details, width).map((line) => `  ${line ? theme.fg("muted", line) : ""}`),
					"",
					...list.render(width),
					"",
					theme.fg("dim", truncateToWidth("↑↓ 切换 · Enter 选择/编辑 · Esc 返回", width, "")),
				];
			},
			invalidate() {
				list.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });
	if (customChoice === CUSTOM_CANCEL) return undefined;
	return customChoice ?? basicSelectConfigItem(ctx, title, items);
}

function formatStoredValue(field: ConfigField, config: StoredFastContextConfig): string {
	const value = config[field.key];
	if (value === undefined || value === "") return field.defaultValue === undefined ? "未设置" : `默认值：${field.defaultValue}`;
	if (field.kind === "secret") return maskSecret(String(value));
	if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
	return String(value);
}

function fieldChoice(field: ConfigField, config: StoredFastContextConfig): ConfigSelectItem {
	return {
		value: String(field.key),
		label: `${field.env} (${field.label}) = ${formatStoredValue(field, config)}`,
		description: field.description,
		details: [
			field.description,
			`环境变量：${field.env}`,
			`配置字段：${String(field.key)}`,
			`当前值：${formatStoredValue(field, config)} · 默认：${field.defaultValue === undefined ? "无" : field.defaultValue}`,
			"优先级：环境变量 > 项目 > 全局 > Windsurf DB 自动发现 > 默认",
		].join("\n"),
	};
}

async function chooseScope(ctx: UiContext, args: string): Promise<FastContextConfigScope | undefined> {
	const direct = parseScopeArg(args);
	if (direct) return direct;
	const choice = await selectConfigItem(ctx, "fast-context 配置", [
		{
			value: "import-key",
			label: "自动导入 Windsurf API Key（推荐）",
			description: "从 Windsurf state.vscdb 读取 key，默认保存到全局配置。",
			details: "只在人工命令中执行，不会暴露给 LLM。默认保存到 ~/.pi/agent/fast-context.json；项目保存需要额外确认。",
		},
		{
			value: "global",
			label: "编辑全局配置 (~/.pi/agent/fast-context.json)",
			description: "默认作用于所有项目，可被项目配置和环境变量覆盖。",
			details: `编辑：${getConfigFilePath("global", ctx.cwd)}\n推荐把 API Key 存在这里。优先级：环境变量 > 项目 > 全局 > Windsurf DB 自动发现。`,
		},
		{
			value: "project",
			label: "编辑项目配置 (.pi/fast-context.json)",
			description: "只作用于当前项目，优先级高于全局配置。",
			details: `编辑：${getConfigFilePath("project", ctx.cwd)}\n不要把包含 API Key 的项目配置提交到 Git；Fast Context 默认会排除 .pi/。`,
		},
		{ value: "clear", label: "清除配置", description: "删除项目或全局配置文件。", details: "删除前会二次确认。" },
		{ value: "exit", label: "退出", description: "不修改任何配置。", details: "关闭配置向导。" },
	]);
	if (!choice || choice === "exit") return undefined;
	if (choice === "import-key") {
		await importWindsurfKeyFlow(ctx);
		return undefined;
	}
	if (choice === "clear") {
		await clearConfigFlow(ctx, args);
		return undefined;
	}
	return choice === "global" ? "global" : "project";
}

async function chooseImportScope(ctx: UiContext): Promise<FastContextConfigScope | undefined> {
	const choice = await selectConfigItem(ctx, "保存自动发现的 Windsurf API Key", [
		{
			value: "global",
			label: "保存到全局配置（推荐）",
			description: "写入 ~/.pi/agent/fast-context.json，适合跨项目复用。",
			details: "推荐选择。全局配置不在当前项目仓库内，可被项目配置或环境变量覆盖。写入时会保留已有其他配置字段。",
		},
		{
			value: "project",
			label: "保存到项目配置（高级 / 有风险）",
			description: "写入 .pi/fast-context.json，只作用于当前项目。",
			details: "只有当前项目必须使用独立 key 时才选择。请确认 .pi/ 已被 .gitignore 忽略；Fast Context 内置排除和读取保护会避免读取 .pi/。",
		},
		{ value: "cancel", label: "取消", description: "不保存 key。", details: "自动发现结果只会留在本次命令内，不写入配置文件。" },
	], 8, { custom: false });
	if (!choice || choice === "cancel") return undefined;
	return choice === "project" ? "project" : "global";
}

async function importWindsurfKeyFlow(ctx: UiContext): Promise<void> {
	const config = loadConfig(ctx.cwd);
	const discovered = await discoverWindsurfDbKey(config.dbPath);
	if (!discovered.apiKey) {
		ctx.ui.notify([
			"未能从 Windsurf state.vscdb 自动获取 API Key。",
			`dbPath: ${discovered.dbPath || config.dbPath || "auto"}`,
			...(discovered.error ? [`error: ${discovered.error}`] : []),
			...(discovered.hint ? [`hint: ${discovered.hint}`] : []),
			"",
			"可先登录 Windsurf 桌面端，或手动设置 FAST_CONTEXT_API_KEY / WINDSURF_API_KEY。",
		].join("\n"), "warning");
		return;
	}

	const scope = await chooseImportScope(ctx);
	if (!scope) return;
	const stored = readStoredConfig(scope, ctx.cwd);
	if (scope === "project") {
		const ok = await ctx.ui.confirm("确认保存到项目配置？", "项目配置会写入 .pi/fast-context.json。请确认 .pi/ 不会被提交到 Git；推荐优先保存到全局配置。是否继续？");
		if (!ok) return;
	}
	if (stored.apiKey && stored.apiKey !== discovered.apiKey) {
		const ok = await ctx.ui.confirm("覆盖已有 API Key？", `${scopeName(scope)}配置已有 key：${maskSecret(stored.apiKey)}\n新发现 key：${maskSecret(discovered.apiKey)}\n\n是否覆盖？`);
		if (!ok) return;
	}

	const filePath = persistApiKey(scope, ctx.cwd, discovered.apiKey);
	updateConfigStatus(ctx);
	ctx.ui.notify([
		"已保存 Windsurf API Key。",
		`scope: ${scopeName(scope)}`,
		`file: ${filePath}`,
		`key: ${maskSecret(discovered.apiKey)}`,
		`dbPath: ${discovered.dbPath || "auto"}`,
		...(hasEnvApiKey() ? ["", "注意：当前环境变量中也设置了 API Key；本次运行仍会优先使用环境变量。"] : []),
	].join("\n"), "info");
}

async function clearConfigFlow(ctx: UiContext, args: string): Promise<void> {
	let scope = parseScopeArg(args);
	if (!scope) {
		const choice = await selectConfigItem(ctx, "要清除哪一份 fast-context 配置？", [
			{
				value: "global",
				label: "全局配置 (~/.pi/agent/fast-context.json)",
				description: "删除全局配置文件。",
				details: `将删除：${getConfigFilePath("global", ctx.cwd)}\n删除后会退回到项目配置、环境变量、Windsurf DB 自动发现或默认值。`,
			},
			{
				value: "project",
				label: "项目配置 (.pi/fast-context.json)",
				description: "删除当前项目配置文件。",
				details: `将删除：${getConfigFilePath("project", ctx.cwd)}\n删除后当前项目会使用全局配置、环境变量、Windsurf DB 自动发现或默认值。`,
			},
			{ value: "cancel", label: "取消", description: "不删除任何配置。", details: "返回上一级菜单。" },
		]);
		if (!choice || choice === "cancel") return;
		scope = choice === "global" ? "global" : "project";
	}
	const filePath = getConfigFilePath(scope, ctx.cwd);
	const ok = await ctx.ui.confirm("清除 fast-context 配置？", `删除 ${filePath}？`);
	if (!ok) return;
	deleteStoredConfig(scope, ctx.cwd);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已删除 ${scopeName(scope)} fast-context 配置：\n${filePath}`, "info");
}

function parseIntegerInput(value: string, min: number, max?: number): number | undefined {
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) {
		return undefined;
	}
	return parsed;
}

async function editString(ctx: UiContext, scope: FastContextConfigScope, key: keyof StoredFastContextConfig, title: string, secret = false): Promise<void> {
	const stored = readStoredConfig(scope, ctx.cwd);
	const current = stored[key];
	const rendered = secret ? maskSecret(typeof current === "string" ? current : undefined) : String(current ?? "not set");
	const value = await ctx.ui.input(title, `当前值：${rendered}。留空 = 保持不变，输入 '-' = 清除。${secret ? " 注意：输入内容会明文显示。" : ""}`);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (key === "apiKey" && scope === "project" && trimmed !== "-") {
		const ok = await ctx.ui.confirm("确认保存 API Key 到项目配置？", "项目配置会写入 .pi/fast-context.json。请确认 .pi/ 不会被提交到 Git；推荐优先保存到全局配置。是否继续？");
		if (!ok) return;
	}
	const next = { ...stored };
	if (trimmed === "-") delete next[key];
	else (next as Record<string, unknown>)[key] = trimmed;
	writeStoredConfig(scope, ctx.cwd, next);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。${hasEnvApiKey() && key === "apiKey" ? "\n注意：当前环境变量 API Key 仍拥有最高优先级。" : ""}`, "info");
}

async function editNumber(ctx: UiContext, scope: FastContextConfigScope, key: keyof StoredFastContextConfig, title: string, min: number, max?: number): Promise<void> {
	const stored = readStoredConfig(scope, ctx.cwd);
	const value = await ctx.ui.input(title, `当前值：${String(stored[key] ?? "default")}。留空 = 保持不变，输入 '-' = 清除。范围：${min}${max === undefined ? "+" : `-${max}`}。`);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const next = { ...stored };
	if (trimmed === "-") {
		delete next[key];
	} else {
		const parsed = parseIntegerInput(trimmed, min, max);
		if (parsed === undefined) {
			ctx.ui.notify(`${String(key)} 必须是 ${min}${max === undefined ? "+" : `-${max}`} 的整数。`, "warning");
			return;
		}
		(next as Record<string, unknown>)[key] = parsed;
	}
	writeStoredConfig(scope, ctx.cwd, next);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。`, "info");
}

async function editBoolean(ctx: UiContext, scope: FastContextConfigScope, key: keyof StoredFastContextConfig, title: string): Promise<void> {
	const stored = readStoredConfig(scope, ctx.cwd);
	const choice = await ctx.ui.select(title, ["true", "false", "清除 / 使用默认值", "取消"]);
	if (!choice || choice === "取消") return;
	const next = { ...stored };
	if (choice.startsWith("清除")) delete next[key];
	else (next as Record<string, unknown>)[key] = choice === "true";
	writeStoredConfig(scope, ctx.cwd, next);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。`, "info");
}

async function editExcludePaths(ctx: UiContext, scope: FastContextConfigScope): Promise<void> {
	const stored = readStoredConfig(scope, ctx.cwd);
	const current = stored.excludePaths?.join(", ") || "not set";
	const value = await ctx.ui.input("设置排除路径", `当前值：${current}。输入逗号分隔列表；留空 = 保持不变，输入 '-' = 清除。`);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const next = { ...stored };
	if (trimmed === "-") delete next.excludePaths;
	else next.excludePaths = [...new Set(trimmed.split(",").map((item) => item.trim()).filter(Boolean))];
	writeStoredConfig(scope, ctx.cwd, next);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。`, "info");
}

async function configureRepoMapMode(ctx: UiContext, scope: FastContextConfigScope): Promise<void> {
	const stored = readStoredConfig(scope, ctx.cwd);
	const choice = await selectConfigItem(ctx, "选择 repo map 模式", [
		{
			value: "bootstrap_hotspot",
			label: "bootstrap_hotspot（推荐）",
			description: "先做轻量探索，再展开热点目录。",
			details: "默认推荐。适合多数真实项目，能在大仓库中保留更多相关目录细节。",
		},
		{
			value: "classic",
			label: "classic",
			description: "直接构建传统 repo tree。",
			details: "更接近上游 fast-context-mcp 原始模式。项目较小或不需要 hotspot 优化时可用。",
		},
		{ value: "clear", label: "清除 / 使用默认值", description: "删除 repoMapMode 字段。", details: "清除后使用默认 bootstrap_hotspot，除非环境变量覆盖。" },
		{ value: "cancel", label: "取消", description: "不修改。", details: "返回上一级菜单。" },
	]);
	if (!choice || choice === "cancel") return;
	const next = { ...stored };
	if (choice === "clear") delete next.repoMapMode;
	else next.repoMapMode = choice === "classic" ? "classic" : "bootstrap_hotspot";
	writeStoredConfig(scope, ctx.cwd, next);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。`, "info");
}

async function editConfigField(ctx: UiContext, scope: FastContextConfigScope, field: ConfigField): Promise<void> {
	if (field.kind === "secret") await editString(ctx, scope, field.key, `设置 ${field.label}`, true);
	else if (field.kind === "string") await editString(ctx, scope, field.key, `设置 ${field.label}`);
	else if (field.kind === "number") await editNumber(ctx, scope, field.key, `设置 ${field.label}`, field.min ?? 1, field.max);
	else if (field.kind === "boolean") await editBoolean(ctx, scope, field.key, `设置 ${field.label}`);
	else if (field.kind === "list") await editExcludePaths(ctx, scope);
	else if (field.kind === "repoMapMode") await configureRepoMapMode(ctx, scope);
}

async function configureAdvanced(ctx: UiContext, scope: FastContextConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await selectConfigItem(ctx, `${scopeName(scope)} fast-context 高级配置`, [
			...ADVANCED_CONFIG_FIELDS.map((field) => fieldChoice(field, stored)),
			{ value: "back", label: "返回", description: "回到上一级配置菜单。", details: "不修改高级配置。" },
		]);
		if (!choice || choice === "back") return;
		const field = ADVANCED_CONFIG_FIELDS.find((item) => item.key === choice);
		if (field) await editConfigField(ctx, scope, field);
	}
}

async function configureScope(ctx: UiContext, scope: FastContextConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await selectConfigItem(ctx, `${scopeName(scope)} fast-context 配置`, [
			{
				value: "import-key",
				label: "自动导入 Windsurf API Key",
				description: "从 Windsurf state.vscdb 读取 key 并保存。",
				details: "推荐保存到全局配置。此操作只由人工命令触发，key 只会 masked 展示，不进入 LLM 工具结果。",
			},
			...BASIC_CONFIG_FIELDS.map((field) => fieldChoice(field, stored)),
			{
				value: "advanced",
				label: "Bootstrap / Hotspot 高级设置",
				description: "调整 repo map 优化器参数。",
				details: "通常保持默认即可。只有大仓库性能或结果覆盖不理想时再改。",
			},
			{ value: "back", label: "返回", description: "退出当前 scope 配置。", details: "回到上一级菜单。" },
		]);
		if (!choice || choice === "back") return;
		if (choice === "import-key") await importWindsurfKeyFlow(ctx);
		else if (choice === "advanced") await configureAdvanced(ctx, scope);
		else {
			const field = BASIC_CONFIG_FIELDS.find((item) => item.key === choice);
			if (field) await editConfigField(ctx, scope, field);
		}
	}
}

async function runConfigWizard(args: string, ctx: UiContext): Promise<void> {
	if (ctx.hasUI === false) {
		throw new Error("/fast-context-config 需要交互式 UI。非交互模式请设置 FAST_CONTEXT_API_KEY 或 WINDSURF_API_KEY。 ");
	}
	const lower = args.trim().toLowerCase();
	if (lower.includes("clear") || lower.includes("delete") || lower.includes("reset")) {
		await clearConfigFlow(ctx, args);
		return;
	}
	if (lower.includes("import") || lower.includes("auto") || lower.includes("key")) {
		await importWindsurfKeyFlow(ctx);
		return;
	}
	const scope = await chooseScope(ctx, args);
	if (scope) await configureScope(ctx, scope);
}

function buildSystemPrompt(cwd: string, options: Pick<BuildSystemPromptOptions, "selectedTools">): string {
	const config = loadConfig(cwd);
	const issues = validateConfig(config);
	if (issues.length > 0) {
		return "Fast Context unavailable: do not call fast_context_search until configuration issues are fixed with /fast-context-status or /fast-context-config.";
	}

	const selectedTools = new Set(options.selectedTools ?? []);
	const hasSelection = Boolean(options.selectedTools);
	const hasTool = (name: string) => !hasSelection || selectedTools.has(name);
	if (!hasTool("fast_context_search")) return "";

	return [
		"## Fast Context routing",
		"fast_context_search is a native Pi semantic codebase discovery tool backed by Windsurf Devstral.",
		"Use it early when relevant files, implementation flows, architecture, behavior, or tests are unknown.",
		"Do not use it for exact identifier grep, exhaustive reference lists, directory listing, reading known files, or editing files.",
		"Treat returned files and line ranges as navigation hints; read the files with normal Pi tools before making changes or claims.",
		"Search query format: concise natural language plus optional exact keywords.",
	].join("\n");
}

function hasFastContextTool(event: { systemPromptOptions?: { selectedTools?: unknown } }): boolean {
	const selectedTools = event.systemPromptOptions?.selectedTools;
	if (!Array.isArray(selectedTools)) return true;
	return selectedTools.some((tool) => {
		if (typeof tool === "string") return tool === "fast_context_search";
		if (tool && typeof tool === "object" && "name" in tool) return (tool as { name?: unknown }).name === "fast_context_search";
		return false;
	});
}

async function loadCore(): Promise<CoreModule> {
	return import(pathToFileURL(path.join(import.meta.dirname, "lib", "core.mjs")).href) as Promise<CoreModule>;
}

function truncateToolText(text: string, maxChars = 50_000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n...[fast_context_search output truncated at ${maxChars} chars]...`;
}

export default function piFastContextExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fast_context_search",
		label: "Fast Context",
		description: `Native Pi semantic codebase discovery powered by Windsurf Devstral Fast Context.

Use fast_context_search early when relevant files, components, implementation flows, architecture, behavior, or tests are unknown, especially before non-trivial code changes driven by natural-language requirements.

Do NOT use it for exact identifier grep, exhaustive reference lists, literal text search, directory listing, reading a known file, or modifying files. Use bash/rg/grep/find/ls/read/edit/write for those jobs when available.

Configuration is handled by /fast-context-config. API key resolution order: FAST_CONTEXT_API_KEY or WINDSURF_API_KEY env > project config > global config > Windsurf state.vscdb auto-discovery.`,
		promptSnippet: "Semantic natural-language codebase discovery using Windsurf Devstral; returns relevant files, line ranges, and grep keywords.",
		promptGuidelines: [
			"Use fast_context_search early when project-specific implementation files or flows are unknown.",
			"Do not use it for exact identifiers, literal text search, directory listings, known file reads, or edits.",
			"After fast_context_search returns candidate files, read those files with normal tools before editing or making claims.",
		],
		parameters: SEARCH_PARAMS,
		prepareArguments(args): SearchParams {
			if (!args || typeof args !== "object") return args as SearchParams;
			const input = args as Record<string, unknown>;
			if (typeof input.projectRootPath === "string" && input.project_root_path === undefined) {
				return { ...input, project_root_path: input.projectRootPath } as SearchParams;
			}
			return args as SearchParams;
		},
		async execute(_toolCallId, params: SearchParams, _signal, onUpdate, ctx) {
			const config = loadConfig(ctx.cwd);
			const issues = validateConfig(config);
			if (issues.length > 0) {
				ctx.ui.setStatus("fast-context", "fast-context: invalid config");
				throw new Error(`fast-context configuration error:\n- ${issues.join("\n- ")}`);
			}

			const keyInfo = await resolveApiKey(config);
			if (!keyInfo.apiKey) {
				ctx.ui.setStatus("fast-context", "fast-context: missing key");
				throw new Error(`Windsurf API key not found. Run /fast-context-config, set FAST_CONTEXT_API_KEY or WINDSURF_API_KEY, or log in to Windsurf.${keyInfo.error ? `\n${keyInfo.error}` : ""}${keyInfo.hint ? `\n${keyInfo.hint}` : ""}`);
			}

			const projectRoot = normalizeProjectPath(params.project_root_path, ctx.cwd);
			const startedAt = Date.now();
			let frame = 0;
			let statusFinished = false;
			const status = beginStatus(ctx, "fast-context: starting");
			try {
				const core = await loadCore();
				const result = await core.searchWithContent({
					query: params.query,
					projectRoot,
					apiKey: keyInfo.apiKey,
					maxTurns: config.maxTurns,
					maxCommands: config.maxCommands,
					maxResults: config.maxResults,
					treeDepth: config.treeDepth,
					timeoutMs: config.timeoutMs,
					excludePaths: config.excludePaths,
					repoMapMode: config.repoMapMode,
					bootstrapEnabled: config.bootstrapEnabled,
					bootstrapTreeDepth: config.bootstrapTreeDepth,
					hotspotTopK: config.hotspotTopK,
					hotspotTreeDepth: config.hotspotTreeDepth,
					hotspotMaxBytes: config.hotspotMaxBytes,
					bootstrapMaxTurns: config.bootstrapMaxTurns,
					bootstrapMaxCommands: config.bootstrapMaxCommands,
					onProgress: (message) => {
						status.progress(message);
						onUpdate?.({
							content: [{ type: "text", text: message }],
							details: {
								query: params.query,
								projectRoot,
								startedAt,
								status: message,
								stage: stageFromProgress(message),
								frame: frame++,
								keySource: keyInfo.source,
							} satisfies SearchDetails,
						});
					},
				});

				status.finish("fast-context: done");
				statusFinished = true;
				return {
					content: [{ type: "text" as const, text: truncateToolText(result) }],
					details: {
						query: params.query,
						projectRoot,
						startedAt,
						keySource: keyInfo.source,
						config: {
							treeDepth: config.treeDepth,
							maxTurns: config.maxTurns,
							maxCommands: config.maxCommands,
							maxResults: config.maxResults,
							timeoutMs: config.timeoutMs,
							repoMapMode: config.repoMapMode,
							bootstrapEnabled: config.bootstrapEnabled,
						},
					} satisfies SearchDetails,
				};
			} finally {
				if (!statusFinished) status.clear();
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("fast_context_search"));
			text += " " + theme.fg("accent", `\"${firstLine(args.query)}\"`);
			if (args.project_root_path) text += " " + theme.fg("dim", compactPath(args.project_root_path, 42));
			return new Text(text, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as SearchDetails | undefined;
			if (isPartial) {
				const status = details?.status ?? "Working...";
				let text = theme.fg("accent", spinnerFrame(details?.frame));
				text += " " + theme.fg("toolTitle", details?.stage ?? "working");
				const elapsed = formatElapsed(details?.startedAt);
				if (elapsed) text += " " + theme.fg("dim", elapsed);
				text += "\n" + theme.fg("muted", status);
				return new Text(text, 0, 0);
			}
			const elapsed = formatElapsed(details?.startedAt);
			let text = theme.fg("success", "✓ fast context ready");
			if (elapsed) text += " " + theme.fg("dim", elapsed);
			if (details?.keySource) text += " " + theme.fg("muted", `key:${details.keySource}`);
			if (details?.projectRoot) text += "\n" + theme.fg("dim", compactPath(details.projectRoot));
			const content = result.content[0];
			if (content?.type === "text") text += "\n" + theme.fg("muted", firstLine(content.text, 120));
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("fast-context-status", {
		description: "Show pi-fast-context configuration, key source, and search defaults",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const projectRoot = normalizeProjectPath(args.trim(), ctx.cwd);
			const keyInfo = await resolveApiKey(config);
			ctx.ui.notify(statusPanel(ctx.cwd, projectRoot, config, keyInfo), keyInfo.apiKey ? "info" : "warning");
		},
	});

	pi.registerCommand("fast-context-config", {
		description: "Configure pi-fast-context interactively. Usage: /fast-context-config [project|global|clear|import]",
		handler: async (args, ctx) => {
			await runConfigWizard(args, ctx as UiContext);
		},
	});

	pi.registerCommand("fast-context-import-key", {
		description: "Import Windsurf API key from local state.vscdb and persist it after confirmation",
		handler: async (_args, ctx) => {
			if ((ctx as UiContext).hasUI === false) {
				throw new Error("/fast-context-import-key 需要交互式 UI。非交互模式请设置 FAST_CONTEXT_API_KEY 或 WINDSURF_API_KEY。");
			}
			await importWindsurfKeyFlow(ctx as UiContext);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		const issues = validateConfig(config);
		ctx.ui.setStatus("fast-context", issues.length > 0 ? "fast-context: invalid config" : undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!hasFastContextTool(event)) return;
		const prompt = buildSystemPrompt(ctx.cwd, event.systemPromptOptions);
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
