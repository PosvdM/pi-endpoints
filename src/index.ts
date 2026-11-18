import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Endpoints } from "./endpoints.ts";
import { notifyFor, runtimeOf, trackContext, untrackContext } from "./notify.ts";

export default function piEndpoints(pi: ExtensionAPI): void {
	const endpoints = new Endpoints(pi);
	// “每系最新”换掉模型、或者开关关着的服务出了新版时在界面上提示。提示先用本实例自己的会话，
	// 自己不能显示时才用同一个 ModelRuntime 上能显示的会话（见 notify.ts）。能显示的会话记在进程级的列表里，会话结束后去掉。
	// pi 每次触发事件时给的 ctx 可能是新对象，所以去掉的是 session_start 时记下的那个。会话结束后 ModelRuntime 仍保留：
	// 本实例注册的 refreshModels 可能还在被共用的 ModelRuntime 调用。
	let context: ExtensionContext | undefined;
	let runtime: object | undefined;
	pi.on("session_start", (_event, ctx) => {
		untrackContext(context);
		context = ctx;
		runtime = runtimeOf(ctx);
		trackContext(ctx);
	});
	pi.on("session_shutdown", () => {
		untrackContext(context);
		context = undefined;
	});
	// 没有能显示提示的会话（-p、json 模式、pi-web-ui 的后台会话）时提示会被丢掉，返回假，调用方据此决定要不要记成已提示。
	endpoints.notify = (message, level) => notifyFor({ ctx: context, runtime }, message, level);
	// 启动时只用配置、目录缓存和 models.dev 的本地文件注册，不访问网络。目录由 pi 调用各服务商的 refreshModels 刷新。
	endpoints.registerAll();
	registerCommands(pi, endpoints);
}
