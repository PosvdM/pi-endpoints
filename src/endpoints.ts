import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviderIds } from "./builtin.ts";
import { type Catalog, CatalogError, fetchCatalog } from "./catalog.ts";
import {
	type EndpointsConfig,
	type KeySource,
	loadAuth,
	loadCache,
	loadConfig,
	normalizeService,
	piApiKey,
	resolveKey,
	saveAuth,
	saveCache,
	saveConfig,
	type ServiceConfig,
} from "./config.ts";
import { type ResolvedModel, resolveService, toProviderModel } from "./resolve.ts";

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

/** 插件的全部状态：配置、密钥、目录缓存，以及向 pi 注册服务商。 */
export class Endpoints {
	config: EndpointsConfig;
	private auth = loadAuth();
	private cache = loadCache();
	private errors = new Map<string, string>();
	private registered = new Set<string>();

	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.config = loadConfig();
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

	/** 按当前配置和缓存注册所有服务。启动时调用，不访问网络。 */
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
		const resolved = service ? resolveKey(service, this.auth) : undefined;
		const models = service ? this.models(name).filter((model) => service.enabled.includes(model.id)) : [];
		// 没有密钥 pi 会拒绝注册；没有启用的模型也没必要注册。
		if (!service || !resolved || models.length === 0) {
			this.unregister(name);
			return;
		}
		this.pi.registerProvider(name, {
			name: service.displayName || name,
			baseUrl: service.baseUrl,
			apiKey: piApiKey(service, resolved),
			api: service.defaultApi ?? models[0].api.value,
			models: models.map(toProviderModel),
			// 打开 /model 时 pi 会调用它刷新目录。
			refreshModels: async (context) => {
				if (context.allowNetwork) await this.refresh(name, context.signal);
				const current = this.service(name);
				return current ? this.models(name).filter((model) => current.enabled.includes(model.id)).map(toProviderModel) : [];
			},
		});
		this.registered.add(name);
	}

	/** 刷新一个服务的目录，成功后写缓存并重新注册。失败时保留旧缓存。 */
	async refresh(name: string, signal?: AbortSignal): Promise<Catalog> {
		const service = this.service(name);
		if (!service) throw new Error(`没有名为 ${name} 的服务`);
		const key = resolveKey(service, this.auth);
		if (!key) throw new Error(`服务 ${name} 还没有设置密钥`);
		try {
			const catalog = await fetchCatalog(service.baseUrl, key.key, { headers: service.headers, signal });
			this.cache[name] = catalog;
			saveCache(this.cache);
			this.errors.delete(name);
			return catalog;
		} catch (error) {
			if (!signal?.aborted) this.errors.set(name, describeError(error));
			throw error;
		}
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
		const service = normalizeService(input);
		validateName(service.name);
		if (!/^https?:\/\//.test(service.baseUrl)) throw new Error("地址要以 http:// 或 https:// 开头");
		// 带 previousName 是修改已有服务，不带是新建。
		const oldName = previousName ?? service.name;
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
		if (existing && service.name !== oldName) {
			if (this.auth[oldName]) {
				this.auth[service.name] = this.auth[oldName];
				delete this.auth[oldName];
				saveAuth(this.auth);
			}
			if (this.cache[oldName]) {
				this.cache[service.name] = this.cache[oldName];
				delete this.cache[oldName];
				saveCache(this.cache);
			}
			this.unregister(oldName);
		}
		if (existing && existing.baseUrl !== service.baseUrl) {
			// 换了地址，旧目录不再可信。
			delete this.cache[service.name];
			saveCache(this.cache);
		}
		saveConfig(this.config);
		this.register(service.name);
		return service;
	}

	removeService(name: string): void {
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
		this.unregister(name);
	}

	/** 写入密钥；传空字符串表示删除。 */
	setKey(name: string, apiKey: string): void {
		if (!this.service(name)) throw new Error(`没有名为 ${name} 的服务`);
		const trimmed = apiKey.trim();
		if (trimmed) this.auth[name] = { apiKey: trimmed };
		else delete this.auth[name];
		saveAuth(this.auth);
		this.register(name);
	}

	setEnabled(name: string, id: string, enabled: boolean): void {
		const service = this.requireService(name);
		const set = new Set(service.enabled);
		if (enabled) set.add(id);
		else set.delete(id);
		service.enabled = [...set];
		saveConfig(this.config);
		this.register(name);
	}

	setOverride(name: string, id: string, override: ServiceConfig["overrides"][string] | undefined): void {
		const service = this.requireService(name);
		if (override && Object.keys(override).length) service.overrides[id] = override;
		else delete service.overrides[id];
		saveConfig(this.config);
		this.register(name);
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

export function describeError(error: unknown): string {
	if (error instanceof CatalogError) return error.body ? `${error.message}：${error.body}` : error.message;
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		return cause instanceof Error ? `${error.message}（${cause.message}）` : error.message;
	}
	return String(error);
}
