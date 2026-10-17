import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { withBetas } from "../betas.ts";
import type { ModelOverride, ServiceConfig } from "../config.ts";
import { describeError, type Endpoints } from "../endpoints.ts";
import { type ResolvedModel, SUPPORTED_APIS, supportedLevels, toProviderModel } from "../resolve.ts";

export interface WebUI {
	url: string;
	close(): Promise<void>;
}

const PAGE = new URL("./page.html", import.meta.url);
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
			"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
			"Referrer-Policy": "no-referrer",
		});
		response.end(html);
		return;
	}

	if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "没有这个页面");
	const header = request.headers["x-endpoints-token"];
	if (!sameToken(Array.isArray(header) ? header[0] : header, token)) throw new HttpError(403, "token 无效");

	if (request.method === "GET" && url.pathname === "/api/state") {
		sendJson(response, 200, state(endpoints));
		return;
	}
	if (request.method !== "POST") throw new HttpError(405, "只接受 POST");
	// 要求 JSON，跨站页面发这种请求必须先过 CORS 预检，而这里不回应预检。
	if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "只接受 JSON");
	const body = (await readBody(request)) as Record<string, unknown>;
	const result = await action(endpoints, url.pathname.slice("/api/".length), body);
	sendJson(response, 200, result ?? state(endpoints));
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

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	if (response.headersSent) return;
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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
			endpoints.saveService(
				{
					name: str(input.name, "name").trim(),
					displayName: input.displayName?.trim() || undefined,
					baseUrl: str(input.baseUrl, "baseUrl"),
					defaultApi: input.defaultApi || undefined,
					apiKeyEnv: input.apiKeyEnv?.trim() || undefined,
					headers: input.headers && Object.keys(input.headers).length ? input.headers : undefined,
				} as ServiceConfig,
				typeof body.previousName === "string" ? body.previousName : undefined,
			);
			return undefined;
		}
		case "removeService":
			endpoints.removeService(str(body.name, "name"));
			return undefined;
		case "setKey":
			endpoints.setKey(str(body.name, "name"), str(body.apiKey, "apiKey"));
			return undefined;
		case "refresh": {
			try {
				await endpoints.refresh(str(body.name, "name"));
				endpoints.register(str(body.name, "name"));
			} catch (error) {
				return { ...state(endpoints), refreshError: describeError(error) };
			}
			return undefined;
		}
		case "setEnabled":
			endpoints.setEnabled(str(body.name, "name"), str(body.id, "id"), body.enabled === true);
			return undefined;
		case "setOverride":
			endpoints.setOverride(str(body.name, "name"), str(body.id, "id"), body.override as ModelOverride | undefined);
			return undefined;
		case "testModel":
			return testModel(endpoints, str(body.name, "name"), str(body.id, "id"));
		default:
			throw new HttpError(404, `没有 ${name} 这个操作`);
	}
}

/** 用当前解析出的参数直接发一条消息，失败时原样返回服务端的错误。 */
async function testModel(endpoints: Endpoints, name: string, id: string) {
	const resolved = endpoints.models(name).find((model) => model.id === id);
	if (!resolved) throw new HttpError(404, `${name} 上没有 ${id}`);
	const apiKey = endpoints.apiKey(name);
	if (!apiKey) throw new HttpError(400, `服务 ${name} 还没有设置密钥`);
	const model = { ...toProviderModel(resolved), provider: name } as Model<Api>;
	const started = Date.now();
	const message = await completeSimple(
		model,
		{ messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] },
		withBetas({ apiKey, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) }, resolved.betas),
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
			request: { api: model.api, baseUrl: model.baseUrl, id: model.id },
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
		apis: SUPPORTED_APIS,
		loadError: endpoints.loadError,
		services: endpoints.config.services.map((service) => {
			const catalog = endpoints.catalog(service.name);
			return {
				name: service.name,
				displayName: service.displayName ?? "",
				baseUrl: service.baseUrl,
				defaultApi: service.defaultApi ?? "",
				apiKeyEnv: service.apiKeyEnv ?? "",
				headers: service.headers ?? {},
				status: statuses.get(service.name),
				catalog: catalog ? { fetchedAt: catalog.fetchedAt, codex: catalog.codex, size: catalog.models.length } : undefined,
				models: endpoints.models(service.name).map((model) => modelView(model, service)),
			};
		}),
	};
}
