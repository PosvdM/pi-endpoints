// @ts-check
// 模型详情面板：生效的参数、手动设置表单和测试消息。
// 调用方以“服务名/模型 id”为 key 渲染，换模型时整个面板重建，表单、提示和测试结果都只属于这一个模型。
import { useEffect, useRef, useState } from "preact/hooks";
import { EnableSwitch, html, SrcText, Star } from "./ui.js";
import { formToOverride, full, LONG_CONTEXT_BETA, nonChat, overrideToForm, SOURCE, TYPE_LABEL } from "./util.js";

/** @typedef {import("./util.js").Model} Model */
/** @typedef {import("./util.js").Service} Service */
/** @typedef {import("./store.js").Store} Store */

// 焦点是否在输入框、文本框或下拉框里。这时详情面板不响应 Esc，免得误触丢掉输入。
export const typing = () => document.activeElement?.matches("textarea, select, input:not([type=checkbox]):not([type=radio])") ?? false;

/**
 * 生效的参数，每次重画都按最新状态显示。
 * @param {{ model: Model }} props
 */
function Effective({ model }) {
	const o = model.override;
	/** @type {any[]} */
	const facts = [];
	/** @param {string} label @param {...any} value */
	const fact = (label, ...value) => facts.push(html`<dt>${label}</dt><dd>${value}</dd>`);
	fact("协议", html`<span class="api">${model.api.value}</span>`, html`<${SrcText} source=${model.api.source} />`);
	fact("地址", html`<span class="mono small">${model.baseUrl.value}</span>`, model.baseUrl.source === "manual" ? html`<${SrcText} source="manual" />` : null);
	fact("上下文", html`<span class="num">${full(model.contextWindow.value)}</span>`, html`<${SrcText} source=${model.contextWindow.source} />`);
	fact("最大输出", html`<span class="num">${full(model.maxTokens.value)}</span>`, html`<${SrcText} source=${model.maxTokens.source} />`);
	fact("输入", model.input.value.join(", "), html`<${SrcText} source=${model.input.source} />`);
	fact("思考档位", model.levels.length ? model.levels.join(", ") : "不支持调节", html`<${SrcText} source=${model.thinkingLevelMap.source} />`);
	if (model.betas.length) {
		fact("附加 beta", html`<span class="mono small">${model.betas.join(", ")}</span>`,
			model.betas.includes(LONG_CONTEXT_BETA) ? html`<span class="srctext">上下文超过 200K 时自动申请 1M</span>` : null);
	}
	if (model.headers) fact("请求头", html`<span class="mono small">${JSON.stringify(model.headers)}</span>`);
	// 每个 compat 字段的来源取自 compatSources。服务端没有给出时，按整体来源推算：Anthropic 协议的会话亲和字段没有手动设置时来自默认值。
	const affinityDefault = model.api.value === "anthropic-messages" && o.compat?.sendSessionAffinityHeaders == null;
	/** @param {string} key */
	const compatSourceOf = (key) => model.compatSources?.[key] ?? (key === "sendSessionAffinityHeaders" && affinityDefault ? "default" : model.compat.source);
	const compatTags = Object.entries(model.compat.value ?? {}).map(([key, value]) =>
		html`<span class="tag mono flush" title=${`来源：${SOURCE[compatSourceOf(key)] ?? compatSourceOf(key)}`}>${value === true ? key : `${key}: ${JSON.stringify(value)}`}</span>`);
	// 手动 compat 里值为 null 的字段表示删掉，加删除线显示。
	const removed = Object.entries(o.compat ?? {}).filter(([, value]) => value === null).map(([key]) => key);
	const removedTags = removed.map((key) => html`<span class="tag mono del flush" title="手动删除">${key}</span>`);
	const usedSources = new Set(Object.keys(model.compat.value ?? {}).map(compatSourceOf));
	if (removed.length) usedSources.add("manual");
	const mixed = usedSources.size > 1 || (usedSources.size === 1 && !usedSources.has(model.compat.source));
	const compatLabel = mixed ? ["manual", "pi", "default"].filter((source) => usedSources.has(source)).map((source) => SOURCE[source]).join(" + ") : undefined;
	fact("compat", ...(compatTags.length || removedTags.length ? [...compatTags, ...removedTags] : ["无"]), html`<${SrcText} source=${model.compat.source} label=${compatLabel} />`);
	const price = model.cost.value;
	fact("价格", html`<span class="num">输入 $${price.input} · 输出 $${price.output} · 缓存读 $${price.cacheRead} · 缓存写 $${price.cacheWrite}（每百万 token）</span>`, html`<${SrcText} source=${model.cost.source} />`);
	if (model.builtin) fact("pi 自带目录", html`<span class="mono small">${model.builtin}</span>`);
	if (model.modelsDev) fact("models.dev", html`<span class="mono small">${model.modelsDev}</span>`);
	return html`<dl class="kv">${facts}</dl>`;
}

/**
 * @param {{ store: Store; service: Service; model: Model | undefined; fallback: Model; onClose: () => void }} props
 * `model` 是最新状态里的这个模型；被停用、又已经不在目录里时为 undefined，面板沿用 `fallback`（最后一次看到的参数），
 * 开关按未启用显示，星标清空：旧的星标可能还显示着被换掉的默认模型，点了会清掉刚换上的新默认模型。
 */
export function Drawer({ store, service, model, fallback, onClose }) {
	const shown = model ?? fallback;
	const [form, setForm] = useState(() => overrideToForm(shown.override));
	// 打开时（以及保存或清除之后）表单的值，关闭面板时和当前的值比较。测试消息的档位不算修改。
	const [initial, setInitial] = useState(form);
	// 提示区里面板自己的内容：表单的校验错误或测试结果，mark 是出现的时刻（store.mark()）。
	const [note, setNote] = useState(/** @type {{ kind: "error" | "ok" | "fail"; text: string; mark: number } | null} */ (null));
	const [testing, setTesting] = useState(false);
	const [testLevel, setTestLevel] = useState("");
	// 打开面板之后出现的顶部错误也显示在面板里：面板盖住了页面顶部的错误提示。
	const openedAt = useRef(store.mark());
	// 最后一次在提示区里显示过的顶部错误的编号。错误出现后，比它早的测试结果不再显示。
	const shownError = useRef(0);
	const mounted = useRef(true);
	useEffect(() => () => {
		mounted.current = false;
	}, []);

	const dirty = JSON.stringify(form) !== JSON.stringify(initial);
	// 手动设置有没保存的修改时，关闭前先确认。
	const requestClose = () => {
		if (dirty && !confirm("放弃没保存的修改？")) return;
		onClose();
	};
	const closeRef = useRef(requestClose);
	closeRef.current = requestClose;
	useEffect(() => {
		/** @param {KeyboardEvent} event */
		const keydown = (event) => {
			if (event.key !== "Escape") return;
			// 输入法选字时的 Esc 用来取消选字；焦点在输入框里时也不关闭面板，免得误触丢掉输入。
			if (event.isComposing || event.keyCode === 229 || typing()) return;
			closeRef.current();
		};
		document.addEventListener("keydown", keydown);
		return () => document.removeEventListener("keydown", keydown);
	}, []);

	/** 保存或清除成功后，按服务端保存的手动设置重建表单。 */
	const resetForm = () => {
		const saved = store.get().data.services.find((item) => item.name === service.name)?.models.find((item) => item.id === shown.id);
		const next = overrideToForm(saved?.override ?? {});
		setForm(next);
		setInitial(next);
	};

	/** @param {Record<string, any> | undefined} override @param {string} okText */
	const submit = async (override, okText) => {
		const data = await store.act("setOverride", { name: service.name, id: shown.id, override }, { okText });
		if (data && mounted.current) resetForm();
	};
	const save = () => {
		let override;
		try {
			override = formToOverride(form);
		} catch (failure) {
			setNote({ kind: "error", text: failure instanceof Error ? failure.message : String(failure), mark: store.mark() });
			return;
		}
		submit(override, "手动设置已保存");
	};
	const clear = () => submit(undefined, "已清除手动设置");

	// 测试消息的思考档位，默认不设置。模型不支持调节思考时不显示。选中的档位按最新的 levels 校验：
	// 手动设置改掉了这个档位后按“不设置”显示和发送，下拉框显示的和请求里的一致。
	const testLevels = shown.levels.filter((level) => level !== "off");
	const level = testLevels.includes(testLevel) ? testLevel : "";
	const sendTest = async () => {
		setTesting(true);
		/** @type {{ kind: "ok" | "fail"; text: string }} */
		let next;
		try {
			const result = await store.test({ name: service.name, id: shown.id, ...(level ? { thinkingLevel: level } : {}) });
			const sent = result.request.thinkingLevel ? ` · 思考档位 ${result.request.thinkingLevel}` : "";
			next = {
				kind: result.ok ? "ok" : "fail",
				text: `${result.ok ? "成功" : "失败"} · ${result.request.api} ${result.request.baseUrl}${sent} · ${(result.durationMs / 1000).toFixed(1)} 秒 · stopReason: ${result.stopReason}\n`
					+ (result.ok ? `回复：${result.text}` : result.error || "没有返回错误信息"),
			};
		} catch (failure) {
			next = { kind: "fail", text: failure instanceof Error ? failure.message : String(failure) };
		}
		// 面板已经关了或换了模型时丢掉结果，结果只属于发出时的模型。
		if (!mounted.current) return;
		setNote({ ...next, mark: store.mark() });
		setTesting(false);
	};

	// 提示区只有一份内容，后出现的盖住先出现的：校验错误、打开面板后出现的顶部错误和测试结果谁新显示谁。
	// 操作成功（okMark）后清掉比它早的校验错误，顶部错误由 store 清掉；测试结果保留，但被错误盖住过的不再显示。
	const { error, okMark } = store.get();
	const topError = error && error.id > openedAt.current ? error : null;
	if (topError) shownError.current = Math.max(shownError.current, topError.id);
	/** @type {{ kind: "error" | "ok" | "fail"; text: string } | null} */
	let message = null;
	if (topError && topError.id > (note?.mark ?? 0)) message = { kind: "error", text: topError.text };
	else if (note?.kind === "error") message = note.mark > okMark ? note : null;
	else if (note && note.mark > shownError.current) message = note;
	const type = nonChat(shown);
	const o = shown.override;
	/** @param {keyof typeof form} key */
	const bind = (key) => ({
		value: form[key],
		onInput: (/** @type {Event} */ event) => setForm({ ...form, [key]: /** @type {HTMLInputElement} */ (event.currentTarget).value }),
	});
	/** @param {string} label @param {any} input @param {string} [hint] */
	const field = (label, input, hint) => html`<label>${label}</label><div>${input}${hint ? html`<div class="hint">${hint}</div>` : null}</div>`;
	// 用普通文本框：Safari 和 Firefox 的 number 框遇到 1,000,000 或 1M 时读出空值，会被当成没填。由 parseCount() 解析。
	const countHint = "可以写 1000000、1,000,000、200K 或 1M";
	const compatHint = "只写要改的字段，其余照常从 pi 自带目录取；写 null 表示删掉这个字段";
	/** @param {keyof typeof form} key */
	const selectBind = (key) => ({
		value: form[key],
		onChange: (/** @type {Event} */ event) => setForm({ ...form, [key]: /** @type {HTMLSelectElement} */ (event.currentTarget).value }),
	});

	return html`<div>
		<div class="scrim" onClick=${requestClose}></div>
		<div class="drawer" role="dialog" aria-label=${shown.id}>
			<div class="drawer-head">
				<${EnableSwitch} store=${store} service=${service} model=${model ?? { ...shown, enabled: false }} class="drawer-toggle" />
				<div class="grow"><div class="model-id">${shown.id}</div><div class="model-name">${shown.name.value}</div></div>
				<span class="drawer-star">${model ? html`<${Star} store=${store} service=${service} model=${model} />` : null}</span>
				<button class="close" title="关闭" onClick=${requestClose}>×</button>
			</div>
			<div class="drawer-body">
				${type ? html`<div class="banner warn">models.dev 标注这是${TYPE_LABEL[shown.modelType ?? ""] ? type : ` ${type} 类型的模型`}，pi 不能拿它对话。${shown.enabled ? "它不会注册到 pi，可以停用。" : "不能启用。"}</div>` : null}
				<div class="section-title">生效的参数</div>
				<${Effective} model=${shown} />
				<div class="section-title">手动设置 · 留空的项自动取值</div>
				<div class="form">
					${field("名称", html`<input class="input" type="text" placeholder=${shown.name.value} ...${bind("name")} />`)}
					${field("协议", html`<select class="input" ...${selectBind("api")}><option value="">自动（${shown.api.value}）</option>${store.get().data.apis.map((value) => html`<option value=${value}>${value}</option>`)}</select>`)}
					${field("地址", html`<input class="input" type="text" placeholder="自动：按协议拼接" ...${bind("baseUrl")} />`)}
					${field("上下文", html`<input class="input" type="text" placeholder=${String(shown.contextWindow.value)} ...${bind("contextWindow")} />`,
						shown.betas.includes(LONG_CONTEXT_BETA) ? `${countHint}。超过 200000 时自动带上 context-1m beta；不想要就填 200000` : countHint)}
					${field("最大输出", html`<input class="input" type="text" placeholder=${String(shown.maxTokens.value)} ...${bind("maxTokens")} />`, countHint)}
					${field("输入", html`<select class="input" ...${selectBind("input")}><option value="">自动</option><option value="text">仅文本</option><option value="text,image">文本和图片</option></select>`)}
					${field("思考档位", html`<input class="input" type="text" placeholder="自动，例如 low, medium, high" ...${bind("thinkingLevels")} />`, "只填 none 表示不支持调节；和其他档位一起写 none 或 off 表示可以关闭思考")}
					${field("请求头", html`<textarea class="input" placeholder='例如 {"X-Title": "pi"}' ...${bind("headers")}></textarea>`, "Anthropic 协议的 anthropic-beta 会追加到 pi 自己的 beta 列表里")}
					${field("compat", html`<textarea class="input" placeholder='只写要改的字段，例如 {"supportsStore": false}' ...${bind("compat")}></textarea>`,
						shown.api.value === "anthropic-messages" ? `${compatHint}。sendSessionAffinityHeaders 默认开启；设为 false 可关闭会话亲和请求头` : compatHint)}
					${field("价格", html`<textarea class="input" placeholder='每百万 token 的美元价格，例如 {"input": 2, "output": 10}' ...${bind("cost")}></textarea>`)}
				</div>
			</div>
			<div class="drawer-msg">${message?.kind === "error"
				? html`<div class="banner err">${message.text}</div>`
				: message ? html`<div class=${`result ${message.kind === "ok" ? "ok" : "err"}`}>${message.text}</div>` : null}</div>
			<div class="drawer-foot">
				<button class="btn primary" onClick=${save}>保存</button>
				<button class="btn" disabled=${!Object.keys(o).length} onClick=${clear}>清除手动设置</button>
				<span class="spacer"></span>
				${testLevels.length
					? html`<select class="input" title="测试消息的思考档位" value=${level} onChange=${(/** @type {Event} */ event) => setTestLevel(/** @type {HTMLSelectElement} */ (event.currentTarget).value)}>
						<option value="">不设置</option>${testLevels.map((level) => html`<option value=${level}>${level}</option>`)}</select>`
					: null}
				<button class="btn" disabled=${testing} onClick=${sendTest}>${testing ? "测试中…" : "发送测试消息"}</button>
			</div>
		</div>
	</div>`;
}
