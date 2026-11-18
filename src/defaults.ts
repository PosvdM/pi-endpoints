import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface DefaultModel {
	provider: string;
	id: string;
}

/**
 * 用 pi 自己的 SettingsManager 读写全局的 settings.json，它会加锁，并且只合并改动的字段。
 * 不读项目设置：写入只写全局，读也只读全局，页面显示的才是刚写入的值。
 */
function open(): SettingsManager {
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	// 读不了 settings.json 时 SettingsManager 不写文件，只记录错误，这里先拦下来。
	const failure = settings.drainErrors()[0];
	if (failure) throw new Error(`无法读取 ${failure.path ?? "pi 的 settings.json"}：${failure.error.message}`);
	return settings;
}

/**
 * 本插件对 pi 全局设置的读、改、写排成一条队列，一次只做一个。SettingsManager 打开时读一次文件、保存时写回改过的字段，
 * 两次修改同时进行时，后保存的会用自己读到的旧列表覆盖前一次对 enabledModels 的修改。
 */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => {});
	return run;
}

/** pi 新开会话时用的默认模型，和 /model 里标为 default 的是同一个。 */
export function readDefaultModel(): DefaultModel | undefined {
	let settings: SettingsManager;
	try {
		settings = open();
	} catch {
		return undefined;
	}
	const provider = settings.getDefaultProvider();
	const id = settings.getDefaultModel();
	return provider && id ? { provider, id } : undefined;
}

/** 效果和在 pi 的 /model 里按 Ctrl+S 相同。 */
export function writeDefaultModel(provider: string, id: string): Promise<void> {
	return serialized(() => writeDefaultModelNow(provider, id));
}

async function writeDefaultModelNow(provider: string, id: string): Promise<void> {
	const settings = open();
	// pi 在设置了 Ctrl+P 轮换列表时会把新的默认模型加进去。这里只比对完整的模型名，不展开通配符。
	// 列表不是数组时不动它，照样写入默认模型；数组里不是字符串的项不参与比对。
	const enabledModels = settings.getEnabledModels();
	const reference = `${provider}/${id}`;
	const addToScope =
		Array.isArray(enabledModels) &&
		enabledModels.length > 0 &&
		!enabledModels.some((pattern) => typeof pattern === "string" && pattern.toLowerCase() === reference.toLowerCase());
	settings.setDefaultModelAndProvider(provider, id);
	if (addToScope) settings.setEnabledModels([...enabledModels, reference]);
	await save(settings);
}

/**
 * 删掉 settings.json 里的默认模型，pi 新开会话时改用 Ctrl+P 列表的第一个或 pi 自带的默认模型。
 * 只在当前的默认模型仍是 `expected` 时清除，否则不写文件并返回假：页面显示的可能是已经被“每系最新”或别的 pi 换掉的旧默认。
 * 核对和清除在同一个队列任务里完成。
 */
export function clearDefaultModel(expected: DefaultModel): Promise<boolean> {
	return serialized(() => clearDefaultModelNow(expected));
}

async function clearDefaultModelNow(expected: DefaultModel): Promise<boolean> {
	const settings = open();
	if (settings.getDefaultProvider() !== expected.provider || settings.getDefaultModel() !== expected.id) return false;
	// 类型只允许字符串；写入时值为 undefined 的字段会从 JSON 里去掉。
	settings.setDefaultModelAndProvider(undefined as unknown as string, undefined as unknown as string);
	await save(settings);
	return true;
}

/**
 * 把 pi 设置里同一服务商的旧模型换成新模型，`replacements` 是旧 id 到新 id 的对应。
 * 默认模型是旧模型时改成新模型；Ctrl+P 轮换列表里精确等于 `<服务商>/<旧 id>` 的项换成新模型，
 * 新模型已经在列表里时只删掉旧的。列表不是数组时不动它。没有变化时不写文件。
 */
export function replaceModels(provider: string, replacements: ReadonlyMap<string, string>): Promise<void> {
	return serialized(() => replaceModelsNow(provider, replacements));
}

async function replaceModelsNow(provider: string, replacements: ReadonlyMap<string, string>): Promise<void> {
	if (replacements.size === 0) return;
	const settings = open();
	let changed = false;
	const defaultId = settings.getDefaultModel();
	const newDefault = settings.getDefaultProvider() === provider && defaultId !== undefined ? replacements.get(defaultId) : undefined;
	if (newDefault !== undefined) {
		settings.setDefaultModelAndProvider(provider, newDefault);
		changed = true;
	}
	const enabledModels = settings.getEnabledModels();
	if (Array.isArray(enabledModels)) {
		const references = new Map([...replacements].map(([from, to]) => [`${provider}/${from}`, `${provider}/${to}`]));
		const next: string[] = [];
		let replaced = false;
		for (const pattern of enabledModels) {
			const to = typeof pattern === "string" ? references.get(pattern) : undefined;
			if (to === undefined) {
				next.push(pattern);
				continue;
			}
			replaced = true;
			if (!next.includes(to) && !enabledModels.includes(to)) next.push(to);
		}
		if (replaced) {
			settings.setEnabledModels(next);
			changed = true;
		}
	}
	if (changed) await save(settings);
}

async function save(settings: SettingsManager): Promise<void> {
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length) throw new Error(`无法写入 pi 的设置：${errors.map((error) => error.error.message).join("；")}`);
}
