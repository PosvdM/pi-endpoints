import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { withBetas } from "../betas.ts";
import { clearDefaultModel, readDefaultModel, writeDefaultModel } from "../defaults.ts";
import type { ModelOverride, ServiceConfig } from "../config.ts";
import { describeError, type Endpoints, typeLabel } from "../endpoints.ts";
import { modelsDevStatus } from "../modelsdev.ts";
import { isChatModel, type ResolvedModel, SUPPORTED_APIS, supportedLevels, toProviderModel } from "../resolve.ts";
import { checkUpdate, VERSION } from "../version.ts";

export interface WebUI {
	url: string;
	close(): Promise<void>;
}

const PAGE = new URL("./page.html", import.meta.url);
/** 页面自己的脚本和样式在 `src/web/app/` 下，只提供这一层里文件名符合 `APP_FILE` 的文件。 */
const APP_DIR = new URL("./app/", import.meta.url);
const APP_FILE = /^[a-z0-9-]+\.(?:js|css)$/;
// 不命名为 require：转译成 CommonJS 的加载器里，模块作用域已经有同名参数。
const resolveModule = createRequire(import.meta.url).resolve;
/**
 * 页面用到的第三方模块，从本插件的 dependencies 里找 ESM 文件。page.html 的 import map 把包名指向这些地址。
 * htm 的 `require` 条件指向 UMD 文件，浏览器不能当模块导入，所以取同目录下的 `htm.module.js`。
 */
const VENDOR: Record<string, () => string> = {
	"preact.js": () => resolveModule("preact"),
	"hooks.js": () => resolveModule("preact/hooks"),
	"htm.js": () => join(dirname(resolveModule("htm")), "htm.module.js"),
};
const MAX_BODY = 1024 * 1024;
const TEST_TIMEOUT_MS = 60_000;

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * 在 127.0.0.1 的随机端口启动管理页。每次启动生成新的 token，页面和接口都要带上它，
 * 防止本机其他网页伪造请求；同时检查 Host，防止 DNS 重绑定。
 */
export async function startWebUI(endpoints: Endpoints): Promise<WebUI> {
	const token = randomBytes(24).toString("hex");
	const server = createServer((request, response) => {
		handle(endpoints, token, request, response).catch((error) => {
			// 其余错误来自配置校验这类用户输入问题。
			const status = error instanceof HttpError ? error.status : 400;
			sendJson(response, status, { error: describeError(error) });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function sameToken(given: string | null | undefined, token: string): boolean {
	if (!given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(endpoints: Endpoints, token: string, request: IncomingMessage, response: ServerResponse) {
	const port = (request.socket.localPort ?? 0).toString();
	if (request.headers.host !== `127.0.0.1:${port}`) throw new HttpError(403, "Host 不对");
	const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

	if (request.method === "GET" && url.pathname === "/") {
		if (!sameToken(url.searchParams.get("token"), token)) throw new HttpError(403, "链接无效，请在 pi 里重新运行 /endpoints");
		const html = readFileSync(PAGE, "utf8").replace("__TOKEN__", token);
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": pagePolicy(html),
			"Referrer-Policy": "no-referrer",
		});
		response.end(html);
		return;
	}

	// 脚本、样式和第三方模块不含密钥，不要求 token；Host 已经在上面检查过。
	if (request.method === "GET" && (url.pathname.startsWith("/app/") || url.pathname.startsWith("/vendor/"))) {
		sendStatic(response, url.pathname);
		return;
	}

	if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "没有这个页面");
	const header = request.headers["x-endpoints-token"];
	if (!sameToken(Array.isArray(header) ? header[0] : header, token)) throw new HttpError(403, "token 无效");

	if (request.method === "GET" && url.pathname === "/api/state") {
		sendJson(response, 200, state(endpoints));
		return;
	}
	// 查询 npm 可能要等几秒，所以和状态分开，页面拿到状态后再单独请求。
	if (request.method === "GET" && url.pathname === "/api/update") {
		sendJson(response, 200, await checkUpdate());
		return;
	}
	if (request.method !== "POST") throw new HttpError(405, "只接受 POST");
	// 要求 JSON，跨站页面发这种请求必须先过 CORS 预检，而这里不回应预检。
	if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "只接受 JSON");
	const body = (await readBody(request)) as Record<string, unknown>;
	const result = await action(endpoints, url.pathname.slice("/api/".length), body);
	// 操作自己带回的状态（如刷新结果）在 await 之后才发出，这期间别的请求可能已经改了数据。
	// 这里重新生成一次状态，保留操作附带的字段（refreshError、defaultChanged、replaced 等），让状态和 sendJson() 的编号在同一段同步代码里产生。
	const services = result !== null && typeof result === "object" && "services" in result;
	sendJson(response, 200, services ? { ...result, ...state(endpoints) } : (result ?? state(endpoints)));
}

/**
 * 页面的 CSP：脚本和样式只能来自本机服务，内联脚本只放行 import map，按内容的 SHA-256 放行。
 * 哈希在每次请求时按 page.html 的内容计算，改了 import map 不用同步改这里。
 */
export function pagePolicy(html: string): string {
	const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1];
	const hash = importMap === undefined ? "" : ` 'sha256-${createHash("sha256").update(importMap).digest("base64")}'`;
	return `default-src 'none'; script-src 'self'${hash}; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

function sendStatic(response: ServerResponse, pathname: string): void {
	const [, dir, file = "", ...rest] = pathname.split("/");
	let source: URL | string | undefined;
	try {
		if (rest.length === 0 && dir === "app" && APP_FILE.test(file)) source = new URL(file, APP_DIR);
		else if (rest.length === 0 && dir === "vendor" && Object.hasOwn(VENDOR, file)) source = VENDOR[file]();
	} catch {
		// 依赖没装上时按文件不存在处理。
	}
	let body: Buffer;
	try {
		if (!source) throw new Error();
		body = readFileSync(source);
	} catch {
		throw new HttpError(404, "没有这个文件");
	}
	response.writeHead(200, {
		"Content-Type": file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpError(413, "请求太大");
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new HttpError(400, "请求不是合法的 JSON");
	}
}

/**
 * 响应的编号，按生成顺序递增。调用方在同一段同步代码里生成状态并调用 sendJson()，编号大的状态就是更新的。
 * 页面并发请求时，响应到达的顺序可能和生成顺序不同，页面只采用编号比已采用的大的状态。
 */
let responseSeq = 0;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	if (response.headersSent) return;
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Endpoints-Seq": String(++responseSeq),
	});
	response.end(JSON.stringify(value));
}

const str = (value: unknown, field: string): string => {
	if (typeof value !== "string") throw new HttpError(400, `${field} 必须是字符串`);
	return value;
};

async function action(endpoints: Endpoints, name: string, body: Record<string, unknown>): Promise<unknown> {
	switch (name) {
		case "saveService": {
			const input = body.service as Partial<ServiceConfig> | undefined;
			if (!input) throw new HttpError(400, "缺少 service");
			const previousName = typeof body.previousName === "string" ? body.previousName : undefined;
			const service = endpoints.saveService(
				{
					name: str(input.name, "name").trim(),
					displayName: input.displayName?.trim() || undefined,
					baseUrl: str(input.baseUrl, "baseUrl"),
					defaultApi: input.defaultApi || undefined,
					apiKeyEnv: input.apiKeyEnv?.trim() || undefined,
					headers: input.headers && Object.keys(input.headers).length ? input.headers : undefined,
					// 只在新建时生效，编辑已有服务时由 Endpoints.saveService() 沿用原值。不传时关闭。
					latestPerFamily: input.latestPerFamily === true || undefined,
				} as ServiceConfig,
				previousName,
			);
			// 添加服务时可以一起带上密钥，能拿到密钥就接着拉一次目录。拉取失败不影响添加。
			if (typeof body.apiKey === "string" && body.apiKey.trim()) endpoints.setKey(service.name, body.apiKey);
			if (previousName === undefined && endpoints.keySource(service.name)) return refreshService(endpoints, service.name);
			return undefined;
		}
		case "removeService":
			endpoints.removeService(str(body.name, "name"));
			return undefined;
		case "setKey":
			endpoints.setKey(str(body.name, "name"), str(body.apiKey, "apiKey"));
			return undefined;
		case "refresh":
			return refreshService(endpoints, str(body.name, "name"));
		case "setServiceDisabled":
			endpoints.setServiceDisabled(str(body.name, "name"), body.disabled === true);
			return undefined;
		case "setLatestPerFamily":
			await endpoints.setLatestPerFamily(str(body.name, "name"), body.latestPerFamily === true);
			return undefined;
		case "applyLatestOnce": {
			// 按“每系最新”的规则只替换这一次，不改开关。
			const replaced = await endpoints.applyLatestOnce(str(body.name, "name"));
			return { ...state(endpoints), replaced };
		}
		case "setDefaultModel": {
			const name = str(body.name, "name");
			const id = str(body.id, "id");
			if (!endpoints.service(name)?.enabled.includes(id)) throw new HttpError(400, "先启用这个模型");
			const model = endpoints.models(name).find((item) => item.id === id);
			if (model && !isChatModel(model)) throw new HttpError(400, `${id} 是${typeLabel(model.modelType)}，pi 不能拿它对话`);
			if (!endpoints.status().find((status) => status.name === name)?.registered) throw new HttpError(400, `服务 ${name} 没有注册到 pi`);
			await writeDefaultModel(name, id);
			return undefined;
		}
		case "clearDefaultModel": {
			// 带上页面认为的当前默认模型，已经被换掉时不清除，返回最新状态。
			const cleared = await clearDefaultModel({ provider: str(body.name, "name"), id: str(body.id, "id") });
			return cleared ? undefined : { ...state(endpoints), defaultChanged: true };
		}
		case "setEnabled":
			endpoints.setEnabled(str(body.name, "name"), str(body.id, "id"), body.enabled === true);
			return undefined;
		case "setOverride":
			endpoints.setOverride(str(body.name, "name"), str(body.id, "id"), body.override as ModelOverride | undefined);
			return undefined;
		case "testModel": {
			const level = body.thinkingLevel;
			if (level !== undefined && typeof level !== "string") throw new HttpError(400, "thinkingLevel 必须是字符串");
			return testModel(endpoints, str(body.name, "name"), str(body.id, "id"), level);
		}
		default:
			throw new HttpError(404, `没有 ${name} 这个操作`);
	}
}

/**
 * 刷新服务目录，等 models.dev 更新完（最多 60 秒），目录刷新成功时再按“每系最新”调整启用的模型。
 * models.dev 失败不算刷新失败，原因在状态的 `modelsDev.error` 里。
 */
async function refreshService(endpoints: Endpoints, name: string) {
	const refreshError = await endpoints.refreshForPage(name);
	return refreshError === undefined ? undefined : { ...state(endpoints), refreshError };
}

/**
 * 用当前解析出的参数直接发一条消息，失败时原样返回服务端的错误。
 * `thinkingLevel` 必须是这个模型可选的档位（off 除外），不传时不设置思考档位。
 */
async function testModel(endpoints: Endpoints, name: string, id: string, thinkingLevel?: string) {
	const resolved = endpoints.models(name).find((model) => model.id === id);
	if (!resolved) throw new HttpError(404, `${name} 上没有 ${id}`);
	if (thinkingLevel !== undefined) {
		const levels = supportedLevels(resolved.reasoning.value, resolved.thinkingLevelMap.value).filter((level) => level !== "off");
		if (!levels.includes(thinkingLevel)) {
			throw new HttpError(400, levels.length ? `${id} 的思考档位只能是 ${levels.join("、")}` : `${id} 不支持调节思考档位`);
		}
	}
	const apiKey = endpoints.apiKey(name);
	if (!apiKey) throw new HttpError(400, `服务 ${name} 还没有设置密钥`);
	const model = { ...toProviderModel(resolved), provider: name } as Model<Api>;
	const started = Date.now();
	const message = await completeSimple(
		model,
		{ messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] },
		withBetas(
			{ apiKey, signal: AbortSignal.timeout(TEST_TIMEOUT_MS), reasoning: thinkingLevel as ThinkingLevel | undefined },
			resolved.betas,
		),
	);
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	return {
		test: {
			ok: message.stopReason !== "error" && message.stopReason !== "aborted",
			stopReason: message.stopReason,
			text,
			error: message.errorMessage,
			durationMs: Date.now() - started,
			request: { api: model.api, baseUrl: model.baseUrl, id: model.id, thinkingLevel },
		},
	};
}

function modelView(model: ResolvedModel, service: ServiceConfig) {
	return {
		...model,
		enabled: service.enabled.includes(model.id),
		levels: supportedLevels(model.reasoning.value, model.thinkingLevelMap.value),
		override: service.overrides[model.id] ?? {},
	};
}

function state(endpoints: Endpoints) {
	const statuses = new Map(endpoints.status().map((status) => [status.name, status]));
	return {
		version: VERSION,
		apis: SUPPORTED_APIS,
		loadError: endpoints.loadError,
		defaultModel: readDefaultModel(),
		modelsDev: modelsDevStatus(),
		services: endpoints.config.services.map((service) => {
			const catalog = endpoints.catalog(service.name);
			return {
				name: service.name,
				displayName: service.displayName ?? "",
				baseUrl: service.baseUrl,
				defaultApi: service.defaultApi ?? "",
				apiKeyEnv: service.apiKeyEnv ?? "",
				headers: service.headers ?? {},
				latestPerFamily: service.latestPerFamily === true,
				// 开关关着时，打开开关会发生的替换，只用于提示。
				updates: endpoints.updates(service.name),
				status: statuses.get(service.name),
				catalog: catalog ? { fetchedAt: catalog.fetchedAt, codex: catalog.codex, size: catalog.models.length } : undefined,
				models: endpoints.models(service.name).map((model) => modelView(model, service)),
			};
		}),
	};
}
