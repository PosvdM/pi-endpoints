/**
 * "每系最新"：从模型 id 里认出系列和版本，在每个已启用的系列里只保留目录中的最新版。
 * 规则见 docs/architecture.md 的「每系最新」一节。
 */

export interface FamilyMember {
	/** 系列名：最后一个 `/` 之前的前缀，加上去掉版本段和日期段后的名字。 */
	family: string;
	/** 版本号各段的十进制数字串，`6.2` 是 ["6", "2"]，`5-5` 也是 ["5", "5"]。 */
	version: string[];
	/** 日期各段的十进制数字串，如 ["20250929"]、["2024", "08", "06"]；没有日期时为空数组。版本相同时才比较。 */
	date: string[];
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

/** 版本段：不超过 3 位的数字，或者含 `.` 的数字，可以以 `v` 开头。 */
const VERSION_SEGMENT = /^v?(?:\d{1,3}|\d+(?:\.\d+)+)$/i;
/** 日期段：4 位及以上的纯数字，如 `20250929`、`0324`、`2024`。 */
const DATE_SEGMENT = /^\d{4,}$/;
/** 紧跟在日期段后面的 1 到 2 位数字（`2024-08-06` 里的 `08`、`06`）也算日期。 */
const DATE_PART = /^\d{1,2}$/;

/**
 * 认出模型所属的系列。名字按 `-` 拆分，日期段单独记下；剩下的段里，第一串连续的版本段是版本，其余部分是系列名。
 * 名字里没有版本段，或者只有版本段时，返回 undefined，这类模型不属于任何系列。
 */
export function familyOf(id: string): FamilyMember | undefined {
	const slash = id.lastIndexOf("/");
	const prefix = id.slice(0, slash + 1);
	const date: string[] = [];
	const parts: string[] = [];
	let afterDate = false;
	for (const part of id.slice(slash + 1).split("-")) {
		if (DATE_SEGMENT.test(part) || (afterDate && DATE_PART.test(part))) {
			date.push(part);
			afterDate = true;
		} else {
			parts.push(part);
			afterDate = false;
		}
	}
	const version: string[] = [];
	const rest: string[] = [];
	// 只取第一串连续的版本段，后面再出现的数字段留在系列名里。
	let state: "before" | "in" | "after" = "before";
	for (const part of parts) {
		if (state !== "after" && VERSION_SEGMENT.test(part)) {
			version.push(...part.replace(/^v/i, "").split("."));
			state = "in";
		} else {
			if (state === "in") state = "after";
			rest.push(part);
		}
	}
	if (version.length === 0 || rest.length === 0) return undefined;
	return { family: prefix + rest.join("-"), version, date };
}

/** 比较两个十进制数字串，不转成数字，避免很长的数字溢出。 */
function compareDigits(a: string, b: string): number {
	const x = a.replace(/^0+(?=\d)/, "");
	const y = b.replace(/^0+(?=\d)/, "");
	if (x.length !== y.length) return Math.sign(x.length - y.length);
	return x < y ? -1 : x > y ? 1 : 0;
}

/** 逐段比较，缺的段按 0 算。 */
function compareSegments(a: readonly string[], b: readonly string[]): number {
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const diff = compareDigits(a[index] ?? "0", b[index] ?? "0");
		if (diff !== 0) return diff;
	}
	return 0;
}

/** 按数字逐段比较版本；版本相同且两边都有日期时比较日期，只有一边有日期时算作相同。 */
export function compareMembers(a: Pick<FamilyMember, "version" | "date">, b: Pick<FamilyMember, "version" | "date">): number {
	const byVersion = compareSegments(a.version, b.version);
	if (byVersion !== 0) return byVersion;
	if (a.date.length && b.date.length) return compareSegments(a.date, b.date);
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
		if (compareSegments(entry.member.version, version) > 0) version = entry.member.version;
	}
	const tied = entries.filter((entry) => compareSegments(entry.member.version, version) === 0);
	let date: string[] = [];
	for (const entry of tied) {
		if (entry.member.date.length && (!date.length || compareSegments(entry.member.date, date) > 0)) date = entry.member.date;
	}
	const top = tied.filter((entry) => !entry.member.date.length || compareSegments(entry.member.date, date) === 0);
	return { top, best: { version, date } };
}

/**
 * 在每个已有启用成员的系列里，启用候选模型中的最新版，停用被它取代的已启用成员。
 * - `candidates`：可以被选为新版的模型（目录里没有隐藏的对话模型）。
 * - `catalog`：目录里的全部模型 id，用来判断已启用的 id 是否已经从目录里消失。
 *
 * 被取代的成员：比最新版旧的，以及和最新版同版本、但已经不在目录里的（如别名 `claude-sonnet-4-5` 消失、
 * 只剩 `claude-sonnet-4-5-20250929`）。目录里还在的同版本多个 id 都保留。
 * 已启用的成员里有不能被取代、又不是最新版的（比最新版还新，或者同版本但在目录里被隐藏），而最新版都没启用时，
 * 整个系列不动，免得降级。候选里没有这个系列的成员、以及不属于任何系列的模型都不动。
 */
export function pickLatest(enabled: readonly string[], candidates: readonly string[], catalog: readonly string[]): LatestResult {
	const candidateFamilies = groupByFamily(candidates);
	const inCatalog = new Set(catalog);
	const remove = new Map<string, string>();
	for (const [family, current] of groupByFamily(enabled)) {
		const members = candidateFamilies.get(family);
		if (!members) continue;
		const { top, best } = newest(members);
		const kept = current.filter((entry) => top.some((item) => item.id === entry.id));
		const superseded = current.filter((entry) => {
			if (kept.includes(entry)) return false;
			const order = compareMembers(entry.member, best);
			return order < 0 || (order === 0 && !inCatalog.has(entry.id));
		});
		if (superseded.length === 0) continue;
		let target: string;
		if (kept.length) target = kept[0].id;
		else if (superseded.length < current.length) continue;
		else target = top[0].id;
		for (const entry of superseded) remove.set(entry.id, target);
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
