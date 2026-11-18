// @ts-check
// 页面和服务端之间的状态：最新的服务端状态、顶部错误、正在刷新的服务、提交中的开关和提示条。
// 组件只读这里的快照，修改都经过这里的方法。

/** @typedef {import("./util.js").State} State */
/**
 * @typedef {{
 *   data: State;
 *   error: { text: string; id: number } | null;
 *   refreshing: Set<string>;
 *   pending: Map<string, boolean>;
 *   toast: { text: string; id: number } | null;
 *   update: { latestVersion?: string; releaseUrl?: string } | null;
 * }} Snapshot
 */
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
	let snapshot = { data: { services: [], apis: [] }, error: null, refreshing: new Set(), pending: new Map(), toast: null, update: null };
	/** @type {Set<() => void>} */
	const listeners = new Set();
	// 已采用的状态的编号（服务端的 X-Endpoints-Seq）。编号不大于它的状态是过期的，不采用。
	let appliedSeq = 0;
	let ids = 0;
	// 修改操作排队执行，前一个结束后才发下一个，页面上的操作按点击顺序生效。
	/** @type {Promise<unknown>} */
	let queue = Promise.resolve();

	/** @param {Partial<Snapshot>} patch */
	function set(patch) {
		snapshot = { ...snapshot, ...patch };
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
	 * 采用响应里的状态。并发的请求（后台刷新和修改操作）可能先发后到，按服务端生成状态时的编号丢掉过期的状态。
	 * 没有编号的响应照常采用。
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

	/** @param {string} text */
	function toast(text) {
		set({ toast: { text, id: ++ids } });
	}

	/**
	 * 排队执行一个修改操作。成功时采用返回的状态、清掉顶部错误并显示 okText；失败时把原因显示在顶部，返回 undefined。
	 * `pending` 给出开关的键和要切换到的值，请求期间开关按这个值显示，结束后按服务端状态显示，失败时也就回到原样。
	 * @param {string} path
	 * @param {Record<string, unknown>} body
	 * @param {ActOptions} [options]
	 * @returns {Promise<any>}
	 */
	function act(path, body, options = {}) {
		const pendingEntry = options.pending;
		if (pendingEntry) set({ pending: new Map(snapshot.pending).set(pendingEntry[0], pendingEntry[1]) });
		const run = async () => {
			/** @type {Partial<Snapshot>} */
			let patch = {};
			try {
				const { result, seq } = await request(path, body);
				patch = { ...accept(result, seq), error: errorOf(result.refreshError ? `刷新失败：${result.refreshError}` : null) };
				if (options.okText && !result.refreshError) patch.toast = { text: options.okText, id: ++ids };
				return result;
			} catch (failure) {
				patch = { error: errorOf(failure instanceof Error ? failure.message : String(failure)) };
				return undefined;
			} finally {
				if (pendingEntry) {
					const pending = new Map(snapshot.pending);
					pending.delete(pendingEntry[0]);
					patch.pending = pending;
				}
				set(patch);
			}
		};
		const task = queue.then(run);
		queue = task;
		return task;
	}

	/**
	 * 刷新服务目录。刷新可能要等一分钟，不进修改队列；过期的状态由编号挡住。
	 * 后台刷新（打开页面和重新启用服务时）的失败原因只记在服务状态里，不弹顶部提示；连不上管理页本身（如 pi 已退出）时也不打扰。
	 * @param {string} name
	 * @param {{ background?: boolean }} [options]
	 */
	async function refresh(name, { background = false } = {}) {
		if (snapshot.refreshing.has(name)) return undefined;
		set({ refreshing: new Set(snapshot.refreshing).add(name) });
		/** @type {Partial<Snapshot>} */
		let patch = {};
		try {
			const { result, seq } = await request("refresh", { name });
			patch = accept(result, seq);
			if (!background) {
				patch.error = errorOf(result.refreshError ? `刷新失败：${result.refreshError}` : null);
				if (!result.refreshError) patch.toast = { text: "目录已刷新", id: ++ids };
			}
			return result;
		} catch (failure) {
			if (!background) patch.error = errorOf(failure instanceof Error ? failure.message : String(failure));
			return undefined;
		} finally {
			const refreshing = new Set(snapshot.refreshing);
			refreshing.delete(name);
			set({ ...patch, refreshing });
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
			set(accept(result, seq));
			return snapshot.data;
		},
		act,
		refresh,
		/**
		 * 发一条测试消息，不改状态，也不进修改队列。
		 * @param {Record<string, unknown>} body
		 */
		test: async (body) => (await request("testModel", body)).result.test,
		/** 查询 npm 上的新版本，失败时不显示。 */
		async checkUpdate() {
			const update = await request("update").then(({ result }) => result, () => ({}));
			set({ update });
		},
		/** @param {string | null} text */
		setError: (text) => set({ error: errorOf(text) }),
		toast,
		/** 错误编号的当前值，用来判断错误是不是某个时刻之后出现的。 */
		errorMark: () => ids,
	};
}

/** @typedef {ReturnType<typeof createStore>} Store */
