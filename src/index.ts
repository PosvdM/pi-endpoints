import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Endpoints } from "./endpoints.ts";

export default function piEndpoints(pi: ExtensionAPI): void {
	const endpoints = new Endpoints(pi);
	// 启动时只用配置和缓存注册，不访问网络。目录由 pi 调用各服务商的 refreshModels 刷新。
	endpoints.registerAll();
	registerCommands(pi, endpoints);
}
