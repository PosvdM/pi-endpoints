// @ts-check
// 管理页的根组件：左栏、服务页头、提示、标签页和详情面板。
import { render } from "preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { Drawer } from "./drawer.js";
import { ModelsPage } from "./models.js";
import { Nav, serviceGroups } from "./nav.js";
import { DangerCard, KeyCard, ServiceForm } from "./settings.js";
import { createStore } from "./store.js";
import { html } from "./ui.js";

/** @typedef {import("./util.js").Service} Service */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./models.js").View} View */

/**
 * @param {{ store: Store; service: Service }} props
 */
function Head({ store, service }) {
	const status = service.status;
	const pill = status?.disabled ? html`<span class="pill">已停用</span>`
		: status?.error ? html`<span class="pill err">有错误</span>`
		: status?.registered ? html`<span class="pill on">已注册到 pi</span>`
		: html`<span class="pill">未注册</span>`;
	const key = status?.keySource === "env" ? `密钥来自环境变量 ${service.apiKeyEnv}` : status?.keySource === "file" ? "密钥已设置" : "未设置密钥";
	const catalog = service.catalog ? `目录 ${service.catalog.size} 个模型 · ${new Date(service.catalog.fetchedAt).toLocaleString()} 刷新` : "还没有读取过目录";
	// 后台刷新期间按钮同样显示“刷新中…”，不能再点。
	const busy = store.get().refreshing.has(service.name);
	return html`<div class="head">
		<div class="info">
			<h1>${service.displayName || service.name}${pill}</h1>
			<div class="facts">
				<span class="mono">${service.baseUrl}</span>
				<span>服务名 ${service.name}</span>
				<span class=${status?.keySource ? "" : "warn"}>${key}</span>
				<span>${catalog}</span>
			</div>
		</div>
		<button class="btn" disabled=${busy} onClick=${() => store.refresh(service.name)}>${busy ? "刷新中…" : "刷新目录"}</button>
	</div>`;
}

/**
 * 右下角的提示条，每条显示 2.2 秒。
 * @param {{ toast: { text: string; id: number } | null }} props
 */
function Toast({ toast }) {
	const [shown, setShown] = useState(/** @type {number | null} */ (null));
	useEffect(() => {
		if (!toast) return undefined;
		setShown(toast.id);
		const timer = setTimeout(() => setShown(null), 2200);
		return () => clearTimeout(timer);
	}, [toast?.id]);
	return html`<div class=${`toast${toast && shown === toast.id ? " show" : ""}`} role="status">${toast?.text ?? ""}</div>`;
}

const EMPTY_VIEW = /** @type {View} */ ({ text: "", api: "", owner: "", hidden: false, prefix: "", epoch: 0 });

/**
 * @param {{ store: Store; initialService: string | null }} props
 * `initialService` 是网址里 `service` 参数指定的服务，存在时打开页面后选中它的“模型”页。
 */
export function App({ store, initialService }) {
	const [, rerender] = useReducer((/** @type {number} */ n) => n + 1, 0);
	useEffect(() => store.subscribe(() => rerender(undefined)), [store]);
	const snapshot = store.get();
	const { data, error } = snapshot;

	// 当前服务名；"" 表示添加服务，null 表示还没加载完。
	const [current, setCurrent] = useState(/** @type {string | null} */ (null));
	const [tab, setTab] = useState(/** @type {"models" | "settings"} */ ("models"));
	const [openModel, setOpenModel] = useState(/** @type {string | null} */ (null));
	const [view, setViewState] = useState(EMPTY_VIEW);
	const [collapsed, setCollapsed] = useState(() => new Set());
	// 服务表单和密钥框里没保存的内容，键见 settings.js 的 draftKey。切到“模型”页再回来时保留；
	// 切换服务、点“添加服务”或保存成功后丢掉。
	const drafts = useRef(/** @type {import("./settings.js").Drafts} */ (new Map())).current;
	// 表单重新开始时加一（点“添加服务”、保存成功后按服务端返回的值重填），表单以它为 key 重新挂载。
	const [formEpoch, setFormEpoch] = useState(0);
	const [loadFailure, setLoadFailure] = useState(/** @type {string | null} */ (null));
	// 本次打开页面期间的冻结状态，见 serviceGroups() 和 visibleModels()。
	const parked = useRef(/** @type {Map<string, boolean>} */ (new Map())).current;
	const frozen = useRef({ key: "", ids: /** @type {Set<string>} */ (new Set()) }).current;
	// 详情面板里的模型最后一次出现在状态里的样子，见 Drawer 的 fallback。
	const lastOpen = useRef(/** @type {{ key: string; model: import("./util.js").Model } | null} */ (null));

	const firstService = () => serviceGroups(store.get().data.services, parked).flat()[0]?.name ?? "";

	useEffect(() => {
		store.load().then((state) => {
			const wanted = initialService && state.services.some((item) => item.name === initialService) ? initialService : null;
			setCurrent(wanted ?? firstService());
			store.checkUpdate();
			// 缓存可能已经过时，比如在服务端停用了模型，所以打开页面时在后台刷新一次。
			for (const item of state.services) if (!item.status?.disabled && item.status?.keySource) store.refresh(item.name, { background: true });
		}, (failure) => setLoadFailure(`${failure.message}。请在 pi 里重新运行 /endpoints。`));
	}, []);

	/** @param {Partial<View>} patch */
	const setView = (patch) => setViewState((previous) => ({ ...previous, ...patch }));
	/** @param {string} name */
	const select = (name) => {
		// 离开服务时，模型表按新服务的条件重新选；同一个服务里切换标签页时保留。
		if (name !== current) frozen.key = "";
		drafts.clear();
		setCurrent(name);
		setTab("models");
		// 筛选条件按服务各自的模型生成，换服务后不再适用。
		setView({ api: "", owner: "", prefix: "" });
		setOpenModel(null);
		setFormEpoch((n) => n + 1);
		store.setError(null);
	};
	const add = () => {
		frozen.key = "";
		drafts.clear();
		setCurrent("");
		setOpenModel(null);
		setFormEpoch((n) => n + 1);
		store.setError(null);
	};
	/** @param {string} id */
	const toggleGroup = (id) => setCollapsed((previous) => {
		const next = new Set(previous);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	});

	if (loadFailure) {
		return html`<div class="app"><aside></aside><main><div class="page"><div class="banner err">${loadFailure}</div></div></main></div>`;
	}

	const service = data.services.find((item) => item.name === current);
	const parts = [];
	if (data.loadError) parts.push(html`<div class="banner err">读取配置失败：${data.loadError}。修好文件后在 pi 里运行 /reload。</div>`);
	if (error) {
		parts.push(html`<div class="banner err"><span class="grow">${error.text}</span><button class="close inherit" title="关闭" onClick=${() => store.setError(null)}>×</button></div>`);
	}
	if (current === null) {
		// 还在加载。
	} else if (current === "" || (!service && data.services.length === 0)) {
		parts.push(html`<div class="head"><div class="info"><h1>添加服务</h1>
			<div class="facts">填好地址和密钥，添加后会自动拉取模型目录，再勾选要启用的模型。</div></div></div>`);
		parts.push(html`<${ServiceForm} key=${`new/${formEpoch}`} store=${store} drafts=${drafts} onSaved=${(/** @type {string} */ name) => {
			setCurrent(name);
			setTab("models");
		}} />`);
	} else if (service) {
		const status = service.status;
		parts.push(html`<${Head} store=${store} service=${service} />`);
		// 刷新失败时页面顶部已经显示了同样的原因，关掉顶部提示后再显示这一条。
		if (status?.error && error?.text !== `刷新失败：${status.error}`) parts.push(html`<div class="banner err">错误：${status.error}</div>`);
		if (status?.syncError) parts.push(html`<div class="banner err">配置已保存，但没能更新运行中的 pi：${status.syncError}。请在 pi 里运行 /reload。</div>`);
		if (!status?.keySource) {
			parts.push(html`<div class="banner warn"><span class="grow">还没有设置密钥，模型不会注册到 pi。</span>
				<button class="btn small" onClick=${() => setTab("settings")}>去设置</button></div>`);
		}
		parts.push(html`<div class="tabs">
			<button class=${`tab${tab === "models" ? " active" : ""}`} onClick=${() => setTab("models")}>模型<span class="count">${service.models.length}</span></button>
			<button class=${`tab${tab === "settings" ? " active" : ""}`} onClick=${() => {
				setTab("settings");
				setOpenModel(null);
			}}>服务设置</button>
		</div>`);
		if (tab === "models") {
			parts.push(html`<${ModelsPage} store=${store} service=${service} view=${view} setView=${setView} frozen=${frozen}
				collapsed=${collapsed} toggleGroup=${toggleGroup} openModel=${openModel} onOpen=${setOpenModel} />`);
		} else {
			parts.push(html`<${KeyCard} key=${`key/${service.name}`} store=${store} service=${service} drafts=${drafts} />`);
			parts.push(html`<${ServiceForm} key=${`edit/${service.name}/${formEpoch}`} store=${store} service=${service} drafts=${drafts} onSaved=${(/** @type {string} */ name) => {
				// 按服务端保存的值（规范化后的地址等）重填表单。
				setCurrent(name);
				setFormEpoch((n) => n + 1);
			}} />`);
			parts.push(html`<${DangerCard} store=${store} service=${service} onRemoved=${() => {
				parked.delete(service.name);
				frozen.key = "";
				drafts.clear();
				setCurrent(firstService());
				setTab("models");
				setOpenModel(null);
				setFormEpoch((n) => n + 1);
			}} />`);
		}
	}

	const drawerKey = service && openModel !== null && tab === "models" ? `${service.name}/${openModel}` : null;
	const openFound = drawerKey ? service?.models.find((model) => model.id === openModel) : undefined;
	if (drawerKey && openFound) lastOpen.current = { key: drawerKey, model: openFound };
	const fallback = drawerKey && lastOpen.current?.key === drawerKey ? lastOpen.current.model : undefined;

	return html`<div class="app">
		<${Nav} store=${store} services=${data.services} parked=${parked} current=${current} onSelect=${select} onAdd=${add} />
		<main><div class="page">${parts}</div></main>
	</div>
	${service && drawerKey && fallback
		? html`<${Drawer} key=${drawerKey} store=${store} service=${service} model=${openFound} fallback=${fallback} onClose=${() => setOpenModel(null)} />`
		: null}
	<${Toast} toast=${snapshot.toast} />`;
}

/**
 * 在 `root` 里启动管理页。
 * @param {Element} root
 * @param {{ token: string; search?: string; fetch?: typeof globalThis.fetch }} options
 * @returns {{ store: Store; stop: () => void }} `stop()` 卸载页面并移除挂在 document 上的监听
 */
export function startApp(root, { token, search = "", fetch: fetchImpl }) {
	const store = createStore({ token, fetch: fetchImpl });
	const untrack = store.trackPointer(root.ownerDocument);
	const initialService = new URLSearchParams(search).get("service");
	render(html`<${App} store=${store} initialService=${initialService} />`, root);
	return {
		store,
		stop: () => {
			untrack();
			render(null, root);
		},
	};
}
