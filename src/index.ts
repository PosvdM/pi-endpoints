import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Endpoints } from "./endpoints.ts";
import { notifyVisible, trackContext, untrackContext } from "./notify.ts";

export default function piEndpoints(pi: ExtensionAPI): void {
	const endpoints = new Endpoints(pi);
	// “每系最新”换掉模型、或者开关关着的服务出了新版时在界面上提示。能显示提示的会话记在进程级的列表里（见 notify.ts），
	// 会话结束后去掉。pi 每次触发事件时给的 ctx 可能是新对象，所以去掉的是 session_start 时记下的那个。
	let context: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		untrackContext(context);
		context = ctx;
		trackContext(ctx);
	});
	pi.on("session_shutdown", () => {
		untrackContext(context);
		context = undefined;
	});
	// 没有能显示提示的会话（-p、json 模式、pi-web-ui 的后台会话）时提示会被丢掉，返回假，调用方据此决定要不要记成已提示。
	endpoints.notify = notifyVisible;
	// 启动时只用配置、目录缓存和 models.dev 的本地文件注册，不访问网络。目录由 pi 调用各服务商的 refreshModels 刷新。
	endpoints.registerAll();
	registerCommands(pi, endpoints);
}
