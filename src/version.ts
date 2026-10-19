import { readFileSync } from "node:fs";

/** 插件自己的版本号，取自包内的 package.json。 */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const REGISTRY_URL = "https://registry.npmjs.org/pi-endpoints/latest";
const RELEASES_URL = "https://github.com/PosvdM/pi-endpoints/releases/tag/v";
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export interface UpdateInfo {
	latestVersion?: string;
	releaseUrl?: string;
}

/** 两个版本都是 x.y.z 这样的纯数字版本、并且 latest 更大时返回 true。预发布版本不比较。 */
export function isNewer(current: string, latest: string): boolean {
	const parse = (version: string) => (/^\d+(\.\d+)*$/.test(version) ? version.split(".").map(Number) : undefined);
	const a = parse(current);
	const b = parse(latest);
	if (!a || !b) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (b[i] ?? 0) - (a[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

let latest: string | undefined;
let nextCheck = 0;
let pending: Promise<void> | undefined;

/**
 * 查询 npm 上的最新版本，有新版时返回版本号和 Release 页面地址。
 * 成功的结果缓存 6 小时；失败时沿用上次的结果，30 分钟后再试。
 */
export async function checkUpdate(current = VERSION, now = Date.now()): Promise<UpdateInfo> {
	if (now >= nextCheck) {
		pending ??= fetchLatest(now).finally(() => {
			pending = undefined;
		});
		await pending;
	}
	if (!latest || !isNewer(current, latest)) return {};
	return { latestVersion: latest, releaseUrl: RELEASES_URL + latest };
}

async function fetchLatest(now: number): Promise<void> {
	nextCheck = now + RETRY_MS;
	try {
		const response = await fetch(REGISTRY_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!response.ok) return;
		const version = ((await response.json()) as { version?: unknown }).version;
		if (typeof version !== "string") return;
		latest = version;
		nextCheck = now + CHECK_TTL_MS;
	} catch {
		// 检查更新失败不影响管理页，不显示。
	}
}

/** 测试用：清掉缓存的检查结果。 */
export function resetUpdateCheckForTest(): void {
	latest = undefined;
	nextCheck = 0;
	pending = undefined;
}
