import type { Api, ModelCost, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { splitBetas } from "./betas.ts";
import { type BuiltinModel, findBuiltin, findBuiltinIn, type Vendor, vendorOf } from "./builtin.ts";
import type { Catalog, CatalogModel } from "./catalog.ts";
import { DEFAULT_API, type ModelOverride, type ServiceConfig } from "./config.ts";

/** 每个值来自哪一层：手动设置、服务端目录、pi 自带目录，还是默认值。 */
export type Source = "manual" | "server" | "pi" | "default";

/** 协议来自哪一步判断。 */
export type ApiSource = "manual" | "native_endpoints" | "owned_by" | "name" | "default";

export interface Sourced<T, S = Source> {
	value: T;
	source: S;
}

export interface ResolvedModel {
	id: string;
	ownedBy?: string;
	/** 服务端标了隐藏，或者看名字是图片生成模型。只影响管理页默认显示不显示。 */
	hidden: boolean;
	/** 已启用，但服务端目录里没有这个模型。 */
	missing: boolean;
	name: Sourced<string>;
	api: Sourced<Api, ApiSource>;
	baseUrl: Sourced<string, "manual" | "default">;
	/** 交给 pi 的请求头。Anthropic 协议的模型不含 `anthropic-beta`，它的值在 `betas` 里。 */
	headers?: Record<string, string>;
	/** 追加到 pi 的 beta 列表里的 Anthropic beta，见 `splitBetas()`。 */
	betas: string[];
	contextWindow: Sourced<number>;
	maxTokens: Sourced<number>;
	input: Sourced<("text" | "image")[]>;
	reasoning: Sourced<boolean>;
	thinkingLevelMap: Sourced<ThinkingLevelMap | undefined>;
	compat: Sourced<Record<string, unknown> | undefined>;
	cost: Sourced<ModelCost>;
	/** pi 自带目录里按名字匹配上的条目，没有就是 undefined。 */
	builtin?: string;
}

type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 管理页可选、手动设置允许的协议。 */
export const SUPPORTED_APIS: Api[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
];

const DEFAULTS = { contextWindow: 128000, maxTokens: 16384 };
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 服务端列出的档位照原样映射，没列出的设为 null。`off` 只在服务端列出 `none` 或 `off` 时开放，
 * 值沿用服务端的写法；`ultra` 这类 pi 没有的档位丢弃。再按协议去掉 pi 发不出去的档位。
 */
export function levelsToMap(levels: string[], api?: Api): ThinkingLevelMap {
	const offered = new Set(levels.map((level) => level.toLowerCase()));
	const map: ThinkingLevelMap = {};
	for (const level of PI_LEVELS) {
		if (level === "off") map.off = offered.has("none") ? "none" : offered.has("off") ? "off" : null;
		else map[level] = offered.has(level) ? level : null;
	}
	// pi 的 Google 实现只接受 minimal 到 high；Anthropic 实现会把 minimal 原样当作 effort 发出，服务端不认。
	if (api === "google-generative-ai") map.xhigh = map.max = null;
	if (api === "anthropic-messages") map.minimal = null;
	return map;
}

/** 有 off 以外的可选档位才算支持调节思考。 */
function hasThinking(map: ThinkingLevelMap): boolean {
	return supportedLevels(true, map).some((level) => level !== "off");
}

/**
 * 列出 pi 里可调的思考档位，规则和 pi 的 getSupportedThinkingLevels 一致。
 * 不支持思考时 pi 返回 ["off"]，这里返回空数组，方便显示"不支持调节"。
 */
export function supportedLevels(reasoning: boolean, map: ThinkingLevelMap | undefined): string[] {
	if (!reasoning) return [];
	return PI_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		// 没写 off 时 pi 会提供"关闭思考"，这里照实显示。
		return true;
	});
}

// antigravity 背后既有 Gemini 也有 Claude，看不出协议，交给按名字判断。
const OWNED_BY_API: Record<string, Api> = {
	openai: "openai-responses",
	codex: "openai-responses",
	anthropic: "anthropic-messages",
	claude: "anthropic-messages",
	gemini: "google-generative-ai",
	google: "google-generative-ai",
	xai: "openai-responses",
	grok: "openai-responses",
};

const ENDPOINT_API: Record<string, Api> = {
	"/v1/responses": "openai-responses",
	"/v1/chat/completions": "openai-completions",
	"/v1/messages": "anthropic-messages",
};

export function selectApi(model: CatalogModel, service: ServiceConfig, override?: ModelOverride): Sourced<Api, ApiSource> {
	if (override?.api) return { value: override.api, source: "manual" };
	for (const endpoint of model.nativeEndpoints ?? []) {
		const api = ENDPOINT_API[endpoint.replace(/\/+$/, "")];
		if (api) return { value: api, source: "native_endpoints" };
	}
	const byOwner = model.ownedBy ? OWNED_BY_API[model.ownedBy.toLowerCase()] : undefined;
	if (byOwner) return { value: byOwner, source: "owned_by" };
	const name = model.id.toLowerCase();
	if (name.includes("claude")) return { value: "anthropic-messages", source: "name" };
	if (name.includes("gpt")) return { value: "openai-responses", source: "name" };
	if (name.includes("gemini")) return { value: "google-generative-ai", source: "name" };
	return { value: service.defaultApi ?? DEFAULT_API, source: "default" };
}

/** openai-codex-responses、azure-openai-responses 和 openai-responses 用同一套 compat。 */
function compatFamily(api: Api): Api {
	return api === "openai-codex-responses" || api === "azure-openai-responses" ? "openai-responses" : api;
}

export function baseUrlFor(root: string, api: Api): string {
	switch (api) {
		case "anthropic-messages":
			return root;
		case "google-generative-ai":
			return `${root}/v1beta`;
		default:
			return `${root}/v1`;
	}
}

function pick<T>(manual: T | undefined, server: T | undefined, pi: T | undefined, fallback: T): Sourced<T> {
	if (manual !== undefined) return { value: manual, source: "manual" };
	if (server !== undefined) return { value: server, source: "server" };
	if (pi !== undefined) return { value: pi, source: "pi" };
	return { value: fallback, source: "default" };
}

/**
 * compat 只从原厂抄。背后是 ChatGPT 订阅的 GPT 改抄 openai-codex 的订阅版条目，
 * 官方 API 的一些能力（如 supportsExplicitPromptCacheMode）订阅版没有。
 */
function compatSource(vendor: Vendor | undefined, model: CatalogModel, catalog: Catalog | undefined): BuiltinModel | undefined {
	if (!vendor) return undefined;
	if (vendor === "openai" && (catalog?.codex || model.ownedBy?.toLowerCase() === "codex")) {
		return findBuiltinIn("openai-codex", model.id);
	}
	return findBuiltinIn(vendor, model.id);
}

/**
 * 手动填写的档位用 pi 的档位名。`off` 写成 `none`，和 OpenAI 关闭思考时的 effort 值一致；
 * 单独一个 `none` 由管理页存成空数组，表示不支持调节思考。
 */
function manualLevels(levels: string[]): string[] {
	return levels.map((level) => (level === "off" ? "none" : level));
}

function resolveThinking(
	override: ModelOverride | undefined,
	model: CatalogModel,
	builtin: BuiltinModel | undefined,
	api: Api,
): { reasoning: Sourced<boolean>; map: Sourced<ThinkingLevelMap | undefined> } {
	if (override?.thinkingLevelMap || override?.thinkingLevels) {
		const map = override.thinkingLevelMap ?? levelsToMap(manualLevels(override.thinkingLevels ?? []), api);
		const reasoning = hasThinking(map);
		return { reasoning: { value: reasoning, source: "manual" }, map: { value: reasoning ? map : undefined, source: "manual" } };
	}
	if (model.reasoningLevels) {
		const map = levelsToMap(model.reasoningLevels, api);
		// 档位列表为空（如 claude-opus-5-5-high）：思考强度已固定在模型名里，不让 pi 发思考参数。
		const usable = hasThinking(map);
		return {
			reasoning: { value: usable, source: "server" },
			map: { value: usable ? map : undefined, source: "server" },
		};
	}
	if (builtin) {
		return {
			reasoning: { value: builtin.reasoning, source: "pi" },
			map: { value: builtin.reasoning ? builtin.thinkingLevelMap : undefined, source: "pi" },
		};
	}
	return { reasoning: { value: false, source: "default" }, map: { value: undefined, source: "default" } };
}

/**
 * 不支持调节思考的模型（如 claude-opus-5-5-high）去掉和思考有关的标志：
 * 带着 forceAdaptiveThinking 或 supportsMidConvoEffort 时，pi 不看 reasoning，照样发思考参数。
 */
const THINKING_COMPAT = ["forceAdaptiveThinking", "supportsMidConvoEffort"];

function copiedCompat(compat: Record<string, unknown>, reasoning: boolean): Record<string, unknown> | undefined {
	if (reasoning) return compat;
	const rest = Object.fromEntries(Object.entries(compat).filter(([key]) => !THINKING_COMPAT.includes(key)));
	return Object.keys(rest).length ? rest : undefined;
}

export function resolveModel(
	service: ServiceConfig,
	model: CatalogModel,
	catalog: Catalog | undefined,
	missing = false,
): ResolvedModel {
	const override = service.overrides[model.id];
	const vendor = vendorOf(model.id, model.ownedBy);
	const builtin = findBuiltin(model.id, vendor);
	const api = selectApi(model, service, override);
	const thinking = resolveThinking(override, model, builtin, api.value);
	// 协议和原厂条目不同时（如手动把 Claude 改成走 openai-completions），抄来的 compat 不适用。
	const compatFrom = compatSource(vendor, model, catalog);
	// 价格一律按官方 API，GPT 也找 openai，不找订阅版。
	const costFrom = vendor ? findBuiltinIn(vendor, model.id) : undefined;
	const contextWindow = pick(override?.contextWindow, model.contextWindow, builtin?.contextWindow, DEFAULTS.contextWindow);
	const { headers, betas } = splitBetas({ ...service.headers, ...override?.headers }, api.value, contextWindow.value, vendor === "anthropic");

	return {
		id: model.id,
		ownedBy: model.ownedBy,
		hidden: (model.hidden ?? false) || IMAGE_MODEL.test(model.id),
		missing,
		// 去掉后缀才匹配上时不借用名字，否则 claude-opus-5-5 和 claude-opus-5-5-high 会显示成同一个名字。
		name: pick(override?.name, model.name, builtin && sameModel(builtin.id, model.id) ? builtin.name : undefined, model.id),
		api,
		baseUrl: override?.baseUrl
			? { value: override.baseUrl, source: "manual" }
			: { value: baseUrlFor(service.baseUrl, api.value), source: "default" },
		headers: Object.keys(headers).length ? headers : undefined,
		betas,
		contextWindow,
		maxTokens: pick(override?.maxTokens, model.maxTokens, builtin?.maxTokens, DEFAULTS.maxTokens),
		input: pick(override?.input, model.input, builtin?.input, ["text"]),
		reasoning: thinking.reasoning,
		thinkingLevelMap: thinking.map,
		compat: override?.compat
			? { value: override.compat, source: "manual" }
			: compatFrom?.compat && compatFamily(compatFrom.api) === compatFamily(api.value)
				? { value: copiedCompat(compatFrom.compat as Record<string, unknown>, thinking.reasoning.value), source: "pi" }
				: { value: undefined, source: "default" },
		cost: pick(override?.cost, undefined, costFrom?.cost, ZERO_COST),
		builtin: builtin ? `${builtin.provider}/${builtin.id}` : undefined,
	};
}

/**
 * 名字里有独立的 image 一词的是图片生成模型，pi 不能拿它对话。CLIProxyAPI 把 gpt-image-* 标成隐藏，
 * 却把 gemini-3.1-flash-image 这类模型标成显示，所以按名字补上。
 */
const IMAGE_MODEL = /(^|[-_/.])image([-_/.]|$)/i;

function sameModel(builtinId: string, id: string): boolean {
	return builtinId === id || builtinId === id.slice(id.lastIndexOf("/") + 1);
}

/** 列出服务上的全部模型；已启用但目录里没有的也列出来，读过目录时标为 missing。 */
export function resolveService(service: ServiceConfig, catalog: Catalog | undefined): ResolvedModel[] {
	const models = catalog?.models ?? [];
	const known = new Set(models.map((model) => model.id));
	const resolved = models.map((model) => resolveModel(service, model, catalog));
	for (const id of service.enabled) {
		if (!known.has(id)) resolved.push(resolveModel(service, { id }, catalog, catalog !== undefined));
	}
	return resolved;
}

export function toProviderModel(model: ResolvedModel): ChatModelConfig {
	return {
		id: model.id,
		name: model.name.value,
		api: model.api.value,
		baseUrl: model.baseUrl.value,
		headers: model.headers,
		reasoning: model.reasoning.value,
		thinkingLevelMap: model.thinkingLevelMap.value,
		input: model.input.value,
		cost: model.cost.value,
		contextWindow: model.contextWindow.value,
		maxTokens: model.maxTokens.value,
		compat: model.compat.value as ChatModelConfig["compat"],
	};
}
