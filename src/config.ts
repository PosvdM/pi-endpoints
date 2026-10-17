import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, ModelCost, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Catalog } from "./catalog.ts";

/** 单个模型的手动设置。没写的项按服务端目录、pi 自带目录、默认值的顺序取。 */
export interface ModelOverride {
	name?: string;
	api?: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	/** 支持的 pi 思考档位，如 ["low", "medium", "high"]。空数组表示不支持调节思考强度。 */
	thinkingLevels?: string[];
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
	cost?: ModelCost;
}

export interface ServiceConfig {
	/** pi 里的服务商名，模型写成 `<name>/<模型 id>`。 */
	name: string;
	displayName?: string;
	/** 服务根地址，不带 `/v1`。 */
	baseUrl: string;
	/** 其他办法都判断不出协议时使用。 */
	defaultApi?: Api;
	/** 设置了这个环境变量时，优先用它作为密钥。 */
	apiKeyEnv?: string;
	/** 加在这个服务所有请求上的请求头。 */
	headers?: Record<string, string>;
	/** 启用的模型 id。 */
	enabled: string[];
	overrides: Record<string, ModelOverride>;
}

export interface EndpointsConfig {
	services: ServiceConfig[];
}

type AuthFile = Record<string, { apiKey: string }>;
type CacheFile = Record<string, Catalog>;

export const DEFAULT_API: Api = "openai-completions";

export function configPath(): string {
	return join(getAgentDir(), "endpoints.json");
}

export function authPath(): string {
	return join(getAgentDir(), "endpoints-auth.json");
}

export function cachePath(): string {
	return join(getAgentDir(), "endpoints-cache.json");
}

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 先写临时文件再改名，避免写到一半时崩溃留下损坏的文件。 */
function writeJson(path: string, value: unknown, secret = false): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, secret ? { mode: 0o600 } : undefined);
	renameSync(tmp, path);
	if (secret && process.platform !== "win32") chmodSync(path, 0o600);
}

/** 补齐缺省字段。手工编辑的文件可能缺字段或类型不对，这里只保证结构，内容由 Endpoints 校验。 */
export function normalizeService(service: Partial<ServiceConfig>): ServiceConfig {
	return {
		...service,
		name: typeof service.name === "string" ? service.name : "",
		baseUrl: normalizeRoot(service.baseUrl),
		enabled: Array.isArray(service.enabled) ? service.enabled.filter((id) => typeof id === "string") : [],
		overrides: service.overrides && typeof service.overrides === "object" ? service.overrides : {},
	};
}

/** 去掉末尾的 `/` 和 `/v1`，用户填 `https://x.com/v1` 和 `https://x.com` 效果一样。 */
export function normalizeRoot(url: unknown): string {
	return typeof url === "string" ? url.trim().replace(/\/+$/, "").replace(/\/v1$/, "") : "";
}

export function loadConfig(): EndpointsConfig {
	const raw = readJson<Partial<EndpointsConfig>>(configPath(), {});
	if (raw.services !== undefined && !Array.isArray(raw.services)) throw new Error(`${configPath()} 里的 services 要是数组`);
	return { services: (raw.services ?? []).filter((item) => item && typeof item === "object").map(normalizeService) };
}

export function saveConfig(config: EndpointsConfig): void {
	writeJson(configPath(), config);
}

export function loadAuth(): AuthFile {
	return readJson<AuthFile>(authPath(), {});
}

export function saveAuth(auth: AuthFile): void {
	writeJson(authPath(), auth, true);
}

export function loadCache(): CacheFile {
	try {
		return readJson<CacheFile>(cachePath(), {});
	} catch {
		// 缓存坏了就当没有，下次刷新会重写。
		return {};
	}
}

export function saveCache(cache: CacheFile): void {
	writeJson(cachePath(), cache);
}

export type KeySource = "env" | "file";

export interface ResolvedKey {
	key: string;
	source: KeySource;
}

export function resolveKey(service: ServiceConfig, auth: AuthFile): ResolvedKey | undefined {
	const envName = service.apiKeyEnv?.trim();
	if (envName && process.env[envName]) return { key: process.env[envName], source: "env" };
	const stored = auth[service.name]?.apiKey;
	return stored ? { key: stored, source: "file" } : undefined;
}

/**
 * 转换成交给 pi 的 `apiKey` 写法。pi 会把 `$NAME` 当环境变量、开头的 `!` 当命令，
 * 文件里的密钥要转义；来自环境变量的直接写 `${NAME}`，由 pi 在请求时读取。
 */
export function piApiKey(service: ServiceConfig, resolved: ResolvedKey): string {
	if (resolved.source === "env") return `\${${service.apiKeyEnv?.trim()}}`;
	return escapeConfigValue(resolved.key);
}

export function escapeConfigValue(value: string): string {
	const escaped = value.replaceAll("$", "$$$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}
