import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { PI_LEVELS, type ResolvedModel, resolveService, SUPPORTED_APIS, toProviderModel } from "./resolve.ts";

export interface ServiceStatus {
	name: string;
	keySource?: KeySource;
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
 * 可能同时开着多个 pi，所以每次修改前都重新读文件，在最新内容上改动。
 */
export class Endpoints {
	config: EndpointsConfig = { services: [] };
	/** 配置或密钥文件读不了时的原因。这时拒绝修改，免得覆盖用户待修的文件。 */
	loadError?: string;
	private auth: AuthFile = {};
	private cache: CacheFile = {};
	private errors = new Map<string, string>();
	private registered = new Set<string>();
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
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
		if (!this.registered.delete(name)) return;
		this.pi.unregisterProvider(name);
	}

	register(name: string): void {
		const service = this.service(name);
		const problem = service ? serviceProblem(service) : undefined;
		if (problem) this.errors.set(name, problem);
		const resolved = service && !problem ? resolveKey(service, this.auth) : undefined;
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
			api: service.defaultApi ?? models[0].api.value,
			models: models.map(toPiModel),
			// 交互模式和 RPC 模式启动后、打开 /model 时，pi 会调用它刷新目录。
			refreshModels: async (context) => {
				if (context.allowNetwork) await this.refresh(name, context.signal);
				const current = this.service(name);
				return current ? this.enabledModels(current).map(toPiModel) : [];
			},
		});
		this.registered.add(name);
	}

	private enabledModels(service: ServiceConfig): ResolvedModel[] {
		return this.models(service.name).filter((model) => service.enabled.includes(model.id));
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

	private isCurrent(service: ServiceConfig): boolean {
		return this.service(service.name)?.baseUrl === service.baseUrl;
	}

	/** 刷新全部服务并重新注册。返回失败的服务和原因。 */
	async refreshAll(signal?: AbortSignal): Promise<Map<string, string>> {
		const failures = new Map<string, string>();
		await Promise.all(
			this.config.services.map(async (service) => {
				try {
					await this.refresh(service.name, signal);
					this.register(service.name);
				} catch (error) {
					failures.set(service.name, describeError(error));
				}
			}),
		);
		return failures;
	}

	status(): ServiceStatus[] {
		return this.config.services.map((service) => {
			const catalog = this.cache[service.name];
			const ids = new Set(catalog?.models.map((model) => model.id));
			return {
				name: service.name,
				keySource: this.keySource(service.name),
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
			// 编辑表单不带模型选择，保留原来的。
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

	setEnabled(name: string, id: string, enabled: boolean): void {
		this.beginChange();
		const service = this.requireService(name);
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
