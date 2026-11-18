import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeError, type Endpoints } from "./endpoints.ts";
import { type WebUI, startWebUI } from "./web/server.ts";

/** `/endpoints` 打开管理页，所有操作都在管理页里完成。 */
export function registerCommands(pi: ExtensionAPI, endpoints: Endpoints): void {
	// 存 Promise 而不是结果，连按两次 /endpoints 时不会启动两个服务器。
	let web: Promise<WebUI> | undefined;

	pi.on("session_shutdown", async () => {
		const running = web;
		web = undefined;
		await (await running?.catch(() => undefined))?.close();
	});

	pi.registerCommand("endpoints", {
		description: "打开 pi-endpoints 管理页",
		handler: async (_args, ctx) => {
			web ??= startWebUI(endpoints);
			let ui: WebUI;
			try {
				ui = await web;
			} catch (error) {
				web = undefined;
				ctx.ui.notify(`管理页启动失败：${describeError(error)}`, "error");
				return;
			}
			const url = pageUrl(ui.url, endpoints);
			openBrowser(url);
			ctx.ui.notify(`管理页已打开：${url}`, "info");
		},
	});
}

/** 有服务存在待处理的新版时，在网址后加 `service=<服务名>`（取第一个），页面打开时直接显示这个服务的模型。 */
export function pageUrl(url: string, endpoints: Endpoints): string {
	const service = endpoints.config.services.find((item) => endpoints.updates(item.name).length > 0);
	return service ? `${url}&service=${encodeURIComponent(service.name)}` : url;
}

/**
 * 打开浏览器用的命令和参数。网址整个作为一个参数传给不经过 shell 的程序：
 * Windows 上不用 `cmd /c start`，cmd 会把网址里的 `&` 当成命令分隔符，丢掉 `&service=` 之后的部分；
 * `rundll32 url.dll,FileProtocolHandler` 按系统的默认浏览器打开，网址里没有空格和引号，Node 不会给它加引号。
 */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	if (platform === "darwin") return ["open", [url]];
	return ["xdg-open", [url]];
}

function openBrowser(url: string): void {
	import("node:child_process")
		.then(({ spawn }) => {
			const [command, args] = browserCommand(process.platform, url);
			const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", () => {});
			child.unref();
		})
		.catch(() => {});
}
