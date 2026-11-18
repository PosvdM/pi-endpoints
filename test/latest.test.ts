import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Endpoints } from "../src/endpoints.ts";
import { loadModelsDev, MODELS_DEV_URL, setModelsDevForTest } from "../src/modelsdev.ts";
import { useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;

const devModels = { typesafe: { "jev-test-2": { type: "decision" } } };
const writeModelsDev = () =>
	writeFileSync(
		join(temp.dir, "endpoints-modelsdev.json"),
		JSON.stringify({ version: 1, fetchedAt: Date.now(), checkedAt: Date.now(), providers: devModels }),
	);

/** 为真时 models.dev 返回 503。 */
let modelsDevDown = false;

beforeEach(() => {
	modelsDevDown = false;
	temp = useTempAgentDir();
	setModelsDevForTest(undefined);
	// 默认 models.dev 数据已经就绪；冷缓存的用例自己删掉这个文件。
	writeModelsDev();
});

afterEach(() => {
	temp.cleanup();
	vi.unstubAllGlobals();
});

const configFile = () => join(temp.dir, "endpoints.json");
const settingsFile = () => join(temp.dir, "settings.json");
const readConfig = () => JSON.parse(readFileSync(configFile(), "utf8"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

type Catalogs = Record<string, { ids: string[]; hidden?: string[]; gate?: Promise<void> }>;

/** 按主机名返回目录，`gate` 没放行前挂起请求（会响应 abort）。models.dev 返回 `devModels`。 */
function stubNetwork(catalogs: Catalogs) {
	vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
		if (url === MODELS_DEV_URL) {
			if (modelsDevDown) return Promise.resolve(new Response("down", { status: 503 }));
			const v2 = Object.fromEntries(Object.entries(devModels).map(([provider, models]) => [provider, { id: provider, models }]));
			return Promise.resolve(new Response(JSON.stringify(v2)));
		}
		const entry = catalogs[new URL(url).hostname];
		if (!entry) return Promise.resolve(new Response("not found", { status: 404 }));
		const body = url.includes("client_version")
			? { models: entry.ids.map((slug) => ({ slug, visibility: entry.hidden?.includes(slug) ? "hide" : "list" })) }
			: { data: entry.ids.map((id) => ({ id, owned_by: "openai" })) };
		return new Promise<Response>((resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			void (entry.gate ?? Promise.resolve()).then(() => resolve(new Response(JSON.stringify(body))));
		});
	});
}

/**
 * 模仿 pi 1.3 的模型运行时：每个服务商的刷新带一个代号，开始新的刷新时取消同一服务商进行中的刷新；
 * 注册或注销服务商会让所有服务商做一次离线刷新。被取消的刷新不发布结果。
 */
function fakeRuntime() {
	const providers = new Map<string, ProviderConfig>();
	const controllers = new Map<string, AbortController>();
	const published = new Map<string, string[]>();
	let registrations = 0;
	let failRegister = false;
	async function refreshOne(name: string, allowNetwork: boolean): Promise<"published" | "superseded" | "failed"> {
		controllers.get(name)?.abort();
		const controller = new AbortController();
		controllers.set(name, controller);
		try {
			const models = await providers.get(name)?.refreshModels?.({ allowNetwork, signal: controller.signal } as never);
			if (controller.signal.aborted) return "superseded";
			published.set(name, (models ?? []).map((model) => model.id));
			return "published";
		} catch {
			return controller.signal.aborted ? "superseded" : "failed";
		}
	}
	const offlineAll = () => {
		for (const name of providers.keys()) void refreshOne(name, false);
	};
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => {
			if (failRegister) throw new Error("注册被拒绝");
			registrations++;
			providers.set(name, config);
			offlineAll();
		},
		unregisterProvider: (name: string) => {
			if (failRegister) throw new Error("注销被拒绝");
			providers.delete(name);
			offlineAll();
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		providers,
		published,
		registrations: () => registrations,
		failRegistration: (fail: boolean) => {
			failRegister = fail;
		},
		/** 像 pi 启动后那样，同一批联网刷新所有服务商。 */
		refreshAll: (names: string[]) => Promise.all(names.map((name) => refreshOne(name, true))),
	};
}

/** 建一个有密钥、已读过目录的服务 cpa。 */
async function setup(enabled: string[], ids: string[], options: { on?: boolean; preset?: boolean; hidden?: string[] } = {}) {
	const catalogs: Catalogs = { "cpa.test": { ids, hidden: options.hidden } };
	stubNetwork(catalogs);
	const runtime = fakeRuntime();
	const endpoints = new Endpoints(runtime.pi);
	// preset：配置里直接写上开关，不经过 setLatestPerFamily()，也就不会先拉 models.dev。
	endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled, overrides: {}, latestPerFamily: options.preset || undefined });
	endpoints.setKey("cpa", "k");
	await endpoints.refresh("cpa");
	if (options.on) await endpoints.setLatestPerFamily("cpa", true);
	return { ...runtime, endpoints, catalogs, refreshModels: () => runtime.refreshAll(["cpa"]) };
}

describe("每系最新", () => {
	it("开启时立即按缓存的目录调整，开关和启用列表一起保存、只注册一次，保留旧 id 的手动设置", async () => {
		const { endpoints, providers, registrations } = await setup(["gpt-6.1-sol", "other"], ["gpt-6.1-sol", "gpt-6.2-sol", "other"]);
		endpoints.setOverride("cpa", "gpt-6.1-sol", { contextWindow: 1000 });
		expect(readConfig().services[0].latestPerFamily).toBeUndefined();

		const before = registrations();
		await endpoints.setLatestPerFamily("cpa", true);
		expect(registrations()).toBe(before + 1);
		const saved = readConfig().services[0];
		expect(saved).toMatchObject({ latestPerFamily: true, enabled: ["gpt-6.2-sol", "other"], overrides: { "gpt-6.1-sol": { contextWindow: 1000 } } });
		expect(saved.overrides["gpt-6.2-sol"]).toBeUndefined();
		expect(providers.get("cpa")?.models?.map((model) => model.id)).toEqual(["gpt-6.2-sol", "other"]);

		// 编辑服务设置时沿用原值。
		endpoints.saveService({ name: "cpa", displayName: "CPA", baseUrl: "https://cpa.test" } as never, "cpa");
		expect(readConfig().services[0].latestPerFamily).toBe(true);

		await endpoints.setLatestPerFamily("cpa", false);
		expect(readFileSync(configFile(), "utf8")).not.toContain("latestPerFamily");
	});

	it("没开启时刷新目录不调整", async () => {
		const { endpoints, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
		await refreshModels();
		await endpoints.refreshForPage("cpa");
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("pi 联网刷新时的迁移只改磁盘：内存和返回给 pi 的列表不变，不注册，提示用户", async () => {
		const { endpoints, catalogs, published, registrations, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		writeFileSync(settingsFile(), JSON.stringify({ defaultProvider: "cpa", defaultModel: "gpt-6.1-sol", enabledModels: ["cpa/gpt-6.1-sol"] }));
		catalogs["cpa.test"].ids = ["gpt-6.2-sol"];
		const notes: string[] = [];
		endpoints.notify = (message) => notes.push(message) > 0;
		const before = registrations();
		expect(await refreshModels()).toEqual(["published"]);
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.2-sol"]);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ defaultProvider: "cpa", defaultModel: "gpt-6.2-sol", enabledModels: ["cpa/gpt-6.2-sol"] });
		expect(endpoints.service("cpa")?.enabled).toEqual(["gpt-6.1-sol"]);
		expect(published.get("cpa")).toEqual(["gpt-6.1-sol"]);
		await tick();
		expect(registrations()).toBe(before);
		expect(notes).toEqual(["cpa：gpt-6.1-sol → gpt-6.2-sol 已写入配置，新会话生效，当前 pi 用 /reload"]);

		// 本进程之后经过 beginChange() 的修改读到新配置。
		endpoints.setOverride("cpa", "gpt-6.2-sol", { contextWindow: 1000 });
		expect(endpoints.service("cpa")?.enabled).toEqual(["gpt-6.2-sol"]);
	});

	it("联网刷新的迁移写盘后，同一实例的管理页刷新读到新启用列表并只注册一次", async () => {
		const { endpoints, catalogs, providers, registrations, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		catalogs["cpa.test"].ids = ["gpt-6.2-sol"];
		await refreshModels();
		expect(endpoints.service("cpa")?.enabled).toEqual(["gpt-6.1-sol"]);
		const before = registrations();
		expect(await endpoints.refreshForPage("cpa")).toBeUndefined();
		expect(endpoints.service("cpa")?.enabled).toEqual(["gpt-6.2-sol"]);
		expect(endpoints.status()[0].missing).toEqual([]);
		expect(registrations()).toBe(before + 1);
		expect(providers.get("cpa")?.models?.map((model) => model.id)).toEqual(["gpt-6.2-sol"]);
	});

	it("管理页刷新载入别的 pi 改过的配置后全量注册：目录失败时，其他服务的地址、密钥和请求头也是新的", async () => {
		const catalogs: Catalogs = { "b.test": { ids: ["n-1"] }, "b2.test": { ids: ["n-1"] } };
		stubNetwork(catalogs);
		const runtime = fakeRuntime();
		const endpoints = new Endpoints(runtime.pi);
		for (const name of ["a", "b"]) {
			endpoints.saveService({ name, baseUrl: `https://${name}.test`, enabled: [name === "a" ? "m-1" : "n-1"], overrides: {}, headers: { "x-test": "old" } });
			endpoints.setKey(name, "k");
		}
		const other = new Endpoints(fakeRuntime().pi);
		other.saveService({ name: "b", baseUrl: "https://b2.test", enabled: ["n-1"], overrides: {}, headers: { "x-test": "new" } } as never, "b");
		other.setKey("b", "k2");
		expect(runtime.providers.get("b")?.baseUrl).toBe("https://b.test");
		// a 的目录请求 404。
		expect(await endpoints.refreshForPage("a")).toBeDefined();
		const b = runtime.providers.get("b");
		expect(b?.baseUrl).toBe("https://b2.test");
		expect(b?.apiKey).toBe("k2");
		expect(b?.models?.[0].headers).toEqual({ "x-test": "new" });
		expect(endpoints.apiKey("b")).toBe("k2");
	});

	it("打开开关时保存失败：内存里的开关和启用列表不变，不注册", async () => {
		const { endpoints, registrations } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
		const blocker = `${configFile()}.${process.pid}.tmp`;
		mkdirSync(blocker);
		const before = registrations();
		await expect(endpoints.setLatestPerFamily("cpa", true)).rejects.toThrow();
		rmSync(blocker, { recursive: true });
		expect(endpoints.service("cpa")).toMatchObject({ enabled: ["gpt-6.1-sol"] });
		expect(endpoints.service("cpa")?.latestPerFamily).toBeUndefined();
		expect(readConfig().services[0].latestPerFamily).toBeUndefined();
		expect(registrations()).toBe(before);
	});

	it("开关等 models.dev 时文件坏了：开关报错，后台更新照常全量注册", async () => {
		rmSync(join(temp.dir, "endpoints-modelsdev.json"));
		const { endpoints, registrations } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { preset: true });
		const before = registrations();
		const background = endpoints.updateModelsDev();
		const toggle = endpoints.setLatestPerFamily("cpa", true);
		writeFileSync(join(temp.dir, "endpoints-auth.json"), "{ broken");
		await expect(toggle).rejects.toThrow("endpoints-auth.json");
		await background;
		expect(registrations()).toBe(before + 1);
	});

	it("注销出错时保留注册记录并记下原因，下次全量注册时重试", async () => {
		const { endpoints, providers, failRegistration } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"]);
		failRegistration(true);
		endpoints.setKey("cpa", "");
		expect(endpoints.status()[0]).toMatchObject({ registered: true, syncError: expect.stringContaining("注销被拒绝") });
		expect(providers.has("cpa")).toBe(true);
		failRegistration(false);
		endpoints.registerAll();
		expect(endpoints.status()[0].registered).toBe(false);
		expect(endpoints.status()[0].syncError).toBeUndefined();
		expect(providers.has("cpa")).toBe(false);
	});

	it("管理页刷新时文件读不了就拒绝，内存状态不变，也不请求目录", async () => {
		const { endpoints, catalogs, registrations } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		catalogs["cpa.test"].ids = ["gpt-6.2-sol"];
		writeFileSync(join(temp.dir, "endpoints-auth.json"), "{ broken");
		const before = registrations();
		await expect(endpoints.refreshForPage("cpa")).rejects.toThrow("endpoints-auth.json");
		expect(endpoints.apiKey("cpa")).toBe("k");
		expect(endpoints.catalog("cpa")?.models.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
		expect(registrations()).toBe(before);
	});

	it("同一批刷新里，快的服务迁移不会取消慢的服务的联网刷新；两个服务的旧项都在 pi 设置里换掉", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const catalogs: Catalogs = { "fast.test": { ids: ["gpt-6.1-sol"] }, "slow.test": { ids: ["m-1"] } };
		stubNetwork(catalogs);
		const runtime = fakeRuntime();
		const endpoints = new Endpoints(runtime.pi);
		for (const [name, enabled] of [["fast", "gpt-6.1-sol"], ["slow", "m-1"]]) {
			endpoints.saveService({ name, baseUrl: `https://${name}.test`, enabled: [enabled], overrides: {} });
			endpoints.setKey(name, "k");
			await endpoints.refresh(name);
			await endpoints.setLatestPerFamily(name, true);
		}
		writeFileSync(settingsFile(), JSON.stringify({ enabledModels: ["fast/gpt-6.1-sol", "slow/m-1", "x/y"] }));
		catalogs["fast.test"].ids = ["gpt-6.2-sol"];
		catalogs["slow.test"] = { ids: ["m-1", "m-2"], gate };
		const batch = runtime.refreshAll(["fast", "slow"]);
		await tick();
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.2-sol"]);
		release();
		expect(await batch).toEqual(["published", "published"]);
		expect(endpoints.catalog("slow")?.models.map((model) => model.id)).toEqual(["m-1", "m-2"]);
		expect(readConfig().services.map((service: { enabled: string[] }) => service.enabled)).toEqual([["gpt-6.2-sol"], ["m-2"]]);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).enabledModels).toEqual(["fast/gpt-6.2-sol", "slow/m-2", "x/y"]);
	});

	it("两个服务同时迁移时，pi 设置的修改排队进行，enabledModels 里两个旧项都换掉", async () => {
		const catalogs: Catalogs = { "a.test": { ids: ["gpt-6.1-sol"] }, "b.test": { ids: ["m-1"] } };
		stubNetwork(catalogs);
		const runtime = fakeRuntime();
		const endpoints = new Endpoints(runtime.pi);
		for (const [name, enabled] of [["a", "gpt-6.1-sol"], ["b", "m-1"]]) {
			endpoints.saveService({ name, baseUrl: `https://${name}.test`, enabled: [enabled], overrides: {}, latestPerFamily: true });
			endpoints.setKey(name, "k");
		}
		writeFileSync(settingsFile(), JSON.stringify({ enabledModels: ["a/gpt-6.1-sol", "b/m-1"] }));
		catalogs["a.test"].ids = ["gpt-6.2-sol"];
		catalogs["b.test"].ids = ["m-2"];
		await runtime.refreshAll(["a", "b"]);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).enabledModels).toEqual(["a/gpt-6.2-sol", "b/m-2"]);
	});

	it("管理页刷新时只注册最终结果一次", async () => {
		const { endpoints, catalogs, registrations, providers } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		const before = registrations();
		expect(await endpoints.refreshForPage("cpa")).toBeUndefined();
		expect(registrations()).toBe(before + 1);
		expect(providers.get("cpa")?.models?.map((model) => model.id)).toEqual(["gpt-6.2-sol"]);
	});

	it("刷新失败时不调整", async () => {
		const { endpoints, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		// 缓存里已经有新版本，但这次刷新失败，不按缓存调整。
		writeFileSync(
			join(temp.dir, "endpoints-cache.json"),
			JSON.stringify({ cpa: { fetchedAt: 1, codex: false, baseUrl: "https://cpa.test", models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6.2-sol" }] } }),
		);
		vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
		expect(await refreshModels()).toEqual(["failed"]);
		expect(await endpoints.refreshForPage("cpa")).toContain("down");
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("没有变化时不写配置文件；pi 联网刷新不把别的 pi 写入的配置换进内存，管理页刷新会重新读取", async () => {
		const { endpoints, refreshModels } = await setup(["gpt-6.2-sol", "Index-Translate-35B-A3B"], ["gpt-6.1-sol", "gpt-6.2-sol", "claude-opus-5-5"], { on: true });
		// 另一个 pi 加了服务 b，并换成紧凑格式写入；保存过就会变回缩进格式。
		const config = readConfig();
		config.services.push({ name: "b", baseUrl: "https://b.test", enabled: [], overrides: {} });
		const compact = JSON.stringify(config);
		writeFileSync(configFile(), compact);
		await refreshModels();
		expect(endpoints.service("b")).toBeUndefined();
		await endpoints.refreshForPage("cpa");
		expect(readFileSync(configFile(), "utf8")).toBe(compact);
		expect(endpoints.service("b")).toBeDefined();
	});

	it("隐藏模型不算新版本", async () => {
		const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"], { on: true, hidden: ["gpt-6.2-sol"] });
		expect(endpoints.models("cpa").find((model) => model.id === "gpt-6.2-sol")?.hidden).toBe(true);
		await endpoints.refreshForPage("cpa");
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("models.dev 标为非对话的模型不算新版本；查不到的模型按对话模型处理", async () => {
		const { endpoints } = await setup(["jev-test-1"], ["jev-test-1", "jev-test-2"], { on: true });
		expect(endpoints.models("cpa").find((model) => model.id === "jev-test-2")?.modelType).toBe("decision");
		expect(readConfig().services[0].enabled).toEqual(["jev-test-1"]);
	});

	it("models.dev 数据已就绪、只是查不到的模型按对话模型处理", async () => {
		const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"], { on: true });
		expect(endpoints.models("cpa").find((model) => model.id === "gpt-6.2-sol")).toMatchObject({ modelsDev: undefined, modelType: undefined });
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.2-sol"]);
	});

	it("models.dev 还没有数据时推迟到下次刷新；管理页刷新等 models.dev 拉完后执行", async () => {
		rmSync(join(temp.dir, "endpoints-modelsdev.json"));
		const { endpoints, catalogs, refreshModels } = await setup(["jev-test-1"], ["jev-test-1"], { preset: true });
		catalogs["cpa.test"].ids = ["jev-test-1", "jev-test-2", "jev-test-3"];
		await refreshModels();
		expect(readConfig().services[0].enabled).toEqual(["jev-test-1"]);
		// 后台拉完 models.dev 后，下次刷新才换，而且不会换成非对话模型 jev-test-2。
		await endpoints.updateModelsDev();
		await refreshModels();
		expect(readConfig().services[0].enabled).toEqual(["jev-test-3"]);
	});

	it("开关开着的服务算作需要 models.dev；从没拿到过数据时推迟", async () => {
		rmSync(join(temp.dir, "endpoints-modelsdev.json"));
		modelsDevDown = true;
		const full = { contextWindow: 1000, maxTokens: 100, input: ["text" as const], thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		const { endpoints, catalogs, refreshModels } = await setup(["m-1"], ["m-1"]);
		for (const id of ["m-1", "m-2"]) endpoints.setOverride("cpa", id, full);
		expect(endpoints.needsModelsDev()).toBe(false);
		catalogs["cpa.test"].ids = ["m-1", "m-2"];
		await endpoints.refresh("cpa");
		await endpoints.setLatestPerFamily("cpa", true);
		expect(endpoints.needsModelsDev()).toBe(true);
		expect(readConfig().services[0]).toMatchObject({ latestPerFamily: true, enabled: ["m-1"] });
		await refreshModels();
		await endpoints.refreshForPage("cpa");
		expect(readConfig().services[0].enabled).toEqual(["m-1"]);
	});

	it("管理页刷新在冷缓存时先等 models.dev", async () => {
		rmSync(join(temp.dir, "endpoints-modelsdev.json"));
		const { endpoints, catalogs } = await setup(["jev-test-1"], ["jev-test-1"], { preset: true });
		catalogs["cpa.test"].ids = ["jev-test-1", "jev-test-2", "jev-test-3"];
		await endpoints.refreshForPage("cpa");
		expect(endpoints.models("cpa").find((model) => model.id === "jev-test-2")?.modelType).toBe("decision");
		expect(readConfig().services[0].enabled).toEqual(["jev-test-3"]);
	});

	it("旧版本写的缓存没有来源地址时不调整", async () => {
		const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"]);
		writeFileSync(join(temp.dir, "endpoints-cache.json"), JSON.stringify({ cpa: { fetchedAt: 1, codex: false, models: [{ id: "gpt-6.2-sol" }] } }));
		await endpoints.setLatestPerFamily("cpa", true);
		expect(readConfig().services[0]).toMatchObject({ latestPerFamily: true, enabled: ["gpt-6.1-sol"] });
	});

	it("基于重新读取的配置修改，不覆盖别的 pi 刚写入的内容", async () => {
		const { endpoints, catalogs } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "other"], { on: true });
		let release: () => void = () => {};
		catalogs["cpa.test"] = { ids: ["gpt-6.1-sol", "gpt-6.2-sol", "other"], gate: new Promise<void>((resolve) => (release = resolve)) };
		const pending = endpoints.refreshForPage("cpa");
		await tick();
		// 另一个 pi 启用了 other，又加了一个服务。这个 pi 内存里的配置还是旧的。
		const other = new Endpoints(fakeRuntime().pi);
		other.setEnabled("cpa", "other", true);
		other.saveService({ name: "b", baseUrl: "https://b.test", enabled: [], overrides: {} });
		expect(endpoints.service("cpa")?.enabled).toEqual(["gpt-6.1-sol"]);
		release();
		await pending;
		const saved = readConfig();
		expect(saved.services.map((service: { name: string }) => service.name)).toEqual(["cpa", "b"]);
		expect(saved.services[0].enabled).toEqual(["gpt-6.2-sol", "other"]);
	});

	it("请求挂起期间另一个 pi 改了服务地址时不调整", async () => {
		const { endpoints, catalogs } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		let release: () => void = () => {};
		catalogs["cpa.test"] = { ids: ["gpt-6.2-sol"], gate: new Promise<void>((resolve) => (release = resolve)) };
		const pending = endpoints.refreshForPage("cpa");
		await tick();
		const other = new Endpoints(fakeRuntime().pi);
		other.saveService({ name: "cpa", baseUrl: "https://new.test" } as never, "cpa");
		release();
		await pending;
		expect(readConfig().services[0]).toMatchObject({ baseUrl: "https://new.test", enabled: ["gpt-6.1-sol"] });
	});

	it("刷新期间这个 pi 改了服务地址时不调整", async () => {
		const { endpoints, catalogs } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		let release: () => void = () => {};
		catalogs["cpa.test"] = { ids: ["gpt-6.2-sol"], gate: new Promise<void>((resolve) => (release = resolve)) };
		const pending = endpoints.refreshForPage("cpa");
		await tick();
		endpoints.saveService({ name: "cpa", baseUrl: "https://new.test" } as never, "cpa");
		release();
		await pending;
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("配置文件损坏时刷新照常返回，记下原因，内存里的配置、密钥和缓存不变", async () => {
		const { endpoints, catalogs, published, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		writeFileSync(configFile(), "{ broken");
		expect(await refreshModels()).toEqual(["published"]);
		expect(published.get("cpa")).toEqual(["gpt-6.1-sol"]);
		expect(endpoints.loadError).toContain("endpoints.json");
		expect(endpoints.service("cpa")?.enabled).toEqual(["gpt-6.1-sol"]);
		expect(endpoints.keySource("cpa")).toBe("file");
		expect(readFileSync(configFile(), "utf8")).toBe("{ broken");
	});

	it("密钥文件损坏时刷新照常返回，不调整，内存里的密钥不变", async () => {
		const { endpoints, catalogs, published, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		writeFileSync(join(temp.dir, "endpoints-auth.json"), "{ broken");
		expect(await refreshModels()).toEqual(["published"]);
		expect(published.get("cpa")).toEqual(["gpt-6.1-sol"]);
		expect(endpoints.loadError).toContain("endpoints-auth.json");
		expect(endpoints.apiKey("cpa")).toBe("k");
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("显式入口保存后注册出错：记下原因，照常返回、替换默认模型并提示", async () => {
		const { endpoints, failRegistration } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
		writeFileSync(settingsFile(), JSON.stringify({ defaultProvider: "cpa", defaultModel: "gpt-6.1-sol" }));
		const notes: string[] = [];
		endpoints.notify = (message) => notes.push(message) > 0;
		failRegistration(true);
		await endpoints.setLatestPerFamily("cpa", true);
		expect(readConfig().services[0]).toMatchObject({ latestPerFamily: true, enabled: ["gpt-6.2-sol"] });
		expect(endpoints.status()[0].syncError).toContain("注册被拒绝");
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).defaultModel).toBe("gpt-6.2-sol");
		expect(notes).toEqual(["cpa：gpt-6.1-sol → gpt-6.2-sol。当前会话请用 /model 切换"]);
		failRegistration(false);
		endpoints.registerAll();
		expect(endpoints.status()[0].syncError).toBeUndefined();
	});

	it("后台 models.dev 更新后注册出错不会产生未处理的拒绝", async () => {
		rmSync(join(temp.dir, "endpoints-modelsdev.json"));
		const { endpoints, failRegistration } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { preset: true });
		failRegistration(true);
		await endpoints.updateModelsDev();
		expect(endpoints.status()[0].syncError).toContain("注册被拒绝");
	});

	it("管理页并行刷新多个服务时，共享的 models.dev 下载不另外触发全量注册", async () => {
		rmSync(join(temp.dir, "endpoints-modelsdev.json"));
		const catalogs: Catalogs = { "a.test": { ids: ["m-1"] }, "b.test": { ids: ["n-1"] } };
		stubNetwork(catalogs);
		const runtime = fakeRuntime();
		const endpoints = new Endpoints(runtime.pi);
		for (const name of ["a", "b"]) {
			endpoints.saveService({ name, baseUrl: `https://${name}.test`, enabled: [name === "a" ? "m-1" : "n-1"], overrides: {} });
			endpoints.setKey(name, "k");
		}
		const before = runtime.registrations();
		expect(await Promise.all([endpoints.refreshForPage("a"), endpoints.refreshForPage("b")])).toEqual([undefined, undefined]);
		// 两次刷新各全量注册一次（每次两个服务），共享的下载认领后不再自己注册。
		expect(runtime.registrations()).toBe(before + 4);
	});

	describe("pi 设置", () => {
		const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

		it("默认模型和 Ctrl+P 列表里的旧模型换成新版", async () => {
			writeFileSync(
				settingsFile(),
				JSON.stringify({ defaultProvider: "cpa", defaultModel: "gpt-6.1-sol", enabledModels: ["x/a", "cpa/gpt-6.1-sol", "cpa/gpt-6-sol", "cpa/gpt-*"], theme: "dark" }),
			);
			await setup(["gpt-6.1-sol", "gpt-6-sol"], ["gpt-6.2-sol"], { on: true });
			expect(readSettings()).toEqual({ defaultProvider: "cpa", defaultModel: "gpt-6.2-sol", enabledModels: ["x/a", "cpa/gpt-6.2-sol", "cpa/gpt-*"], theme: "dark" });
		});

		it("新版已经在列表里时只删旧的；默认模型属于别的服务商时不动；大小写不同的项不改", async () => {
			writeFileSync(
				settingsFile(),
				JSON.stringify({ defaultProvider: "other", defaultModel: "gpt-6.1-sol", enabledModels: ["cpa/gpt-6.1-sol", "cpa/GPT-6.1-sol", "cpa/gpt-6.2-sol"] }),
			);
			await setup(["gpt-6.1-sol"], ["gpt-6.2-sol"], { on: true });
			expect(readSettings()).toEqual({ defaultProvider: "other", defaultModel: "gpt-6.1-sol", enabledModels: ["cpa/GPT-6.1-sol", "cpa/gpt-6.2-sol"] });
		});

		it("enabledModels 不是数组时不动它，照样换默认模型", async () => {
			writeFileSync(settingsFile(), JSON.stringify({ defaultProvider: "cpa", defaultModel: "gpt-6.1-sol", enabledModels: "cpa/gpt-6.1-sol" }));
			await setup(["gpt-6.1-sol"], ["gpt-6.2-sol"], { on: true });
			expect(readSettings()).toEqual({ defaultProvider: "cpa", defaultModel: "gpt-6.2-sol", enabledModels: "cpa/gpt-6.1-sol" });
		});

		it("settings.json 读不了时跳过，启用列表照样修改", async () => {
			writeFileSync(settingsFile(), "{ broken");
			await setup(["gpt-6.1-sol"], ["gpt-6.2-sol"], { on: true });
			expect(readConfig().services[0].enabled).toEqual(["gpt-6.2-sol"]);
			expect(readFileSync(settingsFile(), "utf8")).toBe("{ broken");
		});
	});
});

describe("新版提醒", () => {
	const stateFile = () => join(temp.dir, "endpoints-state.json");
	const readState = () => JSON.parse(readFileSync(stateFile(), "utf8"));

	/** 记下提示；`shown` 为假时模仿没有界面的 pi，提示被丢掉。 */
	function listen(endpoints: Endpoints, shown = true) {
		const notes: [string, string][] = [];
		endpoints.notify = (message, level) => {
			if (shown) notes.push([message, level]);
			return shown;
		};
		return notes;
	}

	it("开关关着、目录出了新版时用 warning 提示一次，不改配置和 pi 设置；同一个替换不再提示，出了更新的版本再提示", async () => {
		const { endpoints, catalogs, registrations, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"]);
		endpoints.saveService({ name: "cpa", displayName: "Magpie", baseUrl: "https://cpa.test" } as never, "cpa");
		writeFileSync(settingsFile(), JSON.stringify({ defaultProvider: "cpa", defaultModel: "gpt-6.1-sol" }));
		const notes = listen(endpoints);
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		const before = registrations();
		expect(await refreshModels()).toEqual(["published"]);
		expect(notes).toEqual([
			["Magpie 有新版模型：gpt-6.1-sol → gpt-6.2-sol。输入 /endpoints 可以一键换成新版，或开启“每系最新”自动替换。", "warning"],
		]);
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).defaultModel).toBe("gpt-6.1-sol");
		expect(readState()).toEqual({ notifiedUpdates: { cpa: [{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }] } });
		await tick();
		expect(registrations()).toBe(before);

		// 另一个 pi 进程（新的实例）读同一个记录，也不再提示。
		await refreshModels();
		const other = fakeRuntime();
		const second = new Endpoints(other.pi);
		second.registerAll();
		const otherNotes = listen(second);
		await other.refreshAll(["cpa"]);
		expect(notes).toHaveLength(1);
		expect(otherNotes).toEqual([]);

		// 出了 6.3，待处理的替换变成 6.1 → 6.3，提示一次，旧记录去掉。
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.3-sol"];
		await refreshModels();
		expect(notes.map(([message]) => message)[1]).toContain("gpt-6.1-sol → gpt-6.3-sol");
		expect(readState().notifiedUpdates.cpa).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.3-sol" }]);

		// 用户自己换成新版后没有待处理的替换，记录清掉。
		endpoints.setEnabled("cpa", "gpt-6.1-sol", false);
		endpoints.setEnabled("cpa", "gpt-6.3-sol", true);
		await refreshModels();
		expect(notes).toHaveLength(2);
		expect(readState()).toEqual({ notifiedUpdates: {} });
	});

	it("同一服务的多个替换拼成一条，没有显示名时用服务名", async () => {
		const { endpoints, catalogs, refreshModels } = await setup(["gpt-6.1-sol", "claude-opus-5-5"], ["gpt-6.1-sol", "claude-opus-5-5"]);
		const notes = listen(endpoints);
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol", "claude-opus-5-5", "claude-opus-5-6"];
		await refreshModels();
		expect(notes).toEqual([
			["cpa 有新版模型：gpt-6.1-sol → gpt-6.2-sol、claude-opus-5-5 → claude-opus-5-6。输入 /endpoints 可以一键换成新版，或开启“每系最新”自动替换。", "warning"],
		]);
	});

	it("开关开着时直接迁移，不发新版提醒", async () => {
		const { endpoints, catalogs, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		const notes = listen(endpoints);
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		await refreshModels();
		expect(notes).toEqual([["cpa：gpt-6.1-sol → gpt-6.2-sol 已写入配置，新会话生效，当前 pi 用 /reload", "warning"]]);
		expect(existsSync(stateFile())).toBe(false);
	});

	it("没有界面时提示被丢掉，不记成已提示，下次有界面时再提示", async () => {
		const { endpoints, catalogs, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"]);
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		listen(endpoints, false);
		await refreshModels();
		expect(existsSync(stateFile())).toBe(false);
		endpoints.notify = undefined;
		await refreshModels();
		expect(existsSync(stateFile())).toBe(false);
		const notes = listen(endpoints);
		await refreshModels();
		expect(notes).toHaveLength(1);
		expect(readState().notifiedUpdates.cpa).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);
	});

	it("目录刷新失败时不提示；记录文件损坏时按空处理，再提示一次", async () => {
		const { endpoints, catalogs, refreshModels } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"]);
		const notes = listen(endpoints);
		catalogs["cpa.test"].ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		await endpoints.refresh("cpa");
		vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
		expect(await refreshModels()).toEqual(["failed"]);
		expect(notes).toEqual([]);

		stubNetwork(catalogs);
		writeFileSync(stateFile(), "{ broken");
		await refreshModels();
		expect(notes).toHaveLength(1);
		expect(readState().notifiedUpdates.cpa).toHaveLength(1);
	});

	it("models.dev 没有数据时推迟，不提示也不记录；有数据后的下次刷新再提示，非对话模型不算新版", async () => {
		rmSync(join(temp.dir, "endpoints-modelsdev.json"));
		modelsDevDown = true;
		const { endpoints, catalogs, refreshModels } = await setup(["jev-test-1"], ["jev-test-1"]);
		const notes = listen(endpoints);
		catalogs["cpa.test"].ids = ["jev-test-1", "jev-test-2", "jev-test-3"];
		await refreshModels();
		await tick();
		expect(notes).toEqual([]);
		expect(existsSync(stateFile())).toBe(false);
		expect(endpoints.updates("cpa")).toEqual([]);

		writeModelsDev();
		loadModelsDev();
		await refreshModels();
		expect(notes.map(([message]) => message)).toEqual([expect.stringContaining("jev-test-1 → jev-test-3")]);
	});

	describe("是否需要 models.dev", () => {
		const full = { contextWindow: 1000, maxTokens: 100, input: ["text" as const], thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

		it("开关关着时，目录里有候选新版才需要；没有候选时不下载", async () => {
			rmSync(join(temp.dir, "endpoints-modelsdev.json"));
			const { endpoints, catalogs, refreshModels } = await setup(["m-1"], ["m-1"]);
			for (const id of ["m-1", "m-2", "m-3"]) endpoints.setOverride("cpa", id, full);
			expect(endpoints.needsModelsDev()).toBe(false);
			await refreshModels();
			await endpoints.updateModelsDev();
			expect(existsSync(join(temp.dir, "endpoints-modelsdev.json"))).toBe(false);

			// 候选只有隐藏模型时也不需要。
			catalogs["cpa.test"] = { ids: ["m-1", "m-2"], hidden: ["m-2"] };
			await endpoints.refresh("cpa");
			expect(endpoints.needsModelsDev()).toBe(false);

			// 停用的服务不算。
			catalogs["cpa.test"] = { ids: ["m-1", "m-3"] };
			await endpoints.refresh("cpa");
			endpoints.setServiceDisabled("cpa", true);
			expect(endpoints.needsModelsDev()).toBe(false);
			endpoints.setServiceDisabled("cpa", false);
			expect(endpoints.needsModelsDev()).toBe(true);
		});

		it("有候选新版时 pi 联网刷新会在后台下载", async () => {
			rmSync(join(temp.dir, "endpoints-modelsdev.json"));
			const { endpoints, catalogs, refreshModels } = await setup(["m-1"], ["m-1"]);
			for (const id of ["m-1", "m-2"]) endpoints.setOverride("cpa", id, full);
			catalogs["cpa.test"].ids = ["m-1", "m-2"];
			await refreshModels();
			await endpoints.updateModelsDev();
			expect(existsSync(join(temp.dir, "endpoints-modelsdev.json"))).toBe(true);
		});

		it("目录缓存的来源地址和服务地址不同时不算候选", async () => {
			const { endpoints } = await setup(["m-1"], ["m-1"]);
			for (const id of ["m-1", "m-2"]) endpoints.setOverride("cpa", id, full);
			writeFileSync(
				join(temp.dir, "endpoints-cache.json"),
				JSON.stringify({ cpa: { fetchedAt: 1, codex: false, baseUrl: "https://old.test", models: [{ id: "m-1" }, { id: "m-2" }] } }),
			);
			endpoints.setKey("cpa", "k");
			expect(endpoints.needsModelsDev()).toBe(false);
			expect(endpoints.updates("cpa")).toEqual([]);
		});
	});

	describe("updates", () => {
		it("开关关着时列出打开开关会发生的替换；开着、停用、服务有问题时为空", async () => {
			const { endpoints } = await setup(["gpt-6.1-sol", "other"], ["gpt-6.1-sol", "gpt-6.2-sol", "other"]);
			expect(endpoints.updates("cpa")).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);
			expect(endpoints.updates("nope")).toEqual([]);
			endpoints.setServiceDisabled("cpa", true);
			expect(endpoints.updates("cpa")).toEqual([]);
			endpoints.setServiceDisabled("cpa", false);

			const config = readConfig();
			config.services[0].apiKeyEnv = "$BAD";
			writeFileSync(configFile(), JSON.stringify(config));
			expect(new Endpoints(fakeRuntime().pi).updates("cpa")).toEqual([]);
			config.services[0].apiKeyEnv = undefined;
			writeFileSync(configFile(), JSON.stringify(config));

			await endpoints.setLatestPerFamily("cpa", true);
			expect(endpoints.updates("cpa")).toEqual([]);
		});

		it("models.dev 没有数据时为空", async () => {
			const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
			setModelsDevForTest(undefined);
			expect(endpoints.updates("cpa")).toEqual([]);
		});
	});

	describe("applyLatestOnce", () => {
		it("只替换这一次，不改开关；替换 pi 设置、提示并只注册一次", async () => {
			const { endpoints, providers, registrations } = await setup(["gpt-6.1-sol", "other"], ["gpt-6.1-sol", "gpt-6.2-sol", "other"]);
			writeFileSync(settingsFile(), JSON.stringify({ defaultProvider: "cpa", defaultModel: "gpt-6.1-sol", enabledModels: ["cpa/gpt-6.1-sol"] }));
			const notes = listen(endpoints);
			const before = registrations();
			expect(await endpoints.applyLatestOnce("cpa")).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);
			expect(registrations()).toBe(before + 1);
			const saved = readConfig().services[0];
			expect(saved.enabled).toEqual(["gpt-6.2-sol", "other"]);
			expect(saved.latestPerFamily).toBeUndefined();
			expect(endpoints.service("cpa")?.latestPerFamily).toBeUndefined();
			expect(providers.get("cpa")?.models?.map((model) => model.id)).toEqual(["gpt-6.2-sol", "other"]);
			expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ defaultProvider: "cpa", defaultModel: "gpt-6.2-sol", enabledModels: ["cpa/gpt-6.2-sol"] });
			expect(notes).toEqual([["cpa：gpt-6.1-sol → gpt-6.2-sol。当前会话请用 /model 切换", "warning"]]);
			expect(endpoints.updates("cpa")).toEqual([]);
		});

		it("没有可换的时返回空数组，不写文件、不注册；服务不存在时报错", async () => {
			const { endpoints, registrations } = await setup(["gpt-6.2-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
			const config = readFileSync(configFile(), "utf8");
			const before = registrations();
			expect(await endpoints.applyLatestOnce("cpa")).toEqual([]);
			expect(readFileSync(configFile(), "utf8")).toBe(config);
			expect(registrations()).toBe(before);
			await expect(endpoints.applyLatestOnce("nope")).rejects.toThrow("没有名为 nope 的服务");
		});

		it("models.dev 拿不到数据时不换", async () => {
			rmSync(join(temp.dir, "endpoints-modelsdev.json"));
			modelsDevDown = true;
			const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
			expect(await endpoints.applyLatestOnce("cpa")).toEqual([]);
			expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
		});
	});
});
