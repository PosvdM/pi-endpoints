import type { Model } from "@earendil-works/pi-ai";
import { streamSimpleAnthropic } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withBetas } from "./betas.ts";
import { builtinProviderIds } from "./builtin.ts";
import { type Catalog, CatalogError, fetchCatalog } from "./catalog.ts";
import {
	dict,
	type EndpointsConfig,
	escapeConfigValue,
	type KeySource,
	loadAuth,
	loadCache,
	loadConfig,
	loadState,
	type ModelOverride,
	type NotifiedUpdate,
	normalizeService,
	piApiKey,
	resolveKey,
	saveAuth,
	saveCache,
	saveConfig,
	saveState,
	type ServiceConfig,
	type StateFile,
} from "./config.ts";
import { replaceModels } from "./defaults.ts";
import { type LatestResult, mayReplace, pickLatest, type Replacement } from "./family.ts";
import { hasModelsDevData, loadModelsDev, updateModelsDev } from "./modelsdev.ts";
import {
	isChatModel,
	PI_LEVELS,
	type ResolvedModel,
	resolveModel,
	resolveService,
	serverHidden,
	type Source,
	SUPPORTED_APIS,
	toProviderModel,
} from "./resolve.ts";

export interface ServiceStatus {
	name: string;
	keySource?: KeySource;
	disabled: boolean;
	registered: boolean;
	catalogAt?: number;
	catalogSize?: number;
	enabled: number;
	/** 已启用但目录里没有的模型。 */
	missing: string[];
	error?: string;
	/** 配置已保存，但向运行中的 pi 注册或注销时出错的原因。 */
	syncError?: string;
}

interface ModelsDevTask {
	promise: Promise<boolean>;
	/** 拿到新数据后由任务自己全量注册一次。 */
	register: boolean;
	/** 已经有人为这次更新做过全量注册。 */
	claimed: boolean;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_PATTERN = /^https?:\/\/./;
const REFRESH_TIMEOUT_MS = 15_000;
/** 同一个新版的提醒最多隔这么久再提示一次：某次提示被客户端静默丢掉时，不至于再也不提示。 */
const RENOTIFY_MS = 7 * 24 * 60 * 60 * 1000;

type AuthFile = ReturnType<typeof loadAuth>;
type CacheFile = ReturnType<typeof loadCache>;

/**
 * 插件的全部状态：配置、密钥、目录缓存，以及向 pi 注册服务商。
 * 可能同时运行多个 pi，所以每次修改前都重新读文件，在最新内容上改动。
 */
export class Endpoints {
	config: EndpointsConfig = { services: [] };
	/** 配置或密钥文件读不了时的原因。这时拒绝修改，免得覆盖用户待修的文件。 */
	loadError?: string;
	private auth: AuthFile = dict({});
	private cache: CacheFile = dict({});
	private errors = new Map<string, string>();
	private syncErrors = new Map<string, string>();
	private registered = new Set<string>();
	/** 每个已注册服务里各模型的附加 Anthropic beta，注册和刷新目录时更新。 */
	private betas = new Map<string, Map<string, string[]>>();
	/** 正在进行的 models.dev 更新，并发的调用共用它，拿到新数据后只全量注册一次。 */
	private modelsDevTask?: ModelsDevTask;
	/**
	 * 在 pi 的界面上提示一句：“每系最新”换掉了模型，或者开关关着的服务出了新版。由插件入口设置，
	 * 返回提示是否真的显示了：子代理、`-p` 这类没有界面的运行会把提示丢掉。
	 */
	notify?: (message: string, level: "info" | "warning") => boolean;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		// 启动时只读本地文件，不访问网络。
		loadModelsDev();
		try {
			this.reload();
		} catch (error) {
			this.loadError = describeError(error);
		}
	}

	private reload(): void {
		this.commit(readFiles());
	}

	private commit(files: Files): void {
		this.config = files.config;
		this.auth = files.auth;
		this.cache = files.cache;
		this.loadError = undefined;
	}

	/** 修改前调用：读最新的文件；文件损坏时拒绝修改。 */
	private beginChange(): void {
		this.commit(this.readSnapshot());
	}

	/** 读最新的文件快照，不换进内存。文件损坏时记下原因并拒绝，内存里的配置、密钥和缓存不变。 */
	private readSnapshot(): Files {
		try {
			return readFiles();
		} catch (error) {
			this.loadError = describeError(error);
			throw new Error(`${this.loadError}。修好文件后运行 /reload`);
		}
	}

	service(name: string): ServiceConfig | undefined {
		return this.config.services.find((service) => service.name === name);
	}

	catalog(name: string): Catalog | undefined {
		return this.cache[name];
	}

	models(name: string): ResolvedModel[] {
		const service = this.service(name);
		return service ? resolveService(service, this.cache[name]) : [];
	}

	keySource(name: string): KeySource | undefined {
		const service = this.service(name);
		return service ? resolveKey(service, this.auth)?.source : undefined;
	}

	apiKey(name: string): string | undefined {
		const service = this.service(name);
		return service ? resolveKey(service, this.auth)?.key : undefined;
	}

	/** 按当前配置和缓存注册所有服务，注销已经不存在的。不访问网络。 */
	registerAll(): void {
		for (const service of this.config.services) this.register(service.name);
		for (const name of [...this.registered]) {
			if (!this.service(name)) this.unregister(name);
		}
	}

	/** 注销成功后才从记录里去掉；出错时保留记录，下次 `registerAll()` 会再试。 */
	private unregister(name: string): void {
		if (this.registered.has(name) && !this.sync(name, () => this.pi.unregisterProvider(name))) return;
		this.registered.delete(name);
		this.betas.delete(name);
	}

	/** 向 pi 注册或注销。出错时记下原因，不抛出：配置已经保存，调用方照常返回，后台任务也不会产生未处理的拒绝。 */
	private sync(name: string, action: () => void): boolean {
		try {
			action();
			this.syncErrors.delete(name);
			return true;
		} catch (error) {
			this.syncErrors.set(name, describeError(error));
			return false;
		}
	}

	register(name: string): void {
		const service = this.service(name);
		const problem = service ? serviceProblem(service) : undefined;
		if (problem) this.errors.set(name, problem);
		const resolved = service && !problem && !service.disabled ? resolveKey(service, this.auth) : undefined;
		const models = service && resolved ? this.enabledModels(service) : [];
		// 没有密钥时 pi 也能注册，但会让用户去 /login 输入密钥，和本插件的密钥管理冲突，所以不注册。
		if (!service || !resolved || models.length === 0) {
			this.unregister(name);
			return;
		}
		const betas = new Map(models.map((model) => [model.id, model.betas]));
		const registered = this.sync(name, () => this.pi.registerProvider(name, {
			name: service.displayName || name,
			baseUrl: service.baseUrl,
			apiKey: piApiKey(service, resolved),
			// 所有模型都写明了协议，这里的 api 只用来让 streamSimple 接管 Anthropic 协议的请求。
			api: "anthropic-messages",
			// 会话、压缩和摘要请求都经过这里，插件事件 before_provider_request 覆盖不到后两者。
			streamSimple: (model, context, options) =>
				streamSimpleAnthropic(model as Model<"anthropic-messages">, context, withBetas(options, this.betas.get(name)?.get(model.id) ?? [])),
			models: models.map(toPiModel),
			// 交互模式和 RPC 模式启动后、打开 /model 时，pi 会调用它刷新目录。
			// 重新注册时 pi 会以 allowNetwork: false 再调用一次，这时不刷新，也就不会再触发 models.dev 更新和“每系最新”。
			refreshModels: async (context) => {
				if (context.allowNetwork) {
					try {
						await this.refresh(name, context.signal);
					} finally {
						// 在后台更新 models.dev，不拖慢启动。拿到新数据后会重新注册所有服务。
						void this.updateModelsDev();
					}
					await this.migrateOnDisk(name);
					this.noticeUpdates(name);
				}
				const current = this.service(name);
				return current ? this.piModels(name, this.enabledModels(current)) : [];
			},
		}));
		// 注册成功后才更新记录和 beta；失败时 pi 里还是上一次的注册。
		if (!registered) return;
		this.registered.add(name);
		this.betas.set(name, betas);
	}

	private piModels(name: string, models: ResolvedModel[]) {
		this.betas.set(name, new Map(models.map((model) => [model.id, model.betas])));
		return models.map(toPiModel);
	}

	/** 已启用的对话模型。models.dev 标为其他类型的模型即使已启用也不注册。 */
	private enabledModels(service: ServiceConfig): ResolvedModel[] {
		return this.models(service.name).filter((model) => service.enabled.includes(model.id) && isChatModel(model));
	}

	/**
	 * 在没停用、有密钥的服务里，有模型的上下文、最大输出、输入、思考或价格取自 models.dev 或默认值时，
	 * 才需要 models.dev 的数据。以下服务也需要，要靠它判断模型类型：
	 * - 开启了“每系最新”的服务，自动迁移要用。
	 * - 开关关着、但目录里可能有已启用模型的新版的服务（`mayHaveUpdates()`），新版提醒要用。
	 */
	needsModelsDev(): boolean {
		return this.config.services.some(
			(service) =>
				!service.disabled &&
				resolveKey(service, this.auth) &&
				(service.latestPerFamily || this.mayHaveUpdates(service) || this.models(service.name).some(usesFallback)),
		);
	}

	/**
	 * 开关关着的服务在拿到 models.dev 后有没有可能算出替换，前提同 `planLatest()`。保守判断（`mayReplace()`）：
	 * 候选只去掉不依赖 models.dev 的隐藏模型（`serverHidden()`），不用 models.dev 已有的分类，分类变了也能重新下载。
	 * 可能有替换时才需要 models.dev 来排除非对话模型，目录里没有候选新版的服务不触发下载。
	 */
	private mayHaveUpdates(service: ServiceConfig): boolean {
		if (service.latestPerFamily || service.disabled || service.enabled.length === 0) return false;
		const catalog = latestCatalog(service, this.cache[service.name]);
		if (!catalog) return false;
		const candidates = catalog.models.filter((model) => !serverHidden(model)).map((model) => model.id);
		return mayReplace(service.enabled, candidates, catalog.models.map((model) => model.id));
	}

	/**
	 * 需要时更新 models.dev，拿到新数据后重新注册所有服务。不会失败，原因记在 `modelsDevStatus().error`。
	 * 是否到期（24 小时、失败后 30 分钟）由 `updateModelsDev()` 判断。
	 */
	updateModelsDev(): Promise<void> {
		return this.startModelsDev(true)?.promise.then(() => {}) ?? Promise.resolve();
	}

	/**
	 * 需要时开始更新 models.dev，并发的调用共用同一个任务。有调用方传 `register` 为真（后台的 `updateModelsDev()`）时，
	 * 拿到新数据后由任务自己全量注册。任务的回调先于等待它的调用方执行，所以这时显式入口随后还会再全量注册一次；
	 * 只有管理页调用方（`register` 为假）时任务不注册，由它们自己注册。`always` 为真时不检查是否需要。
	 */
	private startModelsDev(register: boolean, always = false): ModelsDevTask | undefined {
		if (this.modelsDevTask) {
			this.modelsDevTask.register ||= register;
			return this.modelsDevTask;
		}
		if (!always && !this.needsModelsDev()) return undefined;
		const task: ModelsDevTask = { register, claimed: false, promise: Promise.resolve(false) };
		task.promise = updateModelsDev()
			.catch(() => false)
			.then((changed) => {
				this.modelsDevTask = undefined;
				if (changed && task.register && !task.claimed) {
					task.claimed = true;
					this.registerAll();
				}
				return changed;
			});
		this.modelsDevTask = task;
		return task;
	}

	/**
	 * 等 models.dev 更新完，返回一个认领函数：数据变了、并且还没有人为这次更新做过全量注册时返回真，只返回一次真。
	 * 显式入口在真正全量注册时调用它，只做标记。任务已经因为后台调用方注册过时返回假，显式入口照样注册；
	 * 纯管理页并行刷新时任务不注册，没有这次额外注册。
	 */
	private async waitModelsDev(always = false): Promise<() => boolean> {
		const task = this.startModelsDev(false, always);
		const changed = task ? await task.promise : false;
		return () => {
			if (!task || !changed || task.claimed) return false;
			task.claimed = true;
			return true;
		};
	}

	/** 刷新一个服务的目录并写缓存，失败时保留旧缓存。不负责重新注册。 */
	async refresh(name: string, signal?: AbortSignal): Promise<Catalog> {
		const service = this.service(name);
		if (!service) throw new Error(`没有名为 ${name} 的服务`);
		const key = resolveKey(service, this.auth);
		if (!key) throw new Error(`服务 ${name} 还没有设置密钥`);
		const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
		let catalog: Catalog;
		try {
			catalog = await fetchCatalog(service.baseUrl, key.key, {
				headers: service.headers,
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (error) {
			const timedOut = timeout.aborted && !signal?.aborted;
			const message = timedOut ? `${service.baseUrl} 在 ${REFRESH_TIMEOUT_MS / 1000} 秒内没有响应` : describeError(error);
			if (!signal?.aborted && this.isCurrent(service)) this.errors.set(name, message);
			throw timedOut ? new Error(message) : error;
		}
		// 请求期间服务可能被删除、改名或换了地址，这时结果已经过期，不写缓存。
		if (!this.isCurrent(service)) return catalog;
		this.cache = loadCache();
		this.cache[name] = catalog;
		saveCache(this.cache);
		this.errors.delete(name);
		return catalog;
	}

	/**
	 * 管理页的刷新：先像修改操作一样重新读取配置、密钥和缓存（配置或密钥文件读不了时抛错，内存不变），再刷新目录，
	 * 等 models.dev 更新完（最多 60 秒），目录刷新成功时执行“每系最新”，立即生效。用户点刷新或打开页面是显式操作，
	 * 可以在这里重新加载：pi 联网刷新时只写进磁盘的迁移，这时在本进程生效并显示在页面上。
	 * 载入了快照就在最后全量注册一次（不管目录成功与否、有没有迁移），和其他修改操作一样：
	 * 别的服务的配置也可能换了，它们的 `refreshModels` 会按内存里的新配置发布，注册必须跟内存一致。
	 * 进入注册时认领共享的 models.dev 下载。下载任务有后台调用方时它会先注册一次，这里还会再注册；纯管理页刷新时任务不注册。
	 * 返回目录刷新失败的原因；models.dev 失败不算刷新失败。
	 */
	async refreshForPage(name: string): Promise<string | undefined> {
		this.beginChange();
		let refreshError: string | undefined;
		let replacements: Replacement[] = [];
		let claim: (() => boolean) | undefined;
		try {
			try {
				await this.refresh(name);
			} catch (error) {
				refreshError = describeError(error);
			}
			claim = await this.waitModelsDev();
			if (refreshError === undefined) replacements = this.migrateAndCommit(name);
		} finally {
			claim?.();
			this.registerAll();
		}
		if (replacements.length) await this.afterMigration(name, replacements, "live");
		return refreshError;
	}

	/**
	 * 按“每系最新”算出服务的新启用列表，没有变化或要推迟时返回 undefined。规则见 `pickLatest()`。
	 * 开关关着时不计算，`force` 为真时不看开关（新版提醒和“只换一次”）。
	 * - 目录缓存的来源地址未知（旧版本写的缓存）或和服务地址不同时跳过，目录可能属于旧地址。
	 * - 本进程里还没有 models.dev 数据时推迟：要靠它判断候选是不是对话模型。开启了开关的服务、可能有新版的服务
	 *   算作需要 models.dev，所以会按原有的退避去下载。有数据、只是查不到的模型按对话模型处理，和注册一致。
	 */
	private planLatest(service: ServiceConfig, catalog: Catalog | undefined, force = false): LatestResult | undefined {
		if (!service.latestPerFamily && !force) return undefined;
		const usable = latestCatalog(service, catalog);
		if (!usable || !hasModelsDevData()) return undefined;
		const models = usable.models.map((model) => resolveModel(service, model, usable));
		const candidates = models.filter((model) => !model.hidden && isChatModel(model)).map((model) => model.id);
		const result = pickLatest(service.enabled, candidates, usable.models.map((model) => model.id));
		return result.replacements.length ? result : undefined;
	}

	/**
	 * 在重新读取的文件快照上执行“每系最新”。有变化时返回改过启用列表的快照，没有变化或要推迟时返回 undefined。
	 * 文件读不了时只记下原因，内存状态不变。
	 */
	private planFromFiles(name: string): { files: Files; plan: LatestResult } | undefined {
		let files: Files;
		try {
			files = readFiles();
		} catch (error) {
			this.loadError = describeError(error);
			return undefined;
		}
		const service = files.config.services.find((item) => item.name === name);
		const plan = service ? this.planLatest(service, files.cache[name]) : undefined;
		if (!service || !plan) return undefined;
		service.enabled = plan.enabled;
		return { files, plan };
	}

	/**
	 * pi 联网刷新后的“每系最新”：只改磁盘。保存配置、替换 pi 设置里的旧模型，再提示用户；
	 * 不改本进程的内存状态和返回给 pi 的模型列表，也不重新注册。pi 重新注册服务商时会取消它进行中的刷新，
	 * 并让所有服务商做一次离线刷新，同一批里还没返回的服务就跳过了这轮联网刷新。新配置在新会话、`/reload`
	 * 或本进程下一次经过 `beginChange()` 的修改时生效。写文件失败时放弃，不影响刷新。
	 */
	private async migrateOnDisk(name: string): Promise<void> {
		const planned = this.planFromFiles(name);
		if (!planned) return;
		try {
			saveConfig(planned.files.config);
		} catch {
			return;
		}
		await this.afterMigration(name, planned.plan.replacements, "disk");
	}

	/** 显式入口（管理页刷新）的“每系最新”：先保存配置，成功后再把快照换进内存。不重新注册，由调用方负责。 */
	private migrateAndCommit(name: string): Replacement[] {
		const planned = this.planFromFiles(name);
		if (!planned) return [];
		saveConfig(planned.files.config);
		this.commit(planned.files);
		return planned.plan.replacements;
	}

	/**
	 * 换掉模型之后：替换 pi 设置里的旧模型，并在 pi 的界面上提示。settings.json 读写不了时跳过，启用列表已经保存。
	 * `disk` 表示只改了文件，运行中的 pi 要 /reload；`live` 表示已经注册到当前 pi。
	 */
	private async afterMigration(name: string, replacements: Replacement[], mode: "disk" | "live"): Promise<void> {
		// 旧版已经换掉，它的提醒记录不再需要。
		forgetNotified(name, replacements.map(({ from }) => from));
		try {
			await replaceModels(name, new Map(replacements.map(({ from, to }) => [from, to])));
		} catch {
			// 只跳过这一步。
		}
		const changes = describeReplacements(replacements);
		const message = mode === "disk" ? `${name}：${changes} 已写入配置，新会话生效，当前 pi 用 /reload` : `${name}：${changes}。当前会话请用 /model 切换`;
		// 用 warning：pi 的 info 提示会被紧接着的下一条 info 覆盖。
		this.tryNotify(message, "warning");
	}

	/** 提示失败不影响结果，按没有显示处理。 */
	private tryNotify(message: string, level: "info" | "warning"): boolean {
		try {
			return this.notify?.(message, level) === true;
		} catch {
			return false;
		}
	}

	/**
	 * 开关关着时，如果现在打开开关会发生的替换，用内存里的配置和缓存计算，只用于提示。
	 * 开关开着、服务停用或有问题、models.dev 没有数据、目录缓存不属于当前地址时为空。
	 */
	updates(name: string): Replacement[] {
		const service = this.service(name);
		return service ? this.pendingUpdates(service, this.cache[name]) : [];
	}

	private pendingUpdates(service: ServiceConfig, catalog: Catalog | undefined): Replacement[] {
		if (service.latestPerFamily || service.disabled) return [];
		return this.planLatest(service, catalog, true)?.replacements ?? [];
	}

	/**
	 * pi 联网刷新目录成功后，开关关着的服务有新版时在 pi 里提示。同一个“服务 + 旧 id → 新 id”最多每
	 * `RENOTIFY_MS`（7 天）提示一次，直到用户换掉或停用旧版、打开开关。提示确实显示了才记进 `endpoints-state.json`，
	 * 没有能显示的界面时留到下次；即使某次提示被客户端静默丢掉，7 天后也会再提示。
	 * 记录只在两种情况下去掉：用户处理了旧版（见 `forgetNotified()` 的调用处），或者过了 7 天（这里顺带清理所有服务的）。
	 * 暂时不在待处理列表里的记录不删：目录某次刷新漏掉了新版，下次又出现时不该再提示。
	 * 在重新读取的文件快照上计算，不改内存状态、不重新注册，也不等待任何东西。
	 */
	private noticeUpdates(name: string): void {
		const now = Date.now();
		const shown = this.showUpdates(name, now);
		editState((state) => {
			let changed = false;
			for (const [service, list] of Object.entries(state.notifiedUpdates)) {
				const kept = list.filter((item) => isRecent(item, now));
				if (kept.length === list.length) continue;
				changed = true;
				if (kept.length) state.notifiedUpdates[service] = kept;
				else delete state.notifiedUpdates[service];
			}
			if (shown.length) {
				const keys = new Set(shown.map(replacementKey));
				const others = (state.notifiedUpdates[name] ?? []).filter((item) => !keys.has(replacementKey(item)));
				state.notifiedUpdates[name] = [...others, ...shown.map(({ from, to }) => ({ from, to, at: now }))];
				changed = true;
			}
			return changed;
		});
	}

	/**
	 * 提示这个服务到期的新版，返回确实显示了的替换。本进程还没有 models.dev 数据时推迟到下次刷新。
	 * 开关开着的服务由 `migrateOnDisk()` 处理；快照里拿不到密钥（别的 pi 删了密钥）的服务不提醒，用户已经不再用它。
	 */
	private showUpdates(name: string, now: number): Replacement[] {
		if (!hasModelsDevData()) return [];
		let files: Files;
		try {
			files = readFiles();
		} catch {
			return [];
		}
		const service = files.config.services.find((item) => item.name === name);
		if (!service || service.latestPerFamily || !resolveKey(service, files.auth)) return [];
		const updates = this.pendingUpdates(service, files.cache[name]);
		const recent = new Set((loadState().notifiedUpdates[name] ?? []).filter((item) => isRecent(item, now)).map(replacementKey));
		const due = updates.filter((item) => !recent.has(replacementKey(item)));
		if (!due.length) return [];
		const shown = this.tryNotify(
			`${service.displayName || name} 有新版模型：${describeReplacements(due)}。输入 /endpoints，在模型页点“换成新版”只换这一次，或点“开启自动替换”以后自动换。`,
			"warning",
		);
		return shown ? due : [];
	}

	private isCurrent(service: ServiceConfig): boolean {
		return this.service(service.name)?.baseUrl === service.baseUrl;
	}

	status(): ServiceStatus[] {
		return this.config.services.map((service) => {
			const catalog = this.cache[service.name];
			const ids = new Set(catalog?.models.map((model) => model.id));
			return {
				name: service.name,
				keySource: this.keySource(service.name),
				disabled: service.disabled === true,
				registered: this.registered.has(service.name),
				catalogAt: catalog?.fetchedAt,
				catalogSize: catalog?.models.length,
				enabled: service.enabled.length,
				missing: catalog ? service.enabled.filter((id) => !ids.has(id)) : [],
				error: this.errors.get(service.name),
				syncError: this.syncErrors.get(service.name),
			};
		});
	}

	/** 新建服务，或修改名为 `previousName` 的服务（可以改名）。 */
	saveService(input: ServiceConfig, previousName?: string): ServiceConfig {
		this.beginChange();
		const service = normalizeService(input);
		const problem = serviceProblem(service);
		if (problem) throw new Error(problem);
		// 带 previousName 是修改已有服务，不带是新建。
		const existing = previousName === undefined ? undefined : this.service(previousName);
		if (previousName !== undefined && !existing) throw new Error(`没有名为 ${previousName} 的服务`);
		if (service.name !== previousName && this.service(service.name)) throw new Error(`已经有名为 ${service.name} 的服务`);

		if (existing) {
			// 编辑表单不带模型选择和服务开关，保留原来的。新建时按传入的 latestPerFamily 保存。
			service.disabled = existing.disabled;
			service.latestPerFamily = existing.latestPerFamily;
			service.enabled = input.enabled ?? existing.enabled;
			// 传了 overrides 时用 normalizeService() 整理过的（没有原型），没传时沿用原来的。
			if (input.overrides == null) service.overrides = existing.overrides;
			this.config.services[this.config.services.indexOf(existing)] = service;
		} else {
			this.config.services.push(service);
		}
		if (existing && previousName !== undefined && service.name !== previousName) {
			this.moveEntry(this.auth, previousName, service.name, saveAuth);
			this.moveEntry(this.cache, previousName, service.name, saveCache);
			const error = this.errors.get(previousName);
			this.errors.delete(previousName);
			if (error) this.errors.set(service.name, error);
			renameNotified(previousName, service.name);
		}
		if (existing && existing.baseUrl !== service.baseUrl) {
			// 换了地址，旧目录和旧错误都不再可信。
			delete this.cache[service.name];
			saveCache(this.cache);
			this.errors.delete(service.name);
		}
		saveConfig(this.config);
		this.registerAll();
		return service;
	}

	private moveEntry<T>(file: Record<string, T>, from: string, to: string, save: (value: Record<string, T>) => void): void {
		if (!(from in file)) return;
		file[to] = file[from];
		delete file[from];
		save(file);
	}

	removeService(name: string): void {
		this.beginChange();
		this.config.services = this.config.services.filter((service) => service.name !== name);
		saveConfig(this.config);
		if (this.auth[name]) {
			delete this.auth[name];
			saveAuth(this.auth);
		}
		if (this.cache[name]) {
			delete this.cache[name];
			saveCache(this.cache);
		}
		this.errors.delete(name);
		forgetNotified(name);
		this.registerAll();
	}

	/** 写入密钥；传空字符串表示删除。 */
	setKey(name: string, apiKey: string): void {
		this.beginChange();
		this.requireService(name);
		const trimmed = apiKey.trim();
		if (trimmed) this.auth[name] = { apiKey: trimmed };
		else delete this.auth[name];
		saveAuth(this.auth);
		this.registerAll();
	}

	/** 停用或启用整个服务。 */
	setServiceDisabled(name: string, disabled: boolean): void {
		this.beginChange();
		const service = this.requireService(name);
		service.disabled = disabled || undefined;
		saveConfig(this.config);
		this.registerAll();
	}

	/**
	 * 开启或关闭“每系最新”，立即生效。开启时按缓存的目录立即执行一次，不刷新目录；models.dev 到期时先等它更新完（最多 60 秒）。
	 * 开关和换过的启用列表一起保存，只注册一次。先校验磁盘快照，等完 models.dev 再读一次最新快照，在快照上改；
	 * 保存成功后才换进内存并注册，保存失败时内存不变。
	 */
	async setLatestPerFamily(name: string, on: boolean): Promise<void> {
		await this.applyLatest(name, on);
	}

	/**
	 * 按“每系最新”的规则把服务里已启用的旧版换成新版，只执行这一次，不改开关。用缓存的目录，不刷新。
	 * 换了模型时和打开开关一样保存、全量注册、替换 pi 设置里的旧模型并提示。
	 * 返回换掉的模型；没有可换的（包括 models.dev 拿不到数据、无法判断模型类型）时返回空数组，不写文件。
	 */
	async applyLatestOnce(name: string): Promise<Replacement[]> {
		return this.applyLatest(name, undefined);
	}

	/**
	 * `setLatestPerFamily()` 和 `applyLatestOnce()` 的共同部分。`on` 为 undefined 时不改开关，只替换一次；
	 * `on` 为假时只关闭开关。先校验磁盘快照，要替换时等 models.dev 更新完（最多 60 秒）再读一次最新快照，在快照上改；
	 * 开关和换过的启用列表一起保存，保存成功后才换进内存并注册（只注册一次），保存失败时内存不变。
	 */
	private async applyLatest(name: string, on: boolean | undefined): Promise<Replacement[]> {
		const run = on !== false;
		requireIn(this.readSnapshot(), name);
		// 开关还没保存（或者不改开关），needsModelsDev() 不一定把这个服务算进去，所以不检查是否需要。认领留到真正注册时。
		const claim = run ? await this.waitModelsDev(true) : undefined;
		const files = this.readSnapshot();
		const service = requireIn(files, name);
		if (on !== undefined) service.latestPerFamily = on || undefined;
		const plan = run ? this.planLatest(service, files.cache[name], true) : undefined;
		if (on === undefined && !plan) {
			// 没有可换的模型时不写文件；models.dev 刚更新、还没人为它注册过时照样全量注册。
			if (claim?.()) this.registerAll();
			return [];
		}
		if (plan) service.enabled = plan.enabled;
		saveConfig(files.config);
		this.commit(files);
		claim?.();
		this.registerAll();
		if (plan) await this.afterMigration(name, plan.replacements, "live");
		return plan?.replacements ?? [];
	}

	setEnabled(name: string, id: string, enabled: boolean): void {
		this.beginChange();
		const service = this.requireService(name);
		// 目录里没有、也还没启用的 id 不在 models() 里，按 { id } 单独解析，同样检查类型。
		const model = enabled ? (this.models(name).find((item) => item.id === id) ?? resolveModel(service, { id }, this.cache[name])) : undefined;
		if (model && !isChatModel(model)) throw new Error(`${id} 是${typeLabel(model.modelType)}，pi 不能拿它对话`);
		const set = new Set(service.enabled);
		if (enabled) set.add(id);
		else set.delete(id);
		service.enabled = [...set];
		saveConfig(this.config);
		// 停用了旧版，用户已经处理过它的新版提醒。
		if (!enabled) forgetNotified(name, [id]);
		this.registerAll();
	}

	setOverride(name: string, id: string, override: ModelOverride | undefined): void {
		this.beginChange();
		const service = this.requireService(name);
		if (override && Object.keys(override).length) {
			validateOverride(override);
			service.overrides[id] = override;
		} else {
			delete service.overrides[id];
		}
		saveConfig(this.config);
		this.registerAll();
	}

	private requireService(name: string): ServiceConfig {
		const service = this.service(name);
		if (!service) throw new Error(`没有名为 ${name} 的服务`);
		return service;
	}
}

interface Files {
	config: EndpointsConfig;
	auth: AuthFile;
	cache: CacheFile;
}

/** 读配置、密钥和目录缓存三个文件，不改内存状态。配置或密钥文件损坏时抛出错误。 */
function readFiles(): Files {
	return { config: loadConfig(), auth: loadAuth(), cache: loadCache() };
}

/**
 * “每系最新”可以用的目录：服务配置没有问题，缓存里目录的来源地址等于服务地址。
 * 来源地址未知（旧版本写的缓存）或不同时，目录可能属于旧地址。
 */
function latestCatalog(service: ServiceConfig, catalog: Catalog | undefined): Catalog | undefined {
	if (serviceProblem(service) || !catalog?.baseUrl || catalog.baseUrl !== service.baseUrl) return undefined;
	return catalog;
}

const replacementKey = ({ from, to }: Replacement) => `${from}\n${to}`;

/** 提示时间在 `RENOTIFY_MS` 以内。时钟回拨（提示时间晚于现在）时按已过间隔处理。 */
const isRecent = (item: NotifiedUpdate, now: number) => now - item.at >= 0 && now - item.at < RENOTIFY_MS;

/**
 * 改 `endpoints-state.json`：重新读取，`edit` 返回真时写回。多个 pi 之间不加锁；读写失败时忽略，
 * 最坏是同一个新版多提示一次。
 */
function editState(edit: (state: StateFile) => boolean): void {
	try {
		const state = loadState();
		if (edit(state)) saveState(state);
	} catch {
		// 见上。
	}
}

/** 用户处理了新版（换掉或停用旧版、删除服务）后去掉提醒记录：给了 `froms` 时只去掉这些旧 id 的，否则去掉整个服务的。 */
function forgetNotified(name: string, froms?: readonly string[]): void {
	editState((state) => {
		const list = state.notifiedUpdates[name];
		if (!list) return false;
		const kept = froms ? list.filter((item) => !froms.includes(item.from)) : [];
		if (kept.length === list.length) return false;
		if (kept.length) state.notifiedUpdates[name] = kept;
		else delete state.notifiedUpdates[name];
		return true;
	});
}

/** 服务改名时把提醒记录搬到新名下；旧名没有记录时新名下也不留。 */
function renameNotified(from: string, to: string): void {
	editState((state) => {
		const list = state.notifiedUpdates[from];
		if (!list && !state.notifiedUpdates[to]) return false;
		delete state.notifiedUpdates[from];
		if (list) state.notifiedUpdates[to] = list;
		else delete state.notifiedUpdates[to];
		return true;
	});
}

const describeReplacements = (replacements: Replacement[]) => replacements.map(({ from, to }) => `${from} → ${to}`).join("、");

/** 在文件快照里取服务，没有时报错。 */
function requireIn(files: Files, name: string): ServiceConfig {
	const service = files.config.services.find((item) => item.name === name);
	if (!service) throw new Error(`没有名为 ${name} 的服务`);
	return service;
}

const FALLBACK_SOURCES = new Set<Source>(["modelsdev", "default"]);

function usesFallback(model: ResolvedModel): boolean {
	return [model.contextWindow, model.maxTokens, model.input, model.reasoning, model.cost].some((value) => FALLBACK_SOURCES.has(value.source));
}

const TYPE_LABELS: Record<string, string> = {
	decision: "分类模型",
	image: "图片生成模型",
	video: "视频生成模型",
	embedding: "向量模型",
	reranking: "重排序模型",
	transcription: "语音识别模型",
	speech: "语音合成模型",
	realtime: "实时语音模型",
	audio: "音频模型",
	extraction: "信息抽取模型",
};

/** 管理页报错时用的模型类型名称。 */
export function typeLabel(type: string | undefined): string {
	return (type && TYPE_LABELS[type]) ?? `${type} 类型的模型`;
}

export function validateName(name: string): void {
	if (!NAME_PATTERN.test(name)) throw new Error("服务名只能用小写字母、数字、点、下划线和连字符，并以字母或数字开头");
	// 和 pi 自带的服务商同名会把它的模型整个替换掉。
	if (builtinProviderIds().includes(name)) throw new Error(`${name} 是 pi 自带的服务商，请换一个名字`);
}

/** 检查服务配置，返回问题描述。手工编辑的 endpoints.json 也会经过这里。 */
function serviceProblem(service: ServiceConfig): string | undefined {
	try {
		validateName(service.name);
	} catch (error) {
		return describeError(error);
	}
	if (!URL_PATTERN.test(service.baseUrl)) return `${service.name} 的地址要以 http:// 或 https:// 开头`;
	if (service.defaultApi && !SUPPORTED_APIS.includes(service.defaultApi)) return `不支持的协议 ${service.defaultApi}`;
	if (service.apiKeyEnv && !ENV_NAME_PATTERN.test(service.apiKeyEnv)) {
		return `环境变量名 ${service.apiKeyEnv} 不合规，只写名字，不要带 $`;
	}
	return headersProblem(service.headers);
}

function headersProblem(headers: unknown): string | undefined {
	if (headers === undefined) return undefined;
	if (!isPlainObject(headers)) return "请求头要写成 JSON 对象";
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value !== "string") return `请求头 ${key} 的值要是字符串`;
	}
	return undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInt = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;

export function validateOverride(override: ModelOverride): void {
	if (override.api !== undefined && !SUPPORTED_APIS.includes(override.api)) throw new Error(`不支持的协议 ${override.api}`);
	if (override.contextWindow !== undefined && !isPositiveInt(override.contextWindow)) throw new Error("上下文要填正整数");
	if (override.maxTokens !== undefined && !isPositiveInt(override.maxTokens)) throw new Error("最大输出要填正整数");
	if (override.baseUrl !== undefined && !URL_PATTERN.test(override.baseUrl)) throw new Error("地址要以 http:// 或 https:// 开头");
	if (
		override.input !== undefined &&
		!(Array.isArray(override.input) && override.input.length > 0 && override.input.every((item) => item === "text" || item === "image"))
	) {
		throw new Error("输入类型只能是 text 和 image");
	}
	if (override.thinkingLevels !== undefined) {
		const allowed = new Set<string>([...PI_LEVELS, "none"]);
		if (!Array.isArray(override.thinkingLevels) || override.thinkingLevels.some((level) => !allowed.has(level))) {
			throw new Error(`思考档位只能是 ${PI_LEVELS.join("、")}，或单独填 none`);
		}
	}
	const problem = headersProblem(override.headers);
	if (problem) throw new Error(problem);
	for (const [field, value] of Object.entries({ compat: override.compat, thinkingLevelMap: override.thinkingLevelMap, 价格: override.cost })) {
		if (value !== undefined && !isPlainObject(value)) throw new Error(`${field} 要写成 JSON 对象`);
	}
	if (override.cost) {
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = override.cost[field];
			if (typeof value !== "number" || !(value >= 0)) throw new Error(`价格的 ${field} 要填非负数`);
		}
	}
}

/** 交给 pi 的请求头值也会被当作 $ENV 和 !命令 解释，这里转义成字面值。 */
function toPiModel(model: ResolvedModel) {
	const config = toProviderModel(model);
	if (config.headers) {
		config.headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, escapeConfigValue(value)]));
	}
	return config;
}

export function describeError(error: unknown): string {
	if (error instanceof CatalogError) return error.body ? `${error.message}：${error.body}` : error.message;
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		return cause instanceof Error ? `${error.message}（${cause.message}）` : error.message;
	}
	return String(error);
}
