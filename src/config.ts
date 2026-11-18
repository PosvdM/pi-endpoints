import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, ModelCost, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Catalog } from "./catalog.ts";
import type { Replacement } from "./family.ts";
import type { ModelsDevFile } from "./modelsdev.ts";

/** 单个模型的手动设置。没写的项按服务端目录、pi 自带目录、models.dev、默认值的顺序取。 */
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
	/** 逐字段覆盖抄来的 compat，值为 null 表示删掉这个字段。 */
	compat?: Record<string, unknown>;
	cost?: ModelCost;
}

export interface ServiceConfig {
	/** pi 里的服务商名，模型写成 `<name>/<模型 id>`。 */
	name: string;
	displayName?: string;
	/** 服务根地址，不带 `/v1`。 */
	baseUrl: string;
	/** 协议按模型分别判断，同一服务可混用多种协议，无需按协议拆分。仅无法判断时使用此项。 */
	defaultApi?: Api;
	/** 设置了这个环境变量时，优先用它作为密钥。 */
	apiKeyEnv?: string;
	/** 加在这个服务所有请求上的请求头。 */
	headers?: Record<string, string>;
	/** 停用整个服务：不注册到 pi，其余设置保留。 */
	disabled?: boolean;
	/** 每系最新：目录刷新后，已启用模型所在的每个系列只保留最新版。见 `src/family.ts`。 */
	latestPerFamily?: boolean;
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

export function modelsDevPath(): string {
	return join(getAgentDir(), "endpoints-modelsdev.json");
}

export function statePath(): string {
	return join(getAgentDir(), "endpoints-state.json");
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
function writeJson(path: string, value: unknown, options: { secret?: boolean; compact?: boolean } = {}): void {
	const { secret = false, compact = false } = options;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, compact ? undefined : "\t")}\n`, secret ? { mode: 0o600 } : undefined);
	renameSync(tmp, path);
	if (secret && process.platform !== "win32") chmodSync(path, 0o600);
}

/** 补齐缺省字段。手工编辑的文件可能缺字段或类型不对，这里只保证结构，内容由 Endpoints 校验。 */
export function normalizeService(service: Partial<ServiceConfig>): ServiceConfig {
	return {
		...service,
		name: typeof service.name === "string" ? service.name : "",
		baseUrl: normalizeRoot(service.baseUrl),
		// 启用时不写这个字段，免得改动现有配置。
		disabled: service.disabled === true ? true : undefined,
		latestPerFamily: service.latestPerFamily === true ? true : undefined,
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
	return dict(readJson<AuthFile>(authPath(), {}));
}

export function saveAuth(auth: AuthFile): void {
	writeJson(authPath(), auth, { secret: true });
}

export function loadCache(): CacheFile {
	try {
		return dict(readJson<CacheFile>(cachePath(), {}));
	} catch {
		// 缓存坏了就当没有，下次刷新会重写。
		return {};
	}
}

export function saveCache(cache: CacheFile): void {
	writeJson(cachePath(), cache);
}

/** 读 models.dev 的本地文件，文件损坏时当作没有。格式由 `modelsdev.ts` 检查。 */
export function loadModelsDevFile(): unknown {
	try {
		return readJson<unknown>(modelsDevPath(), undefined);
	} catch {
		return undefined;
	}
}

/** 文件只给插件读，不缩进，减小体积。 */
export function saveModelsDevFile(file: ModelsDevFile, path = modelsDevPath()): void {
	writeJson(path, file, { compact: true });
}

/** 插件自己记下的运行状态，丢了也只会多提示一次。 */
export interface StateFile {
	/** 按服务名记录已经在 pi 里提示过的新版（开关关着时）。 */
	notifiedUpdates: Record<string, Replacement[]>;
}

/** 读状态文件。文件损坏或结构不对时按空处理，不合规的记录丢掉。 */
export function loadState(): StateFile {
	let raw: unknown;
	try {
		raw = readJson<unknown>(statePath(), {});
	} catch {
		return { notifiedUpdates: {} };
	}
	const notified = isRecord(raw) && isRecord(raw.notifiedUpdates) ? raw.notifiedUpdates : {};
	const result = dict<Replacement[]>({});
	for (const [name, list] of Object.entries(notified)) {
		if (!Array.isArray(list)) continue;
		const valid = list.filter((item): item is Replacement => isRecord(item) && typeof item.from === "string" && typeof item.to === "string");
		if (valid.length) result[name] = valid.map(({ from, to }) => ({ from, to }));
	}
	return { notifiedUpdates: result };
}

export function saveState(state: StateFile): void {
	writeJson(statePath(), state);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 按服务名取值的对象一律没有原型：`constructor` 这类合法的服务名在普通对象上会读到继承来的属性。
 * 只复制自有属性；JSON 里的 `__proto__` 键在没有原型的对象上是普通属性。
 */
export function dict<T>(value: Record<string, T>): Record<string, T> {
	const result = Object.create(null) as Record<string, T>;
	if (isRecord(value)) for (const [key, item] of Object.entries(value)) result[key] = item as T;
	return result;
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
