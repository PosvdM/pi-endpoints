import type { Api, SimpleStreamOptions } from "@earendil-works/pi-ai";

/** 申请 1M 上下文的 Anthropic beta。CLIProxyAPI 这类订阅类服务只在请求带它时才给 1M。 */
export const LONG_CONTEXT_BETA = "context-1m-2025-08-07";

/** 上下文超过这个值的 Anthropic 模型自动带上 LONG_CONTEXT_BETA。 */
export const LONG_CONTEXT_THRESHOLD = 200_000;

/**
 * Anthropic 协议的模型把请求头里的 `anthropic-beta` 拆出来，单独作为附加 beta。
 * pi 遇到模型请求头里的 `anthropic-beta` 时会用它整个替换自己算出的 beta 列表，
 * 所以不能交给 pi 的请求头，改在 `withBetas()` 里追加。
 */
export function splitBetas(
	headers: Record<string, string>,
	api: Api,
	contextWindow: number,
): { headers: Record<string, string>; betas: string[] } {
	if (api !== "anthropic-messages") return { headers, betas: [] };
	const rest: Record<string, string> = {};
	const betas: string[] = [];
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === "anthropic-beta") betas.push(...value.split(","));
		else rest[key] = value;
	}
	if (contextWindow > LONG_CONTEXT_THRESHOLD) betas.push(LONG_CONTEXT_BETA);
	return { headers: rest, betas: unique(betas) };
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** 在 pi 组好的请求体上追加 beta，再交给调用方原有的 onPayload。 */
export function withBetas(options: SimpleStreamOptions | undefined, betas: string[]): SimpleStreamOptions | undefined {
	if (betas.length === 0) return options;
	return {
		...options,
		onPayload: async (payload, model) => {
			const params = payload as { betas?: string[] };
			const next = { ...params, betas: unique([...(params.betas ?? []), ...betas]) };
			return (await options?.onPayload?.(next, model)) ?? next;
		},
	};
}
