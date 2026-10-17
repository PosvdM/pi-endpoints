import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeConfigValue, normalizeRoot } from "../src/config.ts";
import { Endpoints, validateName } from "../src/endpoints.ts";
import { fakePi, useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;

beforeEach(() => {
	temp = useTempAgentDir();
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
		const failures = await endpoints.refreshAll();
		expect(failures.size).toBe(0);
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
