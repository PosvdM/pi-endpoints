/** 服务端模型目录里的一个模型。没有的字段留空，由后面几层补齐。 */
export interface CatalogModel {
	id: string;
	ownedBy?: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	/** 服务端列出的思考档位原值。undefined 表示目录里没有这项，空数组表示明确不支持。 */
	reasoningLevels?: string[];
	nativeEndpoints?: string[];
	/** Codex 目录里 `visibility: "hide"` 的模型。 */
	hidden?: boolean;
}

export interface Catalog {
	fetchedAt: number;
	/** 服务返回了 Codex 格式目录，说明背后是 ChatGPT 订阅（CPA）。 */
	codex: boolean;
	models: CatalogModel[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

function modalities(value: unknown): ("text" | "image")[] | undefined {
	if (!Array.isArray(value)) return undefined;
	// pi 只认 text 和 image，pdf 这类丢掉。
	const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
	return input.length ? input : undefined;
}

function levels(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.map((item) => (isObject(item) ? item.effort : item))
		.filter((effort): effort is string => typeof effort === "string");
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** 解析 `GET /v1/models` 的 `{ data: [...] }`，兼容 Magpie 这类带扩展字段的返回。 */
export function parseOpenAIModels(body: unknown): CatalogModel[] {
	if (!isObject(body) || !Array.isArray(body.data)) throw new Error("返回内容不是 OpenAI 格式的模型列表（缺少 data 数组）");
	const models: CatalogModel[] = [];
	for (const entry of body.data) {
		if (!isObject(entry)) continue;
		const id = text(entry.id);
		if (!id) continue;
		models.push(
			compact({
				id,
				ownedBy: text(entry.owned_by),
				name: text(entry.display_name),
				contextWindow: positive(entry.context_window) ?? positive(entry.context_length),
				maxTokens: positive(entry.max_output_tokens) ?? positive(entry.max_tokens),
				input: modalities(isObject(entry.modalities) ? entry.modalities.input : entry.input_modalities),
				reasoningLevels: levels(entry.supported_reasoning_levels),
				nativeEndpoints: strings(entry.native_endpoints),
			}),
		);
	}
	return models;
}

/** 解析 Codex 格式的 `{ models: [...] }`。返回 undefined 表示不是这种格式。 */
export function parseCodexModels(body: unknown): CatalogModel[] | undefined {
	if (!isObject(body) || !Array.isArray(body.models)) return undefined;
	const models: CatalogModel[] = [];
	for (const entry of body.models) {
		if (!isObject(entry)) continue;
		const id = text(entry.slug);
		if (!id) continue;
		models.push(
			compact({
				id,
				name: text(entry.display_name),
				contextWindow: positive(entry.context_window),
				maxTokens: positive(entry.max_tokens),
				input: modalities(entry.input_modalities),
				reasoningLevels: levels(entry.supported_reasoning_levels),
				hidden: entry.visibility === "hide" ? true : undefined,
			}),
		);
	}
	return models;
}

/** 以普通目录为准（它有 owned_by），按 id 补上 Codex 目录里的参数。 */
export function mergeCatalogs(plain: CatalogModel[], codex: CatalogModel[] | undefined): CatalogModel[] {
	if (!codex) return plain;
	const byId = new Map(codex.map((model) => [model.id, model]));
	const merged: CatalogModel[] = plain.map((model) => ({ ...model, ...byId.get(model.id), ownedBy: model.ownedBy }));
	const known = new Set(plain.map((model) => model.id));
	for (const model of codex) if (!known.has(model.id)) merged.push(model);
	return merged.map((model) => compact(model));
}

function compact<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export class CatalogError extends Error {
	readonly status?: number;
	readonly body?: string;

	constructor(message: string, status?: number, body?: string) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

async function getJson(url: string, apiKey: string, headers: Record<string, string>, signal?: AbortSignal) {
	const response = await fetch(url, {
		headers: { ...headers, Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal,
	});
	const body = await response.text();
	if (!response.ok) throw new CatalogError(`${url} 返回 ${response.status}`, response.status, body.slice(0, 2000));
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new CatalogError(`${url} 返回的不是 JSON`, response.status, body.slice(0, 2000));
	}
}

/** 先读所有服务都支持的 `/v1/models`，再试 Codex 格式补参数。 */
export async function fetchCatalog(
	root: string,
	apiKey: string,
	options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Catalog> {
	const headers = options.headers ?? {};
	const plain = parseOpenAIModels(await getJson(`${root}/v1/models`, apiKey, headers, options.signal));
	let codex: CatalogModel[] | undefined;
	try {
		codex = parseCodexModels(await getJson(`${root}/v1/models?client_version=pi`, apiKey, headers, options.signal));
	} catch (error) {
		if (options.signal?.aborted) throw error;
		// 多数服务不认这个参数，出错就只用普通目录。
	}
	return { fetchedAt: Date.now(), codex: codex !== undefined, models: mergeCatalogs(plain, codex) };
}
