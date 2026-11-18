/**
 * "每系最新"：从模型 id 里认出系列和版本，在每个已启用的系列里只保留目录中的最新版。
 * 规则见 docs/architecture.md 的「每系最新」一节。
 */

export interface FamilyMember {
	/** 系列名：最后一个 `/` 之前的前缀，加上去掉版本段和日期段后的名字。 */
	family: string;
	/** 版本号的各段数字，`6.2` 是 [6, 2]，`5-5` 也是 [5, 5]。 */
	version: number[];
	/** 名字里的 8 位日期，如 20250929。版本相同时才比较。 */
	date?: number;
}

export interface Replacement {
	from: string;
	to: string;
}

export interface LatestResult {
	/** 调整后的启用列表。新版放在被替换的旧版原来的位置。 */
	enabled: string[];
	/** 被停用的旧版和替换它的新版。为空表示没有变化。 */
	replacements: Replacement[];
}

/** 版本段：数字，段内可以有 `.`，可以以 `v` 开头。以 0 开头的多位数（如 `0324`、`05`）通常是日期，不算版本。 */
const VERSION_SEGMENT = /^v?(?:0|[1-9]\d*)(?:\.\d+)*$/i;
const DATE_SEGMENT = /^\d{8}$/;

/**
 * 认出模型所属的系列。名字按 `-` 拆分，第一串连续的版本段是版本，其余部分（不含 8 位日期段）是系列名。
 * 名字里没有版本段，或者只有版本段时，返回 undefined，这类模型不属于任何系列。
 */
export function familyOf(id: string): FamilyMember | undefined {
	const slash = id.lastIndexOf("/");
	const prefix = id.slice(0, slash + 1);
	let date: number | undefined;
	const parts: string[] = [];
	for (const part of id.slice(slash + 1).split("-")) {
		if (DATE_SEGMENT.test(part)) date = Number(part);
		else parts.push(part);
	}
	const version: number[] = [];
	const rest: string[] = [];
	// 只取第一串连续的版本段，后面再出现的数字段留在系列名里。
	let state: "before" | "in" | "after" = "before";
	for (const part of parts) {
		if (state !== "after" && VERSION_SEGMENT.test(part)) {
			version.push(...part.replace(/^v/i, "").split(".").map(Number));
			state = "in";
		} else {
			if (state === "in") state = "after";
			rest.push(part);
		}
	}
	if (version.length === 0 || rest.length === 0) return undefined;
	return { family: prefix + rest.join("-"), version, date };
}

/** 按数字逐段比较版本，缺的段按 0 算；版本相同且两边都有日期时比较日期。 */
export function compareMembers(a: Pick<FamilyMember, "version" | "date">, b: Pick<FamilyMember, "version" | "date">): number {
	const length = Math.max(a.version.length, b.version.length);
	for (let index = 0; index < length; index++) {
		const diff = (a.version[index] ?? 0) - (b.version[index] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	if (a.date !== undefined && b.date !== undefined) return Math.sign(a.date - b.date);
	return 0;
}

interface Entry {
	id: string;
	member: FamilyMember;
}

function groupByFamily(ids: readonly string[]): Map<string, Entry[]> {
	const groups = new Map<string, Entry[]>();
	for (const id of new Set(ids)) {
		const member = familyOf(id);
		if (!member) continue;
		const group = groups.get(member.family) ?? [];
		group.push({ id, member });
		groups.set(member.family, group);
	}
	return groups;
}

/**
 * 系列里的最新版。版本最高的成员里，带日期的只留日期最新的，不带日期的都算最新（通常是指向最新版的别名）。
 * 返回最新的成员，按原来的顺序；以及用来比较的代表版本。
 */
function newest(entries: Entry[]): { top: Entry[]; best: Pick<FamilyMember, "version" | "date"> } {
	let version = entries[0].member.version;
	for (const entry of entries) {
		if (compareMembers({ version: entry.member.version }, { version }) > 0) version = entry.member.version;
	}
	const tied = entries.filter((entry) => compareMembers({ version: entry.member.version }, { version }) === 0);
	const dates = tied.map((entry) => entry.member.date).filter((date): date is number => date !== undefined);
	const date = dates.length ? Math.max(...dates) : undefined;
	return { top: tied.filter((entry) => entry.member.date === undefined || entry.member.date === date), best: { version, date } };
}

/**
 * 在每个已有启用成员的系列里，启用候选模型中的最新版，停用比它旧的已启用成员（包括目录里已经没有的 id）。
 * - 候选模型里没有这个系列的成员时不动。
 * - 已启用的成员里有不比最新版旧的（例如目录里隐藏了的同版本或更新的模型）、且最新版都没启用时不动，免得降级。
 * - 不属于任何系列的模型不动。
 */
export function pickLatest(enabled: readonly string[], candidates: readonly string[]): LatestResult {
	const candidateFamilies = groupByFamily(candidates);
	const remove = new Map<string, string>();
	for (const [family, current] of groupByFamily(enabled)) {
		const members = candidateFamilies.get(family);
		if (!members) continue;
		const { top, best } = newest(members);
		const kept = current.filter((entry) => top.some((item) => item.id === entry.id));
		let target: string;
		if (kept.length) target = kept[0].id;
		else if (current.some((entry) => compareMembers(entry.member, best) >= 0)) continue;
		else target = top[0].id;
		for (const entry of current) {
			if (!kept.includes(entry) && compareMembers(entry.member, best) < 0) remove.set(entry.id, target);
		}
	}
	if (remove.size === 0) return { enabled: [...enabled], replacements: [] };
	const next: string[] = [];
	for (const id of enabled) {
		const to = remove.get(id);
		// 新版已经启用时，它留在自己的位置，旧版直接去掉。
		if (to !== undefined && enabled.includes(to)) continue;
		const value = to ?? id;
		if (!next.includes(value)) next.push(value);
	}
	return { enabled: next, replacements: [...remove].map(([from, to]) => ({ from, to })) };
}
