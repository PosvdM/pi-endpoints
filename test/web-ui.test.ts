// @vitest-environment happy-dom
// 管理页前端（src/web/app/）的 DOM 测试。用假的 fetch 代替服务端，按接口约定返回状态和 X-Endpoints-Seq。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/web/app/app.js";
import { parseCount, prefixOf, versionOf } from "../src/web/app/util.js";

type Json = Record<string, any>;

function model(id: string, extra: Json = {}): Json {
	return {
		id,
		enabled: false,
		levels: [],
		override: {},
		betas: [],
		name: { value: id, source: "server" },
		api: { value: "openai-completions", source: "default" },
		baseUrl: { value: "https://relay.test/v1", source: "default" },
		contextWindow: { value: 64000, source: "server" },
		maxTokens: { value: 8000, source: "server" },
		input: { value: ["text"], source: "default" },
		thinkingLevelMap: { value: undefined, source: "default" },
		compat: { value: {}, source: "default" },
		cost: { value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: "default" },
		...extra,
	};
}

function service(name: string, models: Json[], extra: Json = {}): Json {
	return {
		name,
		displayName: "",
		baseUrl: `https://${name}.test`,
		defaultApi: "",
		apiKeyEnv: "",
		headers: {},
		latestPerFamily: false,
		updates: [],
		status: { registered: true, keySource: "file" },
		catalog: { fetchedAt: 0, size: models.length },
		models,
		...extra,
	};
}

function state(services: Json[], extra: Json = {}): Json {
	return { version: "0.4.0", apis: ["openai-completions", "anthropic-messages"], services, ...extra };
}

interface Call {
	path: string;
	body: Json | undefined;
}

/**
 * 假的服务端。`handlers[操作名]` 返回响应体（或 Promise），默认返回当前的 `current`。
 * 每个响应带递增的 X-Endpoints-Seq，也可以在响应体里用 `seq` 指定，用来模拟先发后到。
 */
function fakeServer(initial: Json) {
	let seq = 0;
	const calls: Call[] = [];
	const server = {
		current: initial,
		calls,
		handlers: {} as Record<string, (body: Json | undefined) => Json | Promise<Json>>,
		fetch: vi.fn(async (input: string, init?: RequestInit) => {
			const path = input.replace(/^\/api\//, "");
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ path, body });
			const handler = server.handlers[path];
			let result: Json = handler ? await handler(body) : path === "update" ? {} : server.current;
			let status = 200;
			if (result.status) {
				status = result.status;
				result = { error: result.error };
			}
			const own = result.seq;
			delete result.seq;
			return new Response(JSON.stringify(result), {
				status,
				headers: { "Content-Type": "application/json", "X-Endpoints-Seq": String(own ?? ++seq) },
			});
		}),
		/** 只看修改操作。 */
		posts: () => calls.filter((call) => call.body !== undefined),
	};
	return server;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** 等 Preact 的异步重画和挂起的 Promise 都完成。 */
async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let root: HTMLElement;
let stop: (() => void) | undefined;

beforeEach(() => {
	document.body.innerHTML = '<div id="root"></div>';
	root = document.getElementById("root") as HTMLElement;
	vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
	// 卸载页面，挂在 document 上的 Esc 和指针监听随之移除。
	stop?.();
	stop = undefined;
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

async function open(server: ReturnType<typeof fakeServer>, search = "") {
	const app = startApp(root, { token: "t", search, fetch: server.fetch as unknown as typeof fetch });
	stop = app.stop;
	await settle();
	return app.store;
}

const $ = <T extends Element = HTMLElement>(selector: string) => root.ownerDocument.querySelector(selector) as T | null;
const $$ = (selector: string) => [...root.ownerDocument.querySelectorAll<HTMLElement>(selector)];
const byText = (selector: string, text: string) => $$(selector).find((element) => element.textContent?.trim() === text || element.textContent?.includes(text));
const navNames = () => $$(".svc .name").map((element) => element.textContent);
const rowIds = () => $$("tbody tr:not(.group) .model-id .id").map((element) => element.textContent);
const rowOf = (id: string) => $$("tbody tr:not(.group)").find((row) => row.querySelector(".id")?.textContent === id) as HTMLElement;

/** 在输入框里填字，等页面重画完。 */
async function type(input: Element | null, value: string) {
	const element = input as HTMLInputElement;
	element.focus();
	element.value = value;
	element.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
}

function toggle(input: Element | null) {
	(input as HTMLInputElement).click();
}

describe("加载和左栏", () => {
	it("停用的服务排在下面，默认选中第一个启用的服务，并在后台刷新启用的服务", async () => {
		const server = fakeServer(state([
			service("off", [], { status: { disabled: true, keySource: "file" } }),
			service("relay", [model("gpt-6-sol")]),
			service("nokey", [], { status: {} }),
		]));
		await open(server);
		expect(navNames()).toEqual(["relay", "nokey", "off"]);
		expect($(".head h1")?.textContent).toContain("relay");
		expect(server.posts().map((call) => [call.path, call.body?.name])).toEqual([["refresh", "relay"]]);
	});

	it("网址带 service 参数且服务存在时，选中它并打开模型页", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")]), service("cpa", [model("gpt-6-sol")])]));
		await open(server, "?token=t&service=cpa");
		expect($(".head h1")?.textContent).toContain("cpa");
		expect($(".tab.active")?.textContent).toContain("模型");
		expect(rowIds()).toEqual(["gpt-6-sol"]);
	});

	it("service 参数指向不存在的服务时照旧选第一个", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")])]));
		await open(server, "?service=nope");
		expect($(".head h1")?.textContent).toContain("relay");
	});

	it("有待换的新版时，服务名旁显示角标", async () => {
		const server = fakeServer(state([
			service("relay", [], { updates: [{ from: "gpt-6-sol", to: "gpt-6.1-sol" }] }),
			service("cpa", []),
		]));
		await open(server);
		const badges = $$(".svc").map((row) => Boolean(row.querySelector(".tag.new")));
		expect(badges).toEqual([true, false]);
	});

	it("停用服务后它留在原处，失败时开关拨回原样", async () => {
		const server = fakeServer(state([service("a", []), service("b", [])]));
		await open(server);
		server.handlers.setServiceDisabled = () => (server.current = state([service("a", [], { status: { disabled: true } }), service("b", [])]));
		toggle($(".svc .switch"));
		await settle();
		expect(navNames()).toEqual(["a", "b"]);
		expect(($(".svc .switch") as HTMLInputElement).checked).toBe(false);

		server.handlers.setServiceDisabled = () => ({ status: 400, error: "写不进去" });
		toggle($$(".svc .switch")[1]);
		expect(($$(".svc .switch")[1] as HTMLInputElement).checked).toBe(false);
		await settle();
		expect(($$(".svc .switch")[1] as HTMLInputElement).checked).toBe(true);
		expect($(".banner.err")?.textContent).toContain("写不进去");
	});

	it("重新启用服务后在后台刷新它的目录", async () => {
		const server = fakeServer(state([service("relay", [], { status: { disabled: true, keySource: "file" } })]));
		await open(server);
		expect(server.posts()).toEqual([]);
		server.handlers.setServiceDisabled = () => (server.current = state([service("relay", [])]));
		toggle($(".svc .switch"));
		await settle();
		expect(server.posts().map((call) => call.path)).toEqual(["setServiceDisabled", "refresh"]);
		expect($(".banner.err")).toBeNull();
	});

	it("显示版本号，npm 上有新版时显示箭头", async () => {
		const server = fakeServer(state([service("relay", [])]));
		server.handlers.update = () => ({ latestVersion: "9.9.9", releaseUrl: "https://example.test/r" });
		await open(server);
		expect($(".version")?.textContent).toContain("v0.4.0");
		expect($(".version a.update")?.getAttribute("title")).toBe("有新版本 v9.9.9");
	});
});

describe("状态更新不冲掉输入", () => {
	it("后台刷新期间填的表单、密钥和焦点都保留", async () => {
		const refresh = deferred<Json>();
		const server = fakeServer(state([service("relay", [model("gpt-6-sol")])]));
		server.handlers.refresh = () => refresh.promise;
		await open(server);
		byText(".tab", "服务设置")?.click();
		await settle();
		await type($(".key-row input"), "sk-typed");
		const displayName = $$(".form input")[0];
		await type(displayName, "新名字");
		expect(document.activeElement).toBe(displayName);

		refresh.resolve({ ...state([service("relay", [model("gpt-6-sol"), model("gpt-6.1-sol")], { displayName: "服务端的名字" })]) });
		await settle();
		expect(($(".key-row input") as HTMLInputElement).value).toBe("sk-typed");
		expect(($$(".form input")[0] as HTMLInputElement).value).toBe("新名字");
		expect(document.activeElement).toBe(displayName);
		expect($(".head h1")?.textContent).toContain("服务端的名字");
	});

	it("详情面板的生效参数跟着最新状态更新，表单里没保存的输入保留", async () => {
		const refresh = deferred<Json>();
		const server = fakeServer(state([service("relay", [model("gpt-6-sol", { enabled: true })])]));
		server.handlers.refresh = () => refresh.promise;
		await open(server);
		rowOf("gpt-6-sol").click();
		await settle();
		expect($(".drawer .kv")?.textContent).toContain("64,000");
		const name = $(".drawer .form input") as HTMLInputElement;
		await type(name, "我的名字");

		refresh.resolve(state([service("relay", [model("gpt-6-sol", { enabled: false, contextWindow: { value: 128000, source: "server" } })])]));
		await settle();
		expect($(".drawer .kv")?.textContent).toContain("128,000");
		expect(($(".drawer .form input") as HTMLInputElement).value).toBe("我的名字");
		expect(($(".drawer .drawer-toggle") as HTMLInputElement).checked).toBe(false);
	});

	it("详情里的模型从状态里消失时，开关按未启用显示，星标清空", async () => {
		const server = fakeServer(state([service("relay", [model("gpt-6-sol", { enabled: true })])], { defaultModel: { provider: "relay", id: "gpt-6-sol" } }));
		await open(server);
		rowOf("gpt-6-sol").click();
		await settle();
		expect($(".drawer-star .star")).not.toBeNull();
		server.handlers.setEnabled = () => state([service("relay", [model("gpt-6.1-sol", { enabled: true })])]);
		toggle($(".drawer .drawer-toggle"));
		await settle();
		expect($(".drawer .model-id")?.textContent).toBe("gpt-6-sol");
		expect(($(".drawer .drawer-toggle") as HTMLInputElement).checked).toBe(false);
		expect($(".drawer-star .star")).toBeNull();
	});
});

describe("请求顺序", () => {
	it("修改操作排队执行，前一个结束后才发下一个", async () => {
		const first = deferred<Json>();
		const server = fakeServer(state([service("relay", [model("a-1"), model("a-2")], { status: { registered: true } })]));
		await open(server);
		server.handlers.setEnabled = (body) => (body?.id === "a-1" ? first.promise : server.current);
		toggle(rowOf("a-1").querySelector(".switch"));
		toggle(rowOf("a-2").querySelector(".switch"));
		await settle();
		expect(server.posts().map((call) => call.body?.id)).toEqual(["a-1"]);
		// 请求期间开关按要切换到的值显示。
		expect((rowOf("a-2").querySelector(".switch") as HTMLInputElement).checked).toBe(true);
		first.resolve(server.current);
		await settle();
		expect(server.posts().map((call) => call.body?.id)).toEqual(["a-1", "a-2"]);
	});

	it("先发后到的旧状态被丢弃，长时间刷新带回的新状态被采用", async () => {
		const stale = deferred<Json>();
		const server = fakeServer(state([service("relay", [model("gpt-6-sol")])]));
		server.handlers.refresh = () => stale.promise;
		await open(server);
		// 刷新在途时启用模型，服务端给这个响应编号 10。
		server.handlers.setEnabled = () => ({ ...state([service("relay", [model("gpt-6-sol", { enabled: true })])]), seq: 10 });
		toggle(rowOf("gpt-6-sol").querySelector(".switch"));
		await settle();
		// 刷新的响应在启用之前生成（编号 5），后到达，不能把开关改回去。
		stale.resolve({ ...state([service("relay", [model("gpt-6-sol"), model("gpt-6.1-sol")])]), seq: 5 });
		await settle();
		expect((rowOf("gpt-6-sol").querySelector(".switch") as HTMLInputElement).checked).toBe(true);
		expect(rowIds()).toEqual(["gpt-6-sol"]);

		// 手动刷新先发，期间又启用了模型（编号 11），刷新的状态最后生成（编号 12），采用它。
		const slow = deferred<Json>();
		server.handlers.refresh = () => slow.promise;
		byText(".head .btn", "刷新目录")?.click();
		await settle();
		expect(byText(".head .btn", "刷新中…")).toBeTruthy();
		server.handlers.setEnabled = () => ({ ...state([service("relay", [model("gpt-6-sol")])]), seq: 11 });
		toggle(rowOf("gpt-6-sol").querySelector(".switch"));
		await settle();
		slow.resolve({ ...state([service("relay", [model("gpt-6-sol"), model("gpt-6.1-sol", { enabled: true })])]), seq: 12 });
		await settle();
		expect(rowIds()).toEqual(["gpt-6.1-sol", "gpt-6-sol"]);
		expect(byText(".head .btn", "刷新目录")).toBeTruthy();
	});

	it("测试消息的结果只显示在发出时的模型上", async () => {
		const reply = deferred<Json>();
		const server = fakeServer(state([service("relay", [model("a-1"), model("a-2")])]));
		server.handlers.testModel = () => reply.promise;
		await open(server);
		rowOf("a-1").click();
		await settle();
		byText(".drawer-foot .btn", "发送测试消息")?.click();
		await settle();
		byText(".drawer .close", "×")?.click();
		await settle();
		rowOf("a-2").click();
		await settle();
		reply.resolve({ test: { ok: true, stopReason: "stop", text: "OK", durationMs: 1000, request: { api: "x", baseUrl: "y", id: "a-1" } } });
		await settle();
		expect($(".drawer .model-id")?.textContent).toBe("a-2");
		expect($(".drawer .result")).toBeNull();
	});
});

describe("冻结排序", () => {
	it("“已启用”页里停用的模型留在原处，再点一次“已启用”后移走；自动启用的新版补进来", async () => {
		const server = fakeServer(state([service("relay", [model("gpt-6-sol", { enabled: true }), model("gpt-5-sol", { enabled: true }), model("qwen3")])]));
		await open(server);
		byText(".chip", "已启用")?.click();
		await settle();
		expect(rowIds()).toEqual(["gpt-6-sol", "gpt-5-sol"]);

		server.handlers.setEnabled = () => state([service("relay", [model("gpt-6-sol", { enabled: true }), model("gpt-5-sol"), model("qwen3")])]);
		toggle(rowOf("gpt-5-sol").querySelector(".switch"));
		await settle();
		expect(rowIds()).toEqual(["gpt-6-sol", "gpt-5-sol"]);

		server.handlers.refresh = () => state([service("relay", [model("gpt-6.1-sol", { enabled: true }), model("gpt-6-sol"), model("gpt-5-sol"), model("qwen3")])]);
		byText(".head .btn", "刷新目录")?.click();
		await settle();
		expect(rowIds()).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-5-sol"]);

		byText(".chip", "已启用")?.click();
		await settle();
		expect(rowIds()).toEqual(["gpt-6.1-sol"]);
	});

	it("停用的隐藏模型和改了协议的模型留在原处，改了筛选条件后按规则显示", async () => {
		const server = fakeServer(state([service("relay", [model("a-1", { enabled: true, hidden: true }), model("a-2")])]));
		await open(server);
		expect(rowIds()).toEqual(["a-2", "a-1"]);
		server.handlers.setEnabled = () => state([service("relay", [model("a-1", { hidden: true }), model("a-2")])]);
		toggle(rowOf("a-1").querySelector(".switch"));
		await settle();
		expect(rowIds()).toEqual(["a-2", "a-1"]);
		await type($(".search input"), "a");
		expect(rowIds()).toEqual(["a-2"]);

		const select = $(".toolbar select") as HTMLSelectElement;
		select.value = "openai-completions";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		expect(rowIds()).toEqual(["a-2"]);
		rowOf("a-2").click();
		await settle();
		const api = $(".drawer .form select") as HTMLSelectElement;
		api.value = "anthropic-messages";
		api.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		server.handlers.setOverride = () => state([service("relay", [model("a-1", { hidden: true }), model("a-2", { api: { value: "anthropic-messages", source: "manual" }, override: { api: "anthropic-messages" } })])]);
		byText(".drawer-foot .btn", "保存")?.click();
		await settle();
		expect(server.posts().at(-1)?.body?.override).toEqual({ api: "anthropic-messages" });
		expect(rowIds()).toEqual(["a-2"]);
		select.value = "";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		select.value = "openai-completions";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		expect(rowIds()).toEqual([]);
	});

	it("选中的前缀数量变成 0 时仍保留按钮", async () => {
		const server = fakeServer(state([service("relay", [model("gpt-6-sol"), model("qwen3")])]));
		await open(server);
		byText(".chip", "qwen")?.click();
		await settle();
		await type($(".search input"), "gpt");
		await settle();
		expect($(".chip.active")?.textContent).toBe("qwen0");
		expect(byText(".empty", "没有符合条件的模型")).toBeTruthy();
	});
});

describe("每系最新", () => {
	const updates = [{ from: "gpt-6-sol", to: "gpt-6.1-sol" }, { from: "claude-4", to: "claude-4-5" }];

	it("开关关着、有待换的新版时显示横幅，“换成新版”只换一次并提示换了哪些", async () => {
		const server = fakeServer(state([service("relay", [model("gpt-6-sol", { enabled: true })], { updates })]));
		await open(server);
		expect($(".latest-banner")?.textContent).toContain("2 个已启用模型有新版：gpt-6-sol → gpt-6.1-sol、claude-4 → claude-4-5");
		server.handlers.applyLatestOnce = () => ({ ...state([service("relay", [model("gpt-6.1-sol", { enabled: true })])]), replaced: updates });
		byText(".latest-banner .btn", "换成新版")?.click();
		await settle();
		expect(server.posts().at(-1)).toEqual({ path: "applyLatestOnce", body: { name: "relay" } });
		expect($(".toast")?.textContent).toBe("已换成新版：gpt-6-sol → gpt-6.1-sol、claude-4 → claude-4-5");
		expect($(".latest-banner")).toBeNull();
	});

	it("“开启自动替换”打开开关，开关开着时不显示横幅", async () => {
		const server = fakeServer(state([service("relay", [], { updates })]));
		await open(server);
		server.handlers.setLatestPerFamily = (body) => state([service("relay", [], { latestPerFamily: body?.latestPerFamily, updates: [] })]);
		byText(".latest-banner .btn", "开启自动替换")?.click();
		await settle();
		expect(server.posts().at(-1)).toEqual({ path: "setLatestPerFamily", body: { name: "relay", latestPerFamily: true } });
		expect($(".latest-banner")).toBeNull();
		expect(($(".latest-toggle input") as HTMLInputElement).checked).toBe(true);
		expect($(".latest-toggle")?.textContent).toContain("已开启");
	});

	it("工具栏的开关在“已启用”旁边，点了立即保存，失败时拨回原样", async () => {
		const server = fakeServer(state([service("relay", [])]));
		await open(server);
		const chips = $$(".chips > *");
		expect(chips[1].textContent).toContain("已启用");
		expect(chips[2].classList.contains("latest-toggle")).toBe(true);
		server.handlers.setLatestPerFamily = () => ({ status: 400, error: "models.dev 还没有数据" });
		toggle($(".latest-toggle input"));
		await settle();
		expect(server.posts().at(-1)?.body).toEqual({ name: "relay", latestPerFamily: true });
		expect(($(".latest-toggle input") as HTMLInputElement).checked).toBe(false);
		// 服务设置页里不再有这个开关。
		byText(".tab", "服务设置")?.click();
		await settle();
		expect(root.textContent).not.toContain("每个系列只保留最新版");
	});
});

describe("添加服务", () => {
	it("“每个系列只保留最新版”默认勾选，提交时放进 service.latestPerFamily", async () => {
		const server = fakeServer(state([]));
		await open(server);
		const checkbox = $(".latest-new input") as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
		await type($$(".form input")[0], "My Relay");
		expect(($$(".form input")[1] as HTMLInputElement).value).toBe("my-relay");
		await type($$(".form input")[2], "https://relay.test");
		server.handlers.saveService = (body) => state([service(body?.service.name, [])]);
		byText(".actions .btn", "添加")?.click();
		await settle();
		const body = server.posts().find((call) => call.path === "saveService")?.body;
		expect(body?.service).toMatchObject({ name: "my-relay", displayName: "My Relay", baseUrl: "https://relay.test", latestPerFamily: true });
		expect(body?.previousName).toBeUndefined();
		expect($(".head h1")?.textContent).toContain("my-relay");
	});

	it("取消勾选时提交 false；修改已有服务时不带这个字段", async () => {
		const server = fakeServer(state([service("relay", [])]));
		await open(server);
		byText(".side-foot .btn", "添加服务")?.click();
		await settle();
		toggle($(".latest-new input"));
		await type($$(".form input")[1], "cpa");
		await type($$(".form input")[2], "https://cpa.test");
		byText(".actions .btn", "添加")?.click();
		await settle();
		expect(server.posts().find((call) => call.path === "saveService")?.body?.service.latestPerFamily).toBe(false);

		server.calls.length = 0;
		server.current = state([service("relay", []), service("cpa", [])]);
		byText(".svc .name", "relay")?.click();
		await settle();
		byText(".tab", "服务设置")?.click();
		await settle();
		byText(".actions .btn", "保存")?.click();
		await settle();
		const body = server.posts().find((call) => call.path === "saveService")?.body;
		expect(body?.previousName).toBe("relay");
		expect(body?.service).not.toHaveProperty("latestPerFamily");
	});

	it("保存失败时保留已填内容，密钥框不让浏览器填入已存密码", async () => {
		const server = fakeServer(state([]));
		await open(server);
		const key = $$(".form input")[3] as HTMLInputElement;
		expect(key.type).toBe("password");
		expect(key.getAttribute("autocomplete")).toBe("one-time-code");
		expect(key.hasAttribute("data-1p-ignore")).toBe(true);
		expect(key.hasAttribute("data-bwignore")).toBe(true);
		expect(key.getAttribute("data-lpignore")).toBe("true");
		await type($$(".form input")[1], "relay");
		await type(key, "sk-1");
		server.handlers.saveService = () => ({ status: 400, error: "地址不对" });
		byText(".actions .btn", "添加")?.click();
		await settle();
		expect($(".banner.err")?.textContent).toContain("地址不对");
		expect(($$(".form input")[1] as HTMLInputElement).value).toBe("relay");
		expect(($$(".form input")[3] as HTMLInputElement).value).toBe("sk-1");
	});
});

describe("详情面板", () => {
	it("点不了的星标不挡住列表行，点它也打开详情", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")])]));
		await open(server);
		const star = rowOf("a-1").querySelector(".star") as HTMLElement;
		expect(star.getAttribute("aria-disabled")).toBe("true");
		expect(star.hasAttribute("disabled")).toBe(false);
		star.click();
		await settle();
		expect($(".drawer")).not.toBeNull();
	});

	it("点不了的启用开关（非对话模型）不勾选，也打开详情", async () => {
		const server = fakeServer(state([service("relay", [model("jev-1", { modelType: "decision" })])]));
		await open(server);
		const toggleInput = rowOf("jev-1").querySelector(".switch") as HTMLInputElement;
		expect(toggleInput.getAttribute("aria-disabled")).toBe("true");
		expect(toggleInput.hasAttribute("disabled")).toBe(false);
		toggleInput.click();
		await settle();
		expect(toggleInput.checked).toBe(false);
		expect($(".drawer .model-id")?.textContent).toBe("jev-1");
		expect(server.posts().some((call) => call.path === "setEnabled")).toBe(false);
	});

	it("输入法选字时（keyCode 229）的 Esc 不关闭面板", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")])]));
		await open(server);
		rowOf("a-1").click();
		await settle();
		const event = new KeyboardEvent("keydown", { key: "Escape" });
		Object.defineProperty(event, "keyCode", { value: 229 });
		document.dispatchEvent(event);
		await settle();
		expect($(".drawer")).not.toBeNull();
	});

	it("输入法选字时的 Esc 不关闭，有未保存的修改时先确认", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")])]));
		await open(server);
		rowOf("a-1").click();
		await settle();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
		await settle();
		expect($(".drawer")).not.toBeNull();

		const input = $(".drawer .form input") as HTMLInputElement;
		await type(input, "x");
		input.blur();
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await settle();
		expect(confirm).toHaveBeenCalledWith("放弃没保存的修改？");
		expect($(".drawer")).not.toBeNull();

		vi.stubGlobal("confirm", () => true);
		($(".scrim") as HTMLElement).click();
		await settle();
		expect($(".drawer")).toBeNull();
	});

	it("保存手动设置：数字接受 1M，填错时错误显示在底部按钮上方", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")])]));
		await open(server);
		rowOf("a-1").click();
		await settle();
		const inputs = $$(".drawer .form input");
		await type(inputs[2], "abc");
		byText(".drawer-foot .btn", "保存")?.click();
		await settle();
		expect($(".drawer-msg .banner.err")?.textContent).toContain("上下文填的“abc”不是正整数");
		expect(server.posts().some((call) => call.path === "setOverride")).toBe(false);

		await type(inputs[2], "1M");
		server.handlers.setOverride = (body) => state([service("relay", [model("a-1", { override: body?.override, contextWindow: { value: 1000000, source: "manual" } })])]);
		byText(".drawer-foot .btn", "保存")?.click();
		await settle();
		expect(server.posts().at(-1)?.body).toEqual({ name: "relay", id: "a-1", override: { contextWindow: 1000000 } });
		expect($(".drawer-msg")?.matches(":empty")).toBe(true);
		expect($(".drawer .kv")?.textContent).toContain("1,000,000");
		// 保存后表单按保存的值重建，关闭时不再询问。
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		byText(".drawer .close", "×")?.click();
		await settle();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("取消默认模型时带上星标代表的模型，默认模型已经换了时提示", async () => {
		const server = fakeServer(state([service("relay", [model("a-1", { enabled: true })])], { defaultModel: { provider: "relay", id: "a-1" } }));
		await open(server);
		server.handlers.clearDefaultModel = () => ({ ...state([service("relay", [model("a-1", { enabled: true })])], { defaultModel: { provider: "x", id: "y" } }), defaultChanged: true });
		(rowOf("a-1").querySelector(".star.on") as HTMLElement).click();
		await settle();
		expect(server.posts().at(-1)).toEqual({ path: "clearDefaultModel", body: { name: "relay", id: "a-1" } });
		expect($(".toast")?.textContent).toBe("pi 默认模型已经换了，没有取消，页面已更新");
		expect($(".drawer")).toBeNull();
	});

	it("操作失败的原因也显示在详情面板里", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")])]));
		await open(server);
		rowOf("a-1").click();
		await settle();
		server.handlers.setEnabled = () => ({ status: 400, error: "先设置密钥" });
		toggle($(".drawer .drawer-toggle"));
		await settle();
		expect($(".drawer-msg .banner.err")?.textContent).toBe("先设置密钥");
		expect(($(".drawer .drawer-toggle") as HTMLInputElement).checked).toBe(false);
	});
});

describe("写操作和刷新的顺序", () => {
	it("手动刷新等此前排队的写操作完成再发，刷新期间后来的写操作照常发出", async () => {
		const server = fakeServer(state([
			service("a", [model("gpt-6-sol", { enabled: true })], { latestPerFamily: true }),
			service("b", []),
		]));
		await open(server);
		server.calls.length = 0;
		// b 的保存在等目录返回。
		const slowSave = deferred<Json>();
		server.handlers.saveService = () => slowSave.promise;
		byText(".svc .name", "b")?.click();
		await settle();
		byText(".tab", "服务设置")?.click();
		await settle();
		byText(".actions .btn", "保存")?.click();
		await settle();
		// 切到 a，关掉“每系最新”，开关立即显示关，请求还在队列里。
		byText(".svc .name", "a")?.click();
		await settle();
		server.handlers.setLatestPerFamily = (body) => (server.current = state([
			service("a", [model("gpt-6-sol", { enabled: true })], { latestPerFamily: body?.latestPerFamily }),
			service("b", []),
		]));
		toggle($(".latest-toggle input"));
		await settle();
		expect(($(".latest-toggle input") as HTMLInputElement).checked).toBe(false);
		const slowRefresh = deferred<Json>();
		server.handlers.refresh = () => slowRefresh.promise;
		byText(".head .btn", "刷新目录")?.click();
		await settle();
		expect(server.posts().map((call) => call.path)).toEqual(["saveService"]);

		slowSave.resolve(server.current);
		await settle();
		expect(server.posts().map((call) => call.path)).toEqual(["saveService", "setLatestPerFamily", "refresh"]);
		expect(server.posts()[1].body).toEqual({ name: "a", latestPerFamily: false });

		// 刷新还没返回，这时的写操作不用等它。b 保存成功后页面切到了 b，先回到 a。
		byText(".svc .name", "a")?.click();
		await settle();
		toggle(rowOf("gpt-6-sol").querySelector(".switch"));
		await settle();
		expect(server.posts().map((call) => call.path)).toEqual(["saveService", "setLatestPerFamily", "refresh", "setEnabled"]);
		slowRefresh.resolve(server.current);
		await settle();
		expect(byText(".head .btn", "刷新目录")).toBeTruthy();
	});

	it("重新启用服务后的后台刷新也排在此前的写操作后面", async () => {
		const server = fakeServer(state([service("a", [], { status: { disabled: true, keySource: "file" } }), service("b", [model("b-1")])]));
		await open(server);
		server.calls.length = 0;
		// 重新启用 a 的请求还没返回时，又在 b 里启用了模型。a 的刷新要等 b 的这次修改完成。
		const slowEnable = deferred<Json>();
		const slowWrite = deferred<Json>();
		server.handlers.setServiceDisabled = () => slowEnable.promise;
		server.handlers.setEnabled = () => slowWrite.promise;
		// 左栏里 b 在前，停用的 a 在后。
		toggle($$(".svc .switch")[1]);
		await settle();
		toggle(rowOf("b-1").querySelector(".switch"));
		await settle();
		expect(server.posts().map((call) => call.path)).toEqual(["setServiceDisabled"]);
		slowEnable.resolve(server.current = state([service("a", []), service("b", [model("b-1")])]));
		await settle();
		expect(server.posts().map((call) => call.path)).toEqual(["setServiceDisabled", "setEnabled"]);
		slowWrite.resolve(server.current);
		await settle();
		expect(server.posts().map((call) => call.path)).toEqual(["setServiceDisabled", "setEnabled", "refresh"]);
		expect(server.posts()[2].body).toEqual({ name: "a" });
	});

	it("同一开关连续“开 → 关”，第一个请求先完成时开关仍显示关", async () => {
		const server = fakeServer(state([service("relay", [])]));
		await open(server);
		const replies = [deferred<Json>(), deferred<Json>()];
		let n = 0;
		server.handlers.setLatestPerFamily = () => replies[n++].promise;
		const input = () => $(".latest-toggle input") as HTMLInputElement;
		toggle(input());
		await settle();
		expect(input().checked).toBe(true);
		toggle(input());
		await settle();
		expect(input().checked).toBe(false);
		replies[0].resolve(state([service("relay", [], { latestPerFamily: true })]));
		await settle();
		expect(input().checked).toBe(false);
		expect($(".latest-toggle")?.textContent).toContain("未开启");
		replies[1].resolve(state([service("relay", [], { latestPerFamily: false })]));
		await settle();
		expect(input().checked).toBe(false);
		expect(server.posts().filter((call) => call.path === "setLatestPerFamily").map((call) => call.body?.latestPerFamily)).toEqual([true, false]);
	});

	it("按着指针时推迟采用后台刷新带来的状态，松开后再采用", async () => {
		const refresh = deferred<Json>();
		const server = fakeServer(state([service("relay", [model("gpt-6-sol")])]));
		server.handlers.refresh = () => refresh.promise;
		await open(server);
		document.dispatchEvent(new Event("pointerdown"));
		refresh.resolve(state([service("relay", [model("gpt-6.1-sol"), model("gpt-6-sol")])]));
		await settle();
		expect(rowIds()).toEqual(["gpt-6-sol"]);
		expect(byText(".head .btn", "刷新中…")).toBeTruthy();
		document.dispatchEvent(new Event("pointerup"));
		await settle();
		expect(rowIds()).toEqual(["gpt-6.1-sol", "gpt-6-sol"]);
		expect(byText(".head .btn", "刷新目录")).toBeTruthy();
	});
});

describe("草稿和冻结的范围", () => {
	it("同一服务切换标签页时保留服务表单和密钥草稿，切换服务后丢掉", async () => {
		const server = fakeServer(state([service("relay", []), service("cpa", [])]));
		await open(server);
		byText(".tab", "服务设置")?.click();
		await settle();
		await type($(".key-row input"), "sk-typed");
		await type($$(".form input")[0], "新名字");
		byText(".tab", "模型")?.click();
		await settle();
		byText(".tab", "服务设置")?.click();
		await settle();
		expect(($(".key-row input") as HTMLInputElement).value).toBe("sk-typed");
		expect(($$(".form input")[0] as HTMLInputElement).value).toBe("新名字");

		byText(".svc .name", "cpa")?.click();
		await settle();
		byText(".svc .name", "relay")?.click();
		await settle();
		byText(".tab", "服务设置")?.click();
		await settle();
		expect(($(".key-row input") as HTMLInputElement).value).toBe("");
		expect(($$(".form input")[0] as HTMLInputElement).value).toBe("");
	});

	it("添加服务的草稿在再点“添加服务”时丢掉", async () => {
		const server = fakeServer(state([service("relay", [])]));
		await open(server);
		byText(".side-foot .btn", "添加服务")?.click();
		await settle();
		await type($$(".form input")[2], "https://x.test");
		byText(".side-foot .btn", "添加服务")?.click();
		await settle();
		expect(($$(".form input")[2] as HTMLInputElement).value).toBe("");
	});

	it("保存成功后按服务端返回的值重填表单", async () => {
		const server = fakeServer(state([service("relay", [])]));
		await open(server);
		byText(".tab", "服务设置")?.click();
		await settle();
		await type($$(".form input")[2], "https://relay.test/v1/");
		server.handlers.saveService = () => (server.current = state([service("relay", [], { baseUrl: "https://relay.test" })]));
		byText(".actions .btn", "保存")?.click();
		await settle();
		expect(server.posts().at(-1)?.body?.service.baseUrl).toBe("https://relay.test/v1/");
		expect(($$(".form input")[2] as HTMLInputElement).value).toBe("https://relay.test");
		byText(".tab", "模型")?.click();
		await settle();
		byText(".tab", "服务设置")?.click();
		await settle();
		expect(($$(".form input")[2] as HTMLInputElement).value).toBe("https://relay.test");
	});

	it("切换标签页保留冻结的行，进入“添加服务”再回来后重新选", async () => {
		const server = fakeServer(state([service("relay", [model("a-1", { enabled: true, hidden: true }), model("a-2")]), service("cpa", [])]));
		await open(server);
		server.handlers.setEnabled = () => (server.current = state([service("relay", [model("a-1", { hidden: true }), model("a-2")]), service("cpa", [])]));
		toggle(rowOf("a-1").querySelector(".switch"));
		await settle();
		expect(rowIds()).toEqual(["a-2", "a-1"]);
		byText(".tab", "服务设置")?.click();
		await settle();
		byText(".tab", "模型")?.click();
		await settle();
		expect(rowIds()).toEqual(["a-2", "a-1"]);
		byText(".side-foot .btn", "添加服务")?.click();
		await settle();
		byText(".svc .name", "relay")?.click();
		await settle();
		expect(rowIds()).toEqual(["a-2"]);
	});

	it("A 正在“换成新版”时切到 B，B 的横幅按钮照常可用", async () => {
		const updates = [{ from: "x-1", to: "x-2" }];
		const server = fakeServer(state([service("a", [], { updates }), service("b", [], { updates })]));
		await open(server);
		const slow = deferred<Json>();
		server.handlers.applyLatestOnce = () => slow.promise;
		byText(".latest-banner .btn", "换成新版")?.click();
		await settle();
		expect(byText(".latest-banner .btn", "替换中…")?.hasAttribute("disabled")).toBe(true);
		byText(".svc .name", "b")?.click();
		await settle();
		const button = byText(".latest-banner .btn", "换成新版");
		expect(button).toBeTruthy();
		expect(button?.hasAttribute("disabled")).toBe(false);
		slow.resolve({ ...server.current, replaced: [] });
		await settle();
		expect($(".toast")?.textContent).toBe("没有可换的新版，页面已更新");
	});
});

describe("详情面板的提示和测试档位", () => {
	const levels = (list: string[]) => ({ levels: list, thinkingLevelMap: { value: {}, source: "manual" } });

	it("选中的测试档位被手动设置去掉后，按“不设置”显示和发送", async () => {
		const server = fakeServer(state([service("relay", [model("a-1", levels(["off", "low", "high"]))])]));
		await open(server);
		rowOf("a-1").click();
		await settle();
		const pick = () => $(".drawer-foot select") as HTMLSelectElement;
		pick().value = "high";
		pick().dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		await type($$(".drawer .form input")[4], "low");
		server.handlers.setOverride = () => state([service("relay", [model("a-1", { ...levels(["low"]), override: { thinkingLevels: ["low"] } })])]);
		byText(".drawer-foot .btn", "保存")?.click();
		await settle();
		expect([...pick().options].map((option) => option.value)).toEqual(["", "low"]);
		expect(pick().value).toBe("");
		server.handlers.testModel = (body) => ({ test: { ok: true, stopReason: "stop", text: "OK", durationMs: 100, request: { api: "x", baseUrl: "y", id: "a-1", thinkingLevel: body?.thinkingLevel } } });
		byText(".drawer-foot .btn", "发送测试消息")?.click();
		await settle();
		expect(server.posts().at(-1)?.body).toEqual({ name: "relay", id: "a-1" });
	});

	it("提示区显示最新的内容：测试结果盖住旧的校验错误，新错误盖住测试结果", async () => {
		const server = fakeServer(state([service("relay", [model("a-1")])]));
		await open(server);
		rowOf("a-1").click();
		await settle();
		await type($$(".drawer .form input")[2], "abc");
		byText(".drawer-foot .btn", "保存")?.click();
		await settle();
		expect($(".drawer-msg .banner.err")?.textContent).toContain("不是正整数");
		server.handlers.testModel = () => ({ test: { ok: true, stopReason: "stop", text: "OK", durationMs: 100, request: { api: "x", baseUrl: "y", id: "a-1" } } });
		byText(".drawer-foot .btn", "发送测试消息")?.click();
		await settle();
		expect($(".drawer-msg .banner.err")).toBeNull();
		expect($(".drawer-msg .result.ok")?.textContent).toContain("回复：OK");

		server.handlers.setEnabled = () => ({ status: 400, error: "先设置密钥" });
		toggle($(".drawer .drawer-toggle"));
		await settle();
		expect($(".drawer-msg")?.textContent).toBe("先设置密钥");
		// 操作成功后错误清掉，被盖住的测试结果不再出现。
		server.handlers.setEnabled = () => server.current;
		toggle($(".drawer .drawer-toggle"));
		await settle();
		expect($(".drawer-msg")?.matches(":empty")).toBe(true);
	});
});

describe("纯函数", () => {
	it("parseCount 接受千位分隔和 K、M 后缀，拒绝认不出的写法", () => {
		expect(parseCount("1,000,000", "x")).toBe(1000000);
		expect(parseCount("1 000 000", "x")).toBe(1000000);
		expect(parseCount("1.1M", "x")).toBe(1100000);
		expect(parseCount("200k", "x")).toBe(200000);
		expect(() => parseCount("1,5M", "x")).toThrow();
		expect(() => parseCount("1.0001K", "x")).toThrow();
		expect(() => parseCount("0", "x")).toThrow();
	});

	it("版本号和前缀", () => {
		expect(versionOf("gpt-6.1-sol")).toEqual([6, 1]);
		expect(versionOf("claude-opus-4-6-thinking")).toEqual([4, 6]);
		expect(versionOf("gpt-4o-2024-08-06")).toEqual([4]);
		expect(versionOf("gpt-oss-120b")).toEqual([]);
		expect(prefixOf("openai/gpt-6.1-sol")).toBe("gpt");
		expect(prefixOf("qwen3-coder")).toBe("qwen");
	});
});
