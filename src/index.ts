import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
	deleteStoredConfig,
	formatTimeout,
	getConfigFilePath,
	loadConfig,
	maskSecret,
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

type UiContext = {
	cwd: string;
	hasUI?: boolean;
	ui: {
		select: (title: string, items: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
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

function statusPanel(cwd: string, projectRoot: string, config: FastContextConfig, keyInfo: Awaited<ReturnType<typeof resolveApiKey>>): string {
	const issues = validateConfig(config);
	const ready = issues.length === 0 && Boolean(keyInfo.apiKey);
	const lines = [
		"fast-context status",
		"",
		"─ health",
		`  config        ${issues.length ? "invalid" : "ok"}`,
		`  key           ${keyInfo.apiKey ? "found" : "missing"}`,
		`  keySource     ${keyInfo.source}`,
		`  next          ${ready ? "ready; use fast_context_search" : "run /fast-context-config or log in to Windsurf"}`,
		"",
		"─ key",
		`  masked        ${maskSecret(keyInfo.apiKey)}`,
		`  dbPath        ${keyInfo.dbPath || config.dbPath || "auto"}`,
		...(keyInfo.error ? [`  error         ${keyInfo.error}`] : []),
		...(keyInfo.hint ? [`  hint          ${keyInfo.hint}`] : []),
		"",
		"─ search defaults",
		`  treeDepth     ${config.treeDepth}`,
		`  maxTurns      ${config.maxTurns}`,
		`  maxCommands   ${config.maxCommands}`,
		`  maxResults    ${config.maxResults}`,
		`  timeout       ${formatTimeout(config.timeoutMs)}`,
		`  repoMapMode   ${config.repoMapMode}`,
		`  bootstrap     ${config.bootstrapEnabled ? "on" : "off"}`,
		`  excludes      ${config.excludePaths.length ? config.excludePaths.join(", ") : "none"}`,
		"",
		"─ config files",
		`  project       ${getConfigFilePath("project", cwd)}`,
		`  global        ${getConfigFilePath("global", cwd)}`,
		`  env           ${envOverrideSummary()}`,
		"",
		"─ paths",
		`  projectRoot   ${projectRoot}`,
		...(issues.length ? ["", "─ issues", ...issues.map((issue) => `  ! ${issue}`)] : []),
	];
	return lines.join("\n");
}

async function chooseScope(ctx: UiContext, args: string): Promise<FastContextConfigScope | undefined> {
	const direct = parseScopeArg(args);
	if (direct) return direct;
	const choice = await ctx.ui.select("fast-context 配置：选择要编辑的位置", [
		"全局配置 (~/.pi/agent/fast-context.json)",
		"项目配置 (.pi/fast-context.json)",
		"清除配置",
		"退出",
	]);
	if (!choice || choice === "退出") return undefined;
	if (choice.startsWith("全局")) return "global";
	if (choice.startsWith("项目")) return "project";
	await clearConfigFlow(ctx, args);
	return undefined;
}

async function clearConfigFlow(ctx: UiContext, args: string): Promise<void> {
	let scope = parseScopeArg(args);
	if (!scope) {
		const choice = await ctx.ui.select("要清除哪一份 fast-context 配置？", ["全局配置", "项目配置", "取消"]);
		if (!choice || choice === "取消") return;
		scope = choice.startsWith("全局") ? "global" : "project";
	}
	const filePath = getConfigFilePath(scope, ctx.cwd);
	const ok = await ctx.ui.confirm("清除 fast-context 配置？", `删除 ${filePath}？`);
	if (!ok) return;
	deleteStoredConfig(scope, ctx.cwd);
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
	const next = { ...stored };
	if (trimmed === "-") delete next[key];
	else (next as Record<string, unknown>)[key] = trimmed;
	writeStoredConfig(scope, ctx.cwd, next);
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。`, "info");
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
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。`, "info");
}

async function configureRepoMapMode(ctx: UiContext, scope: FastContextConfigScope): Promise<void> {
	const stored = readStoredConfig(scope, ctx.cwd);
	const choice = await ctx.ui.select("选择 repo map 模式", ["bootstrap_hotspot（推荐）", "classic", "清除 / 使用默认值", "取消"]);
	if (!choice || choice === "取消") return;
	const next = { ...stored };
	if (choice.startsWith("清除")) delete next.repoMapMode;
	else next.repoMapMode = choice.startsWith("classic") ? "classic" : "bootstrap_hotspot";
	writeStoredConfig(scope, ctx.cwd, next);
	ctx.ui.notify(`已保存 ${scopeName(scope)}配置。`, "info");
}

async function configureAdvanced(ctx: UiContext, scope: FastContextConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await ctx.ui.select(`${scopeName(scope)} fast-context 高级配置`, [
			`bootstrapEnabled = ${stored.bootstrapEnabled ?? "default"}`,
			`bootstrapTreeDepth = ${stored.bootstrapTreeDepth ?? "default"}`,
			`hotspotTopK = ${stored.hotspotTopK ?? "default"}`,
			`hotspotTreeDepth = ${stored.hotspotTreeDepth ?? "default"}`,
			`hotspotMaxBytes = ${stored.hotspotMaxBytes ?? "default"}`,
			`bootstrapMaxTurns = ${stored.bootstrapMaxTurns ?? "default"}`,
			`bootstrapMaxCommands = ${stored.bootstrapMaxCommands ?? "default"}`,
			"返回",
		]);
		if (!choice || choice === "返回") return;
		if (choice.startsWith("bootstrapEnabled")) await editBoolean(ctx, scope, "bootstrapEnabled", "设置 bootstrapEnabled");
		else if (choice.startsWith("bootstrapTreeDepth")) await editNumber(ctx, scope, "bootstrapTreeDepth", "设置 bootstrapTreeDepth", 1, 3);
		else if (choice.startsWith("hotspotTopK")) await editNumber(ctx, scope, "hotspotTopK", "设置 hotspotTopK", 1, 8);
		else if (choice.startsWith("hotspotTreeDepth")) await editNumber(ctx, scope, "hotspotTreeDepth", "设置 hotspotTreeDepth", 1, 4);
		else if (choice.startsWith("hotspotMaxBytes")) await editNumber(ctx, scope, "hotspotMaxBytes", "设置 hotspotMaxBytes", 16384);
		else if (choice.startsWith("bootstrapMaxTurns")) await editNumber(ctx, scope, "bootstrapMaxTurns", "设置 bootstrapMaxTurns", 1, 5);
		else if (choice.startsWith("bootstrapMaxCommands")) await editNumber(ctx, scope, "bootstrapMaxCommands", "设置 bootstrapMaxCommands", 1, 12);
	}
}

async function configureScope(ctx: UiContext, scope: FastContextConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await ctx.ui.select(`${scopeName(scope)} fast-context 配置`, [
			`Windsurf API Key = ${maskSecret(stored.apiKey)}`,
			`Windsurf state.vscdb 路径 = ${stored.dbPath || "auto"}`,
			`treeDepth = ${stored.treeDepth ?? "default(0)"}`,
			`maxTurns = ${stored.maxTurns ?? "default(3)"}`,
			`maxCommands = ${stored.maxCommands ?? "default(8)"}`,
			`maxResults = ${stored.maxResults ?? "default(10)"}`,
			`timeoutSecs = ${stored.timeoutSecs ?? "default(30)"}`,
			`excludePaths = ${stored.excludePaths?.join(", ") || "none"}`,
			`repoMapMode = ${stored.repoMapMode ?? "default(bootstrap_hotspot)"}`,
			"Bootstrap / Hotspot 高级设置",
			"返回",
		]);
		if (!choice || choice === "返回") return;
		if (choice.startsWith("Windsurf API Key")) await editString(ctx, scope, "apiKey", "设置 Windsurf API Key", true);
		else if (choice.startsWith("Windsurf state")) await editString(ctx, scope, "dbPath", "设置 Windsurf state.vscdb 路径");
		else if (choice.startsWith("treeDepth")) await editNumber(ctx, scope, "treeDepth", "设置 treeDepth（0 = auto）", 0, 6);
		else if (choice.startsWith("maxTurns")) await editNumber(ctx, scope, "maxTurns", "设置 maxTurns", 1, 10);
		else if (choice.startsWith("maxCommands")) await editNumber(ctx, scope, "maxCommands", "设置 maxCommands", 1, 20);
		else if (choice.startsWith("maxResults")) await editNumber(ctx, scope, "maxResults", "设置 maxResults", 1, 50);
		else if (choice.startsWith("timeoutSecs")) await editNumber(ctx, scope, "timeoutSecs", "设置 timeoutSecs", 1);
		else if (choice.startsWith("excludePaths")) await editExcludePaths(ctx, scope);
		else if (choice.startsWith("repoMapMode")) await configureRepoMapMode(ctx, scope);
		else if (choice.startsWith("Bootstrap")) await configureAdvanced(ctx, scope);
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
		description: "Configure pi-fast-context interactively. Usage: /fast-context-config [project|global|clear]",
		handler: async (args, ctx) => {
			await runConfigWizard(args, ctx as UiContext);
		},
	});

	pi.registerCommand("fast-context-test", {
		description: "Test key discovery and optionally run a lightweight Fast Context search. Usage: /fast-context-test [project path]",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const issues = validateConfig(config);
			if (issues.length > 0) {
				ctx.ui.notify(`fast-context configuration error:\n- ${issues.join("\n- ")}`, "warning");
				return;
			}

			const keyInfo = await resolveApiKey(config);
			if (!keyInfo.apiKey) {
				ctx.ui.notify(`Windsurf API key not found.\nsource: ${keyInfo.source}\ndbPath: ${keyInfo.dbPath || config.dbPath || "auto"}${keyInfo.error ? `\nerror: ${keyInfo.error}` : ""}${keyInfo.hint ? `\nhint: ${keyInfo.hint}` : ""}`, "warning");
				return;
			}

			const projectRoot = normalizeProjectPath(args.trim(), ctx.cwd);
			const ok = await ctx.ui.confirm("运行轻量 Fast Context 搜索？", `Key 已找到：${maskSecret(keyInfo.apiKey)} (${keyInfo.source})\n\n是否对下面项目运行一个轻量测试搜索？\n${projectRoot}`);
			if (!ok) {
				ctx.ui.notify(`fast-context key ok\nsource: ${keyInfo.source}\nkey: ${maskSecret(keyInfo.apiKey)}\ndbPath: ${keyInfo.dbPath || config.dbPath || "auto"}`, "info");
				return;
			}

			const status = beginStatus(ctx, "fast-context: testing");
			let statusFinished = false;
			try {
				const core = await loadCore();
				const output = await core.searchWithContent({
					query: "Find package metadata and extension entry points. Keywords: package.json registerTool registerCommand",
					projectRoot,
					apiKey: keyInfo.apiKey,
					maxTurns: 1,
					maxCommands: Math.min(config.maxCommands, 4),
					maxResults: Math.min(config.maxResults, 5),
					treeDepth: config.treeDepth,
					timeoutMs: config.timeoutMs,
					excludePaths: config.excludePaths,
					repoMapMode: config.repoMapMode,
					bootstrapEnabled: false,
					bootstrapTreeDepth: config.bootstrapTreeDepth,
					hotspotTopK: config.hotspotTopK,
					hotspotTreeDepth: config.hotspotTreeDepth,
					hotspotMaxBytes: config.hotspotMaxBytes,
					bootstrapMaxTurns: config.bootstrapMaxTurns,
					bootstrapMaxCommands: config.bootstrapMaxCommands,
					onProgress: (message) => status.progress(message),
				});
				status.finish("fast-context: test done");
				statusFinished = true;
				ctx.ui.notify(`fast-context test complete\nsource: ${keyInfo.source}\nprojectRoot: ${projectRoot}\n\n${truncateToolText(output, 4000)}`, "info");
			} catch (error) {
				ctx.ui.notify(`fast-context test failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				if (!statusFinished) status.clear();
			}
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
