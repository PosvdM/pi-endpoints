// @ts-check
// 页面和服务端之间的状态：最新的服务端状态、顶部错误、正在刷新的服务、提交中的开关和提示条。
// 组件只读这里的快照，修改都经过这里的方法。
//
// store 里有两份快照。latest 是最新的：响应一到就按 X-Endpoints-Seq 采用其中的状态，错误和提示的编号也在这时分配；
// 成功回调、导航和表单重填都读它（store.latest()）。published 是发布给组件重画的那份（store.get()），
// 平时和 latest 相同；指针按下期间只推迟发布，松开后一次发布最新的快照，见 trackPointer()。

/** @typedef {import("./util.js").State} State */
/**
 * @typedef {{
 *   data: State;
 *   loaded: boolean;
 *   error: { text: string; id: number } | null;
 *   okMark: number;
 *   refreshing: Set<string>;
 *   pending: Map<string, { value: boolean; id: number }>;
 *   toast: { text: string; id: number } | null;
 *   update: { latestVersion?: string; releaseUrl?: string } | null;
 * }} Snapshot
 */
/** @typedef {(snapshot: Snapshot) => Partial<Snapshot>} Updater */
/** @typedef {{ okText?: string; pending?: [string, boolean] }} ActOptions */

/** 指针按住超过这么久（毫秒）就不再推迟发布，免得漏掉松开事件时页面一直不更新。 */
export const HOLD_LIMIT = 1000;

/** 开关在 pending 里的键。 */
export const pendingKey = {
	/** @param {string} service @param {string} id */
	enabled: (service, id) => `enabled:${service}/${id}`,
	/** @param {string} service */
	disabled: (service) => `disabled:${service}`,
	/** @param {string} service */
	latest: (service) => `latest:${service}`,
};

/**
 * @param {{ token: string; fetch?: typeof fetch }} options
 */
export function createStore({ token, fetch: fetchImpl = (...args) => globalThis.fetch(...args) }) {
	/** @type {Snapshot} */
	let latest = { data: { services: [], apis: [] }, loaded: false, error: null, okMark: 0, refreshing: new Set(), pending: new Map(), toast: null, update: null };
	let published = latest;
	/** @type {Set<() => void>} */
	const listeners = new Set();
	// 已采用的状态的编号（服务端的 X-Endpoints-Seq）。编号不大于它的状态是过期的，不采用。
	let appliedSeq = 0;
	// 错误、提示条、待提交的开关和各种时间标记共用的递增编号，可以用来比较先后。
	let ids = 0;
	// 修改操作排队执行，前一个结束后才发下一个，页面上的操作按点击顺序生效。
	/** @type {Promise<unknown>} */
	let queue = Promise.resolve();
	// 排队中和执行中的修改操作涉及的服务，以及失败时显示的错误（没失败时为 null）。
	// 刷新据此判断排在它前面的修改有没有失败，见 refresh()。
	/** @type {Set<{ services: string[]; error: Snapshot["error"] }>} */
	const writes = new Set();
	// 本次打开页面期间动过“每系最新”开关（发过 setLatestPerFamily）的服务，以及其中最后一次写入失败的服务。见 refreshLatest()。
	/** @type {Set<string>} */
	const latestTouched = new Set();
	/** @type {Set<string>} */
	const latestFailed = new Set();
	// 模型页工具栏里“每系最新”复选框的实际勾选状态，按服务名登记，见 watchLatestToggle()。
	/** @type {Map<string, () => boolean>} */
	const latestToggles = new Map();
	// 指针按下期间为 true，只推迟发布，见 trackPointer()。
	let holding = false;

	function publish() {
		if (published === latest) return;
		published = latest;
		for (const listener of listeners) listener();
	}

	/**
	 * 立即更新最新的快照，没按着指针时发布给组件。
	 * @param {Updater} updater
	 */
	function update(updater) {
		latest = { ...latest, ...updater(latest) };
		if (!holding) publish();
	}

	/**
	 * @param {string} path
	 * @param {unknown} [body]
	 * @returns {Promise<{ result: any; seq: number }>}
	 */
	async function request(path, body) {
		const response = await fetchImpl(`/api/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { "x-endpoints-token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const result = await response.json().catch(() => ({ error: `服务器返回 ${response.status}` }));
		if (!response.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
		return { result, seq: Number(response.headers.get("x-endpoints-seq")) || 0 };
	}

	/**
	 * 采用响应里的状态。并发的请求（刷新和修改操作）可能先发后到，按服务端生成状态时的编号丢掉过期的状态。
	 * 没有编号的响应照常采用。响应一到就比较，按住指针期间到达的状态也一样。
	 * @param {any} result
	 * @param {number} seq
	 * @returns {Partial<Snapshot>}
	 */
	function accept(result, seq) {
		if (!result?.services) return {};
		if (seq && seq <= appliedSeq) return {};
		if (seq) appliedSeq = seq;
		const { services, apis, version, loadError, defaultModel, modelsDev } = result;
		return { data: { services, apis, version, loadError, defaultModel, modelsDev } };
	}

	/** @param {string | null} text */
	const errorOf = (text) => (text === null ? null : { text, id: ++ids });
	/** @param {unknown} failure */
	const messageOf = (failure) => (failure instanceof Error ? failure.message : String(failure));

	/**
	 * 排队执行一个修改操作。成功时采用返回的状态、清掉顶部错误并显示 okText；失败时把原因显示在顶部，返回 undefined。
	 * `pending` 给出开关的键和要切换到的值，请求期间开关按这个值显示，结束后按服务端状态显示，失败时也就回到原样。
	 * 每次提交都有自己的编号，同一个开关连续切换时，先结束的请求只清掉自己的记录，不影响后一次的显示。
	 * 操作涉及的服务取自 body 的 name、previousName 和 service.name，记进 writes。
	 * @param {string} path
	 * @param {Record<string, unknown>} body
	 * @param {ActOptions} [options]
	 * @returns {Promise<any>}
	 */
	function act(path, body, options = {}) {
		const pendingEntry = options.pending;
		const pendingId = ++ids;
		if (pendingEntry) {
			update((current) => ({ pending: new Map(current.pending).set(pendingEntry[0], { value: pendingEntry[1], id: pendingId }) }));
		}
		/** @type {Updater} */
		const clearPending = (current) => {
			if (!pendingEntry || current.pending.get(pendingEntry[0])?.id !== pendingId) return {};
			const pending = new Map(current.pending);
			pending.delete(pendingEntry[0]);
			return { pending };
		};
		const entry = {
			services: [body.name, body.previousName, /** @type {any} */ (body.service)?.name].filter((name) => typeof name === "string"),
			error: /** @type {Snapshot["error"]} */ (null),
		};
		writes.add(entry);
		const latestOf = path === "setLatestPerFamily" && typeof body.name === "string" ? body.name : null;
		if (latestOf) latestTouched.add(latestOf);
		const run = async () => {
			try {
				const { result, seq } = await request(path, body);
				update((current) => ({
					...accept(result, seq),
					...clearPending(current),
					error: errorOf(result.refreshError ? `刷新失败：${result.refreshError}` : null),
					okMark: ++ids,
					...(options.okText && !result.refreshError ? { toast: { text: options.okText, id: ++ids } } : {}),
				}));
				if (latestOf) latestFailed.delete(latestOf);
				return result;
			} catch (failure) {
				const error = errorOf(messageOf(failure));
				entry.error = error;
				if (latestOf) latestFailed.add(latestOf);
				update((current) => ({ ...clearPending(current), error }));
				return undefined;
			} finally {
				writes.delete(entry);
			}
		};
		const task = queue.then(run);
		queue = task;
		return task;
	}

	/**
	 * 刷新请求里的 latestPerFamily。为 false 时服务端这次不执行“每系最新”的替换，不传时按磁盘上的配置执行。
	 * 拿不准用户意图时就不替换：漏换没有害处，下次刷新或 pi 联网刷新会补上；误换会改掉用户的 pi 默认模型。
	 * - 自动刷新（`auto`，打开页面和重新启用服务后）：本次打开页面期间没动过这个服务的开关时不传，服务端按刚重新读取的
	 *   磁盘配置执行。页面拿到的状态可能落后于磁盘（例如另一个 pi 刚打开了开关），传 false 会漏掉这次替换。
	 * - 其余情况下，以下各项都为开时才为 true：发布的快照和最新的快照里服务的值和待提交值、工具栏复选框的实际勾选状态
	 *   （模型页没挂载时不算这一项），以及这个服务最后一次开关写入没有失败。按住指针时用键盘切换开关，复选框已经变了，
	 *   待提交值还没发布；写入失败后状态里又是开着的，所以要把这些来源都算上。找不到服务时为 false。
	 * @param {string} name
	 * @param {boolean} auto
	 * @returns {boolean | undefined}
	 */
	function refreshLatest(name, auto) {
		if (auto && !latestTouched.has(name)) return undefined;
		/** @type {boolean[]} */
		const values = [];
		for (const snapshot of [published, latest]) {
			const pending = snapshot.pending.get(pendingKey.latest(name));
			if (pending) values.push(pending.value);
			const found = snapshot.data.services.find((item) => item.name === name);
			if (found) values.push(found.latestPerFamily === true);
		}
		if (!values.length) return false;
		const read = latestToggles.get(name);
		if (read) values.push(read());
		values.push(!latestFailed.has(name));
		return values.every(Boolean);
	}

	/**
	 * 刷新服务目录。刷新会按磁盘上的配置执行“每系最新”，所以先等调用之前已经排队的修改操作都完成，
	 * 免得越过还没提交的修改（例如刚关掉的开关）。其中涉及这个服务的修改只要有一个失败，磁盘上的配置就不是用户要的，
	 * 这次刷新取消，不发请求；其他服务的修改失败不影响。取消时顶部显示那个修改的错误（沿用原来的编号）：
	 * 期间别的修改成功会清掉顶部错误，用户就看不到刷新为什么没发；顶部已经有更新的错误时保留更新的。
	 * 前端的等待和取消挡不住所有交错（例如按住指针期间修改失败，松开后的点击先于发布），所以请求里按 refreshLatest()
	 * 带上 latestPerFamily，由服务端兜底。
	 * 刷新可能要等一分钟，本身不进队列，之后的修改操作不用等它；过期的状态由编号挡住。
	 * 后台刷新（打开页面和重新启用服务时）的失败原因只记在服务状态里，不弹顶部提示；连不上管理页本身（如 pi 已退出）时也不打扰。
	 * @param {string} name
	 * @param {{ background?: boolean }} [options]
	 */
	async function refresh(name, { background = false } = {}) {
		if (latest.refreshing.has(name)) return undefined;
		const ahead = [...writes].filter((entry) => entry.services.includes(name));
		const latestPerFamily = refreshLatest(name, background);
		const body = { name, ...(latestPerFamily === undefined ? {} : { latestPerFamily }) };
		// 刷新成功只清掉发起刷新时页面上显示的那条顶部错误。之后出现的错误（如排在前面的修改失败）用户可能还没看到，留着。
		const seenError = published.error;
		update((current) => ({ refreshing: new Set(current.refreshing).add(name) }));
		/** @type {Updater} */
		const done = (current) => {
			const refreshing = new Set(current.refreshing);
			refreshing.delete(name);
			return { refreshing };
		};
		await queue;
		/** @type {NonNullable<Snapshot["error"]>[]} */
		const failures = ahead.flatMap((entry) => (entry.error ? [entry.error] : []));
		if (failures.length) {
			const lost = failures.reduce((a, b) => (b.id > a.id ? b : a));
			update((current) => ({ ...done(current), ...(current.error && current.error.id >= lost.id ? {} : { error: lost }) }));
			return undefined;
		}
		try {
			const { result, seq } = await request("refresh", body);
			update((current) => ({
				...accept(result, seq),
				...done(current),
				...(background ? {} : {
					error: result.refreshError ? errorOf(`刷新失败：${result.refreshError}`) : current.error === seenError ? null : current.error,
					...(result.refreshError ? {} : { okMark: ++ids, toast: { text: "目录已刷新", id: ++ids } }),
				}),
			}));
			return result;
		} catch (failure) {
			update((current) => ({ ...done(current), ...(background ? {} : { error: errorOf(messageOf(failure)) }) }));
			return undefined;
		}
	}

	return {
		/** 发布给组件重画的快照，渲染时读它。 */
		get: () => published,
		/** 最新的快照，成功回调、导航和表单重填读它。 */
		latest: () => latest,
		/** @param {() => void} listener */
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** 读取初始状态，失败时抛出错误。和其他响应一样按编号采用，返回采用后最新的状态。 */
		async load() {
			const { result, seq } = await request("state");
			update(() => ({ ...accept(result, seq), loaded: true }));
			return latest.data;
		},
		act,
		refresh,
		/**
		 * 登记服务的“每系最新”复选框，刷新时读它的实际勾选状态，见 refreshLatest()。返回取消登记的函数。
		 * @param {string} name
		 * @param {() => boolean} read
		 */
		watchLatestToggle(name, read) {
			latestToggles.set(name, read);
			return () => {
				if (latestToggles.get(name) === read) latestToggles.delete(name);
			};
		},
		/**
		 * 开关正在提交的值，没有在提交时为 undefined。
		 * @param {string} key
		 */
		pendingValue: (key) => published.pending.get(key)?.value,
		/**
		 * 发一条测试消息，不改状态，也不进修改队列。
		 * @param {Record<string, unknown>} body
		 */
		test: async (body) => (await request("testModel", body)).result.test,
		/** 查询 npm 上的新版本，失败时不显示。 */
		async checkUpdate() {
			const result = await request("update").then(({ result }) => result, () => ({}));
			update(() => ({ update: result }));
		},
		/** @param {string | null} text */
		setError: (text) => update(() => ({ error: errorOf(text) })),
		/** @param {string} text */
		toast: (text) => update(() => ({ toast: { text, id: ++ids } })),
		/** 取一个新的时间标记，和错误编号、okMark 比较先后。 */
		mark: () => ++ids,
		/**
		 * 指针按下期间推迟发布，松开后（等这次点击处理完，即下一个任务）发布最新的快照。后台刷新可能增删或挪动列表行，
		 * 按下时换掉了行，松开后的点击就落不到原来的元素上。状态照常立即采用，推迟的只有组件重画。
		 * 按 pointerId 跟踪按下的指针，全部松开才放行。下列情况也放行，免得漏掉松开事件时页面一直不更新：
		 * pointercancel、lostpointercapture、窗口失去焦点、指针移动或进入页面时 buttons 为 0、按住超过 HOLD_LIMIT。
		 * 返回取消监听的函数。
		 * @param {Document} doc
		 */
		trackPointer(doc) {
			/** @type {Set<number>} */
			const active = new Set();
			/** @type {ReturnType<typeof setTimeout> | undefined} */
			let limit;
			const release = () => {
				clearTimeout(limit);
				holding = false;
				publish();
			};
			// 等这次点击处理完再放行；其间又按下了指针时不放行。
			const releaseLater = () => setTimeout(() => {
				if (!active.size) release();
			});
			/** @param {PointerEvent} event */
			const down = (event) => {
				active.add(event.pointerId);
				if (holding) return;
				holding = true;
				// 超时放行时也清掉这一轮的指针记录：漏掉的松开事件不再出现，留着记录的话下次点击松开时不会放行。
				limit = setTimeout(() => {
					active.clear();
					release();
				}, HOLD_LIMIT);
			};
			/** @param {PointerEvent} event */
			const up = (event) => {
				if (!active.delete(event.pointerId)) return;
				if (!active.size) releaseLater();
			};
			/** @param {PointerEvent} event */
			const move = (event) => {
				if (event.buttons === 0) up(event);
			};
			const blur = () => {
				active.clear();
				releaseLater();
			};
			const win = doc.defaultView;
			/** @type {[string, (event: any) => void][]} */
			const handlers = [["pointerdown", down], ["pointerup", up], ["pointercancel", up], ["lostpointercapture", up], ["pointermove", move], ["pointerover", move]];
			for (const [type, handler] of handlers) doc.addEventListener(type, handler, true);
			win?.addEventListener("blur", blur);
			return () => {
				for (const [type, handler] of handlers) doc.removeEventListener(type, handler, true);
				win?.removeEventListener("blur", blur);
				clearTimeout(limit);
				holding = false;
			};
		},
	};
}

/** @typedef {ReturnType<typeof createStore>} Store */
