import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserCommand, pageUrl } from "../src/commands.ts";
import { Endpoints } from "../src/endpoints.ts";
import piEndpoints from "../src/index.ts";
import { setModelsDevForTest } from "../src/modelsdev.ts";
import { contextCountForTest, resetContextsForTest } from "../src/notify.ts";
import { fakePi, useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;
let ids: string[];

beforeEach(() => {
	resetContextsForTest();
	temp = useTempAgentDir();
	setModelsDevForTest(undefined);
	ids = ["gpt-6.1-sol", "gpt-6.2-sol"];
	// models.dev 数据已就绪，服务 cpa 的开关关着，目录里已经有新版。
	const files: Record<string, unknown> = {
		"endpoints.json": { services: [{ name: "cpa", displayName: "Magpie", baseUrl: "https://cpa.test", enabled: ["gpt-6.1-sol"], overrides: {} }] },
		"endpoints-auth.json": { cpa: { apiKey: "k" } },
		"endpoints-cache.json": { cpa: { fetchedAt: 1, codex: false, baseUrl: "https://cpa.test", models: ids.map((id) => ({ id })) } },
		"endpoints-modelsdev.json": { version: 1, fetchedAt: Date.now(), checkedAt: Date.now(), providers: { typesafe: { "jev-test-2": { type: "decision" } } } },
	};
	for (const [name, value] of Object.entries(files)) writeFileSync(join(temp.dir, name), JSON.stringify(value));
	vi.stubGlobal("fetch", async (url: string) =>
		new Response(JSON.stringify(url.includes("client_version") ? { models: [] } : { data: ids.map((id) => ({ id, owned_by: "openai" })) })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	temp.cleanup();
});

describe("插件入口的提示", () => {
	/** 记下插件注册的事件处理器、命令和服务商。 */
	function load() {
		const listeners: [string, (event: unknown, ctx: unknown) => unknown][] = [];
		const providers = new Map<string, ProviderConfig>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => listeners.push([event, handler]),
			registerCommand: () => {},
			registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
			unregisterProvider: (name: string) => providers.delete(name),
		} as unknown as ExtensionAPI;
		piEndpoints(pi);
		const refresh = () => providers.get("cpa")?.refreshModels?.({ allowNetwork: true, signal: new AbortController().signal } as never);
		// 同一事件可能有多个处理器（入口和命令各注册了 session_shutdown），按注册顺序都调用。
		const emit = (event: string, ctx: unknown) => {
			for (const [name, handler] of listeners) if (name === event) void handler({}, ctx);
		};
		return { emit, refresh };
	}

	const stateFile = () => join(temp.dir, "endpoints-state.json");

	it("没有界面时提示不显示，也不记成已提示；有界面时用 warning 提示并记下", async () => {
		const { emit, refresh } = load();
		const notify = vi.fn();
		emit("session_start", { hasUI: false, ui: { notify } });
		await refresh();
		expect(notify).not.toHaveBeenCalled();
		expect(existsSync(stateFile())).toBe(false);

		emit("session_start", { hasUI: true, ui: { notify } });
		await refresh();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Magpie 有新版模型：gpt-6.1-sol → gpt-6.2-sol"), "warning");
		expect(JSON.parse(readFileSync(stateFile(), "utf8")).notifiedUpdates.cpa).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol", at: expect.any(Number) }]);

		await refresh();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("pi-web-ui 的后台会话（headless 的界面）不提示，也不记成已提示", async () => {
		const { emit, refresh } = load();
		const notify = vi.fn();
		emit("session_start", { hasUI: true, mode: "rpc", ui: { headless: true, notify } });
		await refresh();
		expect(notify).not.toHaveBeenCalled();
		expect(existsSync(stateFile())).toBe(false);
	});

	/** 模仿 pi 给扩展的 ctx：`runtime` 是会话共用的 ModelRuntime，pi 放在 `ctx.modelRegistry.runtime` 上。 */
	function ctxOf(runtime: object | undefined, headless: boolean, notify = vi.fn()) {
		return { hasUI: true, mode: "rpc", ui: { headless, notify }, modelRegistry: runtime && { runtime } };
	}
	const records = () => JSON.parse(readFileSync(stateFile(), "utf8")).notifiedUpdates.cpa;

	it("同一客户端里后加载的后台会话接管刷新时，提示显示在同一客户端的界面上；那个界面结束后不提示也不记录", async () => {
		// 模仿 pi-web-ui：主会话和子代理各加载一份插件，共用一个 ModelRuntime，后注册的接管 refreshModels。
		const runtime = {};
		const main = load();
		const shown = ctxOf(runtime, false);
		main.emit("session_start", shown);
		const sub = load();
		const dropped = ctxOf(runtime, true);
		sub.emit("session_start", dropped);
		await sub.refresh();
		expect(dropped.ui.notify).not.toHaveBeenCalled();
		expect(shown.ui.notify).toHaveBeenCalledWith(expect.stringContaining("gpt-6.1-sol → gpt-6.2-sol"), "warning");
		expect(records()).toHaveLength(1);

		// 子代理结束后，它注册的 refreshModels 仍可能被共用的 ModelRuntime 调用，照样找同一客户端的界面。
		sub.emit("session_shutdown", {});
		ids = ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.3-sol"];
		await sub.refresh();
		expect(shown.ui.notify).toHaveBeenCalledTimes(2);

		main.emit("session_shutdown", {});
		ids = ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.3-sol", "gpt-6.4-sol"];
		await sub.refresh();
		expect(shown.ui.notify).toHaveBeenCalledTimes(2);
		expect(records().map(({ to }: { to: string }) => to)).toEqual(["gpt-6.2-sol", "gpt-6.3-sol"]);
	});

	it("两个独立的客户端各用自己的界面：后台会话接管刷新时不投给别的客户端；自己能显示时用自己的", async () => {
		const clientA = {};
		const clientB = {};
		const mainA = load();
		const shownA = ctxOf(clientA, false);
		mainA.emit("session_start", shownA);
		// B 启动得更晚，是进程里最近一个能显示的会话。
		const mainB = load();
		const shownB = ctxOf(clientB, false);
		mainB.emit("session_start", shownB);
		const subA = load();
		subA.emit("session_start", ctxOf(clientA, true));

		await subA.refresh();
		expect(shownB.ui.notify).not.toHaveBeenCalled();
		expect(shownA.ui.notify).toHaveBeenCalledTimes(1);

		// A 的界面关掉后，A 的后台会话找不到同一客户端的界面，不投给 B，也不记录。
		ids = ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.3-sol"];
		mainA.emit("session_shutdown", {});
		await subA.refresh();
		expect(shownB.ui.notify).not.toHaveBeenCalled();
		expect(records().map(({ to }: { to: string }) => to)).toEqual(["gpt-6.2-sol"]);

		// A 自己（较早启动）刷新时用自己的界面，不用最近的 B。
		const ownA = load();
		const ownShown = ctxOf(clientA, false);
		ownA.emit("session_start", ownShown);
		mainB.emit("session_start", shownB);
		await ownA.refresh();
		expect(ownShown.ui.notify).toHaveBeenCalledTimes(1);
		expect(shownB.ui.notify).not.toHaveBeenCalled();
	});

	it("读不到 ModelRuntime 时退回到进程里最近一个能显示的会话；没收到过 session_start 的实例不提示", async () => {
		const main = load();
		const shown = ctxOf(undefined, false);
		main.emit("session_start", shown);
		const fresh = load();
		await fresh.refresh();
		expect(shown.ui.notify).not.toHaveBeenCalled();
		expect(existsSync(stateFile())).toBe(false);

		const sub = load();
		sub.emit("session_start", ctxOf(undefined, true));
		await sub.refresh();
		expect(shown.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("本实例自己的会话显示了提示时，也清扫失效的上下文", async () => {
		const stale = [ctxOf({}, false), ctxOf({}, false)];
		for (const ctx of stale) load().emit("session_start", ctx);
		const own = load();
		own.emit("session_start", ctxOf({}, false));
		for (const ctx of stale) Object.defineProperty(ctx, "hasUI", { get: () => { throw new Error("stale"); } });
		expect(contextCountForTest()).toBe(3);
		await own.refresh();
		expect(records()).toHaveLength(1);
		expect(contextCountForTest()).toBe(1);
	});

	it("注册和投递时清扫整组失效的上下文", async () => {
		const stale = [ctxOf({}, false), ctxOf({}, false)];
		for (const ctx of stale) load().emit("session_start", ctx);
		expect(contextCountForTest()).toBe(2);
		for (const ctx of stale) Object.defineProperty(ctx, "hasUI", { get: () => { throw new Error("stale"); } });
		load().emit("session_start", ctxOf({}, false));
		expect(contextCountForTest()).toBe(1);
	});

	it("已经失效的会话上下文访问时抛错，跳过它，按没有界面处理", async () => {
		const { emit, refresh } = load();
		const ctx = { hasUI: true, ui: { notify: vi.fn() } };
		emit("session_start", ctx);
		Object.defineProperty(ctx, "ui", { get: () => { throw new Error("stale"); } });
		await refresh();
		expect(existsSync(stateFile())).toBe(false);
	});

	it("会话结束后不再用旧的界面", async () => {
		const { emit, refresh } = load();
		const notify = vi.fn();
		emit("session_start", { hasUI: true, ui: { notify } });
		emit("session_shutdown", {});
		await refresh();
		expect(notify).not.toHaveBeenCalled();
		expect(existsSync(stateFile())).toBe(false);
	});
});

describe("/endpoints 的网址", () => {
	it("有服务存在待处理的新版时加上 service 参数，取第一个这样的服务", () => {
		const config = JSON.parse(readFileSync(join(temp.dir, "endpoints.json"), "utf8"));
		config.services.unshift({ name: "a", baseUrl: "https://a.test", enabled: [], overrides: {} });
		config.services.push({ name: "b.2", baseUrl: "https://cpa.test", enabled: ["gpt-6.1-sol"], overrides: {} });
		writeFileSync(join(temp.dir, "endpoints.json"), JSON.stringify(config));
		const cache = JSON.parse(readFileSync(join(temp.dir, "endpoints-cache.json"), "utf8"));
		cache["b.2"] = cache.cpa;
		writeFileSync(join(temp.dir, "endpoints-cache.json"), JSON.stringify(cache));
		const endpoints = new Endpoints(fakePi().pi);
		expect(pageUrl("http://127.0.0.1:1/?token=t", endpoints)).toBe("http://127.0.0.1:1/?token=t&service=cpa");
	});

	it("没有待处理的新版时网址不变", () => {
		const endpoints = new Endpoints(fakePi().pi);
		endpoints.setEnabled("cpa", "gpt-6.1-sol", false);
		expect(pageUrl("http://127.0.0.1:1/?token=t", endpoints)).toBe("http://127.0.0.1:1/?token=t");
	});
});

describe("打开浏览器的命令", () => {
	const url = "http://127.0.0.1:1/?token=t&service=cpa";

	it("网址整个作为一个参数，Windows 上不经过 cmd，& 不会截断网址", () => {
		expect(browserCommand("win32", url)).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
		expect(browserCommand("darwin", url)).toEqual(["open", [url]]);
		expect(browserCommand("linux", url)).toEqual(["xdg-open", [url]]);
	});
});
