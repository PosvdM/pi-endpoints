import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Endpoints } from "../src/endpoints.ts";
import { startWebUI, type WebUI } from "../src/web/server.ts";
import { fakePi, useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;
let web: WebUI;
let endpoints: Endpoints;
let base: URL;
let token: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
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
		});
	});

	it("刷新失败时返回服务端原文", async () => {
		vi.stubGlobal("fetch", async () => new Response('{"error":"Invalid token"}', { status: 401 }));
		await call("/api/saveService", { service: { name: "relay", baseUrl: "https://relay.test" } });
		await call("/api/setKey", { name: "relay", apiKey: "sk-1" });
		const state = await (await call("/api/refresh", { name: "relay" })).json();
		expect(state.refreshError).toContain("Invalid token");
	});
});

describe("token 比较", () => {
	it("长度相同但含非 ASCII 字符的 token 返回 403", async () => {
		const fake = "é".repeat(token.length);
		expect((await call("/api/state", undefined, { "x-endpoints-token": fake })).status).toBe(403);
	});
});
