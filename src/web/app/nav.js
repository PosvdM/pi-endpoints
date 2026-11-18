// @ts-check
// 左栏：服务列表、“添加服务”按钮和版本号。
import { html, UpdateIcon } from "./ui.js";
import { pendingKey } from "./store.js";

/** @typedef {import("./util.js").Service} Service */
/** @typedef {import("./store.js").Store} Store */

/**
 * 左栏的两组服务：[启用的, 停用的]，组内保持配置文件里的顺序。
 * 分组按 `parked` 记下的状态：页面打开时（或服务第一次出现时）服务是否停用。切换开关后服务先留在原处，方便改回来，刷新页面后再挪。
 * @param {Service[]} services
 * @param {Map<string, boolean>} parked
 * @returns {[Service[], Service[]]}
 */
export function serviceGroups(services, parked) {
	for (const item of services) if (!parked.has(item.name)) parked.set(item.name, Boolean(item.status?.disabled));
	return [services.filter((item) => !parked.get(item.name)), services.filter((item) => parked.get(item.name))];
}

/** @param {Service} item */
const statusClass = (item) => (item.status?.disabled ? "" : item.status?.error ? "err" : item.status?.registered ? "on" : "");

/**
 * @param {{ store: Store; services: Service[]; parked: Map<string, boolean>; current: string | null; onSelect: (name: string) => void; onAdd: () => void }} props
 */
export function Nav({ store, services, parked, current, onSelect, onAdd }) {
	const [on, off] = serviceGroups(services, parked);
	const { version } = store.get().data;
	const update = store.get().update;

	/** @param {Service} item */
	const row = (item) => {
		const key = pendingKey.disabled(item.name);
		const disabled = store.get().pending.get(key) ?? Boolean(item.status?.disabled);
		/** @param {Event} event */
		const toggle = async (event) => {
			const next = !(/** @type {HTMLInputElement} */ (event.currentTarget).checked);
			const data = await store.act("setServiceDisabled", { name: item.name, disabled: next }, { pending: [key, next] });
			// 停用期间服务端的模型可能变了，重新启用时刷新一次。
			if (data && !next && item.status?.keySource) store.refresh(item.name, { background: true });
		};
		/** @param {KeyboardEvent} event */
		const keydown = (event) => {
			if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
				event.preventDefault();
				onSelect(item.name);
			}
		};
		const updates = item.updates ?? [];
		// 按钮里不能放开关，所以用 div 模拟按钮。
		return html`<div key=${item.name} class=${`svc${item.name === current ? " active" : ""}`} role="button" tabindex="0" onClick=${() => onSelect(item.name)} onKeyDown=${keydown}>
			<span class=${`status ${statusClass(item)}`}></span>
			<span class="meta">
				<div class="title"><span class="name">${item.displayName || item.name}</span>${updates.length
					? html`<span class="tag accent new" title=${`${updates.length} 个已启用模型有新版`}>有新版</span>`
					: null}</div>
				<div class="sub">${item.status?.disabled ? "已停用" : `${item.models.filter((model) => model.enabled).length} 个已启用`}</div>
			</span>
			<input type="checkbox" class="switch" title=${disabled ? "启用服务" : "停用服务"} checked=${!disabled} onClick=${(/** @type {Event} */ event) => event.stopPropagation()} onChange=${toggle} />
		</div>`;
	};

	return html`<aside>
		<div class="brand"><div class="logo">π</div><b>pi-endpoints</b></div>
		<div class="side-label">服务</div>
		<div class="services">
			${on.map(row)}
			${on.length && off.length ? html`<div class="svc-sep" role="separator"></div>` : null}
			${off.map(row)}
		</div>
		<div class="side-foot">
			<button class="btn block" onClick=${onAdd}>＋ 添加服务</button>
			<p>修改会立即保存并在 pi 里生效</p>
			${version
				? html`<p class="version">v${version}${update?.latestVersion
					? html`<a class="update" href=${update.releaseUrl} target="_blank" rel="noopener" title=${`有新版本 v${update.latestVersion}`} aria-label=${`有新版本 v${update.latestVersion}`}><${UpdateIcon} /></a>`
					: null}</p>`
				: null}
		</div>
	</aside>`;
}
