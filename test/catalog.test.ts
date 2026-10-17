import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCatalog, mergeCatalogs, parseCodexModels, parseOpenAIModels } from "../src/catalog.ts";

describe("parseOpenAIModels", () => {
	it("读普通 OpenAI 格式，只有 id 和 owned_by", () => {
		const models = parseOpenAIModels({
			object: "list",
			data: [{ id: "gpt-6-astra", object: "model", owned_by: "custom", permission: [], root: "gpt-6-astra", parent: null }],
		});
		expect(models).toEqual([{ id: "gpt-6-astra", ownedBy: "custom" }]);
	});

	it("读 Magpie 这类扩展字段，丢掉 pi 不认的输入类型", () => {
		const [model] = parseOpenAIModels({
			data: [
				{
					id: "claude/claude-opus-5-5",
					owned_by: "claude",
					display_name: "Claude Opus 5.5",
					context_window: 400000,
					max_output_tokens: 128000,
					modalities: { input: ["text", "image", "pdf"] },
					supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
					native_endpoints: ["/v1/messages"],
				},
			],
		});
		expect(model).toEqual({
			id: "claude/claude-opus-5-5",
			ownedBy: "claude",
			name: "Claude Opus 5.5",
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
			reasoningLevels: ["low", "max"],
			nativeEndpoints: ["/v1/messages"],
		});
	});

	it("不是 OpenAI 格式时报错", () => {
		expect(() => parseOpenAIModels({ models: [] })).toThrow(/data/);
	});
});

describe("parseCodexModels", () => {
	it("读 Codex 格式，标出隐藏模型，空档位列表保留为空数组", () => {
		const models = parseCodexModels({
			models: [
				{
					slug: "gpt-6.1-sol",
					display_name: "GPT 6.1 Sol",
					context_window: 500000,
					max_context_window: 872000,
					max_tokens: 128000,
					input_modalities: ["text", "image"],
					supported_reasoning_levels: [{ effort: "low", description: "" }, { effort: "ultra" }],
					visibility: "list",
				},
				{ slug: "codex-auto-review", visibility: "hide", supported_reasoning_levels: [] },
			],
		});
		expect(models).toEqual([
			{
				id: "gpt-6.1-sol",
				name: "GPT 6.1 Sol",
				contextWindow: 500000,
				maxTokens: 128000,
				input: ["text", "image"],
				reasoningLevels: ["low", "ultra"],
			},
			{ id: "codex-auto-review", reasoningLevels: [], hidden: true },
		]);
	});

	it("不是 Codex 格式时返回 undefined", () => {
		expect(parseCodexModels({ data: [] })).toBeUndefined();
	});
});

describe("mergeCatalogs", () => {
	it("以普通目录为准，按 id 补上 Codex 参数，保留 owned_by", () => {
		const merged = mergeCatalogs(
			[{ id: "gpt-6.1-sol", ownedBy: "openai" }, { id: "only-plain", ownedBy: "x" }],
			[{ id: "gpt-6.1-sol", contextWindow: 500000 }, { id: "only-codex", maxTokens: 1 }],
		);
		expect(merged).toEqual([
			{ id: "gpt-6.1-sol", ownedBy: "openai", contextWindow: 500000 },
			{ id: "only-plain", ownedBy: "x" },
			{ id: "only-codex", maxTokens: 1 },
		]);
	});
});

describe("fetchCatalog", () => {
	afterEach(() => vi.unstubAllGlobals());

	const respond = (status: number, body: unknown) =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

	it("Codex 请求失败时只用普通目录", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push(url);
			expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
			return url.includes("client_version") ? respond(400, "bad") : respond(200, { data: [{ id: "m", owned_by: "o" }] });
		});
		const catalog = await fetchCatalog("https://x.test", "k");
		expect(calls).toEqual(["https://x.test/v1/models", "https://x.test/v1/models?client_version=pi"]);
		expect(catalog.codex).toBe(false);
		expect(catalog.models).toEqual([{ id: "m", ownedBy: "o" }]);
	});

	it("拿到 Codex 格式时合并并标记 codex", async () => {
		vi.stubGlobal("fetch", async (url: string) =>
			url.includes("client_version")
				? respond(200, { models: [{ slug: "m", context_window: 10 }] })
				: respond(200, { data: [{ id: "m", owned_by: "openai" }] }),
		);
		const catalog = await fetchCatalog("https://x.test", "k");
		expect(catalog.codex).toBe(true);
		expect(catalog.models).toEqual([{ id: "m", ownedBy: "openai", contextWindow: 10 }]);
	});

	it("普通目录失败时报错并带上服务端原文", async () => {
		vi.stubGlobal("fetch", async () => respond(401, '{"error":"Invalid API key"}'));
		await expect(fetchCatalog("https://x.test", "k")).rejects.toMatchObject({
			status: 401,
			body: '{"error":"Invalid API key"}',
		});
	});
});
