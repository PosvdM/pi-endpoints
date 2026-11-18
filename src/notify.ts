import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 进程里能显示提示的会话上下文，按 `session_start` 的先后排列。
 *
 * pi-web-ui 在一个进程里运行多个会话（主会话、子代理、固定的后台会话），每个会话各加载一份插件，
 * 却共用一个 ModelRuntime：最后注册服务商的那份插件接管 `refreshModels`，它可能属于没有界面的子代理。
 * 所以提示不只用插件自己的会话，而是用进程里任意一个还活着、能显示的会话。插件模块可能按会话分别加载，
 * 记录放在 `globalThis` 上，所有副本共用。
 */
const KEY = Symbol.for("pi-endpoints:ui-contexts");

function contexts(): ExtensionContext[] {
	const store = globalThis as unknown as Record<symbol, ExtensionContext[] | undefined>;
	store[KEY] ??= [];
	return store[KEY];
}

/**
 * 会话能不能显示提示。`hasUI` 为假（`-p`、json 模式、pi 自己的子代理进程）时不能。
 * pi-web-ui 给子代理和固定的后台会话绑定的是 `WebUIContext.headless()`：`hasUI` 为真、`mode` 是 `rpc`，
 * 但 `notify` 什么也不发。pi 把 UI 上下文的自有属性展开复制给 `ctx.ui`，`headless` 字段也在其中，据此识别。
 * 出处：pi-web-ui 0.120 的 `dist/server/webui-context.js`（`WebUIContext.headless()`）和 `agent-service.js`。
 */
export function canShow(ctx: ExtensionContext): boolean {
	return ctx.hasUI && (ctx.ui as { headless?: unknown }).headless !== true;
}

/** `session_start` 时调用：能显示提示的会话记下来，排到最后（最近的优先）。 */
export function trackContext(ctx: ExtensionContext): void {
	untrackContext(ctx);
	try {
		if (canShow(ctx)) contexts().push(ctx);
	} catch {
		// 已经失效的上下文访问属性会抛错，不记。
	}
}

/** `session_shutdown` 时调用，之后不再用这个会话的上下文。 */
export function untrackContext(ctx: ExtensionContext | undefined): void {
	const list = contexts();
	const index = ctx ? list.indexOf(ctx) : -1;
	if (index >= 0) list.splice(index, 1);
}

/**
 * 用最近一个还能显示的会话提示，返回是否显示了。调用出错的上下文（会话已经失效）去掉，再试下一个。
 * 没有这样的会话时返回假，调用方不把提示记成已显示。
 */
export function notifyVisible(message: string, level: "info" | "warning"): boolean {
	const list = contexts();
	for (let index = list.length - 1; index >= 0; index--) {
		const ctx = list[index];
		try {
			if (!canShow(ctx)) {
				list.splice(index, 1);
				continue;
			}
			ctx.ui.notify(message, level);
			return true;
		} catch {
			list.splice(index, 1);
		}
	}
	return false;
}

/** 测试用：清空记录。 */
export function resetContextsForTest(): void {
	contexts().length = 0;
}
