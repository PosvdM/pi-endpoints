import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Endpoints } from "../src/endpoints.ts";
import { MODELS_DEV_URL, setModelsDevForTest } from "../src/modelsdev.ts";
import { startWebUI, type WebUI } from "../src/web/server.ts";
import { checkUpdate, isNewer, resetUpdateCheckForTest, VERSION } from "../src/version.ts";
import { fakePi, useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;
let web: WebUI;
let endpoints: Endpoints;
let base: URL;
let token: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
	resetUpdateCheckForTest();
	setModelsDevForTest(undefined);
	temp = useTempAgentDir();
	endpoints = new Endpoints(fakePi().pi);
	web = await startWebUI(endpoints);
	base = new URL(web.url);
	token = base.searchParams.get("token") ?? "";
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await web.close();
	temp.cleanup();
});

function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
	return realFetch(new URL(path, base.origin), {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-endpoints-token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** fetch 不能改 Host，这里用 http.request 直接发。 */
function rawGet(path: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: base.port, path, headers: { host } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("管理页的防护", () => {
	it("只监听 127.0.0.1", () => {
		expect(base.hostname).toBe("127.0.0.1");
	});

	it("页面要带正确的 token，并把 token 写进页面", async () => {
		const page = await realFetch(web.url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain(token);
		expect((await realFetch(`${base.origin}/?token=wrong`)).status).toBe(403);
		expect((await realFetch(`${base.origin}/`)).status).toBe(403);
	});

	it("接口要带 token 请求头", async () => {
		expect((await call("/api/state")).status).toBe(200);
		expect((await call("/api/state", undefined, { "x-endpoints-token": "nope" })).status).toBe(403);
	});

	it("Host 不是 127.0.0.1:端口 时拒绝，防止 DNS 重绑定", async () => {
		expect(await rawGet(`/?token=${token}`, `evil.test:${base.port}`)).toBe(403);
		expect(await rawGet(`/?token=${token}`, `127.0.0.1:${base.port}`)).toBe(200);
	});

	it("CSP 只放行本机的脚本和样式，内联脚本只放行 import map", async () => {
		const page = await realFetch(web.url);
		const html = await page.text();
		const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
		expect(JSON.parse(importMap).imports).toEqual({ preact: "/vendor/preact.js", "preact/hooks": "/vendor/hooks.js", htm: "/vendor/htm.js" });
		const policy = page.headers.get("content-security-policy") ?? "";
		const hash = createHash("sha256").update(importMap).digest("base64");
		expect(policy).toContain(`script-src 'self' 'sha256-${hash}';`);
		expect(policy).toContain("style-src 'self';");
		expect(policy).not.toContain("unsafe-inline");
	});

	it("页面的脚本、样式和第三方模块不要求 token，但要检查 Host", async () => {
		for (const path of ["/app/main.js", "/app/style.css", "/vendor/preact.js", "/vendor/hooks.js", "/vendor/htm.js"]) {
			const response = await realFetch(new URL(path, base.origin));
			expect(response.status, path).toBe(200);
			expect(response.headers.get("content-type")).toBe(path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
		}
		// 浏览器按 ES 模块导入，htm 不能是 UMD 文件。
		const htm = await (await realFetch(new URL("/vendor/htm.js", base.origin))).text();
		expect(htm).toMatch(/export\s*\{|export default/);
		expect(await rawGet("/app/main.js", `evil.test:${base.port}`)).toBe(403);
		for (const path of ["/app/../server.ts", "/app/%2e%2e%2fserver.ts", "/app/web.ts", "/app/x/y.js", "/vendor/vitest.js", "/page.html"]) {
			expect(await rawGet(path, `127.0.0.1:${base.port}`), path).toBe(404);
		}
	});

	it("响应带递增的编号，操作带回的状态在发出前重新生成", async () => {
		const first = await call("/api/state");
		const second = await call("/api/saveService", { service: { name: "cpa", baseUrl: "https://cpa.test" } });
		expect(Number(second.headers.get("x-endpoints-seq"))).toBeGreaterThan(Number(first.headers.get("x-endpoints-seq")));
		vi.stubGlobal("fetch", async () => new Response('{"error":"Invalid token"}', { status: 401 }));
		await call("/api/setKey", { name: "cpa", apiKey: "sk-1" });
		const refreshed = await (await call("/api/refresh", { name: "cpa" })).json();
		expect(refreshed.refreshError).toContain("Invalid token");
		expect(refreshed.services[0]).toMatchObject({ name: "cpa", status: { keySource: "file" } });
	});

	it("修改操作只接受 JSON", async () => {
		const response = await realFetch(new URL("/api/setKey", base.origin), {
			method: "POST",
			headers: { "x-endpoints-token": token, "Content-Type": "text/plain" },
			body: JSON.stringify({ name: "x", apiKey: "y" }),
		});
		expect(response.status).toBe(415);
	});
});

describe("管理页的操作", () => {
	it("添加服务、写密钥，状态里不回显密钥", async () => {
		const added = await call("/api/saveService", { service: { name: "cpa", baseUrl: "https://cpa.test/v1/" } });
		expect(added.status).toBe(200);
		const state = await (await call("/api/setKey", { name: "cpa", apiKey: "sk-very-secret" })).json();
		expect(JSON.stringify(state)).not.toContain("sk-very-secret");
		expect(state.services[0]).toMatchObject({ name: "cpa", baseUrl: "https://cpa.test", status: { keySource: "file" } });
	});

	it("添加服务时带上密钥，会保存密钥并拉取目录", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("authorization") ?? "");
			return new Response(JSON.stringify(url.includes("client_version") ? { data: [] } : { data: [{ id: "model-x", owned_by: "custom" }] }));
		});
		const state = await (await call("/api/saveService", { apiKey: "sk-very-secret", service: { name: "relay", baseUrl: "https://relay.test" } })).json();
		expect(state.refreshError).toBeUndefined();
		expect(JSON.stringify(state)).not.toContain("sk-very-secret");
		expect(state.services[0]).toMatchObject({ name: "relay", status: { keySource: "file" }, catalog: { size: 1 } });
		expect(seen).toContain("Bearer sk-very-secret");
	});

	it("添加服务时拉取目录失败，服务照样保存", async () => {
		vi.stubGlobal("fetch", async () => new Response('{"error":"Invalid token"}', { status: 401 }));
		const response = await call("/api/saveService", { apiKey: "sk-1", service: { name: "relay", baseUrl: "https://relay.test" } });
		expect(response.status).toBe(200);
		const state = await response.json();
		expect(state.refreshError).toContain("Invalid token");
		expect(state.services[0]).toMatchObject({ name: "relay", status: { keySource: "file" } });
	});

	it("错误以中文原因返回", async () => {
		const response = await call("/api/saveService", { service: { name: "openai", baseUrl: "https://x.test" } });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("自带");
	});

	it("刷新、启用、手动设置都反映在状态里", async () => {
		vi.stubGlobal("fetch", async (url: string) =>
			new Response(
				JSON.stringify(
					url.includes("client_version")
						? { data: [] }
						: { data: [{ id: "model-x", owned_by: "custom", context_window: 64000, supported_reasoning_levels: [{ effort: "high" }] }] },
				),
			),
		);
		await call("/api/saveService", { service: { name: "relay", baseUrl: "https://relay.test" } });
		await call("/api/setKey", { name: "relay", apiKey: "sk-1" });
		let state = await (await call("/api/refresh", { name: "relay" })).json();
		expect(state.refreshError).toBeUndefined();
		expect(state.services[0].catalog).toMatchObject({ size: 1, codex: false });

		state = await (await call("/api/setEnabled", { name: "relay", id: "model-x", enabled: true })).json();
		expect(state.services[0].status.registered).toBe(true);
		expect(state.services[0].models[0]).toMatchObject({ enabled: true, levels: ["high"], contextWindow: { value: 64000, source: "server" } });

		state = await (await call("/api/setServiceDisabled", { name: "relay", disabled: true })).json();
		expect(state.services[0].status).toMatchObject({ disabled: true, registered: false });
		state = await (await call("/api/setServiceDisabled", { name: "relay", disabled: false })).json();
		expect(state.services[0].status).toMatchObject({ disabled: false, registered: true });

		state = await (await call("/api/setOverride", { name: "relay", id: "model-x", override: { api: "anthropic-messages", contextWindow: 1000 } })).json();
		expect(state.services[0].models[0]).toMatchObject({
			api: { value: "anthropic-messages", source: "manual" },
			baseUrl: { value: "https://relay.test" },
			contextWindow: { value: 1000, source: "manual" },
			compat: { value: { sendSessionAffinityHeaders: true }, source: "default" },
		});

		state = await (await call("/api/setOverride", {
			name: "relay", id: "model-x", override: { api: "anthropic-messages", compat: { sendSessionAffinityHeaders: false } },
		})).json();
		expect(state.services[0].models[0].compat).toEqual({ value: { sendSessionAffinityHeaders: false }, source: "manual" });
	});

	it("打开“每系最新”后立刻调整并返回状态，之后刷新目录时自动换成新版", async () => {
		let ids = ["gpt-6-sol", "gpt-6.1-sol"];
		// models.dev 没有数据时“每系最新”会推迟，这里给它一份能用的数据。
		const modelsDev = { moonshotai: { id: "moonshotai", models: { "kimi-k9": { limit: { context: 1000, output: 100 } } } } };
		vi.stubGlobal("fetch", async (url: string) =>
			new Response(
				JSON.stringify(
					url === MODELS_DEV_URL ? modelsDev : url.includes("client_version") ? { data: [] } : { data: ids.map((id) => ({ id, owned_by: "openai" })) },
				),
			),
		);
		await call("/api/saveService", { service: { name: "relay", baseUrl: "https://relay.test" } });
		await call("/api/setKey", { name: "relay", apiKey: "sk-1" });
		await call("/api/refresh", { name: "relay" });
		await call("/api/setEnabled", { name: "relay", id: "gpt-6-sol", enabled: true });

		let state = await (await call("/api/setLatestPerFamily", { name: "relay", latestPerFamily: true })).json();
		expect(state.services[0].latestPerFamily).toBe(true);
		expect(state.services[0].models.filter((model: { enabled: boolean }) => model.enabled).map((model: { id: string }) => model.id)).toEqual(["gpt-6.1-sol"]);

		ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		state = await (await call("/api/refresh", { name: "relay" })).json();
		expect(state.services[0].models.filter((model: { enabled: boolean }) => model.enabled).map((model: { id: string }) => model.id)).toEqual(["gpt-6.2-sol"]);

		state = await (await call("/api/setLatestPerFamily", { name: "relay", latestPerFamily: false })).json();
		expect(state.services[0].latestPerFamily).toBe(false);
	});

	it("刷新带 latestPerFamily:false 时只刷新目录、不替换，即使磁盘上开关开着；不传时照旧替换", async () => {
		let ids = ["gpt-6-sol", "gpt-6.1-sol"];
		const modelsDev = { moonshotai: { id: "moonshotai", models: { "kimi-k9": { limit: { context: 1000, output: 100 } } } } };
		vi.stubGlobal("fetch", async (url: string) =>
			new Response(
				JSON.stringify(
					url === MODELS_DEV_URL ? modelsDev : url.includes("client_version") ? { data: [] } : { data: ids.map((id) => ({ id, owned_by: "openai" })) },
				),
			),
		);
		const enabledIds = (state: { services: { models: { id: string; enabled: boolean }[] }[] }) =>
			state.services[0].models.filter((model) => model.enabled).map((model) => model.id);
		await call("/api/saveService", { apiKey: "sk-1", service: { name: "relay", baseUrl: "https://relay.test" } });
		await call("/api/setEnabled", { name: "relay", id: "gpt-6.1-sol", enabled: true });
		await call("/api/setLatestPerFamily", { name: "relay", latestPerFamily: true });

		ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
		let state = await (await call("/api/refresh", { name: "relay", latestPerFamily: false })).json();
		expect(state.services[0].latestPerFamily).toBe(true);
		expect(state.services[0].models.map((model: { id: string }) => model.id)).toContain("gpt-6.2-sol");
		expect(enabledIds(state)).toEqual(["gpt-6.1-sol"]);
		expect(JSON.parse(readFileSync(join(temp.dir, "endpoints.json"), "utf8")).services[0].enabled).toEqual(["gpt-6.1-sol"]);

		const bad = await call("/api/refresh", { name: "relay", latestPerFamily: "no" });
		expect(bad.status).toBe(400);

		state = await (await call("/api/refresh", { name: "relay", latestPerFamily: true })).json();
		expect(enabledIds(state)).toEqual(["gpt-6.2-sol"]);
		ids = ["gpt-6.2-sol", "gpt-6.3-sol"];
		state = await (await call("/api/refresh", { name: "relay" })).json();
		expect(enabledIds(state)).toEqual(["gpt-6.3-sol"]);
	});

	it("状态里带待处理的新版，applyLatestOnce 只替换一次、不改开关", async () => {
		const modelsDev = { moonshotai: { id: "moonshotai", models: { "kimi-k9": { limit: { context: 1000, output: 100 } } } } };
		const ids = ["gpt-6-sol", "gpt-6.1-sol"];
		vi.stubGlobal("fetch", async (url: string) =>
			new Response(
				JSON.stringify(
					url === MODELS_DEV_URL ? modelsDev : url.includes("client_version") ? { data: [] } : { data: ids.map((id) => ({ id, owned_by: "openai" })) },
				),
			),
		);
		await call("/api/saveService", { apiKey: "sk-1", service: { name: "relay", baseUrl: "https://relay.test" } });
		let state = await (await call("/api/setEnabled", { name: "relay", id: "gpt-6-sol", enabled: true })).json();
		// 还没有 models.dev 数据，判断不了候选是不是对话模型。目录里有候选新版，所以刷新时会下载。
		expect(state.services[0].updates).toEqual([]);
		state = await (await call("/api/refresh", { name: "relay" })).json();
		expect(state.services[0]).toMatchObject({ latestPerFamily: false, updates: [{ from: "gpt-6-sol", to: "gpt-6.1-sol" }] });

		state = await (await call("/api/applyLatestOnce", { name: "relay" })).json();
		expect(state.replaced).toEqual([{ from: "gpt-6-sol", to: "gpt-6.1-sol" }]);
		expect(state.services[0]).toMatchObject({ latestPerFamily: false, updates: [] });
		expect(state.services[0].models.filter((model: { enabled: boolean }) => model.enabled).map((model: { id: string }) => model.id)).toEqual(["gpt-6.1-sol"]);

		state = await (await call("/api/applyLatestOnce", { name: "relay" })).json();
		expect(state.replaced).toEqual([]);
		const missing = await call("/api/applyLatestOnce", { name: "nope" });
		expect(missing.status).toBe(400);
		expect((await missing.json()).error).toContain("nope");
	});

	it("新建服务时保存 latestPerFamily，不传时关闭；编辑已有服务时忽略这个字段", async () => {
		let state = await (await call("/api/saveService", { service: { name: "a", baseUrl: "https://a.test", latestPerFamily: true } })).json();
		expect(state.services[0].latestPerFamily).toBe(true);
		state = await (await call("/api/saveService", { service: { name: "b", baseUrl: "https://b.test" } })).json();
		expect(state.services[1].latestPerFamily).toBe(false);

		state = await (await call("/api/saveService", { previousName: "a", service: { name: "a", baseUrl: "https://a.test", latestPerFamily: false } })).json();
		expect(state.services[0].latestPerFamily).toBe(true);
		state = await (await call("/api/saveService", { previousName: "b", service: { name: "b", baseUrl: "https://b.test", latestPerFamily: true } })).json();
		expect(state.services[1].latestPerFamily).toBe(false);
		expect(JSON.parse(readFileSync(join(temp.dir, "endpoints.json"), "utf8")).services.map((service: { latestPerFamily?: boolean }) => service.latestPerFamily)).toEqual([true, undefined]);
	});

	it("刷新失败时返回服务端原文", async () => {
		vi.stubGlobal("fetch", async () => new Response('{"error":"Invalid token"}', { status: 401 }));
		await call("/api/saveService", { service: { name: "relay", baseUrl: "https://relay.test" } });
		await call("/api/setKey", { name: "relay", apiKey: "sk-1" });
		const state = await (await call("/api/refresh", { name: "relay" })).json();
		expect(state.refreshError).toContain("Invalid token");
	});
});

describe("models.dev 和测试消息", () => {
	const v2 = {
		moonshotai: { models: { "dev-chat-9": { limit: { context: 777000 }, capabilities: { reasoning: { supported: true, effort: ["low", "high"] } } } } },
		typesafe: { models: { "jev-test-1": { type: "decision", limit: { context: 64000 } }, "jev-off-catalog": { type: "decision" } } },
	};

	function stubNetwork(modelsDev: () => Response) {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			if (url === MODELS_DEV_URL) return modelsDev();
			if (url.includes("/v1/models")) {
				return new Response(
					JSON.stringify(url.includes("client_version") ? { data: [] } : { data: [{ id: "dev-chat-9", owned_by: "openai" }, { id: "jev-test-1" }] }),
				);
			}
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ error: { message: "stop" } }), { status: 400 });
		});
		return bodies;
	}

	async function addService() {
		return (await call("/api/saveService", { apiKey: "sk-1", service: { name: "relay", baseUrl: "https://relay.test" } })).json();
	}

	it("刷新目录后等 models.dev 拉完再返回状态", async () => {
		stubNetwork(() => new Response(JSON.stringify(v2), { headers: { ETag: '"e"' } }));
		const state = await addService();
		expect(state.refreshError).toBeUndefined();
		expect(state.modelsDev).toMatchObject({ fetching: false, fetchedAt: expect.any(Number), checkedAt: expect.any(Number) });
		const [chat, jev] = state.services[0].models;
		expect(chat).toMatchObject({ modelsDev: "moonshotai/dev-chat-9", modelType: "chat", contextWindow: { value: 777000, source: "modelsdev" } });
		expect(chat.compatSources).toEqual({});
		expect(jev).toMatchObject({ hidden: true, modelType: "decision" });
	});

	it("models.dev 失败不算刷新失败，原因记在 modelsDev.error", async () => {
		stubNetwork(() => new Response("busy", { status: 503 }));
		await addService();
		const state = await (await call("/api/refresh", { name: "relay" })).json();
		expect(state.refreshError).toBeUndefined();
		expect(state.modelsDev.error).toContain("503");
		expect(state.services[0].models[0].contextWindow.source).toBe("default");
	});

	it("不是对话模型的不能启用", async () => {
		stubNetwork(() => new Response(JSON.stringify(v2)));
		await addService();
		const response = await call("/api/setEnabled", { name: "relay", id: "jev-test-1", enabled: true });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("jev-test-1 是分类模型，pi 不能拿它对话");
	});

	it("服务目录里没有的非对话模型也不能启用，目录外的对话模型可以", async () => {
		stubNetwork(() => new Response(JSON.stringify(v2)));
		await addService();
		const before = readFileSync(join(temp.dir, "endpoints.json"), "utf8");
		const response = await call("/api/setEnabled", { name: "relay", id: "jev-off-catalog", enabled: true });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("jev-off-catalog 是分类模型，pi 不能拿它对话");
		expect(readFileSync(join(temp.dir, "endpoints.json"), "utf8")).toBe(before);

		const state = await (await call("/api/setEnabled", { name: "relay", id: "custom-off-catalog", enabled: true })).json();
		expect(state.services[0].models.find((model: { id: string }) => model.id === "custom-off-catalog")).toMatchObject({ enabled: true, missing: true });
	});

	it("测试消息可以选思考档位，档位必须是模型可选的", async () => {
		const bodies = stubNetwork(() => new Response(JSON.stringify(v2)));
		await addService();
		for (const thinkingLevel of ["off", "max", 3]) {
			const response = await call("/api/testModel", { name: "relay", id: "dev-chat-9", thinkingLevel });
			expect(response.status).toBe(400);
		}
		expect(bodies).toHaveLength(0);

		const { test } = await (await call("/api/testModel", { name: "relay", id: "dev-chat-9", thinkingLevel: "high" })).json();
		expect(test.request).toMatchObject({ api: "openai-responses", id: "dev-chat-9", thinkingLevel: "high" });
		expect(bodies[0].reasoning).toMatchObject({ effort: "high" });

		const plain = await (await call("/api/testModel", { name: "relay", id: "dev-chat-9" })).json();
		expect(plain.test.request.thinkingLevel).toBeUndefined();
		expect(bodies[1].reasoning).toBeUndefined();
	});
});

describe("pi 默认模型", () => {
	const settingsFile = () => join(temp.dir, "settings.json");

	beforeEach(async () => {
		await call("/api/saveService", { service: { name: "relay", baseUrl: "https://relay.test" } });
		await call("/api/setKey", { name: "relay", apiKey: "sk-1" });
		await call("/api/setEnabled", { name: "relay", id: "model-x", enabled: true });
	});

	it("写进 pi 的 settings.json，保留其他设置，状态里能读到", async () => {
		writeFileSync(settingsFile(), JSON.stringify({ defaultThinkingLevel: "high" }));
		const state = await (await call("/api/setDefaultModel", { name: "relay", id: "model-x" })).json();
		expect(state.defaultModel).toEqual({ provider: "relay", id: "model-x" });
		expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ defaultThinkingLevel: "high", defaultProvider: "relay", defaultModel: "model-x" });
	});

	it("设置了 Ctrl+P 轮换列表时把默认模型加进去", async () => {
		writeFileSync(settingsFile(), JSON.stringify({ enabledModels: ["cpa/a"] }));
		await call("/api/setDefaultModel", { name: "relay", id: "model-x" });
		expect(JSON.parse(readFileSync(settingsFile(), "utf8")).enabledModels).toEqual(["cpa/a", "relay/model-x"]);
	});

	it("enabledModels 格式不对时照样写入默认模型，不动这个列表", async () => {
		writeFileSync(settingsFile(), JSON.stringify({ enabledModels: "cpa/a" }));
		expect((await call("/api/setDefaultModel", { name: "relay", id: "model-x" })).status).toBe(200);
		expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ enabledModels: "cpa/a", defaultProvider: "relay", defaultModel: "model-x" });
	});

	it("取消时删掉默认模型，保留其他设置", async () => {
		writeFileSync(settingsFile(), JSON.stringify({ defaultThinkingLevel: "high", enabledModels: ["relay/model-x"] }));
		await call("/api/setDefaultModel", { name: "relay", id: "model-x" });
		const state = await (await call("/api/clearDefaultModel", { name: "relay", id: "model-x" })).json();
		expect(state.defaultModel).toBeUndefined();
		expect(state.defaultChanged).toBeUndefined();
		expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ defaultThinkingLevel: "high", enabledModels: ["relay/model-x"] });
	});

	it("页面带的默认模型和当前的不一致时不清除，返回最新状态", async () => {
		await call("/api/setDefaultModel", { name: "relay", id: "model-x" });
		const before = readFileSync(settingsFile(), "utf8");
		const state = await (await call("/api/clearDefaultModel", { name: "relay", id: "old-model" })).json();
		expect(state.defaultChanged).toBe(true);
		expect(state.defaultModel).toEqual({ provider: "relay", id: "model-x" });
		expect(readFileSync(settingsFile(), "utf8")).toBe(before);
		expect((await call("/api/clearDefaultModel", {})).status).toBe(400);
	});

	it("没启用的模型和停用的服务不能设为默认", async () => {
		expect((await call("/api/setDefaultModel", { name: "relay", id: "other" })).status).toBe(400);
		await call("/api/setServiceDisabled", { name: "relay", disabled: true });
		expect((await call("/api/setDefaultModel", { name: "relay", id: "model-x" })).status).toBe(400);
		expect(existsSync(settingsFile())).toBe(false);
	});

	it("settings.json 损坏时拒绝写入，不覆盖文件", async () => {
		writeFileSync(settingsFile(), "{ broken");
		const response = await call("/api/setDefaultModel", { name: "relay", id: "model-x" });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(readFileSync(settingsFile(), "utf8")).toBe("{ broken");
	});
});

describe("token 比较", () => {
	it("长度相同但含非 ASCII 字符的 token 返回 403", async () => {
		const fake = "é".repeat(token.length);
		expect((await call("/api/state", undefined, { "x-endpoints-token": fake })).status).toBe(403);
	});
});

describe("版本号和更新检查", () => {
	const registry = (version: string) => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			seen.push(url);
			return new Response(JSON.stringify({ name: "pi-endpoints", version }));
		});
		return seen;
	};

	it("按数字逐段比较版本号", () => {
		expect(isNewer("0.2.11", "0.2.12")).toBe(true);
		expect(isNewer("0.2.9", "0.2.10")).toBe(true);
		expect(isNewer("0.2.11", "0.3")).toBe(true);
		expect(isNewer("0.2.11", "0.2.11")).toBe(false);
		expect(isNewer("0.3.0", "0.2.12")).toBe(false);
		expect(isNewer("0.2.11", "0.3.0-beta.1")).toBe(false);
		expect(isNewer("dev", "0.3.0")).toBe(false);
	});

	it("状态里带上 package.json 的版本号", async () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(VERSION).toBe(pkg.version);
		expect((await (await call("/api/state")).json()).version).toBe(pkg.version);
	});

	it("npm 上有新版时返回版本号和 Release 页面", async () => {
		const seen = registry("999.0.0");
		expect(await (await call("/api/update")).json()).toEqual({
			latestVersion: "999.0.0",
			releaseUrl: "https://github.com/PosvdM/pi-endpoints/releases/tag/v999.0.0",
		});
		expect(seen).toEqual(["https://registry.npmjs.org/pi-endpoints/latest"]);
	});

	it("已是最新版时什么都不返回", async () => {
		registry(VERSION);
		expect(await (await call("/api/update")).json()).toEqual({});
	});

	it("结果缓存 6 小时", async () => {
		const seen = registry("1.0.0");
		const start = Date.now();
		expect(await checkUpdate("0.1.0", start)).toMatchObject({ latestVersion: "1.0.0" });
		await checkUpdate("0.1.0", start + 5 * 60 * 60 * 1000);
		expect(seen).toHaveLength(1);
		await checkUpdate("0.1.0", start + 6 * 60 * 60 * 1000);
		expect(seen).toHaveLength(2);
	});

	it("检查失败时不显示，30 分钟后再试", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			throw new Error("offline");
		});
		const start = Date.now();
		expect(await checkUpdate("0.1.0", start)).toEqual({});
		expect(await checkUpdate("0.1.0", start + 29 * 60 * 1000)).toEqual({});
		expect(calls).toBe(1);
		vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));
		expect(await checkUpdate("0.1.0", start + 30 * 60 * 1000)).toEqual({});
		expect(await (await call("/api/update")).json()).toEqual({});
	});

	it("失败时沿用上次查到的新版本", async () => {
		registry("1.0.0");
		const start = Date.now();
		await checkUpdate("0.1.0", start);
		vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
		expect(await checkUpdate("0.1.0", start + 7 * 60 * 60 * 1000)).toMatchObject({ latestVersion: "1.0.0" });
	});
});
