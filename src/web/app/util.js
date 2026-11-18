// @ts-check
// 管理页的纯函数和常量，不碰 DOM，方便单独测试。

/** @typedef {{ value: any; source: string }} Sourced */
/**
 * 状态里的模型，字段见 server.ts 的 modelView()。
 * @typedef {{
 *   id: string; enabled: boolean; hidden?: boolean; missing?: boolean; modelType?: string; ownedBy?: string;
 *   levels: string[]; override: Record<string, any>; betas: string[]; headers?: Record<string, string>;
 *   builtin?: string; modelsDev?: string; compatSources?: Record<string, string>;
 *   name: Sourced; api: Sourced; baseUrl: Sourced; contextWindow: Sourced; maxTokens: Sourced; input: Sourced;
 *   thinkingLevelMap: Sourced; compat: Sourced; cost: Sourced;
 * }} Model
 */
/**
 * 状态里的服务，字段见 server.ts 的 state()。
 * @typedef {{
 *   name: string; displayName: string; baseUrl: string; defaultApi: string; apiKeyEnv: string; headers: Record<string, string>;
 *   latestPerFamily: boolean; updates?: { from: string; to: string }[];
 *   status?: { registered?: boolean; disabled?: boolean; error?: string; syncError?: string; keySource?: "file" | "env" };
 *   catalog?: { fetchedAt: number; size: number };
 *   models: Model[];
 * }} Service
 */
/**
 * GET /api/state 和各操作返回的状态。
 * @typedef {{
 *   version?: string; apis: string[]; loadError?: string; defaultModel?: { provider: string; id: string };
 *   modelsDev?: { fetchedAt?: number; checkedAt?: number; error?: string; fetching?: boolean };
 *   services: Service[];
 * }} State
 */

/** @type {Record<string, string>} */
export const SOURCE = { manual: "手动", server: "服务端", pi: "pi 自带", modelsdev: "models.dev", default: "默认值", native_endpoints: "native_endpoints", owned_by: "owned_by", name: "按名字" };
// 用颜色点表示的参数来源，按图例里的顺序排列。
export const PARAM_SOURCES = ["server", "pi", "modelsdev", "manual", "default"];
// models.dev 标的模型类型在界面上的名称，没有列出的类型显示原名。
/** @type {Record<string, string>} */
export const TYPE_LABEL = { decision: "分类模型", image: "图片模型", embedding: "向量模型" };
export const LONG_CONTEXT_BETA = "context-1m-2025-08-07";
// 前缀筛选取这个值时只看已启用的模型。
export const ENABLED = " enabled";

/**
 * 模型名里的版本号，用来把新模型排在前面：gpt-6.1-sol → [6, 1]，claude-opus-4-6-thinking → [4, 6]，
 * qwen3-coder → [3]，gpt-4o → [4]。120b、9B 这类参数规模，以及 2024-08-06、20250929 这类日期不算版本号；
 * 没有版本号时返回空数组。
 * @param {string} id
 * @returns {number[]}
 */
export function versionOf(id) {
	const parts = id.slice(id.lastIndexOf("/") + 1).toLowerCase().split("-");
	/** @type {number[]} */
	const version = [];
	const lead = parts[0].match(/\d+(?:\.\d+)*$/);
	if (lead) version.push(...lead[0].split(".").map(Number));
	for (const part of parts.slice(1)) {
		// 版本号最多三位数字，可以带一个字母后缀（4o），但 b、k、m 是参数规模（120b）。
		const match = /^v?(\d{1,3}(?:\.\d+)*)([a-z]?)$/.exec(part);
		if (match && !"bkm".includes(match[2] || "-")) version.push(...match[1].split(".").map(Number));
		else if (version.length) break;
	}
	return version;
}

/**
 * 版本号大的在前，版本号相同时按名字排序，没有版本号的放最后。
 * @param {{ id: string }} a
 * @param {{ id: string }} b
 */
export function newestFirst(a, b) {
	const va = versionOf(a.id);
	const vb = versionOf(b.id);
	for (let i = 0; i < Math.max(va.length, vb.length); i++) {
		const diff = (vb[i] ?? -1) - (va[i] ?? -1);
		if (diff) return diff;
	}
	return a.id.localeCompare(b.id);
}

/**
 * 模型 id 的前缀：去掉 / 之前的部分，取第一段，去掉末尾的版本号，如 gpt-6.1-sol → gpt、qwen3-coder → qwen。
 * @param {string} id
 */
export function prefixOf(id) {
	const head = id.slice(id.lastIndexOf("/") + 1).split(/[-_.]/)[0].replace(/\d+$/, "").toLowerCase();
	return head || "其他";
}

// 分组和前缀按钮的顺序：这几家按固定顺序排在前面，其余前缀按字母序排在后面。
const PREFIX_ORDER = ["gpt", "claude", "gemini", "grok"];
/**
 * @param {string} a
 * @param {string} b
 */
export function byPrefix(a, b) {
	/** @param {string} prefix */
	const rank = (prefix) => (PREFIX_ORDER.includes(prefix) ? PREFIX_ORDER.indexOf(prefix) : PREFIX_ORDER.length);
	return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * models.dev 标的模型类型不是 chat 时返回界面上显示的类型名，pi 不能拿这类模型对话。没有类型时按对话模型处理。
 * @param {Model} model
 * @returns {string | undefined}
 */
export const nonChat = (model) => (model.modelType && model.modelType !== "chat" ? TYPE_LABEL[model.modelType] ?? model.modelType : undefined);

/** @param {unknown} n */
export function short(n) {
	if (typeof n !== "number") return "";
	/**
	 * @param {number} value
	 * @param {number} digits
	 */
	const trim = (value, digits) => String(Number(value.toFixed(digits)));
	if (n >= 1e6) return `${trim(n / 1e6, 2)}M`;
	if (n >= 1e3) return `${trim(n / 1e3, 1)}K`;
	return String(n);
}

/** @param {unknown} n */
export const full = (n) => (typeof n === "number" ? n.toLocaleString() : "");

/**
 * 解析 JSON 对象输入框，留空时返回 undefined，不是 JSON 对象时抛出错误。
 * @param {string} text
 * @param {string} label
 * @returns {Record<string, any> | undefined}
 */
export function parseJsonField(text, label) {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		const value = JSON.parse(trimmed);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
		return value;
	} catch {
		throw new Error(`${label} 要填 JSON 对象，例如 {"key": "value"}`);
	}
}

/**
 * 解析上下文、最大输出这类 token 数。接受 1000000、1,000,000、1 000 000，以及 200K、1M、1.5M 这类写法：
 * K 是 1000，M 是 1000000，大小写均可，和 short() 显示的单位一致。千位分隔符必须每三位一个，1,5M 这类写法报错。
 * 结果必须是正整数，认不出时抛出错误。
 * @param {string} text
 * @param {string} label
 */
export function parseCount(text, label) {
	const normalized = text.trim().replace(/\s+/g, " ");
	const match = /^(\d+|\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+)(?:\.(\d+))? ?([km])?$/i.exec(normalized);
	let value = NaN;
	if (match) {
		const zeros = match[3] ? (match[3].toLowerCase() === "k" ? 3 : 6) : 0;
		const fraction = match[2] ?? "";
		// 按字符串移动小数点，避免 1.1 * 1e6 这类浮点误差。
		if (fraction.length <= zeros) value = Number(match[1].replace(/[, ]/g, "") + fraction.padEnd(zeros, "0"));
	}
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}填的“${text.trim()}”不是正整数，可以写 1000000、1,000,000、200K 或 1M`);
	return value;
}

/**
 * 服务名：小写字母、数字、点、下划线和连字符，以字母或数字开头。显示名里的其他字符换成连字符。
 * @param {string} text
 */
export function slugify(text) {
	return text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
}

/**
 * 详情面板手动设置表单的初始值，空字符串表示留空、自动取值。
 * @param {Record<string, any>} o 模型的手动设置
 */
export function overrideToForm(o) {
	return {
		name: o.name ?? "",
		api: o.api ?? "",
		baseUrl: o.baseUrl ?? "",
		contextWindow: o.contextWindow === undefined ? "" : String(o.contextWindow),
		maxTokens: o.maxTokens === undefined ? "" : String(o.maxTokens),
		input: o.input ? o.input.join(",") : "",
		// 空数组表示不支持调节思考，回显为 none，再次保存时不会丢失。
		thinkingLevels: o.thinkingLevels ? (o.thinkingLevels.length ? o.thinkingLevels.join(", ") : "none") : "",
		headers: o.headers ? JSON.stringify(o.headers, null, 2) : "",
		compat: o.compat ? JSON.stringify(o.compat, null, 2) : "",
		cost: o.cost ? JSON.stringify(o.cost, null, 2) : "",
	};
}

/**
 * 把手动设置表单转成 setOverride 的 override，填得不对时抛出错误。
 * @param {ReturnType<typeof overrideToForm>} form
 */
export function formToOverride(form) {
	/** @type {Record<string, any>} */
	const override = {};
	if (form.name.trim()) override.name = form.name.trim();
	if (form.api) override.api = form.api;
	if (form.baseUrl.trim()) override.baseUrl = form.baseUrl.trim().replace(/\/+$/, "");
	if (form.contextWindow.trim()) override.contextWindow = parseCount(form.contextWindow, "上下文");
	if (form.maxTokens.trim()) override.maxTokens = parseCount(form.maxTokens, "最大输出");
	if (form.input) override.input = form.input.split(",");
	if (form.thinkingLevels.trim()) {
		const list = form.thinkingLevels.split(/[\s,，]+/).map((/** @type {string} */ level) => level.trim().toLowerCase()).filter(Boolean);
		override.thinkingLevels = list.length === 1 && list[0] === "none" ? [] : list;
	}
	const headers = parseJsonField(form.headers, "请求头");
	if (headers) override.headers = headers;
	const compat = parseJsonField(form.compat, "compat");
	if (compat) override.compat = compat;
	const cost = parseJsonField(form.cost, "价格");
	if (cost) override.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost };
	return override;
}

/**
 * 替换列表的文字，如“a → b、c → d”。
 * @param {{ from: string; to: string }[]} list
 */
export const describeReplacements = (list) => list.map((item) => `${item.from} → ${item.to}`).join("、");
