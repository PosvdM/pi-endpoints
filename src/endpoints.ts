import type { Model } from "@earendil-works/pi-ai";
import { streamSimpleAnthropic } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withBetas } from "./betas.ts";
import { builtinProviderIds } from "./builtin.ts";
import { type Catalog, CatalogError, fetchCatalog } from "./catalog.ts";
import {
	type EndpointsConfig,
	escapeConfigValue,
	type KeySource,
	loadAuth,
	loadCache,
	loadConfig,
	type ModelOverride,
	normalizeService,
	piApiKey,
	resolveKey,
	saveAuth,
	saveCache,
	saveConfig,
	type ServiceConfig,
} from "./config.ts";
import { replaceModels } from "./defaults.ts";
import { pickLatest, type Replacement } from "./family.ts";
import { loadModelsDev, updateModelsDev } from "./modelsdev.ts";
import { isChatModel, PI_LEVELS, type ResolvedModel, resolveModel, resolveService, type Source, SUPPORTED_APIS, toProviderModel } from "./resolve.ts";

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
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_PATTERN = /^https?:\/\/./;
const REFRESH_TIMEOUT_MS = 15_000;

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
	private auth: AuthFile = {};
	private cache: CacheFile = {};
	private errors = new Map<string, string>();
	private registered = new Set<string>();
	/** 每个已注册服务里各模型的附加 Anthropic beta，注册和刷新目录时更新。 */
	private betas = new Map<string, Map<string, string[]>>();
	/** 正在进行的 models.dev 更新，并发的调用共用它，拿到新数据后只重新注册一次。 */
	private modelsDevTask?: Promise<void>;
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
		this.config = loadConfig();
		this.auth = loadAuth();
		this.cache = loadCache();
		this.loadError = undefined;
	}

	/** 修改前调用：读最新的文件；文件损坏时拒绝修改。 */
	private beginChange(): void {
		try {
			this.reload();
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

	private unregister(name: string): void {
		this.betas.delete(name);
		if (!this.registered.delete(name)) return;
		this.pi.unregisterProvider(name);
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
		this.pi.registerProvider(name, {
			name: service.displayName || name,
			baseUrl: service.baseUrl,
			apiKey: piApiKey(service, resolved),
			// 所有模型都写明了协议，这里的 api 只用来让 streamSimple 接管 Anthropic 协议的请求。
			api: "anthropic-messages",
			// 会话、压缩和摘要请求都经过这里，插件事件 before_provider_request 覆盖不到后两者。
			streamSimple: (model, context, options) =>
				streamSimpleAnthropic(model as Model<"anthropic-messages">, context, withBetas(options, this.betas.get(name)?.get(model.id) ?? [])),
			models: this.piModels(name, models),
			// 交互模式和 RPC 模式启动后、打开 /model 时，pi 会调用它刷新目录。
			// 重新注册时 pi 会以 allowNetwork: false 再调用一次，这时不刷新，也就不会再触发 models.dev 更新和“每系最新”。
			refreshModels: async (context) => {
				if (context.allowNetwork) {
					try {
						await this.refreshAndApply(name, context.signal);
					} finally {
						// 在后台更新 models.dev，不拖慢启动。拿到新数据后会重新注册所有服务。
						void this.updateModelsDev();
					}
				}
				const current = this.service(name);
				return current ? this.piModels(name, this.enabledModels(current)) : [];
			},
		});
		this.registered.add(name);
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
	 * 才需要 models.dev 的数据。
	 */
	needsModelsDev(): boolean {
		return this.config.services.some(
			(service) => !service.disabled && resolveKey(service, this.auth) && this.models(service.name).some(usesFallback),
		);
	}

	/**
	 * 需要时更新 models.dev，拿到新数据后重新注册所有服务。不会失败，原因记在 `modelsDevStatus().error`。
	 * 是否到期（24 小时、失败后 30 分钟）由 `updateModelsDev()` 判断。
	 */
	updateModelsDev(): Promise<void> {
		if (this.modelsDevTask) return this.modelsDevTask;
		if (!this.needsModelsDev()) return Promise.resolve();
		this.modelsDevTask = updateModelsDev()
			.then((changed) => {
				if (changed) this.registerAll();
			})
			.catch(() => {})
			.finally(() => {
				this.modelsDevTask = undefined;
			});
		return this.modelsDevTask;
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
	 * 刷新目录；成功并写入缓存后，按“每系最新”调整启用的模型。刷新失败时抛出错误，不调整。
	 * 调整了模型时会重新注册所有服务，否则不负责重新注册。
	 */
	async refreshAndApply(name: string, signal?: AbortSignal): Promise<Catalog> {
		const service = this.service(name);
		const catalog = await this.refresh(name, signal);
		// 请求期间服务被删除、改名或换了地址时，refresh() 没有写缓存，这里也不调整。
		if (service && this.isCurrent(service)) await this.applyLatestPerFamily(name, service.baseUrl);
		return catalog;
	}

	/**
	 * 服务开启了 `latestPerFamily` 时，按缓存的目录在每个已启用的系列里只保留最新版（规则见 `pickLatest()`）。
	 * 候选只取目录里没有隐藏的对话模型。有变化时保存配置、重新注册，再把 pi 设置里的旧模型换成新版；
	 * 没有变化时不写文件。不会失败：配置文件损坏时不调整，pi 设置读写不了时跳过那一步。
	 * 带 `baseUrl` 时，重新读到的服务地址和它不同就不调整，缓存里的目录未必属于新地址。
	 */
	async applyLatestPerFamily(name: string, baseUrl?: string): Promise<Replacement[]> {
		try {
			this.beginChange();
		} catch {
			return [];
		}
		const service = this.service(name);
		const catalog = this.cache[name];
		if (!service?.latestPerFamily || !catalog || (baseUrl !== undefined && service.baseUrl !== baseUrl)) return [];
		const candidates = catalog.models
			.map((model) => resolveModel(service, model, catalog))
			.filter((model) => !model.hidden && isChatModel(model))
			.map((model) => model.id);
		const { enabled, replacements } = pickLatest(service.enabled, candidates);
		if (replacements.length === 0) return [];
		service.enabled = enabled;
		saveConfig(this.config);
		this.registerAll();
		try {
			await replaceModels(name, new Map(replacements.map(({ from, to }) => [from, to])));
		} catch {
			// settings.json 读不了或写不了时只跳过这一步，启用列表已经保存。
		}
		return replacements;
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
			// 编辑表单不带模型选择和服务开关，保留原来的。
			service.disabled = existing.disabled;
			service.latestPerFamily = existing.latestPerFamily;
			service.enabled = input.enabled ?? existing.enabled;
			service.overrides = input.overrides ?? existing.overrides;
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

	/** 开启或关闭“每系最新”。开启时立即按缓存的目录调整一次，不访问网络。 */
	async setLatestPerFamily(name: string, on: boolean): Promise<void> {
		this.beginChange();
		const service = this.requireService(name);
		service.latestPerFamily = on || undefined;
		saveConfig(this.config);
		this.registerAll();
		if (on) await this.applyLatestPerFamily(name);
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
