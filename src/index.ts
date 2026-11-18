import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Endpoints } from "./endpoints.ts";

export default function piEndpoints(pi: ExtensionAPI): void {
	const endpoints = new Endpoints(pi);
	// “每系最新”换掉模型时在界面上提示，正在用旧模型的会话不会自动切换。会话结束后不再用旧的 ctx。
	let context: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("session_shutdown", () => {
		context = undefined;
	});
	endpoints.notify = (message) => {
		if (context?.hasUI) context.ui.notify(message, "info");
	};
	// 启动时只用配置、目录缓存和 models.dev 的本地文件注册，不访问网络。目录由 pi 调用各服务商的 refreshModels 刷新。
	endpoints.registerAll();
	registerCommands(pi, endpoints);
}
