import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuiltinModel, candidateIds, findBuiltin, setBuiltinCatalogForTest, vendorOf } from "../src/builtin.ts";
import type { Catalog } from "../src/catalog.ts";
import type { ServiceConfig } from "../src/config.ts";
import { LONG_CONTEXT_BETA } from "../src/betas.ts";
import { setModelsDevForTest } from "../src/modelsdev.ts";
import { isChatModel, levelsToMap, resolveModel, resolveService, selectApi, supportedLevels, toProviderModel } from "../src/resolve.ts";

const cost = (input: number) => ({ input, output: input * 5, cacheRead: 0, cacheWrite: 0 });

function builtin(provider: string, id: string, extra: Partial<BuiltinModel> = {}): BuiltinModel {
	return {
		id,
		name: `${provider} ${id}`,
		api: "openai-responses",
		provider,
		baseUrl: "https://official.test",
		reasoning: true,
		input: ["text", "image"],
		cost: cost(1),
		contextWindow: 272000,
		maxTokens: 128000,
		...extra,
	} as BuiltinModel;
}

beforeAll(() => {
	setBuiltinCatalogForTest({
		openai: [builtin("openai", "gpt-6.1-sol", { cost: cost(2), compat: { supportsStrictMode: true, supportsToolSearch: true } })],
		"openai-codex": [
			builtin("openai-codex", "gpt-6.1-sol", { api: "openai-codex-responses", cost: cost(9), compat: { supportsToolSearch: true } }),
		],
		anthropic: [
			builtin("anthropic", "claude-opus-5-5", {
				api: "anthropic-messages",
				contextWindow: 1000000,
				cost: cost(4),
				compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsStrictTools: true, sendSessionAffinityHeaders: false },
				thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
			}),
		],
		google: [
			builtin("google", "gemini-3.8-flash", {
				api: "google-generative-ai",
				contextWindow: 1048576,
				maxTokens: 65536,
				thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
			}),
		],
		openrouter: [builtin("openrouter", "deepseek-v9", { contextWindow: 1 })],
		deepseek: [builtin("deepseek", "deepseek-v9", { api: "openai-completions", contextWindow: 64000, reasoning: false })],
	});
});

afterAll(() => setBuiltinCatalogForTest(undefined));

const service = (extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
	name: "svc",
	baseUrl: "https://gw.test",
	enabled: [],
	overrides: {},
	...extra,
});

const catalog = (models: Catalog["models"], codex = false): Catalog => ({ fetchedAt: 1, codex, models });

describe("levelsToMap", () => {
	it("列出的档位照原样映射，其他为 null，ultra 丢弃", () => {
		expect(levelsToMap(["low", "medium", "high", "xhigh", "max", "ultra"])).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("服务端明确支持时才开放 minimal 和 off", () => {
		const map = levelsToMap(["none", "minimal", "low"]);
		expect(map.off).toBe("none");
		expect(map.minimal).toBe("minimal");
		expect(supportedLevels(true, map)).toEqual(["off", "minimal", "low"]);
	});

	it("和 pi 一样：没写的 xhigh/max 不可选，没写的 off 可选", () => {
		expect(supportedLevels(true, undefined)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(supportedLevels(false, undefined)).toEqual([]);
	});
});

describe("candidateIds 和 findBuiltin", () => {
	it("去掉前缀、档位、日期和变体后缀", () => {
		expect(candidateIds("codex/gpt-6.1-sol")).toEqual(["codex/gpt-6.1-sol", "gpt-6.1-sol"]);
		expect(candidateIds("gemini-3.8-flash-high")).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash"]);
		expect(candidateIds("claude-sonnet-4-5-20250929")).toEqual(["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"]);
		expect(candidateIds("claude-fable-5-1-reversed")).toEqual(["claude-fable-5-1-reversed", "claude-fable-5-1"]);
	});

	it("先找原厂，再找直营服务商，不用转卖的服务商", () => {
		expect(findBuiltin("claude/claude-opus-5-5", "anthropic")?.provider).toBe("anthropic");
		expect(findBuiltin("workbuddy/deepseek-v9")?.provider).toBe("deepseek");
	});

	it("按 owned_by 和名字判断原厂", () => {
		expect(vendorOf("whatever", "codex")).toBe("openai");
		expect(vendorOf("claude-opus-5-5-high", "antigravity")).toBe("anthropic");
		expect(vendorOf("gemini-3.8-flash-high")).toBe("google");
		expect(vendorOf("grok-4.7")).toBe("xai");
		expect(vendorOf("deepseek-v9")).toBeUndefined();
	});
});

describe("selectApi", () => {
	it("native_endpoints 优先", () => {
		expect(selectApi({ id: "x", ownedBy: "claude", nativeEndpoints: ["/v1/chat/completions"] }, service())).toEqual({
			value: "openai-completions",
			source: "native_endpoints",
		});
	});

	it("再看 owned_by，antigravity 看不出协议，交给名字判断", () => {
		expect(selectApi({ id: "x", ownedBy: "grok" }, service()).value).toBe("openai-responses");
		expect(selectApi({ id: "claude-opus-5-5-high", ownedBy: "antigravity" }, service())).toEqual({
			value: "anthropic-messages",
			source: "name",
		});
		expect(selectApi({ id: "gemini-3.8-flash-high", ownedBy: "antigravity" }, service()).value).toBe("google-generative-ai");
	});

	it("都判断不出时用服务的默认协议", () => {
		expect(selectApi({ id: "deepseek-v9", ownedBy: "custom" }, service())).toEqual({ value: "openai-completions", source: "default" });
		expect(selectApi({ id: "deepseek-v9" }, service({ defaultApi: "anthropic-messages" })).value).toBe("anthropic-messages");
	});

	it("手动设置最优先", () => {
		expect(selectApi({ id: "gpt-x", nativeEndpoints: ["/v1/responses"] }, service(), { api: "anthropic-messages" })).toEqual({
			value: "anthropic-messages",
			source: "manual",
		});
	});
});

describe("resolveModel", () => {
	it("服务端参数优先于 pi 自带目录", () => {
		const model = resolveModel(
			service(),
			{ id: "gpt-6.1-sol", ownedBy: "openai", contextWindow: 500000, maxTokens: 128000, reasoningLevels: ["low", "max", "ultra"] },
			catalog([]),
		);
		expect(model.contextWindow).toEqual({ value: 500000, source: "server" });
		expect(model.name).toEqual({ value: "openai gpt-6.1-sol", source: "pi" });
		expect(model.thinkingLevelMap.source).toBe("server");
		expect(supportedLevels(model.reasoning.value, model.thinkingLevelMap.value)).toEqual(["low", "max"]);
		expect(model.baseUrl.value).toBe("https://gw.test/v1");
	});

	it("服务端没有的参数用 pi 自带目录，再没有就用默认值", () => {
		const fromPi = resolveModel(service(), { id: "claude-opus-5-5", ownedBy: "custom" }, catalog([]));
		expect(fromPi.contextWindow).toEqual({ value: 1000000, source: "pi" });
		expect(fromPi.api.value).toBe("anthropic-messages");
		expect(fromPi.baseUrl.value).toBe("https://gw.test");
		expect(supportedLevels(fromPi.reasoning.value, fromPi.thinkingLevelMap.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);

		const unknown = resolveModel(service(), { id: "mystery" }, catalog([]));
		expect(unknown.contextWindow.source).toBe("default");
		expect(unknown.reasoning).toEqual({ value: false, source: "default" });
		expect(unknown.cost).toEqual({ value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: "default" });
	});

	it("服务端档位列表为空时不支持调节思考，抄来的 compat 去掉思考相关标志", () => {
		const model = resolveModel(service(), { id: "claude-opus-5-5-high", ownedBy: "antigravity", reasoningLevels: [] }, catalog([]));
		expect(model.reasoning).toEqual({ value: false, source: "server" });
		expect(model.thinkingLevelMap.value).toBeUndefined();
		expect(model.compat).toEqual({ value: { supportsStrictTools: true, sendSessionAffinityHeaders: true }, source: "pi" });
	});

	it("订阅类服务上的 GPT 从 openai-codex 抄 compat，价格仍按官方", () => {
		const viaCodexCatalog = resolveModel(service(), { id: "gpt-6.1-sol", ownedBy: "openai" }, catalog([], true));
		expect(viaCodexCatalog.compat).toEqual({ value: { supportsToolSearch: true }, source: "pi" });
		expect(viaCodexCatalog.cost.value.input).toBe(2);

		const viaOwnedBy = resolveModel(service(), { id: "codex/gpt-6.1-sol", ownedBy: "codex" }, catalog([]));
		expect(viaOwnedBy.compat.value).toEqual({ supportsToolSearch: true });

		const official = resolveModel(service(), { id: "gpt-6.1-sol", ownedBy: "custom" }, catalog([]));
		expect(official.compat.value).toEqual({ supportsStrictMode: true, supportsToolSearch: true });
	});

	it("协议和原厂条目不同时不抄 compat", () => {
		const model = resolveModel(
			service({ overrides: { "claude-opus-5-5": { api: "openai-completions" } } }),
			{ id: "claude-opus-5-5" },
			catalog([]),
		);
		expect(model.compat).toEqual({ value: undefined, source: "default" });
	});

	it("手动设置覆盖所有层，思考档位可以设成不支持", () => {
		const model = resolveModel(
			service({
				headers: { "X-Service": "1" },
				overrides: {
					"gpt-6.1-sol": {
						contextWindow: 1000,
						thinkingLevels: [],
						headers: { "anthropic-beta": "context-1m-2025-08-07" },
						baseUrl: "https://other.test/v1",
						cost: cost(7),
					},
				},
			}),
			{ id: "gpt-6.1-sol", contextWindow: 500000, reasoningLevels: ["low"] },
			catalog([]),
		);
		expect(model.contextWindow).toEqual({ value: 1000, source: "manual" });
		expect(model.reasoning).toEqual({ value: false, source: "manual" });
		expect(model.headers).toEqual({ "X-Service": "1", "anthropic-beta": "context-1m-2025-08-07" });
		expect(model.baseUrl).toEqual({ value: "https://other.test/v1", source: "manual" });
		expect(model.cost.source).toBe("manual");
	});

	it("转成 pi 的模型配置", () => {
		const model = resolveModel(service(), { id: "gemini-3.8-flash-high", reasoningLevels: ["low", "high"] }, catalog([]));
		expect(toProviderModel(model)).toMatchObject({
			id: "gemini-3.8-flash-high",
			api: "google-generative-ai",
			baseUrl: "https://gw.test/v1beta",
			contextWindow: 1048576,
			maxTokens: 65536,
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
		});
	});
});

describe("resolveService", () => {
	it("已启用但目录里没有的模型也列出来并标记", () => {
		const models = resolveService(service({ enabled: ["gone"] }), catalog([{ id: "here" }]));
		expect(models.map((model) => [model.id, model.missing])).toEqual([
			["here", false],
			["gone", true],
		]);
	});
});

describe("审查后补充的规则", () => {
	it("按协议去掉 pi 发不出去的档位，off 沿用服务端写法", () => {
		const google = levelsToMap(["low", "high", "xhigh", "max"], "google-generative-ai");
		expect([google.xhigh, google.max]).toEqual([null, null]);
		expect(levelsToMap(["minimal", "low"], "anthropic-messages").minimal).toBeNull();
		expect(levelsToMap(["off", "low"]).off).toBe("off");
		expect(levelsToMap(["none", "low"]).off).toBe("none");
	});

	it("只剩 off 时算作不支持调节思考", () => {
		const model = resolveModel(service(), { id: "x", reasoningLevels: ["none"] }, catalog([]));
		expect(model.reasoning.value).toBe(false);
	});

	it("手动写的不完整 thinkingLevelMap 按 pi 的规则判断", () => {
		const model = resolveModel(service({ overrides: { x: { thinkingLevelMap: { off: null } } } }), { id: "x" }, catalog([]));
		expect(model.reasoning).toEqual({ value: true, source: "manual" });
		expect(supportedLevels(model.reasoning.value, model.thinkingLevelMap.value)).toEqual(["minimal", "low", "medium", "high"]);
	});

	it("手动档位里的 none 或 off 和其他档位一起出现时表示可以关闭思考", () => {
		for (const levels of [["none", "low"], ["off", "low"]]) {
			const model = resolveModel(service({ overrides: { x: { thinkingLevels: levels } } }), { id: "x" }, catalog([]));
			expect(model.thinkingLevelMap.value?.off).toBe("none");
			expect(supportedLevels(model.reasoning.value, model.thinkingLevelMap.value)).toEqual(["off", "low"]);
		}
	});

	it("去掉后缀才匹配上时不借用 pi 自带的名字", () => {
		expect(resolveModel(service(), { id: "claude-opus-5-5-high" }, catalog([])).name).toEqual({ value: "claude-opus-5-5-high", source: "default" });
		expect(resolveModel(service(), { id: "claude/claude-opus-5-5" }, catalog([])).name.source).toBe("pi");
	});

	it("模型名明确是 Claude 时不看 owned_by 判断原厂", () => {
		expect(vendorOf("claude-opus-5-5", "openai")).toBe("anthropic");
		expect(resolveModel(service(), { id: "claude-opus-5-5", ownedBy: "openai" }, catalog([])).cost.value.input).toBe(4);
	});

	it("名字里有独立的 image 一词的模型当作隐藏", () => {
		const models = resolveService(service(), catalog([{ id: "gemini-3.1-flash-image" }, { id: "gpt-image-2" }, { id: "imagen-4" }, { id: "gemini-3.8-flash" }]));
		expect(models.map((model) => model.hidden)).toEqual([true, true, false, false]);
	});

	it("没读过目录时，已启用的模型不标为目录里没有", () => {
		expect(resolveService(service({ enabled: ["a"] }), undefined)[0].missing).toBe(false);
	});
});

describe("会话亲和 compat", () => {
	it("Anthropic 模型在抄来的 compat 上默认开启会话亲和，不修改 pi 自带条目", () => {
		const model = resolveModel(service(), { id: "claude-opus-5-5" }, catalog([]));
		expect(model.compat).toEqual({
			value: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsStrictTools: true, sendSessionAffinityHeaders: true },
			source: "pi",
		});
		expect(toProviderModel(model).compat).toEqual(model.compat.value);
		expect(findBuiltin("claude-opus-5-5", "anthropic")?.compat).toMatchObject({ sendSessionAffinityHeaders: false });
	});

	it("没有 pi 自带 compat 的 Anthropic 模型也默认开启，来源为默认值", () => {
		const model = resolveModel(service(), { id: "custom-model", nativeEndpoints: ["/v1/messages"] }, catalog([]));
		expect(model.compat).toEqual({ value: { sendSessionAffinityHeaders: true }, source: "default" });
		expect(toProviderModel(model).compat).toEqual({ sendSessionAffinityHeaders: true });
	});

	const copied = { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsStrictTools: true };
	it.each([
		{ compat: {}, expected: { ...copied, sendSessionAffinityHeaders: true }, source: "pi" },
		{ compat: { supportsStrictTools: false }, expected: { ...copied, supportsStrictTools: false, sendSessionAffinityHeaders: true }, source: "manual" },
		{ compat: { sendSessionAffinityHeaders: false }, expected: { ...copied, sendSessionAffinityHeaders: false }, source: "manual" },
		{ compat: { sendSessionAffinityHeaders: true }, expected: { ...copied, sendSessionAffinityHeaders: true }, source: "manual" },
		{ compat: { forceAdaptiveThinking: null, supportsMidConvoEffort: null }, expected: { supportsStrictTools: true, sendSessionAffinityHeaders: true }, source: "manual" },
		{ compat: { sendSessionAffinityHeaders: null }, expected: copied, source: "manual" },
	])("手动 compat 逐字段覆盖抄来的设置，null 删掉字段：$compat", ({ compat, expected, source }) => {
		const original = { ...compat };
		const svc = service({ overrides: { "claude-opus-5-5": { compat } } });
		const model = resolveModel(svc, { id: "claude-opus-5-5" }, catalog([]));
		expect(model.compat).toEqual({ value: expected, source });
		expect(toProviderModel(model).compat).toEqual(expected);
		expect(model.compat.value).not.toBe(compat);
		expect(svc.overrides[model.id].compat).toEqual(original);
	});

	it("记录每个 compat 字段的来源", () => {
		const svc = service({ overrides: { "claude-opus-5-5": { compat: { supportsStrictTools: false, forceAdaptiveThinking: null, extra: 1 } } } });
		expect(resolveModel(svc, { id: "claude-opus-5-5" }, catalog([])).compatSources).toEqual({
			supportsMidConvoEffort: "pi",
			supportsStrictTools: "manual",
			sendSessionAffinityHeaders: "default",
			extra: "manual",
		});
	});

	it("删掉全部字段后 compat 为 undefined", () => {
		const svc = service({ overrides: { "claude-opus-5-5": { compat: { sendSessionAffinityHeaders: null } } } });
		const model = resolveModel(svc, { id: "custom-model", nativeEndpoints: ["/v1/messages"] }, catalog([]));
		expect(model.compat).toEqual({ value: { sendSessionAffinityHeaders: true }, source: "default" });
		svc.overrides["custom-model"] = { compat: { sendSessionAffinityHeaders: null } };
		const removed = resolveModel(svc, { id: "custom-model", nativeEndpoints: ["/v1/messages"] }, catalog([]));
		expect(removed.compat).toEqual({ value: undefined, source: "manual" });
		expect(removed.compatSources).toEqual({});
	});

	it.each([
		{ id: "claude-opus-5-5", api: undefined, compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsStrictTools: true, sendSessionAffinityHeaders: false } },
		{ id: "claude-opus-5-5", api: undefined, compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsStrictTools: true } },
		{ id: "claude-opus-5-5-high", api: undefined, compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsStrictTools: true } },
		{ id: "gpt-6.1-sol", api: undefined, compat: { supportsStrictMode: true, supportsToolSearch: true } },
		{ id: "gpt-6.1-sol", api: "openai-completions" as const, compat: { supportsStrictMode: false } },
	])("整份手动 compat（和 pi 自带的一致）合并后结果和整体替换时相同：$id $compat", ({ id, api, compat }) => {
		// 整体替换时的结果：手动 compat 原样使用，Anthropic 协议再补上会话亲和默认值。
		const svc = service({ overrides: { [id]: { api, compat } } });
		const levels = id.endsWith("-high") ? { reasoningLevels: [] } : {};
		const model = resolveModel(svc, { id, ...levels }, catalog([]));
		const wholesale = model.api.value === "anthropic-messages" ? { ...compat, sendSessionAffinityHeaders: compat.sendSessionAffinityHeaders ?? true } : compat;
		expect(model.compat).toEqual({ value: wholesale, source: "manual" });
	});

	it.each(["openai-completions", "openai-responses", "google-generative-ai", "mistral-conversations"] as const)(
		"其他协议 %s 不添加会话亲和设置，手动 compat 保持原样",
		(api) => {
			const svc = service({ defaultApi: api });
			expect(resolveModel(svc, { id: "custom-model" }, catalog([])).compat).toEqual({ value: undefined, source: "default" });
			svc.overrides["custom-model"] = { compat: { supportsStrictMode: false } };
			expect(resolveModel(svc, { id: "custom-model" }, catalog([])).compat).toEqual({ value: { supportsStrictMode: false }, source: "manual" });
		},
	);
});

describe("models.dev 层", () => {
	const dev = (extra: Record<string, unknown> = {}) => ({
		name: "Dev Name",
		limit: { context: 333000, output: 33000 },
		modalities: { input: ["text", "image/png"] },
		capabilities: { reasoning: { supported: true, effort: ["low", "high", "xhigh"] } },
		cost: { text: { input: { price: 3 }, output: { price: 9 } } },
		...extra,
	});

	beforeAll(() =>
		setModelsDevForTest({
			anthropic: { "claude-opus-5-5": dev({ cost: { text: { input: { price: 99 }, output: { price: 99 } } } }), "claude-haiku-5-5": dev() },
			deepseek: { "deepseek-v9": dev() },
			google: { "gemini-9": dev() },
			moonshotai: {
				"kimi-auto": dev({ capabilities: { reasoning: { supported: true } } }),
				"kimi-plain": dev({ capabilities: { reasoning: { supported: false } } }),
				"kimi-none": dev({ capabilities: { reasoning: { supported: true, effort: ["none"] } } }),
			},
			typesafe: { "jev-latest": { type: "decision", name: "Jev Latest", limit: { context: 64000 }, capabilities: { reasoning: { supported: false } } } },
		}),
	);
	afterAll(() => setModelsDevForTest(undefined));

	it("pi 自带目录查不到的值取 models.dev，记下匹配到的条目", () => {
		const model = resolveModel(service(), { id: "claude-haiku-5-5" }, catalog([]));
		expect(model.builtin).toBeUndefined();
		expect(model.modelsDev).toBe("anthropic/claude-haiku-5-5");
		expect(model.modelType).toBe("chat");
		expect(model.name).toEqual({ value: "Dev Name", source: "modelsdev" });
		expect(model.contextWindow).toEqual({ value: 333000, source: "modelsdev" });
		expect(model.maxTokens).toEqual({ value: 33000, source: "modelsdev" });
		expect(model.input).toEqual({ value: ["text", "image"], source: "modelsdev" });
		expect(model.cost).toEqual({ value: { input: 3, output: 9, cacheRead: 0, cacheWrite: 0 }, source: "modelsdev" });
		// Anthropic 协议去掉 minimal，其余按 levelsToMap 转换。
		expect(model.thinkingLevelMap.source).toBe("modelsdev");
		expect(supportedLevels(model.reasoning.value, model.thinkingLevelMap.value)).toEqual(["low", "high", "xhigh"]);
		// compat 不从 models.dev 取。
		expect(model.compat).toEqual({ value: { sendSessionAffinityHeaders: true }, source: "default" });
	});

	it("手动、服务端目录和 pi 自带目录都优先于 models.dev", () => {
		const fromPi = resolveModel(service(), { id: "claude-opus-5-5" }, catalog([]));
		expect(fromPi.contextWindow.source).toBe("pi");
		expect(fromPi.cost).toEqual({ value: cost(4), source: "pi" });
		expect(fromPi.modelsDev).toBe("anthropic/claude-opus-5-5");

		const fromServer = resolveModel(service(), { id: "claude-haiku-5-5", contextWindow: 200000, reasoningLevels: ["high"] }, catalog([]));
		expect(fromServer.contextWindow.source).toBe("server");
		expect(fromServer.reasoning.source).toBe("server");
		expect(fromServer.maxTokens.source).toBe("modelsdev");

		const manual = service({ overrides: { "claude-haiku-5-5": { maxTokens: 1000, cost: cost(1) } } });
		const fromManual = resolveModel(manual, { id: "claude-haiku-5-5" }, catalog([]));
		expect(fromManual.maxTokens.source).toBe("manual");
		expect(fromManual.cost.source).toBe("manual");
	});

	it("pi 自带目录里有、但原厂不明拿不到价格时，价格取 models.dev", () => {
		const model = resolveModel(service(), { id: "deepseek-v9" }, catalog([]));
		expect(model.contextWindow.source).toBe("pi");
		expect(model.cost).toEqual({ value: { input: 3, output: 9, cacheRead: 0, cacheWrite: 0 }, source: "modelsdev" });
	});

	it("名字只在去掉前缀后 id 完全相同时借用", () => {
		expect(resolveModel(service(), { id: "anthropic/claude-haiku-5-5" }, catalog([])).name.source).toBe("modelsdev");
		const suffixed = resolveModel(service(), { id: "claude-haiku-5-5-high" }, catalog([]));
		expect(suffixed.name).toEqual({ value: "claude-haiku-5-5-high", source: "default" });
		expect(suffixed.contextWindow.source).toBe("modelsdev");
	});

	it("思考：只写 supported 时交给 pi 的默认档位，不支持时为 false，只剩 none 时不支持调节", () => {
		const auto = resolveModel(service(), { id: "kimi-auto" }, catalog([]));
		expect(auto.reasoning).toEqual({ value: true, source: "modelsdev" });
		expect(auto.thinkingLevelMap).toEqual({ value: undefined, source: "modelsdev" });
		expect(resolveModel(service(), { id: "kimi-plain" }, catalog([])).reasoning).toEqual({ value: false, source: "modelsdev" });
		const none = resolveModel(service(), { id: "kimi-none" }, catalog([]));
		expect(none.reasoning).toEqual({ value: false, source: "modelsdev" });
		expect(none.thinkingLevelMap.value).toBeUndefined();
	});

	it("档位按最终协议去掉 pi 发不出去的", () => {
		const model = resolveModel(service(), { id: "gemini-9" }, catalog([]));
		expect(model.api.value).toBe("google-generative-ai");
		expect(supportedLevels(model.reasoning.value, model.thinkingLevelMap.value)).toEqual(["low", "high"]);
	});

	it("不是 chat 的模型标为隐藏，不算对话模型", () => {
		const jev = resolveModel(service(), { id: "jev-latest" }, catalog([]));
		expect(jev).toMatchObject({ hidden: true, modelType: "decision", modelsDev: "typesafe/jev-latest" });
		expect(isChatModel(jev)).toBe(false);
		expect(isChatModel(resolveModel(service(), { id: "claude-haiku-5-5" }, catalog([])))).toBe(true);
		const unknown = resolveModel(service(), { id: "mystery" }, catalog([]));
		expect(unknown.modelType).toBeUndefined();
		expect(unknown.modelsDev).toBeUndefined();
		expect(isChatModel(unknown)).toBe(true);
	});
});

describe("Anthropic beta", () => {
	it("上下文超过 200K 的 Anthropic 模型自动申请 1M 上下文", () => {
		expect(resolveModel(service(), { id: "claude-opus-5-5", ownedBy: "anthropic" }, catalog([])).betas).toEqual([LONG_CONTEXT_BETA]);
		const small = service({ overrides: { "claude-opus-5-5": { contextWindow: 200000 } } });
		expect(resolveModel(small, { id: "claude-opus-5-5", ownedBy: "anthropic" }, catalog([])).betas).toEqual([]);
		const kimi = service({ overrides: { "kimi-k3": { api: "anthropic-messages", contextWindow: 256000 } } });
		expect(resolveModel(kimi, { id: "kimi-k3", ownedBy: "moonshot" }, catalog([])).betas).toEqual([]);
	});

	it("请求头里的 anthropic-beta 拆出来合并，其他协议原样保留", () => {
		const svc = service({
			headers: { "anthropic-beta": "a, b", "X-Title": "pi" },
			overrides: { "claude-opus-5-5": { headers: { "Anthropic-Beta": "b,c" } }, "gpt-6.1-sol": { headers: { "anthropic-beta": "a" } } },
		});
		const claude = resolveModel(svc, { id: "claude-opus-5-5", ownedBy: "anthropic", contextWindow: 200000 }, catalog([]));
		expect(claude.headers).toEqual({ "X-Title": "pi" });
		expect(claude.betas).toEqual(["a", "b", "c"]);
		const gpt = resolveModel(svc, { id: "gpt-6.1-sol", ownedBy: "openai" }, catalog([]));
		expect(gpt.headers).toEqual({ "anthropic-beta": "a", "X-Title": "pi" });
		expect(gpt.betas).toEqual([]);
	});
});
