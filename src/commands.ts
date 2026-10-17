import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { describeError, type Endpoints, type ServiceStatus } from "./endpoints.ts";
import { supportedLevels } from "./resolve.ts";
import { type WebUI, startWebUI } from "./web/server.ts";

const SUBCOMMANDS = [
	{ value: "ui", description: "打开 Web 管理页" },
	{ value: "models", description: "在终端里勾选要启用的模型" },
	{ value: "refresh", description: "立即刷新所有服务的模型目录" },
	{ value: "status", description: "查看各服务的状态" },
];

const ON = "启用";
const OFF = "—";

export function registerCommands(pi: ExtensionAPI, endpoints: Endpoints): void {
	// 存 Promise 而不是结果，连按两次 /endpoints ui 时不会启动两个服务器。
	let web: Promise<WebUI> | undefined;

	pi.on("session_shutdown", async () => {
		const running = web;
		web = undefined;
		await (await running?.catch(() => undefined))?.close();
	});

	pi.registerCommand("endpoints", {
		description: "管理自己的 API 服务：ui | models | refresh | status",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix.trim()));
			return items.map((item) => ({ value: item.value, label: item.value, description: item.description }));
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (sub) {
				case "ui": {
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
					return;
				}
				case "models":
					await chooseModels(endpoints, ctx, rest[0]);
					return;
				case "refresh": {
					if (endpoints.config.services.length === 0) {
						ctx.ui.notify("还没有添加服务，先运行 /endpoints ui", "warning");
						return;
					}
					const failures = await endpoints.refreshAll(ctx.signal);
					const ok = endpoints.config.services.length - failures.size;
					const lines = [`已刷新 ${ok} 个服务`, ...[...failures].map(([name, error]) => `${name}：${printable(error)}`)];
					ctx.ui.notify(lines.join("\n"), failures.size ? "warning" : "info");
					return;
				}
				case "status":
					ctx.ui.notify(formatStatus(endpoints.status(), endpoints.loadError), endpoints.loadError ? "error" : "info");
					return;
				default:
					ctx.ui.notify(`未知的子命令 ${sub}。可用：${SUBCOMMANDS.map((item) => item.value).join(" | ")}`, "warning");
			}
		},
	});
}

/** 去掉服务端原文里的控制字符，免得 ANSI 转义序列搅乱终端。保留换行。 */
export function printable(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

export function formatStatus(statuses: ServiceStatus[], loadError?: string): string {
	if (loadError) return `读取配置失败：${printable(loadError)}\n修好文件后运行 /reload。`;
	if (statuses.length === 0) return "还没有添加服务。运行 /endpoints ui 添加。";
	return statuses
		.map((status) => {
			const parts = [
				`${status.name}：${status.registered ? "已注册" : "未注册"}`,
				`密钥${status.keySource === "env" ? "来自环境变量" : status.keySource === "file" ? "已设置" : "未设置"}`,
				status.catalogAt
					? `目录 ${status.catalogSize} 个模型，${new Date(status.catalogAt).toLocaleString()} 刷新`
					: "还没有读取过目录",
				`启用 ${status.enabled} 个`,
			];
			const lines = [parts.join("，")];
			if (status.missing.length) lines.push(`  目录里没有：${status.missing.join("、")}`);
			if (status.error) lines.push(`  错误：${printable(status.error)}`);
			return lines.join("\n");
		})
		.join("\n");
}

async function chooseModels(endpoints: Endpoints, ctx: ExtensionCommandContext, requested?: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/endpoints models 需要在交互界面里使用，也可以用 /endpoints ui", "warning");
		return;
	}
	const names = endpoints.config.services.map((service) => service.name);
	if (names.length === 0) {
		ctx.ui.notify("还没有添加服务，先运行 /endpoints ui", "warning");
		return;
	}
	const name = requested ?? (names.length === 1 ? names[0] : await ctx.ui.select("选择服务", names));
	if (!name) return;
	if (!endpoints.service(name)) {
		ctx.ui.notify(`没有名为 ${name} 的服务`, "warning");
		return;
	}
	if (!endpoints.catalog(name)) {
		try {
			await endpoints.refresh(name, ctx.signal);
		} catch (error) {
			ctx.ui.notify(`读取 ${name} 的模型目录失败：${printable(describeError(error))}`, "error");
			return;
		}
	}

	const service = endpoints.service(name);
	if (!service) return;
	const items: SettingItem[] = endpoints
		.models(name)
		.filter((model) => !model.hidden || service.enabled.includes(model.id))
		.map((model) => {
			const levels = supportedLevels(model.reasoning.value, model.thinkingLevelMap.value);
			return {
				id: model.id,
				label: model.id,
				description: [
					model.name.value,
					model.api.value,
					`上下文 ${model.contextWindow.value}`,
					`最大输出 ${model.maxTokens.value}`,
					levels.length ? `思考 ${levels.join("/")}` : "不支持调节思考",
					model.missing ? "目录里没有这个模型" : undefined,
				]
					.filter(Boolean)
					.join(" · "),
				currentValue: service.enabled.includes(model.id) ? ON : OFF,
				values: [ON, OFF],
			};
		});

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(`${name} 的模型（Enter 切换，输入文字筛选，Esc 结束）`)), 1, 0));
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 20),
			getSettingsListTheme(),
			(id, value) => endpoints.setEnabled(name, id, value === ON),
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
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
