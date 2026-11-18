// @ts-check
// 各页面共用的小组件：来源圆点、星标、启用开关和图标。
import { h } from "preact";
import htm from "htm";
import { nonChat, PARAM_SOURCES, SOURCE } from "./util.js";
import { pendingKey } from "./store.js";

/** @typedef {import("./util.js").Model} Model */
/** @typedef {import("./util.js").Service} Service */
/** @typedef {import("./store.js").Store} Store */

// htm 的类型声明按 CommonJS 写，在 nodenext 下取不到 default 上的 bind，这里按实际的 ES 模块用法标注。
/** @type {(strings: TemplateStringsArray, ...values: any[]) => any} */
export const html = /** @type {any} */ (htm).bind(h);

// 协议和 owned_by 那类来源只在详情里显示文字，表格里只用颜色点表示参数来源。
/** @param {{ source: string }} props */
export const Dot = ({ source }) => html`<span class=${`src ${source}`} title=${SOURCE[source] ?? source}></span>`;

/** @param {{ source: string; label?: string }} props */
export const SrcText = ({ source, label }) =>
	html`<span class="srctext">${PARAM_SOURCES.includes(source) ? html`<${Dot} source=${source} />` : null}${label ?? SOURCE[source] ?? source}</span>`;

// 用 SVG 画星，字符 ★ 在部分系统上显示成彩色 emoji，颜色不受 CSS 控制。
/** @param {{ filled: boolean }} props */
export const StarIcon = ({ filled }) => html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill=${filled ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.3l-5.7 3 1.1-6.3-4.6-4.5 6.4-.9z" /></svg>`;

export const UpdateIcon = () => html`<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="8" fill="currentColor" /><path d="M8 11.5v-7M5 7.5l3-3 3 3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

export const Caret = () => html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>`;

export const SearchIcon = () => html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>`;

/**
 * @param {import("./util.js").State} data
 * @param {Service} service
 * @param {Model} model
 */
export const isDefault = (data, service, model) => data.defaultModel?.provider === service.name && data.defaultModel.id === model.id;

/**
 * 实心星是 pi 的默认模型，点击取消；没注册到 pi 时变灰。空心星设为默认，在列表里悬停才显示。
 * 点不了的星不用 disabled：禁用的按钮会吞掉点击，列表行就打不开详情了。
 * @param {{ store: Store; service: Service; model: Model }} props
 */
export function Star({ store, service, model }) {
	const usable = model.enabled && service.status?.registered && !nonChat(model);
	if (isDefault(store.get().data, service, model)) {
		const title = usable ? "pi 默认模型，点击取消" : "pi 默认模型，但它现在没有注册到 pi，pi 启动时会改用别的模型。点击取消";
		/** @param {Event} event */
		const clear = async (event) => {
			event.stopPropagation();
			// 带上这颗星代表的模型：默认模型已经被换掉时服务端不清除，只返回最新状态。
			const data = await store.act("clearDefaultModel", { name: service.name, id: model.id });
			if (data) store.toast(data.defaultChanged ? "pi 默认模型已经换了，没有取消，页面已更新" : "已取消 pi 默认模型，运行中的 pi 需执行 /reload");
		};
		return html`<button class=${`star${usable ? " on" : ""}`} title=${title} onClick=${clear}><${StarIcon} filled=${true} /></button>`;
	}
	if (!usable) {
		const title = nonChat(model) ? "pi 不能拿这个模型对话，不能设为默认模型" : !model.enabled ? "先启用这个模型，才能设为 pi 默认模型" : "服务没有注册到 pi，不能设为默认模型";
		return html`<button class="star off" title=${title} aria-disabled="true"><${StarIcon} filled=${false} /></button>`;
	}
	/** @param {Event} event */
	const setDefault = (event) => {
		event.stopPropagation();
		store.act("setDefaultModel", { name: service.name, id: model.id }, { okText: "已设为 pi 默认模型，运行中的 pi 需执行 /reload" });
	};
	return html`<button class="star off" title="设为 pi 默认模型" onClick=${setDefault}><${StarIcon} filled=${false} /></button>`;
}

/**
 * 模型的启用开关。pi 不能拿来对话的模型没启用时不能启用，已经启用的可以停用。
 * 点不了的开关不用 disabled：禁用的控件会吞掉点击，列表行就打不开详情了。
 * 请求期间开关按要切换到的值显示，结束后按服务端状态显示，失败时也就拨回原样。
 * @param {{ store: Store; service: Service; model: Model; class?: string; onChanged?: (enabled: boolean) => void }} props
 */
export function EnableSwitch({ store, service, model, class: extra = "", onChanged }) {
	const key = pendingKey.enabled(service.name, model.id);
	const pending = store.pendingValue(key);
	const enabled = pending ?? model.enabled;
	const type = nonChat(model);
	const className = `switch${extra ? ` ${extra}` : ""}`;
	if (type && !enabled) {
		return html`<input type="checkbox" class=${className} title=${`${type}，pi 不能拿它对话，不能启用`} aria-disabled="true" checked=${false} onClick=${(/** @type {Event} */ event) => event.preventDefault()} />`;
	}
	/** @param {Event} event */
	const change = (event) => {
		const next = /** @type {HTMLInputElement} */ (event.currentTarget).checked;
		onChanged?.(next);
		store.act("setEnabled", { name: service.name, id: model.id, enabled: next }, { pending: [key, next] });
	};
	return html`<input type="checkbox" class=${className} title=${enabled ? "已启用" : "未启用"} checked=${enabled} onChange=${change} />`;
}
