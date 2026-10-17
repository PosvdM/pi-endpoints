import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

/** 把 pi 的配置目录换成临时目录，返回清理函数。 */
export function useTempAgentDir(): { dir: string; cleanup: () => void } {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pi-endpoints-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return {
		dir,
		cleanup: () => {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** 只记录注册调用的假 pi。 */
export function fakePi() {
	const providers = new Map<string, ProviderConfig>();
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
		unregisterProvider: (name: string) => providers.delete(name),
	} as unknown as ExtensionAPI;
	return { pi, providers };
}
