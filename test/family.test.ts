import { describe, expect, it } from "vitest";
import { compareMembers, familyOf, pickLatest } from "../src/family.ts";

describe("familyOf", () => {
	it("去掉版本段得到系列名，保留最后一个 / 之前的前缀", () => {
		expect(familyOf("codex/gpt-6.2-sol")).toEqual({ family: "codex/gpt-sol", version: [6, 2], date: undefined });
		expect(familyOf("claude/claude-opus-5-5")).toEqual({ family: "claude/claude-opus", version: [5, 5], date: undefined });
		expect(familyOf("agy-cli/gemini-3.8-flash")?.family).toBe("agy-cli/gemini-flash");
		expect(familyOf("opencode-zen-free/mimo-v2.6-flash-free")).toMatchObject({ family: "opencode-zen-free/mimo-flash-free", version: [2, 6] });
		expect(familyOf("gpt-6-chat-thinking")).toMatchObject({ family: "gpt-chat-thinking", version: [6] });
		expect(familyOf("a/b/gpt-6")?.family).toBe("a/b/gpt");
	});

	it("没有版本段、只有版本段的模型不属于任何系列", () => {
		expect(familyOf("Index-Translate-35B-A3B")).toBeUndefined();
		expect(familyOf("codex/o3")).toBeUndefined();
		expect(familyOf("5-5")).toBeUndefined();
	});

	it("8 位日期段不算系列名，单独记下", () => {
		expect(familyOf("claude-sonnet-4-5-20250929")).toEqual({ family: "claude-sonnet", version: [4, 5], date: 20250929 });
		expect(familyOf("claude-3-5-sonnet-20241022")).toEqual({ family: "claude-sonnet", version: [3, 5], date: 20241022 });
	});

	it("只取第一串版本段，以 0 开头的多位数不算版本", () => {
		expect(familyOf("gemini-2.5-flash-preview-05-20")).toMatchObject({ family: "gemini-flash-preview-05-20", version: [2, 5] });
		expect(familyOf("deepseek-v3-0324")).toMatchObject({ family: "deepseek-0324", version: [3] });
	});

	it("codex/ 和 claude/ 前缀属于不同系列", () => {
		expect(familyOf("codex/gpt-6.2-sol")?.family).not.toBe(familyOf("claude/gpt-6.2-sol")?.family);
	});
});

describe("compareMembers", () => {
	const v = (...version: number[]) => ({ version });
	it("按数字逐段比较，缺的段按 0 算", () => {
		expect(compareMembers(v(6, 2), v(6, 1))).toBe(1);
		expect(compareMembers(v(6, 1), v(6))).toBe(1);
		expect(compareMembers(v(6), v(6, 0))).toBe(0);
		expect(compareMembers(v(10), v(9, 9))).toBe(1);
	});

	it("版本相同、两边都有日期时比较日期", () => {
		expect(compareMembers({ version: [4, 5], date: 20250929 }, { version: [4, 5], date: 20250101 })).toBe(1);
		expect(compareMembers({ version: [4, 5], date: 20250929 }, { version: [4, 5] })).toBe(0);
		expect(compareMembers({ version: [4, 6] }, { version: [4, 5], date: 20250929 })).toBe(1);
	});
});

describe("pickLatest", () => {
	it("启用目录里的最新版，停用同系列旧版，新版放在旧版的位置", () => {
		const result = pickLatest(["a", "gpt-6.1-sol", "b"], ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-sol", "a", "b"]);
		expect(result.enabled).toEqual(["a", "gpt-6.2-sol", "b"]);
		expect(result.replacements).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);
	});

	it("目录里没有的旧 id 也被替换", () => {
		const result = pickLatest(["gpt-6.1-sol"], ["gpt-6.2-sol"]);
		expect(result.enabled).toEqual(["gpt-6.2-sol"]);
		expect(result.replacements).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);
	});

	it("新版已经启用时只停用旧版", () => {
		const result = pickLatest(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]);
		expect(result.enabled).toEqual(["gpt-6.2-sol"]);
		expect(result.replacements).toEqual([
			{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" },
			{ from: "gpt-6-sol", to: "gpt-6.2-sol" },
		]);
	});

	it("没有启用成员的系列、目录里没有成员的系列、不属于系列的模型都不动", () => {
		const result = pickLatest(["claude-opus-5-5", "Index-Translate-35B-A3B"], ["gpt-6.2-sol", "gpt-6.1-sol", "Index-Translate-35B-A3B"]);
		expect(result).toEqual({ enabled: ["claude-opus-5-5", "Index-Translate-35B-A3B"], replacements: [] });
	});

	it("已是最新版时没有变化", () => {
		expect(pickLatest(["gpt-6.2-sol"], ["gpt-6.1-sol", "gpt-6.2-sol"]).replacements).toEqual([]);
	});

	it("已启用的成员比候选的最新版还新时不降级", () => {
		expect(pickLatest(["gpt-6.3-sol"], ["gpt-6.2-sol"]).replacements).toEqual([]);
		expect(pickLatest(["gpt-6.3-sol", "gpt-6.1-sol"], ["gpt-6.2-sol"]).replacements).toEqual([]);
	});

	it("日期最后比较，不带日期的别名和最新日期的版本都算最新", () => {
		const candidates = ["claude-sonnet-4-5-20250101", "claude-sonnet-4-5-20250929", "claude-sonnet-4-5"];
		expect(pickLatest(["claude-sonnet-4-5-20250101"], candidates)).toEqual({
			enabled: ["claude-sonnet-4-5-20250929"],
			replacements: [{ from: "claude-sonnet-4-5-20250101", to: "claude-sonnet-4-5-20250929" }],
		});
		expect(pickLatest(["claude-sonnet-4-5"], candidates).replacements).toEqual([]);
		expect(pickLatest(["claude-3-5-sonnet-20241022"], candidates).enabled).toEqual(["claude-sonnet-4-5-20250929"]);
	});
});
