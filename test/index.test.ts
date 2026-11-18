import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageUrl } from "../src/commands.ts";
import { Endpoints } from "../src/endpoints.ts";
import piEndpoints from "../src/index.ts";
import { setModelsDevForTest } from "../src/modelsdev.ts";
import { fakePi, useTempAgentDir } from "./helpers.ts";

let temp: ReturnType<typeof useTempAgentDir>;
let ids: string[];

beforeEach(() => {
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
		expect(JSON.parse(readFileSync(stateFile(), "utf8")).notifiedUpdates.cpa).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);

		await refresh();
		expect(notify).toHaveBeenCalledTimes(1);
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
