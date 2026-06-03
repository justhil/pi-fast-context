import { readFileSync } from "node:fs";
import path from "node:path";

export type RuntimeEnv = "windows" | "wsl" | "unix";

let detectedRuntimeEnv: RuntimeEnv | undefined;

export function detectRuntimeEnv(): RuntimeEnv {
	if (detectedRuntimeEnv) return detectedRuntimeEnv;
	if (process.platform === "win32") {
		detectedRuntimeEnv = "windows";
		return detectedRuntimeEnv;
	}

	if (process.platform === "linux") {
		const envLooksWsl = Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
		const procLooksWsl = ["/proc/version", "/proc/sys/kernel/osrelease"].some((filePath) => {
			try {
				const text = readFileSync(filePath, "utf8").toLowerCase();
				return text.includes("microsoft") || text.includes("wsl");
			} catch {
				return false;
			}
		});
		if (envLooksWsl || procLooksWsl) {
			detectedRuntimeEnv = "wsl";
			return detectedRuntimeEnv;
		}
	}

	detectedRuntimeEnv = "unix";
	return detectedRuntimeEnv;
}

function isWindowsDrivePath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(value.trim());
}

function winToWsl(value: string): string | undefined {
	const normalized = value.trim().replace(/\\/g, "/");
	if (!/^[a-zA-Z]:\//.test(normalized)) return undefined;
	const drive = normalized[0]?.toLowerCase();
	const rest = normalized.slice(2);
	return `/mnt/${drive}${rest}`;
}

function isWslMntPath(value: string): boolean {
	return /^\/mnt\/[a-zA-Z](?:\/|$)/.test(value.trim().replace(/\\/g, "/"));
}

function wslToWin(value: string): string | undefined {
	const normalized = value.trim().replace(/\\/g, "/");
	const match = normalized.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
	if (!match) return undefined;
	const drive = match[1]?.toUpperCase();
	const rest = match[2] ? `\\${match[2].replace(/\//g, "\\")}` : "\\";
	return `${drive}:${rest}`;
}

function parseWslUncPath(value: string): { innerPath: string } | undefined {
	const normalized = value.trim().replace(/\//g, "\\");
	const lower = normalized.toLowerCase();
	const prefixes = ["\\\\wsl$\\", "\\\\wsl.localhost\\"];
	for (const prefix of prefixes) {
		if (!lower.startsWith(prefix)) continue;
		const rest = normalized.slice(prefix.length);
		const slashIndex = rest.indexOf("\\");
		if (slashIndex === -1) return { innerPath: "/" };
		return { innerPath: rest.slice(slashIndex).replace(/\\/g, "/") || "/" };
	}
	return undefined;
}

function resolveLocalPath(value: string, cwd: string, runtimeEnv: RuntimeEnv): string {
	if (runtimeEnv === "windows") {
		return path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.win32.resolve(cwd, value);
	}
	const posixValue = value.replace(/\\/g, "/");
	const posixCwd = cwd.replace(/\\/g, "/");
	return path.posix.isAbsolute(posixValue) ? path.posix.normalize(posixValue) : path.posix.resolve(posixCwd, posixValue);
}

export function normalizeProjectPath(input: string | undefined, cwd: string): string {
	const runtimeEnv = detectRuntimeEnv();
	const raw = (input || cwd).trim() || cwd;
	const baseCwd = runtimeEnv === "windows" ? path.win32.resolve(cwd) : path.posix.resolve(cwd.replace(/\\/g, "/"));

	if (runtimeEnv === "windows") {
		const unc = parseWslUncPath(raw);
		if (unc) return raw.replace(/\//g, "\\");
		const winFromWsl = isWslMntPath(raw) ? wslToWin(raw) : undefined;
		return resolveLocalPath(winFromWsl ?? raw, baseCwd, runtimeEnv);
	}

	if (runtimeEnv === "wsl") {
		const unc = parseWslUncPath(raw);
		const wslFromWin = isWindowsDrivePath(raw) ? winToWsl(raw) : undefined;
		return resolveLocalPath(unc?.innerPath ?? wslFromWin ?? raw, baseCwd, runtimeEnv);
	}

	return resolveLocalPath(raw, baseCwd, runtimeEnv);
}

export function compactPath(value: string | undefined, maxLength = 72): string {
	if (!value) return "current project";
	const normalized = value.replace(/\\/g, "/");
	if (normalized.length <= maxLength) return normalized;
	return `…${normalized.slice(-(maxLength - 1))}`;
}
