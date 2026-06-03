import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type FastContextConfigScope = "project" | "global";
export type RepoMapMode = "classic" | "bootstrap_hotspot";
export type ApiKeySource = "env" | "project" | "global" | "windsurf-db" | "none";

export interface StoredFastContextConfig {
	apiKey?: string;
	dbPath?: string;
	treeDepth?: number;
	maxTurns?: number;
	maxCommands?: number;
	maxResults?: number;
	timeoutSecs?: number;
	excludePaths?: string[];
	repoMapMode?: RepoMapMode;
	bootstrapEnabled?: boolean;
	bootstrapTreeDepth?: number;
	hotspotTopK?: number;
	hotspotTreeDepth?: number;
	hotspotMaxBytes?: number;
	bootstrapMaxTurns?: number;
	bootstrapMaxCommands?: number;
}

export interface FastContextConfig {
	apiKey?: string;
	apiKeySource: ApiKeySource;
	dbPath?: string;
	treeDepth: number;
	maxTurns: number;
	maxCommands: number;
	maxResults: number;
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
}

export interface ResolvedApiKey {
	apiKey?: string;
	source: ApiKeySource;
	dbPath?: string;
	error?: string;
	hint?: string;
}

type ExtractKeyResult = {
	api_key?: string;
	db_path?: string;
	error?: string;
	hint?: string;
};

const DEFAULT_CONFIG = {
	treeDepth: 0,
	maxTurns: 3,
	maxCommands: 8,
	maxResults: 10,
	timeoutSecs: 30,
	excludePaths: [] as string[],
	repoMapMode: "bootstrap_hotspot" as RepoMapMode,
	bootstrapEnabled: true,
	bootstrapTreeDepth: 1,
	hotspotTopK: 4,
	hotspotTreeDepth: 2,
	hotspotMaxBytes: 120 * 1024,
	bootstrapMaxTurns: 2,
	bootstrapMaxCommands: 6,
};

function maybeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function maybePositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function maybeNonNegativeInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

function maybeBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(lower)) return true;
		if (["0", "false", "no", "off"].includes(lower)) return false;
	}
	return undefined;
}

function maybeRepoMapMode(value: unknown): RepoMapMode | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.trim().toLowerCase();
	if (lower === "classic") return "classic";
	if (lower === "bootstrap_hotspot" || lower === "hotspot" || lower === "bootstrap-hotspot") return "bootstrap_hotspot";
	return undefined;
}

function maybeStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const out = value.map((item) => maybeString(item)).filter((item): item is string => Boolean(item));
		return out.length ? [...new Set(out)] : [];
	}
	if (typeof value === "string") {
		const out = value.split(",").map((item) => item.trim()).filter(Boolean);
		return out.length ? [...new Set(out)] : [];
	}
	return undefined;
}

function readOptionalIntSetting(envName: string, stored: number | undefined, fallback: number, zeroAllowed = false): number {
	const fromEnv = zeroAllowed ? maybeNonNegativeInt(process.env[envName]) : maybePositiveInt(process.env[envName]);
	if (fromEnv !== undefined) return fromEnv;
	return stored ?? fallback;
}

function readBooleanSetting(envName: string, stored: boolean | undefined, fallback: boolean): boolean {
	return maybeBoolean(process.env[envName]) ?? stored ?? fallback;
}

function readStringSetting(envName: string, stored: string | undefined): string | undefined {
	return maybeString(process.env[envName]) ?? stored;
}

function readStringArraySetting(envName: string, stored: string[] | undefined, fallback: string[]): string[] {
	return maybeStringArray(process.env[envName]) ?? stored ?? fallback;
}

export function cleanStoredConfig(config: StoredFastContextConfig): StoredFastContextConfig {
	const cleaned: StoredFastContextConfig = {};
	if (config.apiKey) cleaned.apiKey = config.apiKey.trim();
	if (config.dbPath) cleaned.dbPath = config.dbPath.trim();
	if (config.treeDepth !== undefined && config.treeDepth >= 0) cleaned.treeDepth = Math.min(6, Math.trunc(config.treeDepth));
	if (config.maxTurns && config.maxTurns > 0) cleaned.maxTurns = Math.min(10, Math.trunc(config.maxTurns));
	if (config.maxCommands && config.maxCommands > 0) cleaned.maxCommands = Math.min(20, Math.trunc(config.maxCommands));
	if (config.maxResults && config.maxResults > 0) cleaned.maxResults = Math.min(50, Math.trunc(config.maxResults));
	if (config.timeoutSecs && config.timeoutSecs > 0) cleaned.timeoutSecs = Math.trunc(config.timeoutSecs);
	if (Array.isArray(config.excludePaths)) cleaned.excludePaths = [...new Set(config.excludePaths.map((item) => item.trim()).filter(Boolean))];
	if (config.repoMapMode) cleaned.repoMapMode = config.repoMapMode;
	if (typeof config.bootstrapEnabled === "boolean") cleaned.bootstrapEnabled = config.bootstrapEnabled;
	if (config.bootstrapTreeDepth && config.bootstrapTreeDepth > 0) cleaned.bootstrapTreeDepth = Math.min(3, Math.trunc(config.bootstrapTreeDepth));
	if (config.hotspotTopK && config.hotspotTopK > 0) cleaned.hotspotTopK = Math.min(8, Math.trunc(config.hotspotTopK));
	if (config.hotspotTreeDepth && config.hotspotTreeDepth > 0) cleaned.hotspotTreeDepth = Math.min(4, Math.trunc(config.hotspotTreeDepth));
	if (config.hotspotMaxBytes && config.hotspotMaxBytes > 0) cleaned.hotspotMaxBytes = Math.trunc(config.hotspotMaxBytes);
	if (config.bootstrapMaxTurns && config.bootstrapMaxTurns > 0) cleaned.bootstrapMaxTurns = Math.min(5, Math.trunc(config.bootstrapMaxTurns));
	if (config.bootstrapMaxCommands && config.bootstrapMaxCommands > 0) cleaned.bootstrapMaxCommands = Math.min(12, Math.trunc(config.bootstrapMaxCommands));
	return cleaned;
}

function normalizeStoredConfig(raw: unknown): StoredFastContextConfig {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as Record<string, unknown>;
	return cleanStoredConfig({
		apiKey: maybeString(value.apiKey) ?? maybeString(value.FAST_CONTEXT_API_KEY) ?? maybeString(value.WINDSURF_API_KEY),
		dbPath: maybeString(value.dbPath) ?? maybeString(value.FAST_CONTEXT_DB_PATH),
		treeDepth: maybeNonNegativeInt(value.treeDepth) ?? maybeNonNegativeInt(value.FAST_CONTEXT_TREE_DEPTH),
		maxTurns: maybePositiveInt(value.maxTurns) ?? maybePositiveInt(value.FAST_CONTEXT_MAX_TURNS),
		maxCommands: maybePositiveInt(value.maxCommands) ?? maybePositiveInt(value.FAST_CONTEXT_MAX_COMMANDS),
		maxResults: maybePositiveInt(value.maxResults) ?? maybePositiveInt(value.FAST_CONTEXT_MAX_RESULTS),
		timeoutSecs: maybePositiveInt(value.timeoutSecs) ?? maybePositiveInt(value.FAST_CONTEXT_TIMEOUT_SECS),
		excludePaths: maybeStringArray(value.excludePaths) ?? maybeStringArray(value.FAST_CONTEXT_EXCLUDE_PATHS),
		repoMapMode: maybeRepoMapMode(value.repoMapMode) ?? maybeRepoMapMode(value.FAST_CONTEXT_REPO_MAP_MODE),
		bootstrapEnabled: maybeBoolean(value.bootstrapEnabled) ?? maybeBoolean(value.FAST_CONTEXT_BOOTSTRAP_ENABLED),
		bootstrapTreeDepth: maybePositiveInt(value.bootstrapTreeDepth) ?? maybePositiveInt(value.FAST_CONTEXT_BOOTSTRAP_TREE_DEPTH),
		hotspotTopK: maybePositiveInt(value.hotspotTopK) ?? maybePositiveInt(value.FAST_CONTEXT_HOTSPOT_TOP_K),
		hotspotTreeDepth: maybePositiveInt(value.hotspotTreeDepth) ?? maybePositiveInt(value.FAST_CONTEXT_HOTSPOT_TREE_DEPTH),
		hotspotMaxBytes: maybePositiveInt(value.hotspotMaxBytes) ?? maybePositiveInt(value.FAST_CONTEXT_HOTSPOT_MAX_BYTES),
		bootstrapMaxTurns: maybePositiveInt(value.bootstrapMaxTurns) ?? maybePositiveInt(value.FAST_CONTEXT_BOOTSTRAP_MAX_TURNS),
		bootstrapMaxCommands: maybePositiveInt(value.bootstrapMaxCommands) ?? maybePositiveInt(value.FAST_CONTEXT_BOOTSTRAP_MAX_COMMANDS),
	});
}

export function getGlobalConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "fast-context.json");
}

export function getProjectConfigPath(cwd: string): string {
	return path.join(path.resolve(cwd), ".pi", "fast-context.json");
}

export function getConfigFilePath(scope: FastContextConfigScope, cwd: string): string {
	return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

export function readStoredConfig(scope: FastContextConfigScope, cwd: string): StoredFastContextConfig {
	try {
		return normalizeStoredConfig(JSON.parse(readFileSync(getConfigFilePath(scope, cwd), "utf8")));
	} catch {
		return {};
	}
}

export function readMergedStoredConfig(cwd: string): { global: StoredFastContextConfig; project: StoredFastContextConfig; merged: StoredFastContextConfig } {
	const global = readStoredConfig("global", cwd);
	const project = readStoredConfig("project", cwd);
	return { global, project, merged: cleanStoredConfig({ ...global, ...project }) };
}

export function writeStoredConfig(scope: FastContextConfigScope, cwd: string, config: StoredFastContextConfig): string {
	const filePath = getConfigFilePath(scope, cwd);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(cleanStoredConfig(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return filePath;
}

export function deleteStoredConfig(scope: FastContextConfigScope, cwd: string): string {
	const filePath = getConfigFilePath(scope, cwd);
	rmSync(filePath, { force: true });
	return filePath;
}

export function loadConfig(cwd: string): FastContextConfig {
	const { global, project, merged } = readMergedStoredConfig(cwd);
	const envKey = maybeString(process.env.FAST_CONTEXT_API_KEY) ?? maybeString(process.env.WINDSURF_API_KEY);
	let apiKeySource: ApiKeySource = "none";
	let apiKey = envKey;
	if (apiKey) apiKeySource = "env";
	else if (project.apiKey) {
		apiKey = project.apiKey;
		apiKeySource = "project";
	} else if (global.apiKey) {
		apiKey = global.apiKey;
		apiKeySource = "global";
	}

	const envMode = maybeRepoMapMode(process.env.FAST_CONTEXT_REPO_MAP_MODE);
	return {
		apiKey,
		apiKeySource,
		dbPath: readStringSetting("FAST_CONTEXT_DB_PATH", merged.dbPath),
		treeDepth: Math.min(6, readOptionalIntSetting("FAST_CONTEXT_TREE_DEPTH", merged.treeDepth, DEFAULT_CONFIG.treeDepth, true)),
		maxTurns: Math.min(10, readOptionalIntSetting("FAST_CONTEXT_MAX_TURNS", merged.maxTurns, DEFAULT_CONFIG.maxTurns)),
		maxCommands: Math.min(20, readOptionalIntSetting("FAST_CONTEXT_MAX_COMMANDS", merged.maxCommands, DEFAULT_CONFIG.maxCommands)),
		maxResults: Math.min(50, readOptionalIntSetting("FAST_CONTEXT_MAX_RESULTS", merged.maxResults, DEFAULT_CONFIG.maxResults)),
		timeoutMs: readOptionalIntSetting("FAST_CONTEXT_TIMEOUT_SECS", merged.timeoutSecs, DEFAULT_CONFIG.timeoutSecs) * 1000,
		excludePaths: readStringArraySetting("FAST_CONTEXT_EXCLUDE_PATHS", merged.excludePaths, DEFAULT_CONFIG.excludePaths),
		repoMapMode: envMode ?? merged.repoMapMode ?? DEFAULT_CONFIG.repoMapMode,
		bootstrapEnabled: readBooleanSetting("FAST_CONTEXT_BOOTSTRAP_ENABLED", merged.bootstrapEnabled, DEFAULT_CONFIG.bootstrapEnabled),
		bootstrapTreeDepth: Math.min(3, readOptionalIntSetting("FAST_CONTEXT_BOOTSTRAP_TREE_DEPTH", merged.bootstrapTreeDepth, DEFAULT_CONFIG.bootstrapTreeDepth)),
		hotspotTopK: Math.min(8, readOptionalIntSetting("FAST_CONTEXT_HOTSPOT_TOP_K", merged.hotspotTopK, DEFAULT_CONFIG.hotspotTopK)),
		hotspotTreeDepth: Math.min(4, readOptionalIntSetting("FAST_CONTEXT_HOTSPOT_TREE_DEPTH", merged.hotspotTreeDepth, DEFAULT_CONFIG.hotspotTreeDepth)),
		hotspotMaxBytes: readOptionalIntSetting("FAST_CONTEXT_HOTSPOT_MAX_BYTES", merged.hotspotMaxBytes, DEFAULT_CONFIG.hotspotMaxBytes),
		bootstrapMaxTurns: Math.min(5, readOptionalIntSetting("FAST_CONTEXT_BOOTSTRAP_MAX_TURNS", merged.bootstrapMaxTurns, DEFAULT_CONFIG.bootstrapMaxTurns)),
		bootstrapMaxCommands: Math.min(12, readOptionalIntSetting("FAST_CONTEXT_BOOTSTRAP_MAX_COMMANDS", merged.bootstrapMaxCommands, DEFAULT_CONFIG.bootstrapMaxCommands)),
	};
}

export function validateConfig(config: FastContextConfig): string[] {
	const issues: string[] = [];
	if (config.treeDepth < 0 || config.treeDepth > 6) issues.push("FAST_CONTEXT_TREE_DEPTH/treeDepth must be 0-6");
	if (config.maxTurns <= 0) issues.push("FAST_CONTEXT_MAX_TURNS/maxTurns must be positive");
	if (config.maxCommands <= 0) issues.push("FAST_CONTEXT_MAX_COMMANDS/maxCommands must be positive");
	if (config.maxResults <= 0) issues.push("FAST_CONTEXT_MAX_RESULTS/maxResults must be positive");
	if (config.timeoutMs <= 0) issues.push("FAST_CONTEXT_TIMEOUT_SECS/timeoutSecs must be positive");
	if (config.repoMapMode !== "classic" && config.repoMapMode !== "bootstrap_hotspot") issues.push("FAST_CONTEXT_REPO_MAP_MODE/repoMapMode must be classic or bootstrap_hotspot");
	return issues;
}

export async function resolveApiKey(config: FastContextConfig): Promise<ResolvedApiKey> {
	if (config.apiKey) {
		return { apiKey: config.apiKey, source: config.apiKeySource, dbPath: config.dbPath };
	}

	try {
		const core = await import(pathToFileURL(path.join(import.meta.dirname, "lib", "core.mjs")).href) as {
			extractKeyInfo: (dbPath?: string) => Promise<ExtractKeyResult>;
		};
		const result = await core.extractKeyInfo(config.dbPath);
		if (result.api_key) {
			return { apiKey: result.api_key, source: "windsurf-db", dbPath: result.db_path };
		}
		return { source: "none", dbPath: result.db_path, error: result.error, hint: result.hint };
	} catch (error) {
		return { source: "none", dbPath: config.dbPath, error: error instanceof Error ? error.message : String(error) };
	}
}

export function maskSecret(value: string | undefined): string {
	if (!value) return "not set";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function formatTimeout(ms: number): string {
	return `${Math.round(ms / 1000)}s`;
}
