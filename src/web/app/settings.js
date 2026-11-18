// @ts-check
// “服务设置”页和“添加服务”页：密钥卡片、服务表单和删除服务。
// 表单的输入是组件自己的状态，状态更新和后台刷新不会冲掉；同时写进调用方持有的 drafts，
// 切到“模型”页再回来时从 drafts 恢复。调用方在切换服务、点“添加服务”或保存成功后丢掉草稿。
import { useState } from "preact/hooks";
import { html } from "./ui.js";
import { parseJsonField, slugify } from "./util.js";

/** @typedef {import("./util.js").Service} Service */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {Map<string, any>} Drafts */

/** 草稿在 drafts 里的键。 */
export const draftKey = {
	/** @param {string} [name] 已有服务的名字，添加服务时不传 */
	service: (name) => `service:${name ?? ""}`,
	/** @param {string} name */
	key: (name) => `key:${name}`,
};

// one-time-code 让 Chrome 不把网站密码填进密钥框；off 对密码框无效，new-password 会弹出生成密码。
/** @param {{ value: string; placeholder: string; onInput: (value: string) => void }} props */
const KeyInput = ({ value, placeholder, onInput }) =>
	html`<input class="input" type="password" placeholder=${placeholder} autocomplete="one-time-code" data-1p-ignore data-bwignore data-lpignore="true" value=${value} onInput=${(/** @type {Event} */ event) => onInput(/** @type {HTMLInputElement} */ (event.currentTarget).value)} />`;

/** @param {{ store: Store; service: Service; drafts: Drafts }} props */
export function KeyCard({ store, service, drafts }) {
	// 保存失败时已填的密钥留在框里。
	const draft = draftKey.key(service.name);
	const [value, setValueState] = useState(() => /** @type {string} */ (drafts.get(draft) ?? ""));
	/** @param {string} next */
	const setValue = (next) => {
		if (next) drafts.set(draft, next);
		else drafts.delete(draft);
		setValueState(next);
	};
	const status = service.status;
	const text = status?.keySource === "env" ? `已设置，来自环境变量 ${service.apiKeyEnv}，优先于文件里的密钥` : status?.keySource === "file" ? "已设置，保存在本机文件" : "未设置";
	const save = async () => {
		if (value.trim() && (await store.act("setKey", { name: service.name, apiKey: value }, { okText: "密钥已保存" }))) setValue("");
	};
	const clear = async () => {
		if (confirm("清除文件里保存的密钥？")) await store.act("setKey", { name: service.name, apiKey: "" }, { okText: "密钥已清除" });
	};
	return html`<div class="card">
		<h3>密钥 <span class=${`pill key-pill ${status?.keySource ? "on" : "warn"}`}>${text}</span></h3>
		<div class="key-row">
			<${KeyInput} value=${value} placeholder=${status?.keySource ? "已设置，输入新密钥可替换" : "输入密钥"} onInput=${setValue} />
			<button class="btn" onClick=${save}>保存密钥</button>
			<button class="btn danger" disabled=${!status?.keySource || status.keySource === "env"} onClick=${clear}>清除</button>
		</div>
		<div class="hint">密钥只写不读，页面不会显示已保存的密钥。</div>
	</div>`;
}

/**
 * 添加服务（`service` 为 undefined）或修改已有服务的表单。保存成功后丢掉草稿，调用 `onSaved(新服务名)`。
 * @param {{ store: Store; service?: Service; drafts: Drafts; onSaved: (name: string) => void }} props
 */
export function ServiceForm({ store, service, drafts, onSaved }) {
	const isNew = !service;
	const draft = draftKey.service(service?.name);
	const saved = drafts.get(draft);
	const [values, setValues] = useState(() => {
		const fresh = {
			name: service?.name ?? "",
			displayName: service?.displayName ?? "",
			baseUrl: service?.baseUrl ?? "",
			defaultApi: service?.defaultApi ?? "",
			apiKey: "",
			apiKeyEnv: service?.apiKeyEnv ?? "",
			headers: service && Object.keys(service.headers).length ? JSON.stringify(service.headers, null, 2) : "",
			// 添加服务时默认打开“每系最新”。已有服务的开关在模型页，不在这个表单里。
			latestPerFamily: true,
		};
		return /** @type {typeof fresh} */ (saved?.values ?? fresh);
	});
	// 添加服务时，名字跟着显示名生成，直到用户自己改名字；把名字清空后重新跟随。
	const [nameTouched, setNameTouchedState] = useState(() => /** @type {boolean} */ (saved?.nameTouched ?? false));
	const [busy, setBusy] = useState(false);
	/** @param {Partial<typeof values>} patch */
	const update = (patch) => setValues((previous) => {
		const next = { ...previous, ...patch };
		drafts.set(draft, { values: next, nameTouched: drafts.get(draft)?.nameTouched ?? nameTouched });
		return next;
	});
	/** @param {boolean} touched */
	const setNameTouched = (touched) => {
		drafts.set(draft, { values: drafts.get(draft)?.values ?? values, nameTouched: touched });
		setNameTouchedState(touched);
	};
	/** @param {keyof typeof values} key */
	const text = (key) => ({
		value: values[key],
		onInput: (/** @type {Event} */ event) => update({ [key]: /** @type {HTMLInputElement} */ (event.currentTarget).value }),
	});
	/** @param {string} label @param {any} input @param {string} [hint] */
	const field = (label, input, hint) => html`<label>${label}</label><div>${input}${hint ? html`<div class="hint">${hint}</div>` : null}</div>`;

	const submit = async () => {
		let headers;
		try {
			headers = parseJsonField(values.headers, "请求头");
		} catch (failure) {
			store.setError(failure instanceof Error ? failure.message : String(failure));
			return;
		}
		const name = values.name.trim().toLowerCase();
		/** @type {Record<string, unknown>} */
		const body = {
			previousName: service?.name,
			apiKey: isNew ? values.apiKey : undefined,
			service: {
				name,
				displayName: values.displayName,
				baseUrl: values.baseUrl,
				defaultApi: values.defaultApi,
				apiKeyEnv: values.apiKeyEnv,
				headers: headers ?? {},
				...(isNew ? { latestPerFamily: values.latestPerFamily } : {}),
			},
		};
		// 添加服务时还要读取目录，最长等到超时。请求期间禁用按钮，免得重复提交。
		setBusy(true);
		const data = await store.act("saveService", body, { okText: isNew ? "已添加" : "已保存" });
		setBusy(false);
		if (data) {
			drafts.delete(draft);
			onSaved(name);
		}
	};

	return html`<div class="card">
		<h3>${isNew ? "添加服务" : "服务"}</h3>
		<div class="form">
			${field("显示名", html`<input class="input" type="text" placeholder="可选，显示在 pi 的模型列表里" value=${values.displayName} onInput=${(/** @type {Event} */ event) => {
				const displayName = /** @type {HTMLInputElement} */ (event.currentTarget).value;
				update(isNew && !nameTouched ? { displayName, name: slugify(displayName) } : { displayName });
			}} />`)}
			${field("名字", html`<input class="input" type="text" placeholder="cpa" value=${values.name}
				onInput=${(/** @type {Event} */ event) => {
					const name = /** @type {HTMLInputElement} */ (event.currentTarget).value;
					setNameTouched(name !== "");
					update({ name });
				}}
				onBlur=${() => update({ name: values.name.trim().toLowerCase() })} />`,
				`pi 里的服务商名，模型写成 名字/模型 id。只能用小写字母、数字、点、下划线和连字符。${isNew ? "默认按显示名生成，可以修改。" : ""}`)}
			${field("地址", html`<input class="input" type="text" placeholder="https://example.com" ...${text("baseUrl")} />`, "服务根地址，不带 /v1")}
			${isNew ? field("密钥", html`<${KeyInput} value=${values.apiKey} placeholder="可选，用环境变量提供密钥时可以不填" onInput=${(/** @type {string} */ apiKey) => update({ apiKey })} />`, "只保存在本机，页面不会再显示") : null}
			${field("密钥环境变量", html`<input class="input" type="text" placeholder="可选，例如 CPA_API_KEY" ...${text("apiKeyEnv")} />`, "设置了这个环境变量时优先用它")}
			${field("默认协议", html`<select class="input" value=${values.defaultApi} onChange=${(/** @type {Event} */ event) => update({ defaultApi: /** @type {HTMLSelectElement} */ (event.currentTarget).value })}>
				<option value="">openai-completions（默认）</option>${store.get().data.apis.map((value) => html`<option value=${value}>${value}</option>`)}</select>`,
				"协议按模型分别判断，同一服务可混用多种协议，无需按协议拆分。仅无法判断时使用此项。")}
			${field("请求头", html`<textarea class="input" placeholder='可选，例如 {"X-Title": "pi"}' ...${text("headers")}></textarea>`, "加在这个服务所有请求上，按原样发送。Anthropic 协议的 anthropic-beta 会追加到 pi 自己的 beta 列表里")}
			${isNew ? field("每系最新", html`<label class="check latest-new"><input type="checkbox" class="switch" checked=${values.latestPerFamily}
				onChange=${(/** @type {Event} */ event) => update({ latestPerFamily: /** @type {HTMLInputElement} */ (event.currentTarget).checked })} />每个系列只保留最新版</label>`,
				"目录出了同系列的新版时自动启用新版、停用旧版，并替换 pi 默认模型和 Ctrl+P 列表里的旧版。添加后可以在模型页关闭。") : null}
		</div>
		<div class="actions"><button class="btn primary" disabled=${busy} onClick=${submit}>${busy ? (isNew ? "添加中…" : "保存中…") : isNew ? "添加" : "保存"}</button></div>
	</div>`;
}

/** @param {{ store: Store; service: Service; onRemoved: () => void }} props */
export function DangerCard({ store, service, onRemoved }) {
	const remove = async () => {
		if (!confirm(`删除服务 ${service.name}？它的密钥和目录缓存也会删除。`)) return;
		if (await store.act("removeService", { name: service.name }, { okText: "已删除" })) onRemoved();
	};
	return html`<div class="card danger">
		<h3>删除服务</h3>
		<div class="hint danger-hint">服务的密钥和目录缓存会一起删除。</div>
		<button class="btn danger" onClick=${remove}>删除服务</button>
	</div>`;
}
