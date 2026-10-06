const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const DEFAULT_STEP = 1024;

function compareRank(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function encodeInteger(value: number): string {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid rank integer");
	let remaining = value;
	let encoded = "";
	do {
		encoded = DIGITS[remaining % BASE]! + encoded;
		remaining = Math.floor(remaining / BASE);
	} while (remaining > 0);
	return encoded.padStart(8, "0");
}

function decodeInteger(rank: string): number | null {
	let value = 0;
	for (const character of rank) {
		const digit = DIGITS.indexOf(character);
		if (digit < 0) return null;
		value = value * BASE + digit;
		if (!Number.isSafeInteger(value)) return null;
	}
	return value;
}

export function initialCanvasRanks(ids: readonly string[]): Map<string, string> {
	return new Map(ids.map((id, index) => [id, encodeInteger((index + 1) * DEFAULT_STEP)]));
}

export function rankBetween(before: string | null, after: string | null): string | null {
	const low = before === null ? 0 : decodeInteger(before);
	const high = after === null ? null : decodeInteger(after);
	if (low === null || (after !== null && high === null)) return null;
	if (high === null) {
		if (low > Number.MAX_SAFE_INTEGER - DEFAULT_STEP) return null;
		return encodeInteger(low + DEFAULT_STEP);
	}
	if (low >= high - 1) return null;
	return encodeInteger(low + Math.floor((high - low) / 2));
}

function longestIncreasingSubsequence(values: readonly number[]): Set<number> {
	if (values.length === 0) return new Set();
	const tails: number[] = [];
	const tailIndices: number[] = [];
	const predecessors = new Array<number>(values.length).fill(-1);
	for (let index = 0; index < values.length; index++) {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (tails[middle]! < values[index]!) low = middle + 1;
			else high = middle;
		}
		if (low > 0) predecessors[index] = tailIndices[low - 1]!;
		tails[low] = values[index]!;
		tailIndices[low] = index;
	}
	const selected = new Set<number>();
	let cursor = tailIndices[tails.length - 1]!;
	while (cursor >= 0) {
		selected.add(cursor);
		cursor = predecessors[cursor]!;
	}
	return selected;
}

export interface ReconcileRanksResult { ranks: Map<string, string>; rebalanced: boolean }
export interface CanvasRankMap {
	get(id: string): string | undefined;
	entries(): Iterable<[string, string]>;
}

export function reconcileCanvasRanks(
	desiredIds: readonly string[],
	existing: CanvasRankMap,
): ReconcileRanksResult {
	const current = [...existing.entries()]
		.filter(([id]) => desiredIds.includes(id))
		.sort((left, right) => compareRank(left[1], right[1]) || compareRank(left[0], right[0]));
	const currentIndex = new Map(current.map(([id], index) => [id, index]));
	const comparable = desiredIds.map((id, desiredIndex) => ({ desiredIndex, oldIndex: currentIndex.get(id) }))
		.filter((entry): entry is { desiredIndex: number; oldIndex: number } => entry.oldIndex !== undefined);
	const retainedComparable = longestIncreasingSubsequence(comparable.map((entry) => entry.oldIndex));
	const retainedDesired = new Set([...retainedComparable].map((index) => comparable[index]!.desiredIndex));
	const ranks = new Map<string, string>();
	for (let index = 0; index < desiredIds.length; index++) {
		const id = desiredIds[index]!;
		if (retainedDesired.has(index)) ranks.set(id, existing.get(id)!);
	}
	for (let index = 0; index < desiredIds.length; index++) {
		const id = desiredIds[index]!;
		if (ranks.has(id)) continue;
		let before: string | null = null;
		for (let scan = index - 1; scan >= 0; scan--) {
			const candidate = ranks.get(desiredIds[scan]!);
			if (candidate !== undefined) { before = candidate; break; }
		}
		let after: string | null = null;
		for (let scan = index + 1; scan < desiredIds.length; scan++) {
			const candidate = ranks.get(desiredIds[scan]!);
			if (candidate !== undefined) { after = candidate; break; }
		}
		const allocated = rankBetween(before, after);
		if (allocated === null) return { ranks: initialCanvasRanks(desiredIds), rebalanced: true };
		ranks.set(id, allocated);
	}
	return { ranks, rebalanced: false };
}

export function orderedCanvasIds(ranks: Pick<CanvasRankMap, "get">, liveIds: Iterable<string>): string[] {
	return [...liveIds].sort((left, right) => {
		const leftRank = ranks.get(left) ?? "";
		const rightRank = ranks.get(right) ?? "";
		return compareRank(leftRank, rightRank) || compareRank(left, right);
	});
}
