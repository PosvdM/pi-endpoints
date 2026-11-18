import { describe, expect, it } from "vitest";
import { compareMembers, familyOf, pickLatest } from "../src/family.ts";

describe("familyOf", () => {
	it("去掉版本段得到系列名，保留最后一个 / 之前的前缀", () => {
		expect(familyOf("codex/gpt-6.2-sol")).toEqual({ family: "codex/gpt-sol", version: ["6", "2"], date: [] });
		expect(familyOf("claude/claude-opus-5-5")).toEqual({ family: "claude/claude-opus", version: ["5", "5"], date: [] });
		expect(familyOf("agy-cli/gemini-3.8-flash")?.family).toBe("agy-cli/gemini-flash");
		expect(familyOf("opencode-zen-free/mimo-v2.6-flash-free")).toMatchObject({ family: "opencode-zen-free/mimo-flash-free", version: ["2", "6"] });
		expect(familyOf("gpt-6-chat-thinking")).toMatchObject({ family: "gpt-chat-thinking", version: ["6"] });
		expect(familyOf("a/b/gpt-6")?.family).toBe("a/b/gpt");
	});

	it("没有版本段、只有版本段的模型不属于任何系列", () => {
		expect(familyOf("Index-Translate-35B-A3B")).toBeUndefined();
		expect(familyOf("codex/o3")).toBeUndefined();
		expect(familyOf("5-5")).toBeUndefined();
		expect(familyOf("deepseek-chat-0324")).toBeUndefined();
	});

	it("4 位及以上的纯数字段是日期，不进系列名也不算版本", () => {
		expect(familyOf("claude-sonnet-4-5-20250929")).toEqual({ family: "claude-sonnet", version: ["4", "5"], date: ["20250929"] });
		expect(familyOf("claude-3-5-sonnet-20241022")).toEqual({ family: "claude-sonnet", version: ["3", "5"], date: ["20241022"] });
		expect(familyOf("deepseek-v3-0324")).toEqual({ family: "deepseek", version: ["3"], date: ["0324"] });
		expect(familyOf("deepseek-v3-1120")).toEqual({ family: "deepseek", version: ["3"], date: ["1120"] });
		expect(familyOf("qwen-3-2024-08-06")).toEqual({ family: "qwen", version: ["3"], date: ["20240806"] });
		expect(familyOf("qwen-3-2024-8-6")?.date).toEqual(["20240806"]);
	});

	it("版本段只能是不超过 3 位的数字或含 . 的数字，只取第一串", () => {
		expect(familyOf("gemini-2.5-flash-preview-05-20")).toMatchObject({ family: "gemini-flash-preview-05-20", version: ["2", "5"] });
		expect(familyOf("model-v1234-x")).toBeUndefined();
		expect(familyOf("model-2024.1-x")).toMatchObject({ family: "model-x", version: ["2024", "1"] });
	});

	it("前缀不同、大小写不同的是不同系列；版本段的位置不影响系列名", () => {
		expect(familyOf("codex/gpt-6.2-sol")?.family).not.toBe(familyOf("claude/gpt-6.2-sol")?.family);
		expect(familyOf("GPT-6-sol")?.family).not.toBe(familyOf("gpt-6-sol")?.family);
		expect(familyOf("gpt-sol-7")?.family).toBe(familyOf("gpt-6-sol")?.family);
	});
});

describe("compareMembers", () => {
	const v = (...version: string[]) => ({ version, date: [] });
	it("按数字逐段比较，缺的段按 0 算", () => {
		expect(compareMembers(v("6", "2"), v("6", "1"))).toBe(1);
		expect(compareMembers(v("6", "1"), v("6"))).toBe(1);
		expect(compareMembers(v("6"), v("6", "0"))).toBe(0);
		expect(compareMembers(v("10"), v("9", "9"))).toBe(1);
		expect(compareMembers(v("05"), v("5"))).toBe(0);
	});

	it("很长的数字也按数值比较，不会溢出", () => {
		expect(compareMembers(v("1", "99999999999999999999"), v("1", "99999999999999999998"))).toBe(1);
		expect(compareMembers(v("1", "100000000000000000000"), v("1", "99999999999999999999"))).toBe(1);
	});

	it("版本相同、两边都有日期时比较日期", () => {
		expect(compareMembers({ version: ["4", "5"], date: ["20250929"] }, { version: ["4", "5"], date: ["20250101"] })).toBe(1);
		expect(compareMembers({ version: ["3"], date: ["1120"] }, { version: ["3"], date: ["0324"] })).toBe(1);
		expect(compareMembers({ version: ["4", "5"], date: ["20250929"] }, v("4", "5"))).toBe(0);
		expect(compareMembers(v("4", "6"), { version: ["4", "5"], date: ["20250929"] })).toBe(1);
	});
});

describe("pickLatest", () => {
	it("启用目录里的最新版，停用同系列旧版，新版放在旧版的位置", () => {
		const catalog = ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-sol", "a", "b"];
		const result = pickLatest(["a", "gpt-6.1-sol", "b"], catalog, catalog);
		expect(result.enabled).toEqual(["a", "gpt-6.2-sol", "b"]);
		expect(result.replacements).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);
	});

	it("目录里没有的旧 id 也被替换", () => {
		const result = pickLatest(["gpt-6.1-sol"], ["gpt-6.2-sol"], ["gpt-6.2-sol"]);
		expect(result.enabled).toEqual(["gpt-6.2-sol"]);
		expect(result.replacements).toEqual([{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" }]);
	});

	it("新版已经启用时只停用旧版", () => {
		const catalog = ["gpt-6.1-sol", "gpt-6.2-sol"];
		const result = pickLatest(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"], catalog, catalog);
		expect(result.enabled).toEqual(["gpt-6.2-sol"]);
		expect(result.replacements).toEqual([
			{ from: "gpt-6.1-sol", to: "gpt-6.2-sol" },
			{ from: "gpt-6-sol", to: "gpt-6.2-sol" },
		]);
	});

	it("没有启用成员的系列、目录里没有成员的系列、不属于系列的模型都不动", () => {
		const catalog = ["gpt-6.2-sol", "gpt-6.1-sol", "Index-Translate-35B-A3B"];
		const result = pickLatest(["claude-opus-5-5", "Index-Translate-35B-A3B"], catalog, catalog);
		expect(result).toEqual({ enabled: ["claude-opus-5-5", "Index-Translate-35B-A3B"], replacements: [] });
	});

	it("已是最新版时没有变化", () => {
		const catalog = ["gpt-6.1-sol", "gpt-6.2-sol"];
		expect(pickLatest(["gpt-6.2-sol"], catalog, catalog).replacements).toEqual([]);
	});

	it("已启用的成员比候选的最新版还新时不降级", () => {
		expect(pickLatest(["gpt-6.3-sol"], ["gpt-6.2-sol"], ["gpt-6.2-sol"]).replacements).toEqual([]);
		expect(pickLatest(["gpt-6.3-sol", "gpt-6.1-sol"], ["gpt-6.2-sol"], ["gpt-6.2-sol"]).replacements).toEqual([]);
		// 同版本、在目录里但被隐藏（不是候选）的也不换。
		expect(pickLatest(["gpt-6.2-sol-x"], ["gpt-6.2-sol"], ["gpt-6.2-sol", "gpt-6.2-sol-x"]).replacements).toEqual([]);
	});

	it("日期最后比较，不带日期的别名和最新日期的版本都算最新", () => {
		const candidates = ["claude-sonnet-4-5-20250101", "claude-sonnet-4-5-20250929", "claude-sonnet-4-5"];
		expect(pickLatest(["claude-sonnet-4-5-20250101"], candidates, candidates)).toEqual({
			enabled: ["claude-sonnet-4-5-20250929"],
			replacements: [{ from: "claude-sonnet-4-5-20250101", to: "claude-sonnet-4-5-20250929" }],
		});
		expect(pickLatest(["claude-sonnet-4-5"], candidates, candidates).replacements).toEqual([]);
		expect(pickLatest(["claude-3-5-sonnet-20241022"], candidates, candidates).enabled).toEqual(["claude-sonnet-4-5-20250929"]);
	});

	it("别名从目录里消失时，由目录里同版本最新的 id 接替", () => {
		const catalog = ["claude-sonnet-4-5-20250101", "claude-sonnet-4-5-20250929"];
		expect(pickLatest(["claude-sonnet-4-5"], catalog, catalog)).toEqual({
			enabled: ["claude-sonnet-4-5-20250929"],
			replacements: [{ from: "claude-sonnet-4-5", to: "claude-sonnet-4-5-20250929" }],
		});
	});

	it("目录里还在的同版本多个 id 都保留", () => {
		const catalog = ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"];
		expect(pickLatest(["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"], catalog, catalog).replacements).toEqual([]);
	});

	it("拆开写的日期归一后再比较，不会把新版当成旧版", () => {
		const catalog = ["m-v1-20231201", "m-v1-2024-08-06"];
		expect(pickLatest(["m-v1-20231201"], catalog, catalog).enabled).toEqual(["m-v1-2024-08-06"]);
		expect(pickLatest(["m-v1-2024-08-06"], catalog, catalog).replacements).toEqual([]);
	});

	it("要启用新 id 时，有带日期的选日期最新的，否则选不带日期的", () => {
		const both = ["claude-sonnet-4-5", "claude-sonnet-4-5-20250101", "claude-sonnet-4-5-20250929"];
		expect(pickLatest(["claude-sonnet-4"], both, both).enabled).toEqual(["claude-sonnet-4-5-20250929"]);
		expect(pickLatest(["claude-sonnet-4"], ["claude-sonnet-4-5"], ["claude-sonnet-4-5"]).enabled).toEqual(["claude-sonnet-4-5"]);
	});

	it("旧 id 从目录消失，同版本候选里既有带日期的也有不带日期的时，选日期最新的", () => {
		const catalog = ["claude-sonnet-4.5", "claude-sonnet-4-5-20250101", "claude-sonnet-4-5-20250929"];
		expect(pickLatest(["claude-sonnet-4-5"], catalog, catalog)).toEqual({
			enabled: ["claude-sonnet-4-5-20250929"],
			replacements: [{ from: "claude-sonnet-4-5", to: "claude-sonnet-4-5-20250929" }],
		});
	});

	it("deepseek-v3 的日期版本按日期比较，和不带日期的 deepseek-v3 算同一版本", () => {
		const catalog = ["deepseek-v3-0324", "deepseek-v3-1120"];
		expect(pickLatest(["deepseek-v3-0324"], catalog, catalog).enabled).toEqual(["deepseek-v3-1120"]);
		expect(pickLatest(["deepseek-v3"], [...catalog, "deepseek-v3"], [...catalog, "deepseek-v3"]).replacements).toEqual([]);
	});
});
