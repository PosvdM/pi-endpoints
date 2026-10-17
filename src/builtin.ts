import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

export type BuiltinModel = Model<Api>;

/** 模型原厂，用来决定 compat 和价格从 pi 自带目录的哪个服务商抄。 */
export type Vendor = "anthropic" | "openai" | "google" | "xai";

/**
 * 这些服务商转卖别家的模型，或者是订阅套餐，参数和原厂不一定一致，按名字匹配时不用它们。
 * openai-codex 是订阅版，只在抄 compat 时单独使用。
 */
const RESELLERS = new Set([
	"kimi-coding",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai-coding-cn",
	"amazon-bedrock",
	"azure",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"github-copilot",
	"google-vertex",
	"huggingface",
	"openai-codex",
	"opencode",
	"opencode-go",
	"openrouter",
	"radius",
	"together",
	"vercel-ai-gateway",
	"fireworks",
	"baseten",
	"nvidia",
	"groq",
	"cerebras",
]);

let byProvider: Map<string, BuiltinModel[]> | undefined;

function catalog(): Map<string, BuiltinModel[]> {
	if (!byProvider) {
		byProvider = new Map();
		for (const provider of getBuiltinProviders()) {
			byProvider.set(provider, getBuiltinModels(provider) as BuiltinModel[]);
		}
	}
	return byProvider;
}

/** 测试用：换掉 pi 自带目录。 */
export function setBuiltinCatalogForTest(models: Record<string, BuiltinModel[]> | undefined): void {
	byProvider = models ? new Map(Object.entries(models)) : undefined;
}

export function builtinProviderIds(): string[] {
	return [...catalog().keys()];
}

/**
 * 模型名里明确写着 claude、gemini、grok 时以名字为准：one-api 类中转站常把经 OpenAI 兼容渠道
 * 提供的 Claude 也标成 `owned_by: openai`。其余情况先看 owned_by，再看名字。
 */
export function vendorOf(id: string, ownedBy?: string): Vendor | undefined {
	const name = id.toLowerCase();
	if (name.includes("claude")) return "anthropic";
	if (name.includes("gemini") || name.includes("gemma")) return "google";
	if (name.includes("grok")) return "xai";
	switch (ownedBy?.toLowerCase()) {
		case "anthropic":
		case "claude":
			return "anthropic";
		case "openai":
		case "codex":
			return "openai";
		case "google":
		case "gemini":
			return "google";
		case "xai":
		case "grok":
			return "xai";
	}
	if (name.includes("gpt") || /(^|\/)o\d/.test(name) || name.includes("codex")) return "openai";
	return undefined;
}

const LEVEL_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/;
const DATE_SUFFIX = /-(20\d{6}|\d{4}-\d{2}-\d{2})$/;
const VARIANT_SUFFIX = /-(reversed|thinking|preview|latest)$/;

/**
 * 按顺序给出用来查 pi 自带目录的 id：原样、去掉 `codex/` 这类前缀，
 * 再依次去掉档位、日期和变体后缀。
 */
export function candidateIds(id: string): string[] {
	const result: string[] = [];
	const add = (value: string) => {
		if (value && !result.includes(value)) result.push(value);
	};
	add(id);
	let current = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	add(current);
	for (let changed = true; changed; ) {
		changed = false;
		for (const pattern of [LEVEL_SUFFIX, DATE_SUFFIX, VARIANT_SUFFIX]) {
			const next = current.replace(pattern, "");
			if (next !== current) {
				current = next;
				add(current);
				changed = true;
			}
		}
	}
	return result;
}

function findIn(provider: string, ids: string[]): BuiltinModel | undefined {
	const models = catalog().get(provider);
	if (!models) return undefined;
	for (const id of ids) {
		const match = models.find((model) => model.id === id);
		if (match) return match;
	}
	return undefined;
}

/** 按名字在 pi 自带目录里找参数。先找原厂，再找其他直营服务商。 */
export function findBuiltin(id: string, vendor?: Vendor): BuiltinModel | undefined {
	const ids = candidateIds(id);
	if (vendor) {
		const match = findIn(vendor, ids);
		if (match) return match;
	}
	for (const provider of catalog().keys()) {
		if (provider === vendor || RESELLERS.has(provider)) continue;
		const match = findIn(provider, ids);
		if (match) return match;
	}
	return undefined;
}

/** 在指定服务商里找，用于抄 compat 和价格。 */
export function findBuiltinIn(provider: string, id: string): BuiltinModel | undefined {
	return findIn(provider, candidateIds(id));
}
