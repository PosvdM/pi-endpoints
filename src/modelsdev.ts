import type { ModelCost } from "@earendil-works/pi-ai";
import { candidateIds, type Vendor } from "./builtin.ts";
import { loadModelsDevFile, modelsDevPath, saveModelsDevFile } from "./config.ts";

/** models.dev 的 v2 完整目录，`base_model` 继承已经合并好。 */
export const MODELS_DEV_URL = "https://models.dev/experimental/v2.0/api.json";

/**
 * 只在这些服务商里查，先查模型原厂，再按顺序查其余的。models.dev 上的其他服务商大多转卖别家的模型，
 * 参数和原厂不一定一致。
 */
export const MODELS_DEV_PROVIDERS = [
	"openai",
	"anthropic",
	"google",
	"xai",
	"deepseek",
	"moonshotai",
	"zai",
	"zhipuai",
	"alibaba",
	"alibaba-cn",
	"mistral",
	"minimax",
	"xiaomi",
	"meta",
	"cohere",
	"perplexity",
	"stepfun",
	"volcengine",
	"inception",
	"ai21",
	"typesafe",
];

/** 本地文件的格式版本。保存的字段有变化时加一，旧文件当作没有，下次需要时重新拉取。 */
const FILE_VERSION = 1;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RETRY_AFTER_MS = 30 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 60_000;

/** `endpoints-modelsdev.json` 的内容。模型保留 v2 目录的结构，只留下映射用得到的字段。 */
export interface ModelsDevFile {
	version: number;
	etag?: string;
	/** 最后一次拿到新数据的时间。 */
	fetchedAt: number;
	/** 最后一次成功检查的时间，含服务端回 304。 */
	checkedAt: number;
	/** `{ <服务商>: { <模型 id>: 模型 } }`。 */
	providers: Record<string, Record<string, unknown>>;
}

/** 映射成 pi 参数的一个模型。没有的字段留空，交给下一层。 */
export interface ModelsDevModel {
	provider: string;
	id: string;
	name?: string;
	/** `chat`、`decision`、`image`、`embedding` 等，没写时为 `chat`。 */
	type: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	/** `capabilities.reasoning.supported`，没写时为 undefined。 */
	reasoning?: boolean;
	/** `capabilities.reasoning.effort`，没有或为空时为 undefined。 */
	effort?: string[];
	cost?: ModelCost;
}

export interface ModelsDevStatus {
	fetchedAt?: number;
	checkedAt?: number;
	/** 最近一次失败的原因，之后成功时清空。 */
	error?: string;
	fetching: boolean;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const price = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** 缓存写入价格可能是 `{ "<TTL>": 价格 }`，第一个是默认 TTL。 */
function firstPrice(value: unknown): number | undefined {
	if (isObject(value)) return price(Object.values(value)[0]);
	return price(value);
}

/** 只认按 token 计价的价格，没写 unit 时按 token 算。 */
const perToken = (part: Json) => part.unit === undefined || part.unit === "token";

/**
 * 取 `cost.text` 的基础价格，不按上下文分档。input 或 output 缺失，或者不是按 token 计价时不提供价格。
 */
function costOf(text: unknown): ModelCost | undefined {
	if (!isObject(text) || !isObject(text.input) || !isObject(text.output)) return undefined;
	if (!perToken(text.input) || !perToken(text.output)) return undefined;
	const input = price(text.input.price);
	const output = price(text.output.price);
	if (input === undefined || output === undefined) return undefined;
	const cache = isObject(text.input.cache) ? text.input.cache : {};
	const explicit = isObject(cache.explicit) ? cache.explicit : {};
	return {
		input,
		output,
		cacheRead: price(cache.read) ?? 0,
		cacheWrite: firstPrice(cache.write) ?? firstPrice(explicit.write) ?? 0,
	};
}

/** pi 只认 text 和 image。输入里有 `image` 或 `image/*` 时算支持图片，其余类型丢掉。 */
function inputOf(modalities: unknown): ("text" | "image")[] | undefined {
	if (!isObject(modalities) || !Array.isArray(modalities.input)) return undefined;
	const image = modalities.input.some((item) => typeof item === "string" && (item === "image" || item.startsWith("image/")));
	return image ? ["text", "image"] : ["text"];
}

/** 把 v2 目录里的一个模型映射成 pi 的参数。 */
export function parseModelsDevModel(provider: string, id: string, raw: unknown): ModelsDevModel {
	const model = isObject(raw) ? raw : {};
	const limit = isObject(model.limit) ? model.limit : {};
	const capabilities = isObject(model.capabilities) ? model.capabilities : {};
	const reasoning = isObject(capabilities.reasoning) ? capabilities.reasoning : undefined;
	const effort = Array.isArray(reasoning?.effort) ? reasoning.effort.filter((item): item is string => typeof item === "string") : [];
	const cost = isObject(model.cost) ? costOf(model.cost.text) : undefined;
	return {
		provider,
		id,
		name: typeof model.name === "string" && model.name.trim() ? model.name : undefined,
		type: typeof model.type === "string" && model.type ? model.type : "chat",
		contextWindow: positive(limit.context),
		maxTokens: positive(limit.output),
		input: inputOf(model.modalities),
		reasoning: typeof reasoning?.supported === "boolean" ? reasoning.supported : undefined,
		effort: effort.length ? effort : undefined,
		cost,
	};
}

/** 去掉值为 undefined 的字段，没有字段时返回 undefined。 */
function compact(value: Json): Json | undefined {
	const result = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
	return Object.keys(result).length ? result : undefined;
}

const only = (value: unknown, keys: string[]): Json | undefined =>
	isObject(value) ? compact(Object.fromEntries(keys.map((key) => [key, value[key]]))) : undefined;

/** 只留下映射用得到的字段，本地文件因此只有一两百 KB。 */
function trimModel(raw: Json): Json {
	const capabilities = isObject(raw.capabilities) ? raw.capabilities : {};
	const text = isObject(raw.cost) && isObject(raw.cost.text) ? raw.cost.text : undefined;
	const input = isObject(text?.input) ? text.input : undefined;
	const cache = isObject(input?.cache) ? input.cache : undefined;
	return (
		compact({
			name: raw.name,
			type: raw.type,
			limit: only(raw.limit, ["context", "output"]),
			modalities: only(raw.modalities, ["input"]),
			capabilities: compact({ reasoning: only(capabilities.reasoning, ["supported", "effort"]) }),
			cost: text && compact({
				text: compact({
					input:
						input &&
						compact({
							price: input.price,
							unit: input.unit,
							cache: cache && compact({ read: cache.read, write: cache.write, explicit: only(cache.explicit, ["write"]) }),
						}),
					output: only(text.output, ["price", "unit"]),
				}),
			}),
		}) ?? {}
	);
}

/** 从 v2 完整目录里取出名单上的服务商。一个模型都没有时说明格式不对。 */
export function extractModelsDev(body: unknown): ModelsDevFile["providers"] {
	if (!isObject(body)) throw new Error("models.dev 返回的不是 JSON 对象");
	const providers: ModelsDevFile["providers"] = {};
	for (const name of MODELS_DEV_PROVIDERS) {
		const provider = body[name];
		if (!isObject(provider) || !isObject(provider.models)) continue;
		providers[name] = Object.fromEntries(
			Object.entries(provider.models)
				.filter(([, model]) => isObject(model))
				.map(([id, model]) => [id, trimModel(model as Json)]),
		);
	}
	if (!Object.values(providers).some((models) => Object.keys(models).length)) {
		throw new Error("models.dev 返回的目录里没有名单上的服务商的模型");
	}
	return providers;
}

let data: ModelsDevFile | undefined;
let index: Map<string, Map<string, ModelsDevModel>> | undefined;
let inflight: Promise<boolean> | undefined;
let fetching = false;
let failedAt: number | undefined;
let lastError: string | undefined;

const isTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * 检查本地文件的结构。服务商或模型的结构不对，或者一个模型都没有时，整份文件当作无效：
 * 只丢掉坏的部分会留下“有缓存但没有模型”的数据，到期后带着旧 ETag 请求，服务端回 304，数据就一直恢复不了。
 */
function validFile(raw: unknown): ModelsDevFile | undefined {
	if (!isObject(raw) || raw.version !== FILE_VERSION || !isObject(raw.providers)) return undefined;
	if (!isTimestamp(raw.fetchedAt) || !isTimestamp(raw.checkedAt)) return undefined;
	if (raw.etag !== undefined && typeof raw.etag !== "string") return undefined;
	let count = 0;
	for (const models of Object.values(raw.providers)) {
		if (!isObject(models)) return undefined;
		for (const model of Object.values(models)) {
			if (!isObject(model)) return undefined;
			count++;
		}
	}
	if (count === 0) return undefined;
	return {
		version: FILE_VERSION,
		etag: raw.etag,
		fetchedAt: raw.fetchedAt,
		checkedAt: raw.checkedAt,
		providers: raw.providers as ModelsDevFile["providers"],
	};
}

function setData(next: ModelsDevFile | undefined): void {
	data = next;
	index = undefined;
}

/**
 * 重新读本地文件，可能同时运行着多个 pi，别的 pi 可能刚拉过。文件损坏、结构不对或格式版本不对时当作没有。
 * 返回模型数据有没有变化，变化时调用方要重新注册。
 */
export function loadModelsDev(): boolean {
	const next = validFile(loadModelsDevFile());
	// 本进程下载失败后，别的 pi 成功检查过时，清掉旧的失败原因和退避；读到的还是失败前的文件时保留。
	if (next && failedAt !== undefined && next.checkedAt > failedAt) {
		failedAt = undefined;
		lastError = undefined;
	}
	if (data && next && data.fetchedAt === next.fetchedAt && data.etag === next.etag) {
		data.checkedAt = Math.max(data.checkedAt, next.checkedAt);
		return false;
	}
	const changed = data !== undefined || next !== undefined;
	setData(next);
	return changed;
}

function modelsIndex(): Map<string, Map<string, ModelsDevModel>> {
	if (!index) {
		index = new Map();
		for (const [provider, models] of Object.entries(data?.providers ?? {})) {
			index.set(provider, new Map(Object.entries(models).map(([id, raw]) => [id, parseModelsDevModel(provider, id, raw)])));
		}
	}
	return index;
}

/** 按名字在 models.dev 里找模型：先找原厂，再按名单顺序找其余服务商，匹配方式和 `findBuiltin()` 相同。 */
export function findModelsDev(id: string, vendor?: Vendor): ModelsDevModel | undefined {
	const models = modelsIndex();
	if (!models.size) return undefined;
	const ids = candidateIds(id);
	const order = vendor && MODELS_DEV_PROVIDERS.includes(vendor) ? [vendor, ...MODELS_DEV_PROVIDERS.filter((name) => name !== vendor)] : MODELS_DEV_PROVIDERS;
	for (const provider of order) {
		const byId = models.get(provider);
		if (!byId) continue;
		for (const candidate of ids) {
			const match = byId.get(candidate);
			if (match) return match;
		}
	}
	return undefined;
}

export function modelsDevStatus(): ModelsDevStatus {
	return { fetchedAt: data?.fetchedAt, checkedAt: data?.checkedAt, error: lastError, fetching };
}

/** 本地没有数据或上次成功检查超过 24 小时才拉；失败后 30 分钟内不再试。 */
function due(now: number): boolean {
	if (failedAt !== undefined && now - failedAt < RETRY_AFTER_MS) return false;
	return !data || now - data.checkedAt >= CHECK_INTERVAL_MS;
}

/** 本进程里有没有 models.dev 数据：读到过有效的本地文件，或者下载成功过。“每系最新”没有它时推迟。 */
export function hasModelsDevData(): boolean {
	return data !== undefined;
}

/**
 * 到期时拉取 models.dev。同一进程里同时只发一个请求，并发的调用共用同一个结果。
 * 不会失败，失败原因记在 `modelsDevStatus().error`。返回模型数据有没有变化。
 */
export function updateModelsDev(): Promise<boolean> {
	inflight ??= run().finally(() => {
		inflight = undefined;
	});
	return inflight;
}

async function run(): Promise<boolean> {
	const changed = loadModelsDev();
	if (!due(Date.now())) return changed;
	// 请求期间测试可能换掉 pi 配置目录，路径在发请求前确定。
	const path = modelsDevPath();
	fetching = true;
	try {
		const result = await download(data?.etag);
		const now = Date.now();
		if (result === "not-modified") {
			if (!data) throw new Error("models.dev 返回 304，但本地没有数据");
			const next = { ...data, checkedAt: now };
			saveModelsDevFile(next, path);
			data = next;
		} else {
			const next: ModelsDevFile = { version: FILE_VERSION, etag: result.etag, fetchedAt: now, checkedAt: now, providers: result.providers };
			saveModelsDevFile(next, path);
			setData(next);
		}
		failedAt = undefined;
		lastError = undefined;
		return changed || result !== "not-modified";
	} catch (error) {
		failedAt = Date.now();
		lastError = describe(error);
		return changed;
	} finally {
		fetching = false;
	}
}

async function download(etag: string | undefined): Promise<"not-modified" | { etag?: string; providers: ModelsDevFile["providers"] }> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (etag) headers["If-None-Match"] = etag;
	let response: Response;
	try {
		response = await fetch(MODELS_DEV_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") throw new Error(`models.dev 在 ${FETCH_TIMEOUT_MS / 1000} 秒内没有响应`);
		throw error;
	}
	if (response.status === 304) return "not-modified";
	if (!response.ok) throw new Error(`${MODELS_DEV_URL} 返回 ${response.status}`);
	let body: unknown;
	try {
		body = JSON.parse(await response.text());
	} catch {
		throw new Error(`${MODELS_DEV_URL} 返回的不是 JSON`);
	}
	return { etag: response.headers.get("etag") ?? undefined, providers: extractModelsDev(body) };
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		return cause instanceof Error ? `${error.message}（${cause.message}）` : error.message;
	}
	return String(error);
}

/**
 * 测试用：换掉 models.dev 数据，传入 `{ <服务商>: { <模型 id>: v2 格式的模型 } }`。
 * 传 undefined 时清空数据和拉取状态（失败记录、错误原因）。
 */
export function setModelsDevForTest(providers: ModelsDevFile["providers"] | undefined): void {
	setData(providers ? { version: FILE_VERSION, fetchedAt: 0, checkedAt: 0, providers } : undefined);
	failedAt = undefined;
	lastError = undefined;
	fetching = false;
}
