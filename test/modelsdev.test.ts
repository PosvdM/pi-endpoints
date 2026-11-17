import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CHECK_INTERVAL_MS,
	extractModelsDev,
	FETCH_TIMEOUT_MS,
	findModelsDev,
	loadModelsDev,
	MODELS_DEV_URL,
	modelsDevStatus,
	parseModelsDevModel,
	RETRY_AFTER_MS,
	setModelsDevForTest,
	updateModelsDev,
} from "../src/modelsdev.ts";
import { useTempAgentDir } from "./helpers.ts";

/** v2 目录里的一个对话模型，字段按 models.dev 的结构写。 */
const chat = (extra: Record<string, unknown> = {}) => ({
	id: "x",
	type: "chat",
	name: "Model X",
	description: "不需要保存的字段",
	modalities: { input: ["text", "image/png", "application/pdf"], output: ["text"] },
	capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["none", "low", "high"], toggle: true }, temperature: false },
	limit: { context: 400000, input: 272000, output: 64000 },
	cost: {
		text: {
			input: { price: 1.25, cache: { read: 0.125, write: { "5m": 1.5, "1h": 2.5 } }, overrides: [{ when: { context: { gt: 272000 } }, price: 2.5 }] },
			output: { price: 10 },
		},
		web_search: { price: 10 },
	},
	api: { responses: {} },
	...extra,
});

describe("parseModelsDevModel", () => {
	it("按规则映射名称、上下文、最大输出、输入、思考和价格", () => {
		expect(parseModelsDevModel("openai", "gpt-x", chat())).toEqual({
			provider: "openai",
			id: "gpt-x",
			name: "Model X",
			type: "chat",
			contextWindow: 400000,
			maxTokens: 64000,
			input: ["text", "image"],
			reasoning: true,
			effort: ["none", "low", "high"],
			// 不按上下文分档；缓存写入取第一个 TTL 的价格。
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5 },
		});
	});

	it("泛称 image 也算支持图片，没有图片时只有 text，没写输入时留空", () => {
		expect(parseModelsDevModel("p", "a", chat({ modalities: { input: ["text", "image"] } })).input).toEqual(["text", "image"]);
		expect(parseModelsDevModel("p", "a", chat({ modalities: { input: ["text", "audio"] } })).input).toEqual(["text"]);
		expect(parseModelsDevModel("p", "a", chat({ modalities: undefined })).input).toBeUndefined();
	});

	it("没写类型时为 chat，上下文和输出不是正数时留空", () => {
		const model = parseModelsDevModel("p", "a", chat({ type: undefined, limit: { context: 0, output: -1 } }));
		expect(model).toMatchObject({ type: "chat", contextWindow: undefined, maxTokens: undefined });
		expect(parseModelsDevModel("typesafe", "jev-latest", { type: "decision", limit: { context: 64000 } }).type).toBe("decision");
	});

	it("思考：没写 effort 或为空时只记 supported", () => {
		expect(parseModelsDevModel("p", "a", chat({ capabilities: { reasoning: { supported: true } } }))).toMatchObject({ reasoning: true, effort: undefined });
		expect(parseModelsDevModel("p", "a", chat({ capabilities: { reasoning: { supported: false } } }))).toMatchObject({ reasoning: false });
		expect(parseModelsDevModel("p", "a", chat({ capabilities: {} })).reasoning).toBeUndefined();
	});

	it("价格：没有缓存写入时取 explicit.write，缺 input/output 或不按 token 计价时不提供", () => {
		const explicit = { text: { input: { price: 1, cache: { read: 0.5, explicit: { read: 0.25, write: { "5m": 3 } } } }, output: { price: 2 } } };
		expect(parseModelsDevModel("p", "a", chat({ cost: explicit })).cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 });
		expect(parseModelsDevModel("p", "a", chat({ cost: { text: { input: { price: 1 }, output: { price: 2 } } } })).cost).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(parseModelsDevModel("p", "a", chat({ cost: { text: { input: { price: 1 } } } })).cost).toBeUndefined();
		expect(parseModelsDevModel("p", "a", chat({ cost: { text: { input: { price: 1, unit: "character" }, output: { price: 2 } } } })).cost).toBeUndefined();
		expect(parseModelsDevModel("p", "a", chat({ cost: { text: { input: { price: 1, unit: "token" }, output: { price: 2 } } } })).cost?.input).toBe(1);
	});
});

describe("extractModelsDev 和 findModelsDev", () => {
	afterEach(() => setModelsDevForTest(undefined));

	it("只保留名单上的服务商和映射用得到的字段", () => {
		const providers = extractModelsDev({
			openai: { id: "openai", name: "OpenAI", models: { "gpt-x": chat() } },
			openrouter: { id: "openrouter", models: { "gpt-x": chat() } },
		});
		expect(Object.keys(providers)).toEqual(["openai"]);
		expect(providers.openai["gpt-x"]).toEqual({
			name: "Model X",
			type: "chat",
			limit: { context: 400000, output: 64000 },
			modalities: { input: ["text", "image/png", "application/pdf"] },
			capabilities: { reasoning: { supported: true, effort: ["none", "low", "high"] } },
			cost: { text: { input: { price: 1.25, cache: { read: 0.125, write: { "5m": 1.5, "1h": 2.5 } } }, output: { price: 10 } } },
		});
		// 裁剪后的数据映射结果不变。
		expect(parseModelsDevModel("openai", "gpt-x", providers.openai["gpt-x"])).toEqual(parseModelsDevModel("openai", "gpt-x", chat()));
	});

	it("名单上的服务商一个都没有时报错", () => {
		expect(() => extractModelsDev({ openrouter: { models: {} } })).toThrow("没有名单上的服务商");
		expect(() => extractModelsDev([])).toThrow();
	});

	it("先找原厂，再按名单顺序找，不查名单以外的服务商", () => {
		setModelsDevForTest({
			mistral: { shared: chat() },
			deepseek: { shared: chat() },
			openai: { other: chat() },
			xai: { other: chat() },
			openrouter: { only: chat() },
		});
		expect(findModelsDev("shared")?.provider).toBe("deepseek");
		expect(findModelsDev("shared", "anthropic")?.provider).toBe("deepseek");
		expect(findModelsDev("other")?.provider).toBe("openai");
		expect(findModelsDev("other", "xai")?.provider).toBe("xai");
		expect(findModelsDev("only")).toBeUndefined();
	});

	it("用 candidateIds 去掉前缀和后缀匹配", () => {
		setModelsDevForTest({ anthropic: { "claude-haiku-5-5": chat() } });
		expect(findModelsDev("claude/claude-haiku-5-5-20260101", "anthropic")?.id).toBe("claude-haiku-5-5");
		expect(findModelsDev("claude-haiku-5-5-high")?.id).toBe("claude-haiku-5-5");
	});
});

describe("拉取 models.dev", () => {
	let temp: ReturnType<typeof useTempAgentDir>;
	let now: number;
	let requests: Headers[];
	let respond: () => Response | Promise<Response>;

	const v2 = { openai: { id: "openai", models: { "gpt-x": chat() } }, openrouter: { models: { "gpt-x": chat() } } };
	const ok = (etag = '"v1"') => () => new Response(JSON.stringify(v2), { headers: { ETag: etag } });
	const file = () => JSON.parse(readFileSync(join(temp.dir, "endpoints-modelsdev.json"), "utf8"));

	beforeEach(() => {
		temp = useTempAgentDir();
		setModelsDevForTest(undefined);
		now = Date.UTC(2026, 10, 17);
		vi.spyOn(Date, "now").mockImplementation(() => now);
		requests = [];
		respond = ok();
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			expect(url).toBe(MODELS_DEV_URL);
			requests.push(new Headers(init?.headers));
			return respond();
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		setModelsDevForTest(undefined);
		temp.cleanup();
	});

	it("本地没有数据时拉取，保存名单上的服务商、ETag 和时间", async () => {
		expect(await updateModelsDev()).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0].get("if-none-match")).toBeNull();
		expect(file()).toMatchObject({ version: 1, etag: '"v1"', fetchedAt: now, checkedAt: now });
		expect(Object.keys(file().providers)).toEqual(["openai"]);
		expect(findModelsDev("gpt-x")?.contextWindow).toBe(400000);
		expect(modelsDevStatus()).toEqual({ fetchedAt: now, checkedAt: now, error: undefined, fetching: false });
	});

	it("24 小时内不再拉取，之后带 If-None-Match，回 304 时只更新检查时间", async () => {
		await updateModelsDev();
		const fetchedAt = now;
		now += CHECK_INTERVAL_MS - 1;
		expect(await updateModelsDev()).toBe(false);
		expect(requests).toHaveLength(1);

		now += 1;
		respond = () => new Response(null, { status: 304 });
		expect(await updateModelsDev()).toBe(false);
		expect(requests).toHaveLength(2);
		expect(requests[1].get("if-none-match")).toBe('"v1"');
		expect(file()).toMatchObject({ fetchedAt, checkedAt: now, etag: '"v1"' });
		expect(findModelsDev("gpt-x")).toBeDefined();
	});

	it("失败后记录原因，30 分钟内不再试，成功后清掉原因", async () => {
		respond = () => new Response("bad gateway", { status: 502 });
		expect(await updateModelsDev()).toBe(false);
		expect(modelsDevStatus().error).toContain("502");
		expect(existsSync(join(temp.dir, "endpoints-modelsdev.json"))).toBe(false);

		now += RETRY_AFTER_MS - 1;
		await updateModelsDev();
		expect(requests).toHaveLength(1);

		now += 1;
		respond = ok();
		expect(await updateModelsDev()).toBe(true);
		expect(requests).toHaveLength(2);
		expect(modelsDevStatus().error).toBeUndefined();
	});

	it("请求带 60 秒的超时，到时中止并记录原因", async () => {
		// Node 的 AbortSignal.timeout 不走全局计时器，假计时器管不到，这里换成用 setTimeout 实现的同等信号。
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
			return controller.signal;
		});
		let signal: AbortSignal | undefined;
		vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason)));
		});
		try {
			const pending = updateModelsDev();
			// 读文件之后同步发出请求。
			expect(signal).toBeDefined();
			expect(timeout).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);
			await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
			expect(signal?.aborted).toBe(false);
			expect(modelsDevStatus().fetching).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(signal?.aborted).toBe(true);
			expect(await pending).toBe(false);
			expect(modelsDevStatus()).toMatchObject({ fetching: false, error: "models.dev 在 60 秒内没有响应" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("返回内容不是 JSON 时记录原因", async () => {
		respond = () => new Response("<html>");
		await updateModelsDev();
		expect(modelsDevStatus().error).toContain("不是 JSON");
	});

	it("同时只发一个请求，请求期间 fetching 为 true", async () => {
		let release: (response: Response) => void = () => {};
		respond = () => new Promise<Response>((resolve) => (release = resolve));
		const first = updateModelsDev();
		const second = updateModelsDev();
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		expect(modelsDevStatus().fetching).toBe(true);
		release(ok()());
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(requests).toHaveLength(1);
		expect(modelsDevStatus().fetching).toBe(false);
	});

	it("判断前重新读文件：别的 pi 刚拉过时不再请求，用它的数据", async () => {
		await updateModelsDev();
		now += CHECK_INTERVAL_MS + 1;
		// 另一个 pi 进程刚拉到新数据。
		writeFileSync(
			join(temp.dir, "endpoints-modelsdev.json"),
			JSON.stringify({ version: 1, etag: '"v2"', fetchedAt: now, checkedAt: now, providers: { openai: { "gpt-y": chat() } } }),
		);
		expect(await updateModelsDev()).toBe(true);
		expect(requests).toHaveLength(1);
		expect(findModelsDev("gpt-y")).toBeDefined();
		expect(findModelsDev("gpt-x")).toBeUndefined();
	});

	it("别的 pi 只更新了检查时间时不算数据变化", async () => {
		await updateModelsDev();
		now += CHECK_INTERVAL_MS + 1;
		writeFileSync(join(temp.dir, "endpoints-modelsdev.json"), JSON.stringify({ ...file(), checkedAt: now }));
		expect(await updateModelsDev()).toBe(false);
		expect(requests).toHaveLength(1);
	});

	it.each([
		["服务商不是对象", '{"openai":null}'],
		["模型不是对象", '{"openai":{"gpt-x":null}}'],
		["没有服务商", "{}"],
		["服务商里没有模型", '{"openai":{}}'],
	])("文件能解析但结构不对（%s）时当作无效，不带旧 ETag 重新下载", async (_label, providers) => {
		writeFileSync(
			join(temp.dir, "endpoints-modelsdev.json"),
			`{"version":1,"etag":"\\"old\\"","fetchedAt":${now},"checkedAt":${now},"providers":${providers}}`,
		);
		// 带旧 ETag 时服务端会回 304，空数据就恢复不了。
		respond = () => (requests.at(-1)?.get("if-none-match") ? new Response(null, { status: 304 }) : ok()());
		expect(await updateModelsDev()).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0].get("if-none-match")).toBeNull();
		expect(findModelsDev("gpt-x")).toBeDefined();
		expect(file()).toMatchObject({ etag: '"v1"', fetchedAt: now });
	});

	it.each([
		["无穷大", "1e999"],
		["负数", "-1"],
		["字符串", '"1"'],
	])("时间戳是%s时当作无效", async (_label, checkedAt) => {
		writeFileSync(
			join(temp.dir, "endpoints-modelsdev.json"),
			`{"version":1,"etag":"\\"old\\"","fetchedAt":${now},"checkedAt":${checkedAt},"providers":{"openai":{"gpt-x":{}}}}`,
		);
		expect(loadModelsDev()).toBe(false);
		expect(findModelsDev("gpt-x")).toBeUndefined();
		await updateModelsDev();
		expect(requests).toHaveLength(1);
		expect(requests[0].get("if-none-match")).toBeNull();
	});

	it("本进程下载失败后，别的 pi 成功检查过时清掉失败原因和退避", async () => {
		await updateModelsDev();
		now += CHECK_INTERVAL_MS;
		respond = () => new Response("bad gateway", { status: 502 });
		await updateModelsDev();
		expect(modelsDevStatus().error).toContain("502");

		// 读到的还是失败前的文件：保留失败原因，30 分钟内不再试。
		now += 1;
		await updateModelsDev();
		expect(modelsDevStatus().error).toContain("502");
		expect(requests).toHaveLength(2);

		// 另一个 pi 在失败之后检查成功（回了 304），只更新了检查时间。
		writeFileSync(join(temp.dir, "endpoints-modelsdev.json"), JSON.stringify({ ...file(), checkedAt: now }));
		expect(await updateModelsDev()).toBe(false);
		expect(modelsDevStatus().error).toBeUndefined();
		expect(modelsDevStatus().checkedAt).toBe(now);
		expect(requests).toHaveLength(2);
	});

	it("文件损坏或格式版本不对时当作没有，重新拉取且不带 ETag", async () => {
		writeFileSync(join(temp.dir, "endpoints-modelsdev.json"), "{broken");
		expect(loadModelsDev()).toBe(false);
		await updateModelsDev();
		expect(requests[0].get("if-none-match")).toBeNull();

		writeFileSync(join(temp.dir, "endpoints-modelsdev.json"), JSON.stringify({ ...file(), version: 999 }));
		expect(loadModelsDev()).toBe(true);
		expect(findModelsDev("gpt-x")).toBeUndefined();
	});

});
