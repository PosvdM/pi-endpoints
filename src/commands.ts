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
			openBrowser(ui.url);
			ctx.ui.notify(`管理页已打开：${ui.url}`, "info");
		},
	});
}

function openBrowser(url: string): void {
	import("node:child_process")
		.then(({ spawn }) => {
			const [command, args] =
				process.platform === "win32"
					? ["cmd", ["/c", "start", "", url]]
					: process.platform === "darwin"
						? ["open", [url]]
						: ["xdg-open", [url]];
			const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", () => {});
			child.unref();
		})
		.catch(() => {});
}
