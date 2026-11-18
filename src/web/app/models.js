// @ts-check
// “模型”页：新版提示、工具栏、前缀按钮、按前缀分组的模型表和图例。
import { useState } from "preact/hooks";
import { Caret, Dot, EnableSwitch, html, SearchIcon, Star } from "./ui.js";
import { pendingKey } from "./store.js";
import { byPrefix, describeReplacements, ENABLED, full, newestFirst, nonChat, PARAM_SOURCES, prefixOf, short, SOURCE } from "./util.js";

/** @typedef {import("./util.js").Model} Model */
/** @typedef {import("./util.js").Service} Service */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {{ text: string; api: string; owner: string; hidden: boolean; prefix: string; epoch: number }} View */
/** @typedef {{ key: string; ids: Set<string> }} Frozen */

/**
 * 模型是否符合除前缀以外的筛选条件。
 * @param {Model} model
 * @param {View} view
 */
function matches(model, view) {
	const text = view.text.trim().toLowerCase();
	if (text && !model.id.toLowerCase().includes(text) && !model.name.value.toLowerCase().includes(text)) return false;
	if (view.api && model.api.value !== view.api) return false;
	if (view.owner && (model.ownedBy ?? "") !== view.owner) return false;
	if (!view.hidden && model.hidden && !model.enabled) return false;
	return true;
}

/**
 * 按筛选条件选出要显示的模型，并冻结这次的显示集合。
 *
 * 冻结的范围是“服务 + 筛选条件 + 点前缀按钮的次数”（`frozen.key`），范围不变时，显示过的模型一直留在原处：
 * 停用了“已启用”页里的模型、停用了隐藏模型、在详情里改了协议或名字之后，行不会从眼前消失，方便改回来；
 * 新符合条件的模型（如“每系最新”自动启用的新版）照常加进来。换服务、改筛选条件、再点一次前缀按钮或刷新页面后，按条件重新选。
 * @param {Model[]} models
 * @param {View} view
 * @param {Frozen} frozen 由调用方持有，跨重画保留
 * @param {string} service
 */
export function visibleModels(models, view, frozen, service) {
	const key = JSON.stringify([service, view]);
	if (frozen.key !== key) {
		frozen.key = key;
		frozen.ids = new Set();
	}
	// 前缀按钮上的数量按其他筛选条件计算，不受当前所选前缀影响。
	const filtered = models.filter((model) => frozen.ids.has(model.id) || matches(model, view));
	const shown = filtered.filter((model) =>
		frozen.ids.has(model.id) || !view.prefix || (view.prefix === ENABLED ? model.enabled : prefixOf(model.id) === view.prefix));
	for (const model of shown) frozen.ids.add(model.id);
	return { filtered, shown };
}

/**
 * 服务有待换的新版、开关又关着时，在模型页顶部提示，可以换一次或打开开关。
 * 调用方以服务名为 key 渲染，“替换中…”只属于发起替换的服务。
 * @param {{ store: Store; service: Service }} props
 */
function LatestBanner({ store, service }) {
	const [busy, setBusy] = useState(false);
	const updates = service.updates ?? [];
	if (service.latestPerFamily || !updates.length) return null;
	const applyOnce = async () => {
		setBusy(true);
		try {
			const data = await store.act("applyLatestOnce", { name: service.name });
			if (data) store.toast(data.replaced?.length ? `已换成新版：${describeReplacements(data.replaced)}` : "没有可换的新版，页面已更新");
		} finally {
			setBusy(false);
		}
	};
	const enableAuto = () => store.act("setLatestPerFamily", { name: service.name, latestPerFamily: true }, { okText: "已开启", pending: [pendingKey.latest(service.name), true] });
	return html`<div class="banner info latest-banner">
		<span class="grow">${updates.length} 个已启用模型有新版：${describeReplacements(updates)}</span>
		<button class="btn small" disabled=${busy} onClick=${applyOnce}>${busy ? "替换中…" : "换成新版"}</button>
		<button class="btn small" onClick=${enableAuto}>开启自动替换</button>
	</div>`;
}

const LATEST_TITLE = "开启后，已启用模型所在的每个系列只保留最新版，目录里出了新版本会自动启用、并停用旧版本；手动启用的旧版本也会在下次刷新时被换掉。同一版本的多个 id（如别名和带日期的版本）可以同时保留。";

/**
 * “每个系列只保留最新版”开关，放在前缀按钮里“已启用”旁边。点了立即保存，失败时拨回原样。
 * @param {{ store: Store; service: Service }} props
 */
function LatestToggle({ store, service }) {
	const key = pendingKey.latest(service.name);
	const on = store.pendingValue(key) ?? service.latestPerFamily;
	/** @param {Event} event */
	const change = (event) => {
		const next = /** @type {HTMLInputElement} */ (event.currentTarget).checked;
		store.act("setLatestPerFamily", { name: service.name, latestPerFamily: next }, { okText: next ? "已开启" : "已关闭", pending: [key, next] });
	};
	return html`<label class=${`latest-toggle${on ? " on" : ""}`} title=${LATEST_TITLE}>
		<input type="checkbox" class="switch" checked=${on} onChange=${change} />
		每个系列只保留最新版
		<span class="state">${on ? "已开启" : "未开启"}</span>
	</label>`;
}

/**
 * @param {{ store: Store; service: Service; model: Model; open: boolean; onOpen: (id: string) => void }} props
 */
function ModelRow({ store, service, model, open, onOpen }) {
	const needsFix = model.contextWindow.source === "default" || model.maxTokens.source === "default";
	const type = nonChat(model);
	/** @param {MouseEvent} event */
	const click = (event) => {
		// 点不了的开关和星标带 aria-disabled，点它们也打开详情。
		if (/** @type {Element} */ (event.target).closest("input:not([aria-disabled]), button:not([aria-disabled])")) return;
		onOpen(model.id);
	};
	return html`<tr class=${open ? "open" : ""} onClick=${click}>
		<td class="toggle"><${EnableSwitch} store=${store} service=${service} model=${model} /></td>
		<td title=${`${model.id}\n${model.name.value}`}>
			<div class="model-id"><span class="id">${model.id}</span><${Star} store=${store} service=${service} model=${model} />${type
				? html`<span class="tag" title="pi 不能拿它对话">${type}</span>` : null}${model.hidden && !type
				? html`<span class="tag">隐藏</span>` : null}${model.missing
				? html`<span class="tag warn">目录里没有</span>` : null}${needsFix
				? html`<span class="tag warn">缺参数</span>` : null}${Object.keys(model.override).length
				? html`<span class="tag accent">手动</span>` : null}</div>
			${model.name.value !== model.id ? html`<div class="model-name">${model.name.value}</div>` : null}
		</td>
		<td title=${`协议来源：${SOURCE[model.api.source] ?? model.api.source}`}><span class="api">${model.api.value}</span></td>
		<td title=${`${full(model.contextWindow.value)}（${SOURCE[model.contextWindow.source]}）`}><span class="val num"><span>${short(model.contextWindow.value)}</span><${Dot} source=${model.contextWindow.source} /></span></td>
		<td title=${`${full(model.maxTokens.value)}（${SOURCE[model.maxTokens.source]}）`}><span class="val num"><span>${short(model.maxTokens.value)}</span><${Dot} source=${model.maxTokens.source} /></span></td>
		<td title=${SOURCE[model.thinkingLevelMap.source]}><span class="val"><span class="levels">${model.levels.length ? model.levels.join(" · ") : "不支持调节"}</span><${Dot} source=${model.thinkingLevelMap.source} /></span></td>
		<td class="levels">${model.ownedBy ?? ""}</td>
	</tr>`;
}

// 参数来源图例旁边的 models.dev 状态：正在拉取、数据更新时间或失败原因。从没拉过时不显示。
/** @param {{ status: import("./util.js").State["modelsDev"] }} props */
function ModelsDevStatus({ status }) {
	if (!status) return null;
	/** @param {number} ms */
	const time = (ms) => new Date(ms).toLocaleString();
	if (status.fetching) return html`<span>models.dev 正在拉取…</span>`;
	if (status.error) return html`<span class="warn" title=${status.fetchedAt ? `沿用 ${time(status.fetchedAt)} 更新的数据` : undefined}>models.dev 拉取失败：${status.error}</span>`;
	if (status.fetchedAt) return html`<span title=${status.checkedAt ? `最后检查于 ${time(status.checkedAt)}` : undefined}>models.dev 数据更新于 ${time(status.fetchedAt)}</span>`;
	return null;
}

/**
 * @param {{
 *   store: Store; service: Service; view: View; setView: (patch: Partial<View>) => void; frozen: Frozen;
 *   collapsed: Set<string>; toggleGroup: (id: string) => void; openModel: string | null; onOpen: (id: string) => void;
 * }} props
 */
export function ModelsPage({ store, service, view, setView, frozen, collapsed, toggleGroup, openModel, onOpen }) {
	const models = service.models;
	const { filtered, shown } = visibleModels(models, view, frozen, service.name);
	/** @param {string[]} values @param {string} all */
	const options = (values, all) => [
		html`<option value="">${all}</option>`,
		...[...new Set(values)].sort().map((value) => html`<option value=${value}>${value || "（空）"}</option>`),
	];

	const counts = new Map();
	for (const model of filtered) counts.set(prefixOf(model.id), (counts.get(prefixOf(model.id)) ?? 0) + 1);
	// 选中的前缀数量变成 0 时也保留按钮，筛选条件始终看得到，也能点“全部”取消。
	if (view.prefix && view.prefix !== ENABLED && !counts.has(view.prefix)) counts.set(view.prefix, 0);
	/** @param {string} value @param {string} label @param {number} n */
	const chip = (value, label, n) =>
		html`<button class=${`chip${view.prefix === value ? " active" : ""}`} onClick=${() => setView({ prefix: value, epoch: view.epoch + 1 })}>${label}<span class="n">${n}</span></button>`;

	let body;
	if (shown.length === 0) {
		const empty = !models.length
			? service.status?.keySource ? "目录是空的。点“刷新目录”重新读取。" : "目录是空的。设置好密钥后点“刷新目录”。"
			: view.prefix === ENABLED && !models.some((model) => model.enabled) ? "还没有启用模型" : "没有符合条件的模型";
		body = html`<div class="table-wrap"><div class="empty">${empty}</div></div>`;
	} else {
		/** @type {Map<string, Model[]>} */
		const groups = new Map();
		for (const model of shown) {
			const prefix = prefixOf(model.id);
			groups.set(prefix, [...(groups.get(prefix) ?? []), model]);
		}
		// 每个分组单独放一张表，彼此隔开。各表列宽相同，表头只放在第一张上。
		body = [...groups].sort(([a], [b]) => byPrefix(a, b)).map(([prefix, list], index) => {
			list.sort(newestFirst);
			const enabled = list.filter((model) => model.enabled).length;
			const id = `${service.name}/${prefix}`;
			const closed = collapsed.has(id);
			return html`<div class="table-wrap" key=${prefix}><table class="models">
				<colgroup>${[0, 1, 2, 3, 4, 5, 6].map(() => html`<col />`)}</colgroup>
				${index === 0 ? html`<thead><tr>${["", "模型", "协议", "上下文", "最大输出", "思考档位", "owned_by"].map((title) => html`<th>${title}</th>`)}</tr></thead>` : null}
				<tbody>
					<tr class=${`group${closed ? " collapsed" : ""}`} onClick=${() => toggleGroup(id)}>
						<td colspan="7"><span class="caret"><${Caret} /></span><b>${prefix}</b>${list.length} 个${enabled ? `，已启用 ${enabled}` : ""}</td>
					</tr>
					${closed ? null : list.map((model) => html`<${ModelRow} key=${model.id} store=${store} service=${service} model=${model} open=${openModel === model.id} onOpen=${onOpen} />`)}
				</tbody>
			</table></div>`;
		});
	}

	return html`<div>
		<${LatestBanner} key=${service.name} store=${store} service=${service} />
		<div class="toolbar">
			<div class="search"><${SearchIcon} /><input class="input" type="search" value=${view.text} placeholder="搜索模型 id 或名称" onInput=${(/** @type {Event} */ event) => setView({ text: /** @type {HTMLInputElement} */ (event.currentTarget).value })} /></div>
			<select class="input" value=${view.api} onChange=${(/** @type {Event} */ event) => setView({ api: /** @type {HTMLSelectElement} */ (event.currentTarget).value })}>${options(models.map((model) => model.api.value), "全部协议")}</select>
			<select class="input" value=${view.owner} onChange=${(/** @type {Event} */ event) => setView({ owner: /** @type {HTMLSelectElement} */ (event.currentTarget).value })}>${options(models.map((model) => model.ownedBy ?? ""), "全部 owned_by")}</select>
			<label class="check"><input type="checkbox" checked=${view.hidden} onChange=${(/** @type {Event} */ event) => setView({ hidden: /** @type {HTMLInputElement} */ (event.currentTarget).checked })} />显示隐藏模型</label>
			<span class="spacer"></span>
			<span class="hint count">显示 ${shown.length} / ${models.length}</span>
		</div>
		<div class="chips">
			${chip("", "全部", filtered.length)}
			${chip(ENABLED, "已启用", filtered.filter((model) => model.enabled).length)}
			<${LatestToggle} store=${store} service=${service} />
			<span class="chips-sep" role="separator"></span>
			${[...counts].sort(([a], [b]) => byPrefix(a, b)).map(([prefix, n]) => chip(prefix, prefix, n))}
		</div>
		${body}
		<div class="legend">
			<span>参数来源：</span>
			${PARAM_SOURCES.map((source) => html`<span><${Dot} source=${source} />${SOURCE[source]}</span>`)}
			<${ModelsDevStatus} status=${store.get().data.modelsDev} />
			<span class="spacer"></span><span>点击查看详情和手动设置</span>
		</div>
	</div>`;
}
