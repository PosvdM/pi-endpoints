import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Endpoints } from "./endpoints.ts";

export default function piEndpoints(pi: ExtensionAPI): void {
	const endpoints = new Endpoints(pi);
	// “每系最新”换掉模型、或者开关关着的服务出了新版时在界面上提示。会话结束后不再用旧的 ctx。
	let context: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("session_shutdown", () => {
		context = undefined;
	});
	// 没有界面（子代理、-p、json 模式）时提示会被丢掉，返回假，调用方据此决定要不要记成已提示。
	endpoints.notify = (message, level) => {
		if (!context?.hasUI) return false;
		context.ui.notify(message, level);
		return true;
	};
	// 启动时只用配置、目录缓存和 models.dev 的本地文件注册，不访问网络。目录由 pi 调用各服务商的 refreshModels 刷新。
	endpoints.registerAll();
	registerCommands(pi, endpoints);
}
