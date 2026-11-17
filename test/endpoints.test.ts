import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeConfigValue, normalizeRoot } from "../src/config.ts";
import { Endpoints, validateName } from "../src/endpoints.ts";
import { MODELS_DEV_URL, setModelsDevForTest } from "../src/modelsdev.ts";
import { fakePi, useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;

beforeEach(() => {
	temp = useTempAgentDir();
	setModelsDevForTest(undefined);
});

afterEach(() => {
	temp.cleanup();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const catalogResponse = () =>
	vi.stubGlobal("fetch", async (url: string) =>
		new Response(
			JSON.stringify(
				url.includes("client_version")
					? { models: [{ slug: "model-x", context_window: 500000, max_tokens: 128000, supported_reasoning_levels: [{ effort: "low" }] }] }
					: { data: [{ id: "model-x", owned_by: "openai" }, { id: "other", owned_by: "custom" }] },
			),
		),
	);

describe("escapeConfigValue", () => {
	it("转义 $ 和开头的 !，避免被 pi 当成环境变量或命令", () => {
		expect(escapeConfigValue("sk-abc")).toBe("sk-abc");
		expect(escapeConfigValue("a$HOME")).toBe("a$$HOME");
		expect(escapeConfigValue("!rm -rf")).toBe("$!rm -rf");
		expect(escapeConfigValue("$$")).toBe("$$$$");
	});
});

describe("normalizeRoot", () => {
	it("去掉末尾的 / 和 /v1", () => {
		expect(normalizeRoot(" https://x.test/v1/ ")).toBe("https://x.test");
		expect(normalizeRoot("https://x.test/api")).toBe("https://x.test/api");
	});
});

describe("validateName", () => {
	it("拒绝不合规的名字和 pi 自带服务商的名字", () => {
		expect(() => validateName("cpa")).not.toThrow();
		expect(() => validateName("CPA")).toThrow();
		expect(() => validateName("my relay")).toThrow();
		expect(() => validateName("openai")).toThrow(/自带/);
	});
});

describe("Endpoints", () => {
	it("没有密钥或没有启用模型时不注册", () => {
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test/v1", enabled: [], overrides: {} });
		expect(endpoints.service("cpa")?.baseUrl).toBe("https://cpa.test");
		expect(providers.has("cpa")).toBe(false);

		endpoints.setKey("cpa", "sk-1");
		expect(providers.has("cpa")).toBe(false);

		endpoints.setEnabled("cpa", "model-x", true);
		expect(providers.get("cpa")?.models?.map((model) => model.id)).toEqual(["model-x"]);
		expect(providers.get("cpa")?.apiKey).toBe("sk-1");

		endpoints.setEnabled("cpa", "model-x", false);
		expect(providers.has("cpa")).toBe(false);
	});

	it("停用服务时注销，模型选择保留，编辑设置不改变开关", () => {
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: ["model-x"], overrides: {} });
		endpoints.setKey("cpa", "sk-1");
		expect(providers.has("cpa")).toBe(true);

		endpoints.setServiceDisabled("cpa", true);
		expect(providers.has("cpa")).toBe(false);
		expect(endpoints.status()[0].disabled).toBe(true);
		expect(endpoints.service("cpa")?.enabled).toEqual(["model-x"]);

		endpoints.saveService({ name: "cpa", displayName: "CPA", baseUrl: "https://cpa.test" } as never, "cpa");
		expect(endpoints.service("cpa")?.disabled).toBe(true);
		expect(providers.has("cpa")).toBe(false);

		endpoints.setServiceDisabled("cpa", false);
		expect(providers.get("cpa")?.models?.map((model) => model.id)).toEqual(["model-x"]);
		expect(readFileSync(join(temp.dir, "endpoints.json"), "utf8")).not.toContain("disabled");
	});

	it("密钥单独存放，配置文件里没有密钥", () => {
		const { pi } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: [], overrides: {} });
		endpoints.setKey("cpa", "sk-secret");
		expect(readFileSync(join(temp.dir, "endpoints.json"), "utf8")).not.toContain("sk-secret");
		expect(JSON.parse(readFileSync(join(temp.dir, "endpoints-auth.json"), "utf8"))).toEqual({ cpa: { apiKey: "sk-secret" } });
		if (process.platform !== "win32") expect(statSync(join(temp.dir, "endpoints-auth.json")).mode & 0o777).toBe(0o600);
	});

	it("设置了环境变量时优先用它，交给 pi 的是 ${NAME}", () => {
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", apiKeyEnv: "CPA_KEY", enabled: ["m"], overrides: {} });
		endpoints.setKey("cpa", "from-file");
		expect(providers.get("cpa")?.apiKey).toBe("from-file");

		vi.stubEnv("CPA_KEY", "from-env");
		endpoints.registerAll();
		expect(endpoints.keySource("cpa")).toBe("env");
		expect(providers.get("cpa")?.apiKey).toBe("${CPA_KEY}");
	});

	it("刷新目录后写缓存，重启后从缓存注册", async () => {
		catalogResponse();
		const first = fakePi();
		const endpoints = new Endpoints(first.pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: ["model-x"], overrides: {} });
		endpoints.setKey("cpa", "sk-1");
		await endpoints.refresh("cpa");
		endpoints.register("cpa");
		expect(first.providers.get("cpa")?.models?.[0]).toMatchObject({ id: "model-x", contextWindow: 500000 });

		vi.unstubAllGlobals();
		const second = fakePi();
		new Endpoints(second.pi).registerAll();
		expect(second.providers.get("cpa")?.models?.[0]).toMatchObject({ id: "model-x", contextWindow: 500000 });
	});

	it("刷新失败时保留旧缓存并记录原因", async () => {
		catalogResponse();
		const { pi } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: [], overrides: {} });
		endpoints.setKey("cpa", "sk-1");
		await endpoints.refresh("cpa");
		vi.stubGlobal("fetch", async () => new Response("当前分组上游负载已饱和", { status: 503 }));
		await expect(endpoints.refresh("cpa")).rejects.toThrow();
		expect(endpoints.catalog("cpa")?.models).toHaveLength(2);
		expect(endpoints.status()[0].error).toContain("当前分组上游负载已饱和");
	});

	it("refreshModels 返回最新的启用模型", async () => {
		catalogResponse();
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: ["model-x"], overrides: {} });
		endpoints.setKey("cpa", "sk-1");
		const refresh = providers.get("cpa")?.refreshModels;
		const offline = await refresh?.({ allowNetwork: false, signal: new AbortController().signal } as never);
		expect(offline?.[0]).toMatchObject({ id: "model-x", contextWindow: 128000 });
		const online = await refresh?.({ allowNetwork: true, signal: new AbortController().signal } as never);
		expect(online?.[0]).toMatchObject({ id: "model-x", contextWindow: 500000 });
	});

	it("改名时带上密钥和缓存，删除时一并清掉", () => {
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "a", baseUrl: "https://a.test", enabled: ["m"], overrides: {} });
		endpoints.setKey("a", "sk-1");
		endpoints.saveService({ name: "b", baseUrl: "https://a.test" } as never, "a");
		expect(endpoints.service("b")?.enabled).toEqual(["m"]);
		expect(endpoints.apiKey("b")).toBe("sk-1");
		expect(providers.has("a")).toBe(false);
		expect(providers.has("b")).toBe(true);

		endpoints.removeService("b");
		expect(providers.has("b")).toBe(false);
		expect(JSON.parse(readFileSync(join(temp.dir, "endpoints-auth.json"), "utf8"))).toEqual({});
	});

	it("拒绝重名和非 http 地址", () => {
		const { pi } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} });
		expect(() => endpoints.saveService({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} })).toThrow(/已经有/);
		expect(() => endpoints.saveService({ name: "c", baseUrl: "ftp://a.test", enabled: [], overrides: {} })).toThrow(/http/);
	});

	it("缓存文件损坏时当作没有缓存", () => {
		writeFileSync(join(temp.dir, "endpoints-cache.json"), "{oops");
		const { pi } = fakePi();
		expect(() => new Endpoints(pi)).not.toThrow();
	});
});

describe("Endpoints 的校验和并发", () => {
	it("交给 pi 的请求头按字面值转义，非字符串的值被拒绝", () => {
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "a", baseUrl: "https://a.test", headers: { "X-Token": "!echo hi", "X-Price": "$5" }, enabled: ["m"], overrides: {} });
		endpoints.setKey("a", "k");
		expect(providers.get("a")?.models?.[0].headers).toEqual({ "X-Token": "$!echo hi", "X-Price": "$$5" });
		expect(() => endpoints.saveService({ name: "b", baseUrl: "https://b.test", headers: { X: 1 } as never, enabled: [], overrides: {} })).toThrow(/字符串/);
	});

	it("校验环境变量名、协议和手动设置", () => {
		const { pi } = fakePi();
		const endpoints = new Endpoints(pi);
		expect(() => endpoints.saveService({ name: "a", baseUrl: "https://a.test", apiKeyEnv: "$KEY", enabled: [], overrides: {} })).toThrow(/环境变量/);
		expect(() => endpoints.saveService({ name: "a", baseUrl: "https://a.test", defaultApi: "nope", enabled: [], overrides: {} })).toThrow(/协议/);
		endpoints.saveService({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} });
		expect(() => endpoints.setOverride("a", "m", { contextWindow: -1 })).toThrow(/上下文/);
		expect(() => endpoints.setOverride("a", "m", { api: "nope" })).toThrow(/协议/);
		expect(() => endpoints.setOverride("a", "m", { thinkingLevels: ["ultra"] })).toThrow(/思考档位/);
		expect(() => endpoints.setOverride("a", "m", { cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } })).toThrow(/价格/);
		expect(() => endpoints.setOverride("a", "m", { compat: [] as never })).toThrow(/compat/);
		// compat 的字段值为 null 表示删掉抄来的字段，原样保存。
		endpoints.setOverride("a", "m", { compat: { supportsStrictTools: null } });
		expect(endpoints.service("a")?.overrides.m.compat).toEqual({ supportsStrictTools: null });
	});

	it("刷新期间删除服务时不写回过期目录", async () => {
		let release: (value: Response) => void = () => {};
		vi.stubGlobal("fetch", (url: string) =>
			url.includes("client_version") ? Promise.resolve(new Response("{}")) : new Promise<Response>((resolve) => (release = resolve)),
		);
		const { pi } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} });
		endpoints.setKey("a", "k");
		const pending = endpoints.refresh("a");
		await new Promise((resolve) => setTimeout(resolve, 0));
		endpoints.removeService("a");
		release(new Response(JSON.stringify({ data: [{ id: "m" }] })));
		await pending;
		const cacheFile = join(temp.dir, "endpoints-cache.json");
		expect(existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {}).toEqual({});
	});

	it("改名时带走错误记录", async () => {
		vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
		const { pi } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} });
		endpoints.setKey("a", "k");
		await expect(endpoints.refresh("a")).rejects.toThrow();
		endpoints.saveService({ name: "b", baseUrl: "https://a.test", enabled: [], overrides: {} }, "a");
		endpoints.saveService({ name: "a", baseUrl: "https://new.test", enabled: [], overrides: {} });
		expect(endpoints.status().find((status) => status.name === "a")?.error).toBeUndefined();
		expect(endpoints.status().find((status) => status.name === "b")?.error).toContain("down");
	});

	it("另一个 pi 进程的修改不会被覆盖", () => {
		const first = new Endpoints(fakePi().pi);
		const second = new Endpoints(fakePi().pi);
		first.saveService({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} });
		second.saveService({ name: "b", baseUrl: "https://b.test", enabled: [], overrides: {} });
		first.setEnabled("a", "m", true);
		const saved = JSON.parse(readFileSync(join(temp.dir, "endpoints.json"), "utf8"));
		expect(saved.services.map((service: { name: string }) => service.name)).toEqual(["a", "b"]);
	});

	it("配置文件损坏时照常加载，拒绝修改并保留原文件", () => {
		writeFileSync(join(temp.dir, "endpoints.json"), "{broken");
		const endpoints = new Endpoints(fakePi().pi);
		expect(endpoints.loadError).toContain("endpoints.json");
		expect(() => endpoints.saveService({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} })).toThrow(/reload/);
		expect(readFileSync(join(temp.dir, "endpoints.json"), "utf8")).toBe("{broken");
	});

	it("手工写坏的服务不注册，并记录原因", () => {
		writeFileSync(
			join(temp.dir, "endpoints.json"),
			JSON.stringify({ services: [{ name: "openai", baseUrl: "https://x.test", enabled: ["m"] }, { name: "nourl", enabled: ["m"] }] }),
		);
		writeFileSync(join(temp.dir, "endpoints-auth.json"), JSON.stringify({ openai: { apiKey: "k" }, nourl: { apiKey: "k" } }));
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.registerAll();
		expect(providers.size).toBe(0);
		expect(endpoints.status().map((status) => status.error)).toEqual([expect.stringContaining("自带"), expect.stringContaining("地址")]);
	});
});

describe("Anthropic 会话亲和请求头", () => {
	it.each([
		{ affinity: undefined, sessionId: "pi-session", expected: "pi-session" },
		{ affinity: false, sessionId: "pi-session", expected: null },
		{ affinity: true, sessionId: "pi-session", expected: "pi-session" },
		{ affinity: undefined, sessionId: undefined, expected: null },
	])("按 compat 和会话 ID 发送 x-session-affinity：$affinity / $sessionId", async ({ affinity, sessionId, expected }) => {
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({
			name: "cpa",
			baseUrl: "https://cpa.test",
			enabled: ["claude-custom"],
			overrides: affinity === undefined ? {} : { "claude-custom": { compat: { sendSessionAffinityHeaders: affinity } } },
		});
		endpoints.setKey("cpa", "k");
		const provider = providers.get("cpa");
		const config = provider?.models?.[0];
		expect(config).toMatchObject({ compat: { sendSessionAffinityHeaders: affinity ?? true } });

		let sent: Headers | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			sent = new Headers(init.headers);
			return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), { status: 400 });
		});
		const model = { ...config, provider: "cpa" } as never;
		const stream = provider?.streamSimple?.(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
			{ apiKey: "k", sessionId },
		);
		await stream?.result();
		expect(sent).toBeDefined();
		expect(sent?.get("x-session-affinity")).toBe(expected);
		expect(sent?.get("x-session-id")).toBeNull();
	});
});

describe("Anthropic beta", () => {
	it("请求头里的 anthropic-beta 和 1M 上下文 beta 追加到 pi 自己的 beta 列表", async () => {
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({
			name: "a",
			baseUrl: "https://a.test",
			headers: { "anthropic-beta": "x-test-beta", "X-Title": "pi" },
			enabled: ["claude-opus-5-5"],
			overrides: {},
		});
		endpoints.setKey("a", "k");
		const provider = providers.get("a");
		const config = provider?.models?.[0];
		expect(config?.headers).toEqual({ "X-Title": "pi" });

		let sent: Headers | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			sent = new Headers(init.headers);
			return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), { status: 400 });
		});
		const model = { ...config, provider: "a" } as never;
		const stream = provider?.streamSimple?.(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, { apiKey: "k" });
		await stream?.result();
		const betas = sent?.get("anthropic-beta")?.split(",") ?? [];
		expect(betas).toContain("x-test-beta");
		expect(betas).toContain("context-1m-2025-08-07");
		// pi 自己算出的 beta 仍在
		expect(betas.length).toBeGreaterThan(2);
		expect(sent?.get("x-title")).toBe("pi");
	});
});

describe("models.dev", () => {
	const devModels = {
		moonshotai: {
			"dev-chat-9": {
				name: "Dev Chat",
				limit: { context: 777000, output: 7000 },
				capabilities: { reasoning: { supported: false } },
				cost: { text: { input: { price: 1 }, output: { price: 2 } } },
			},
		},
		typesafe: { "jev-test-1": { type: "decision", limit: { context: 64000 } } },
	};
	const v2 = Object.fromEntries(Object.entries(devModels).map(([provider, models]) => [provider, { id: provider, models }]));

	/** 服务目录里有 dev-chat-9 和 jev-test-1，models.dev 按 `modelsDev` 返回。返回请求过的地址。 */
	function stubNetwork(modelsDev: () => Response = () => new Response(JSON.stringify(v2), { headers: { ETag: '"e"' } })) {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			if (url === MODELS_DEV_URL) return modelsDev();
			return new Response(
				JSON.stringify(url.includes("client_version") ? { data: [] } : { data: [{ id: "dev-chat-9", owned_by: "custom" }, { id: "jev-test-1", owned_by: "custom" }] }),
			);
		});
		return urls;
	}

	/** 和 pi 一样：注册服务商后以 allowNetwork: false 调用 refreshModels。 */
	function reentrantPi() {
		const fake = fakePi();
		let registrations = 0;
		const register = fake.pi.registerProvider;
		fake.pi.registerProvider = ((name: string, config: Parameters<typeof register>[1]) => {
			registrations++;
			register(name, config);
			void config.refreshModels?.({ allowNetwork: false, signal: new AbortController().signal } as never);
		}) as typeof register;
		return { ...fake, registrations: () => registrations };
	}

	const writeModelsDev = () =>
		writeFileSync(
			join(temp.dir, "endpoints-modelsdev.json"),
			JSON.stringify({ version: 1, fetchedAt: Date.now(), checkedAt: Date.now(), providers: devModels }),
		);

	it("启动时读本地文件，不访问网络", () => {
		writeModelsDev();
		const urls = stubNetwork();
		const { pi, providers } = fakePi();
		const setup = new Endpoints(pi);
		setup.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: ["dev-chat-9"], overrides: {} });
		setup.setKey("cpa", "k");
		new Endpoints(pi).registerAll();
		expect(providers.get("cpa")?.models?.[0]).toMatchObject({ contextWindow: 777000, maxTokens: 7000, reasoning: false });
		expect(urls).toEqual([]);
	});

	it("refreshModels 刷新目录后在后台拉 models.dev，拿到新数据后重新注册，不会循环", async () => {
		const urls = stubNetwork();
		const { pi, providers, registrations } = reentrantPi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: ["dev-chat-9"], overrides: {} });
		endpoints.setKey("cpa", "k");
		const refresh = () => providers.get("cpa")?.refreshModels?.({ allowNetwork: true, signal: new AbortController().signal } as never);

		const first = await refresh();
		expect(first?.[0]).toMatchObject({ contextWindow: 128000 });
		const before = registrations();
		await endpoints.updateModelsDev();
		expect(urls.filter((url) => url === MODELS_DEV_URL)).toHaveLength(1);
		expect(providers.get("cpa")?.models?.[0]).toMatchObject({ contextWindow: 777000, cost: { input: 1, output: 2 } });
		expect(registrations()).toBe(before + 1);

		// 24 小时内再次刷新不再请求 models.dev。
		await refresh();
		await endpoints.updateModelsDev();
		expect(urls.filter((url) => url === MODELS_DEV_URL)).toHaveLength(1);
	});

	it("allowNetwork 为 false 时不访问网络", async () => {
		const urls = stubNetwork();
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: ["dev-chat-9"], overrides: {} });
		endpoints.setKey("cpa", "k");
		await providers.get("cpa")?.refreshModels?.({ allowNetwork: false, signal: new AbortController().signal } as never);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(urls).toEqual([]);
		expect(endpoints.needsModelsDev()).toBe(true);
	});

	it("只在没停用、有密钥的服务里有模型用到 models.dev 或默认值时才需要", () => {
		const endpoints = new Endpoints(fakePi().pi);
		expect(endpoints.needsModelsDev()).toBe(false);
		endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled: ["m"], overrides: {} });
		expect(endpoints.needsModelsDev()).toBe(false);
		endpoints.setKey("cpa", "k");
		expect(endpoints.needsModelsDev()).toBe(true);
		endpoints.setServiceDisabled("cpa", true);
		expect(endpoints.needsModelsDev()).toBe(false);
		endpoints.setServiceDisabled("cpa", false);
		endpoints.setOverride("cpa", "m", {
			contextWindow: 1000,
			maxTokens: 100,
			input: ["text"],
			thinkingLevels: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(endpoints.needsModelsDev()).toBe(false);
	});

	it("不需要时不拉取", async () => {
		const urls = stubNetwork();
		const endpoints = new Endpoints(fakePi().pi);
		await endpoints.updateModelsDev();
		expect(urls).toEqual([]);
	});

	it("不是对话模型的不注册，不能启用，已启用的可以停用", () => {
		writeModelsDev();
		writeFileSync(
			join(temp.dir, "endpoints.json"),
			JSON.stringify({ services: [{ name: "cpa", baseUrl: "https://cpa.test", enabled: ["jev-test-1", "dev-chat-9"] }] }),
		);
		writeFileSync(join(temp.dir, "endpoints-auth.json"), JSON.stringify({ cpa: { apiKey: "k" } }));
		const { pi, providers } = fakePi();
		const endpoints = new Endpoints(pi);
		endpoints.registerAll();
		expect(providers.get("cpa")?.models?.map((model) => model.id)).toEqual(["dev-chat-9"]);
		expect(endpoints.models("cpa").find((model) => model.id === "jev-test-1")).toMatchObject({ hidden: true, modelType: "decision" });

		expect(() => endpoints.setEnabled("cpa", "jev-test-1", true)).toThrow("jev-test-1 是分类模型，pi 不能拿它对话");
		endpoints.setEnabled("cpa", "jev-test-1", false);
		expect(endpoints.service("cpa")?.enabled).toEqual(["dev-chat-9"]);
	});

	it("只启用了非对话模型时不注册服务", () => {
		writeModelsDev();
		writeFileSync(join(temp.dir, "endpoints.json"), JSON.stringify({ services: [{ name: "cpa", baseUrl: "https://cpa.test", enabled: ["jev-test-1"] }] }));
		writeFileSync(join(temp.dir, "endpoints-auth.json"), JSON.stringify({ cpa: { apiKey: "k" } }));
		const { pi, providers } = fakePi();
		new Endpoints(pi).registerAll();
		expect(providers.has("cpa")).toBe(false);
	});
});
