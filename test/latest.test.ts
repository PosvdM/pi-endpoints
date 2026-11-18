import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Endpoints } from "../src/endpoints.ts";
import { setModelsDevForTest } from "../src/modelsdev.ts";
import { fakePi, useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;

beforeEach(() => {
	temp = useTempAgentDir();
	setModelsDevForTest(undefined);
});

afterEach(() => {
	temp.cleanup();
	vi.unstubAllGlobals();
});

const configFile = () => join(temp.dir, "endpoints.json");
const settingsFile = () => join(temp.dir, "settings.json");
const readConfig = () => JSON.parse(readFileSync(configFile(), "utf8"));
const signal = () => new AbortController().signal;

/** 服务目录返回 `ids()` 里的模型；`hidden` 里的模型在 Codex 目录里标为隐藏。 */
function stubCatalog(ids: () => string[], hidden: string[] = []) {
	vi.stubGlobal("fetch", async (url: string) =>
		new Response(
			JSON.stringify(
				url.includes("client_version")
					? { models: ids().map((slug) => ({ slug, visibility: hidden.includes(slug) ? "hide" : "list" })) }
					: { data: ids().map((id) => ({ id, owned_by: "openai" })) },
			),
		),
	);
}

/** 和 pi 一样：注册服务商后以 allowNetwork: false 调用 refreshModels。 */
function reentrantPi() {
	const fake = fakePi();
	let registrations = 0;
	const register = fake.pi.registerProvider;
	fake.pi.registerProvider = ((name: string, config: Parameters<typeof register>[1]) => {
		registrations++;
		register(name, config);
		void config.refreshModels?.({ allowNetwork: false, signal: signal() } as never);
	}) as typeof register;
	return { ...fake, registrations: () => registrations };
}

/** 建一个有密钥、已读过目录的服务。 */
async function setup(enabled: string[], catalog: string[], options: { on?: boolean; hidden?: string[] } = {}) {
	let ids = catalog;
	stubCatalog(() => ids, options.hidden);
	const fake = reentrantPi();
	const endpoints = new Endpoints(fake.pi);
	endpoints.saveService({ name: "cpa", baseUrl: "https://cpa.test", enabled, overrides: {} });
	endpoints.setKey("cpa", "k");
	await endpoints.refresh("cpa");
	if (options.on) await endpoints.setLatestPerFamily("cpa", true);
	return { ...fake, endpoints, setCatalog: (next: string[]) => (ids = next) };
}

describe("每系最新", () => {
	it("开启时立即按缓存的目录调整，保留旧 id 的手动设置，关闭时去掉字段", async () => {
		const { endpoints, providers } = await setup(["gpt-6.1-sol", "other"], ["gpt-6.1-sol", "gpt-6.2-sol", "other"]);
		endpoints.setOverride("cpa", "gpt-6.1-sol", { contextWindow: 1000 });
		expect(readConfig().services[0].latestPerFamily).toBeUndefined();

		await endpoints.setLatestPerFamily("cpa", true);
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
		const { providers } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
		await providers.get("cpa")?.refreshModels?.({ allowNetwork: true, signal: signal() } as never);
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("refreshModels 刷新出新版本后换掉目录里已经没有的旧 id，返回新模型，不会循环", async () => {
		const { providers, setCatalog, registrations } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
		setCatalog(["gpt-6.2-sol"]);
		const before = registrations();
		const models = await providers.get("cpa")?.refreshModels?.({ allowNetwork: true, signal: signal() } as never);
		expect(models?.map((model) => model.id)).toEqual(["gpt-6.2-sol"]);
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.2-sol"]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(registrations()).toBe(before + 1);
	});

	it("刷新失败时不调整", async () => {
		const { endpoints, providers } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		// 缓存里已经有新版本，但这次刷新失败，不按缓存调整。
		writeFileSync(
			join(temp.dir, "endpoints-cache.json"),
			JSON.stringify({ cpa: { fetchedAt: 1, codex: false, models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6.2-sol" }] } }),
		);
		vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
		await expect(providers.get("cpa")?.refreshModels?.({ allowNetwork: true, signal: signal() } as never)).rejects.toThrow();
		await expect(endpoints.refreshAndApply("cpa")).rejects.toThrow();
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("没有变化时不写配置文件", async () => {
		const { endpoints } = await setup(["gpt-6.2-sol", "Index-Translate-35B-A3B"], ["gpt-6.1-sol", "gpt-6.2-sol", "claude-opus-5-5"], { on: true });
		// 换成紧凑格式，保存过就会变回缩进格式。
		const compact = JSON.stringify(readConfig());
		writeFileSync(configFile(), compact);
		expect(await endpoints.refreshAndApply("cpa").then(() => readFileSync(configFile(), "utf8"))).toBe(compact);
		expect(await endpoints.applyLatestPerFamily("cpa")).toEqual([]);
		expect(readFileSync(configFile(), "utf8")).toBe(compact);
	});

	it("隐藏模型不算新版本", async () => {
		const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"], { on: true, hidden: ["gpt-6.2-sol"] });
		expect(endpoints.models("cpa").find((model) => model.id === "gpt-6.2-sol")?.hidden).toBe(true);
		await endpoints.refreshAndApply("cpa");
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
	});

	it("models.dev 标为非对话的模型不算新版本", async () => {
		writeFileSync(
			join(temp.dir, "endpoints-modelsdev.json"),
			JSON.stringify({ version: 1, fetchedAt: Date.now(), checkedAt: Date.now(), providers: { typesafe: { "jev-test-2": { type: "decision" } } } }),
		);
		const { endpoints } = await setup(["jev-test-1"], ["jev-test-1", "jev-test-2"], { on: true });
		expect(endpoints.models("cpa").find((model) => model.id === "jev-test-2")?.modelType).toBe("decision");
		expect(readConfig().services[0].enabled).toEqual(["jev-test-1"]);
	});

	it("基于重新读取的配置修改，不覆盖别的 pi 刚写入的内容", async () => {
		const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol", "other"], { on: true });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		vi.stubGlobal("fetch", async (url: string) => {
			await gate;
			return new Response(JSON.stringify(url.includes("client_version") ? {} : { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6.2-sol" }, { id: "other" }] }));
		});
		// 另一个 pi 启用了 other，又加了一个服务。这个 pi 内存里的配置还是旧的。
		const other = new Endpoints(fakePi().pi);
		other.setEnabled("cpa", "other", true);
		other.saveService({ name: "b", baseUrl: "https://b.test", enabled: [], overrides: {} });
		expect(endpoints.service("cpa")?.enabled).toEqual(["gpt-6.1-sol"]);
		const pending = endpoints.refreshAndApply("cpa");
		release();
		await pending;
		const saved = readConfig();
		expect(saved.services.map((service: { name: string }) => service.name)).toEqual(["cpa", "b"]);
		expect(saved.services[0].enabled).toEqual(["gpt-6.2-sol", "other"]);
	});

	it("刷新期间服务换了地址时不调整", async () => {
		const { endpoints } = await setup(["gpt-6.1-sol"], ["gpt-6.1-sol"], { on: true });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		vi.stubGlobal("fetch", async (url: string) => {
			await gate;
			return new Response(JSON.stringify(url.includes("client_version") ? {} : { data: [{ id: "gpt-6.2-sol" }] }));
		});
		const pending = endpoints.refreshAndApply("cpa");
		endpoints.saveService({ name: "cpa", baseUrl: "https://new.test" } as never, "cpa");
		release();
		await pending;
		expect(readConfig().services[0].enabled).toEqual(["gpt-6.1-sol"]);
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

		it("新版已经在列表里时只删旧的；默认模型属于别的服务商时不动", async () => {
			writeFileSync(settingsFile(), JSON.stringify({ defaultProvider: "other", defaultModel: "gpt-6.1-sol", enabledModels: ["cpa/gpt-6.1-sol", "cpa/gpt-6.2-sol"] }));
			await setup(["gpt-6.1-sol"], ["gpt-6.2-sol"], { on: true });
			expect(readSettings()).toEqual({ defaultProvider: "other", defaultModel: "gpt-6.1-sol", enabledModels: ["cpa/gpt-6.2-sol"] });
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
