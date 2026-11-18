// @ts-check
// 页面和服务端之间的状态：最新的服务端状态、顶部错误、正在刷新的服务、提交中的开关和提示条。
// 组件只读这里的快照，修改都经过这里的方法。

/** @typedef {import("./util.js").State} State */
/**
 * @typedef {{
 *   data: State;
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
	let snapshot = { data: { services: [], apis: [] }, error: null, okMark: 0, refreshing: new Set(), pending: new Map(), toast: null, update: null };
	/** @type {Set<() => void>} */
	const listeners = new Set();
	// 已采用的状态的编号（服务端的 X-Endpoints-Seq）。编号不大于它的状态是过期的，不采用。
	let appliedSeq = 0;
	// 错误、提示条、待提交的开关和各种时间标记共用的递增编号，可以用来比较先后。
	let ids = 0;
	// 修改操作排队执行，前一个结束后才发下一个，页面上的操作按点击顺序生效。
	/** @type {Promise<unknown>} */
	let queue = Promise.resolve();
	// 指针按下期间暂存的更新，松开后再采用，见 trackPointer()。
	/** @type {Updater[] | null} */
	let held = null;
	// 正在刷新的服务。快照里的 refreshing 可能还在暂存，去重以这里为准。
	/** @type {Set<string>} */
	const inFlight = new Set();

	/** @param {Updater} updater */
	function apply(updater) {
		snapshot = { ...snapshot, ...updater(snapshot) };
	}

	/**
	 * 更新快照并通知组件。更新写成函数，按当时的快照计算，暂存后再采用时也不会盖掉中间的变化。
	 * @param {Updater} updater
	 */
	function update(updater) {
		if (held) {
			held.push(updater);
			return;
		}
		apply(updater);
		for (const listener of listeners) listener();
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
	 * 没有编号的响应照常采用。编号在采用时比较，暂存期间到达的状态也按编号取舍。
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
				return result;
			} catch (failure) {
				update((current) => ({ ...clearPending(current), error: errorOf(messageOf(failure)) }));
				return undefined;
			}
		};
		const task = queue.then(run);
		queue = task;
		return task;
	}

	/**
	 * 刷新服务目录。刷新会按磁盘上的配置执行“每系最新”，所以先等调用之前已经排队的修改操作都完成，
	 * 免得越过还没提交的修改（例如刚关掉的开关）。刷新可能要等一分钟，本身不进队列，之后的修改操作不用等它；
	 * 过期的状态由编号挡住。
	 * 后台刷新（打开页面和重新启用服务时）的失败原因只记在服务状态里，不弹顶部提示；连不上管理页本身（如 pi 已退出）时也不打扰。
	 * @param {string} name
	 * @param {{ background?: boolean }} [options]
	 */
	async function refresh(name, { background = false } = {}) {
		if (inFlight.has(name)) return undefined;
		inFlight.add(name);
		update((current) => ({ refreshing: new Set(current.refreshing).add(name) }));
		/** @type {Updater} */
		const done = (current) => {
			const refreshing = new Set(current.refreshing);
			refreshing.delete(name);
			return { refreshing };
		};
		await queue;
		try {
			const { result, seq } = await request("refresh", { name });
			update((current) => ({
				...accept(result, seq),
				...done(current),
				...(background ? {} : {
					error: errorOf(result.refreshError ? `刷新失败：${result.refreshError}` : null),
					...(result.refreshError ? {} : { okMark: ++ids, toast: { text: "目录已刷新", id: ++ids } }),
				}),
			}));
			return result;
		} catch (failure) {
			update((current) => ({ ...done(current), ...(background ? {} : { error: errorOf(messageOf(failure)) }) }));
			return undefined;
		} finally {
			inFlight.delete(name);
		}
	}

	return {
		get: () => snapshot,
		/** @param {() => void} listener */
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** 读取初始状态，失败时抛出错误。 */
		async load() {
			const { result, seq } = await request("state");
			const patch = accept(result, seq);
			update(() => patch);
			return patch.data ?? snapshot.data;
		},
		act,
		refresh,
		/**
		 * 开关正在提交的值，没有在提交时为 undefined。
		 * @param {string} key
		 */
		pendingValue: (key) => snapshot.pending.get(key)?.value,
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
		 * 指针按下期间暂存所有更新，松开后再采用。后台刷新可能增删或挪动列表行，按下时换掉了行，松开后的点击就落不到原来的元素上。
		 * 松开后等这次点击处理完（下一个任务）再采用。暂存的更新按顺序采用，状态仍按编号取舍。返回取消监听的函数。
		 * @param {Document} doc
		 */
		trackPointer(doc) {
			const down = () => {
				held ??= [];
			};
			const up = () => {
				setTimeout(() => {
					const updaters = held;
					held = null;
					if (!updaters?.length) return;
					for (const updater of updaters) apply(updater);
					for (const listener of listeners) listener();
				});
			};
			doc.addEventListener("pointerdown", down, true);
			doc.addEventListener("pointerup", up, true);
			doc.addEventListener("pointercancel", up, true);
			// 在窗口外松开时可能收不到 pointerup，窗口失去焦点时同样放行。
			doc.defaultView?.addEventListener("blur", up);
			return () => {
				doc.defaultView?.removeEventListener("blur", up);
				doc.removeEventListener("pointerdown", down, true);
				doc.removeEventListener("pointerup", up, true);
				doc.removeEventListener("pointercancel", up, true);
			};
		},
	};
}

/** @typedef {ReturnType<typeof createStore>} Store */
