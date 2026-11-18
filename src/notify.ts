import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 进程里能显示提示的会话上下文，按 `session_start` 的先后排列。
 *
 * pi-web-ui 在一个进程里为每个浏览器客户端建一个 ClientSession。同一客户端里的会话（主会话、子代理、固定的后台会话）
 * 各加载一份插件，却共用一个 ModelRuntime：最后注册服务商的那份插件接管 `refreshModels`，它可能属于没有界面的子代理。
 * 这时提示要改用同一客户端里能显示的会话；别的客户端可能已经断开，投给它谁也看不到。插件模块可能按会话分别加载，
 * 记录放在 `globalThis` 上，所有副本共用。
 *
 * 记录用 WeakRef：宿主直接销毁会话、没有发 `session_shutdown` 时，不靠这份列表让旧上下文一直留在内存里。
 */
const KEY = Symbol.for("pi-endpoints:ui-contexts");

interface Tracked {
	ctx: WeakRef<ExtensionContext>;
	/** 会话所用的 ModelRuntime，读不到时为 undefined。 */
	runtime?: WeakRef<object>;
}

function contexts(): Tracked[] {
	const store = globalThis as unknown as Record<symbol, Tracked[] | undefined>;
	store[KEY] ??= [];
	return store[KEY];
}

/**
 * 会话能不能显示提示。`hasUI` 为假（`-p`、json 模式、pi 自己的子代理进程）时不能。
 * pi-web-ui 给子代理和固定的后台会话绑定的是 `WebUIContext.headless()`：`hasUI` 为真、`mode` 是 `rpc`，
 * 但 `notify` 什么也不发。pi 把 UI 上下文的自有属性展开复制给 `ctx.ui`，`headless` 字段也在其中，据此识别。
 * 出处：pi-web-ui 0.120 的 `dist/server/webui-context.js`（`WebUIContext.headless()`）和 `agent-service.js`。
 * 会话失效后访问 `ctx` 的属性会抛错，调用方要接住。
 */
export function canShow(ctx: ExtensionContext): boolean {
	return ctx.hasUI && (ctx.ui as { headless?: unknown }).headless !== true;
}

/**
 * 会话所用的 ModelRuntime，用来判断两个会话是否同属一个 pi-web-ui 客户端。pi 给每个会话新建一个 `ModelRegistry`，
 * 它的 `runtime` 字段指向会话共用的 ModelRuntime。这个字段在 pi 的类型声明里是私有的，读不到（会话已失效、
 * pi 改了实现）时返回 undefined。出处：pi 1.5 的 `dist/core/model-registry.js` 和 `AgentSession` 创建
 * `ExtensionRunner` 的地方；pi-web-ui 0.120 的 `ClientSession.create()` 把客户端第一个会话的 ModelRuntime
 * 记为 `sharedModelRuntime`，同一客户端后来的会话都用它。
 */
export function runtimeOf(ctx: ExtensionContext): object | undefined {
	try {
		const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown } | undefined)?.runtime;
		return runtime !== null && typeof runtime === "object" ? runtime : undefined;
	} catch {
		return undefined;
	}
}

/** 还活着、能显示提示的上下文。已被回收、访问抛错（会话失效）或不能显示时返回 undefined。 */
function live(item: Tracked): ExtensionContext | undefined {
	const ctx = item.ctx.deref();
	if (!ctx) return undefined;
	try {
		return canShow(ctx) ? ctx : undefined;
	} catch {
		return undefined;
	}
}

/** 去掉整组失效的记录。注册和投递时都清扫一遍。 */
function sweep(): void {
	const list = contexts();
	for (let index = list.length - 1; index >= 0; index--) {
		if (!live(list[index])) list.splice(index, 1);
	}
}

/** `session_start` 时调用：能显示提示的会话记下来，排到最后（最近的优先）。 */
export function trackContext(ctx: ExtensionContext): void {
	untrackContext(ctx);
	let visible = false;
	try {
		visible = canShow(ctx);
	} catch {
		// 已经失效的上下文访问属性会抛错，不记。
	}
	if (!visible) return;
	const runtime = runtimeOf(ctx);
	contexts().push({ ctx: new WeakRef(ctx), runtime: runtime && new WeakRef(runtime) });
}

/** `session_shutdown` 时调用，之后不再用这个会话的上下文。顺带清扫失效的记录。 */
export function untrackContext(ctx: ExtensionContext | undefined): void {
	sweep();
	const list = contexts();
	const index = ctx ? list.findIndex((item) => item.ctx.deref() === ctx) : -1;
	if (index >= 0) list.splice(index, 1);
}

/** 插件实例所在的会话：`ctx` 是当前的上下文（会话结束后为 undefined），`runtime` 是它的 ModelRuntime，会话结束后仍保留。 */
export interface Owner {
	ctx?: ExtensionContext;
	runtime?: object;
}

/**
 * 替插件实例提示，返回是否显示了。没有显示时调用方不把提示记成已显示。
 * 1. 实例自己的会话能显示时用它。
 * 2. 否则（例如 pi-web-ui 的子代理接管了刷新）用最近一个和它共用 ModelRuntime、能显示的会话，即同一客户端的界面。
 * 3. 读不到 ModelRuntime、但实例有过会话时，退回到进程里最近一个能显示的会话，它可能属于别的客户端，见技术文档的已知限制。
 *    实例从没收到 `session_start` 时不知道自己属于哪个会话，不提示。
 */
export function notifyFor(owner: Owner, message: string, level: "info" | "warning"): boolean {
	sweep();
	const own = owner.ctx && live({ ctx: new WeakRef(owner.ctx) });
	if (own && show(own, message, level)) return true;
	if (!owner.ctx && !owner.runtime) return false;
	const list = contexts();
	for (let index = list.length - 1; index >= 0; index--) {
		const item = list[index];
		if (owner.runtime && item.runtime?.deref() !== owner.runtime) continue;
		const ctx = live(item);
		if (ctx && ctx !== owner.ctx && show(ctx, message, level)) return true;
	}
	return false;
}

function show(ctx: ExtensionContext, message: string, level: "info" | "warning"): boolean {
	try {
		ctx.ui.notify(message, level);
		return true;
	} catch {
		untrackContext(ctx);
		return false;
	}
}

/** 测试用：清空记录。 */
export function resetContextsForTest(): void {
	contexts().length = 0;
}

/** 测试用：记录的条数。 */
export function contextCountForTest(): number {
	return contexts().length;
}
