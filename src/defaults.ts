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
export async function writeDefaultModel(provider: string, id: string): Promise<void> {
	const settings = open();
	// pi 在设置了 Ctrl+P 轮换列表时会把新的默认模型加进去。这里只比对完整的模型名，不展开通配符。
	// 先算好再写，列表格式不对时直接报错，不会只写了一半。
	const enabledModels = settings.getEnabledModels();
	const reference = `${provider}/${id}`;
	const addToScope =
		Array.isArray(enabledModels) &&
		enabledModels.length > 0 &&
		!enabledModels.some((pattern) => typeof pattern === "string" && pattern.toLowerCase() === reference.toLowerCase());
	settings.setDefaultModelAndProvider(provider, id);
	if (addToScope) settings.setEnabledModels([...enabledModels, reference]);
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length) throw new Error(`无法写入 pi 的设置：${errors.map((error) => error.error.message).join("；")}`);
}
