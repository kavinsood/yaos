import type {
	ThreeWayConflict,
	ThreeWayEdit,
	ThreeWayMergeLimits,
	ThreeWayMergeResult,
} from "./threeWayMerge";

/**
 * Line-based diff3 for closed-file reconcile (write-budget spike, D4).
 *
 * base = last-synced text (local CRDT common base), disk = what is on disk
 * ("ours"), body = what the server/CRDT holds ("theirs").
 *
 * The result reuses ThreeWayMergeResult so ThreeWayConflictModal and
 * resolveThreeWayText keep working unchanged. Every offset is a character
 * offset into `base` that lies on a line boundary.
 *
 * Rules:
 * - A line is the text up to and including "\n". "\r\n" endings are kept
 *   byte-exact (the "\r" is part of the line). A final line without a
 *   terminator is a different line from the same text with one, so a change
 *   to the trailing newline is a change to the last line.
 * - Two hunks conflict when their base ranges properly overlap, when both are
 *   insertions at the same line, or when an insertion lands strictly inside
 *   the other side's replaced range. Hunks that only touch (edits to adjacent
 *   lines) merge cleanly; an insertion at the edge of the other side's
 *   replaced range is kept next to it. Identical hunks on both sides are
 *   applied once. Exception: two hunks that both reach the end of the file
 *   always conflict (a dropped final newline plus an appended line would
 *   otherwise glue two lines together).
 * - Transitively overlapping hunks form one conflict region. A region whose
 *   two local results are equal is not a conflict.
 * - Pure insertions and pure deletions slide to their rightmost equivalent
 *   line so equal edits made on both sides compare equal.
 * - The line diff is Myers O(ND) on interned line ids after trimming the
 *   common prefix and suffix. When the edit distance or work exceeds a fixed
 *   budget the whole middle becomes one replace hunk: still exact, only
 *   coarser (it can turn a clean merge into a conflict copy, never into lost
 *   text).
 */

const DEFAULT_LIMITS: ThreeWayMergeLimits = {
	maxInputCharacters: 2 * 1024 * 1024,
	maxEditsPerSide: 10_000,
};

/** Max Myers edit distance (in lines) before the middle is coarsened. */
export const MAX_LINE_DIFF_DISTANCE = 2_000;
/** Max snake steps (approximate work units) before the middle is coarsened. */
export const MAX_LINE_DIFF_WORK = 20_000_000;

interface LineText {
	/** Interned line ids. */
	ids: Int32Array;
	/** offsets[i] = char offset of line i; offsets[ids.length] = text.length. */
	offsets: Int32Array;
}

/** A hunk in line coordinates: base lines [start, end) become `lines`. */
interface LineHunk {
	start: number;
	end: number;
	lines: number[];
	/** Leftmost equivalent start line for a pure insertion/deletion (else = start). */
	flexStart?: number;
}

interface SideEdit {
	start: number;
	end: number;
	replacement: string;
	/** Char offset of the leftmost equivalent position (pure insert/delete only). */
	flexStart?: number;
}

export function splitLines(text: string): string[] {
	const lines: string[] = [];
	let from = 0;
	while (from < text.length) {
		const newline = text.indexOf("\n", from);
		if (newline < 0) {
			lines.push(text.slice(from));
			break;
		}
		lines.push(text.slice(from, newline + 1));
		from = newline + 1;
	}
	return lines;
}

class LineInterner {
	private readonly ids = new Map<string, number>();
	readonly texts: string[] = [];
	tokenize(text: string): LineText {
		const lines = splitLines(text);
		const ids = new Int32Array(lines.length);
		const offsets = new Int32Array(lines.length + 1);
		let offset = 0;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			let id = this.ids.get(line);
			if (id === undefined) {
				id = this.texts.length;
				this.ids.set(line, id);
				this.texts.push(line);
			}
			ids[index] = id;
			offsets[index] = offset;
			offset += line.length;
		}
		offsets[lines.length] = offset;
		return { ids, offsets };
	}
}

/**
 * Myers greedy O(ND) diff of a[aStart, aEnd) against b[bStart, bEnd).
 * Returns hunks in a-coordinates, or null if the budget is exceeded.
 */
function myers(
	a: Int32Array, aStart: number, aEnd: number,
	b: Int32Array, bStart: number, bEnd: number,
): LineHunk[] | null {
	const n = aEnd - aStart;
	const m = bEnd - bStart;
	const max = Math.min(n + m, MAX_LINE_DIFF_DISTANCE);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	v[offset + 1] = 0;
	const trace: Int32Array[] = [];
	let work = 0;
	let found = -1;
	for (let d = 0; d <= max; d++) {
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
				? v[offset + k + 1]!
				: v[offset + k - 1]! + 1;
			let y = x - k;
			const snakeStart = x;
			while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
				x++;
				y++;
			}
			work += 1 + x - snakeStart;
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		trace.push(v.slice(offset - d, offset + d + 1));
		if (found >= 0) break;
		if (work > MAX_LINE_DIFF_WORK) return null;
	}
	if (found < 0) return null;

	// Backtrack: collect single-line operations from the end.
	const operations: Array<{ kind: "insert" | "delete"; aIndex: number; bIndex: number }> = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const previous = trace[d - 1]!;
		const at = (k: number) => previous[k + d - 1]!;
		const k = x - y;
		const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const previousX = at(previousK);
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			x--;
			y--;
		}
		if (x === previousX) operations.push({ kind: "insert", aIndex: previousX, bIndex: previousY });
		else operations.push({ kind: "delete", aIndex: previousX, bIndex: previousY });
		x = previousX;
		y = previousY;
	}
	operations.reverse();

	const hunks: LineHunk[] = [];
	let current: LineHunk | null = null;
	let currentEndB = -1;
	for (const operation of operations) {
		const baseIndex = aStart + operation.aIndex;
		const bIndex = bStart + operation.bIndex;
		const contiguous = current !== null && current.end === baseIndex && currentEndB === bIndex;
		if (!contiguous) {
			current = { start: baseIndex, end: baseIndex, lines: [] };
			hunks.push(current);
			currentEndB = bIndex;
		}
		if (operation.kind === "delete") {
			current!.end++;
		} else {
			current!.lines.push(b[bIndex]!);
			currentEndB++;
		}
	}
	return hunks;
}

function lineHunks(base: Int32Array, changed: Int32Array): LineHunk[] {
	let prefix = 0;
	const limit = Math.min(base.length, changed.length);
	while (prefix < limit && base[prefix] === changed[prefix]) prefix++;
	let suffix = 0;
	while (suffix < limit - prefix
		&& base[base.length - 1 - suffix] === changed[changed.length - 1 - suffix]) suffix++;
	const aEnd = base.length - suffix;
	const bEnd = changed.length - suffix;
	if (prefix === aEnd && prefix === bEnd) return [];
	if (prefix === aEnd || prefix === bEnd) {
		return [{ start: prefix, end: aEnd, lines: Array.from(changed.subarray(prefix, bEnd)) }];
	}
	const exact = myers(base, prefix, aEnd, changed, prefix, bEnd);
	if (exact) return exact;
	return [{ start: prefix, end: aEnd, lines: Array.from(changed.subarray(prefix, bEnd)) }];
}

/**
 * Slide pure insertions and pure deletions to their rightmost equivalent
 * position (never touching the next hunk), so the same edit made on both
 * sides lands on the same lines.
 */
function slideRight(base: Int32Array, hunks: LineHunk[]): LineHunk[] {
	for (let index = 0; index < hunks.length; index++) {
		const hunk = hunks[index]!;
		const next = hunks[index + 1];
		const previous = index > 0 ? hunks[index - 1]! : undefined;
		// Keep at least one unchanged line between hunks so they never merge.
		const limit = next === undefined ? base.length : next.start - 1;
		const lowerLimit = previous === undefined ? 0 : previous.end + 1;
		if (hunk.start === hunk.end && hunk.lines.length > 0) {
			let { start } = hunk;
			const lines = hunk.lines.slice();
			while (start < limit && base[start] === lines[0]) {
				lines.push(lines.shift()!);
				start++;
			}
			// How far left could the same insertion have been placed?
			let flexStart = start;
			const probe = lines.slice();
			while (flexStart > lowerLimit && base[flexStart - 1] === probe[probe.length - 1]) {
				probe.unshift(probe.pop()!);
				flexStart--;
			}
			hunks[index] = { start, end: start, lines, flexStart };
		} else if (hunk.lines.length === 0 && hunk.end > hunk.start) {
			let { start, end } = hunk;
			while (end < limit && base[start] === base[end]) {
				start++;
				end++;
			}
			let flexStart = start;
			let flexEnd = end;
			while (flexStart > lowerLimit && base[flexStart - 1] === base[flexEnd - 1]) {
				flexStart--;
				flexEnd--;
			}
			hunks[index] = { start, end, lines: [], flexStart };
		}
	}
	return hunks;
}

function toSideEdits(base: LineText, hunks: readonly LineHunk[], texts: readonly string[]): SideEdit[] {
	return hunks.map((hunk) => ({
		start: base.offsets[hunk.start]!,
		end: base.offsets[hunk.end]!,
		replacement: hunk.lines.map((id) => texts[id]!).join(""),
		...(hunk.flexStart !== undefined && hunk.flexStart < hunk.start
			? { flexStart: base.offsets[hunk.flexStart]! } : {}),
	}));
}

/**
 * Overlap test. A pure insertion or deletion of repeated lines has a range of
 * equivalent positions [flexStart, start]; the two sides' diffs may have
 * picked different ones, so the whole range counts. That turns an ambiguous
 * "both deleted one of two equal lines" into a conflict instead of deleting
 * both.
 */
function editsOverlap(left: SideEdit, right: SideEdit, baseLength: number): boolean {
	// Both sides changing the end of the file conflict even when they only
	// touch: one side may have dropped the final newline while the other
	// appended a line, and gluing them would merge two lines into one.
	if (left.end === baseLength && right.end === baseLength) return true;
	const leftLow = left.flexStart ?? left.start;
	const rightLow = right.flexStart ?? right.start;
	const leftInsert = left.start === left.end;
	const rightInsert = right.start === right.end;
	if (leftInsert && rightInsert) return leftLow <= right.start && rightLow <= left.start;
	if (leftInsert) return left.start > rightLow && leftLow < right.end;
	if (rightInsert) return right.start > leftLow && rightLow < left.end;
	return leftLow < right.end && rightLow < left.end;
}

function publicEdit(edit: SideEdit, source: "disk" | "body"): ThreeWayEdit {
	return { start: edit.start, end: edit.end, replacement: edit.replacement, source };
}

function sameEdit(left: SideEdit, right: SideEdit): boolean {
	return left.start === right.start && left.end === right.end && left.replacement === right.replacement;
}

function applyEdits(base: string, edits: readonly SideEdit[]): string {
	// Apply right to left. For equal starts, apply the wider edit first so an
	// insertion at the start of a replaced range ends up before it.
	const sorted = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
	const parts: string[] = [];
	let cursor = base.length;
	for (const edit of sorted) {
		parts.push(base.slice(edit.end, cursor));
		parts.push(edit.replacement);
		cursor = edit.start;
	}
	parts.push(base.slice(0, cursor));
	return parts.reverse().join("");
}

class Components {
	private readonly parents: number[];
	constructor(size: number) { this.parents = Array.from({ length: size }, (_, index) => index); }
	find(value: number): number {
		let root = value;
		while (this.parents[root] !== root) root = this.parents[root]!;
		while (this.parents[value] !== value) {
			const next = this.parents[value]!;
			this.parents[value] = root;
			value = next;
		}
		return root;
	}
	join(left: number, right: number): void {
		const leftRoot = this.find(left);
		const rightRoot = this.find(right);
		if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot;
	}
}

function localAlternative(base: string, start: number, end: number, edits: readonly SideEdit[]): string {
	return applyEdits(base.slice(start, end), edits.map((edit) => ({
		start: edit.start - start,
		end: edit.end - start,
		replacement: edit.replacement,
	})));
}

/** Line diff of `base` -> `changed` as character-offset edits on line boundaries. */
export function lineEditsFromBase(base: string, changed: string): ThreeWayEdit[] {
	const interner = new LineInterner();
	const baseLines = interner.tokenize(base);
	const changedLines = interner.tokenize(changed);
	return toSideEdits(baseLines, slideRight(baseLines.ids, lineHunks(baseLines.ids, changedLines.ids)), interner.texts)
		.map((edit) => publicEdit(edit, "disk"));
}

/** Line-based diff3. See the module comment for the exact rules. */
export function mergeThreeWayLines(
	base: string,
	disk: string,
	body: string,
	limits: ThreeWayMergeLimits = DEFAULT_LIMITS,
): ThreeWayMergeResult {
	if (Math.max(base.length, disk.length, body.length) > limits.maxInputCharacters) {
		return { kind: "too-large", outcome: "too-large", reason: "input" };
	}
	if (disk === body) return { kind: "clean", outcome: "identical", content: disk, edits: [] };

	const interner = new LineInterner();
	const baseLines = interner.tokenize(base);
	const diskLines = interner.tokenize(disk);
	const bodyLines = interner.tokenize(body);
	const diskEdits = toSideEdits(baseLines, slideRight(baseLines.ids, lineHunks(baseLines.ids, diskLines.ids)), interner.texts);
	const bodyEdits = toSideEdits(baseLines, slideRight(baseLines.ids, lineHunks(baseLines.ids, bodyLines.ids)), interner.texts);

	if (disk === base) {
		return { kind: "clean", outcome: "body-only", content: body,
			edits: bodyEdits.map((edit) => publicEdit(edit, "body")) };
	}
	if (body === base) {
		return { kind: "clean", outcome: "disk-only", content: disk,
			edits: diskEdits.map((edit) => publicEdit(edit, "disk")) };
	}
	if (diskEdits.length > limits.maxEditsPerSide || bodyEdits.length > limits.maxEditsPerSide) {
		return { kind: "too-large", outcome: "too-large", reason: "edit-count" };
	}

	const components = new Components(diskEdits.length + bodyEdits.length);
	const overlappingDisk = new Set<number>();
	const overlappingBody = new Set<number>();
	let firstPossibleBody = 0;
	for (let diskIndex = 0; diskIndex < diskEdits.length; diskIndex++) {
		const diskEdit = diskEdits[diskIndex]!;
		while (firstPossibleBody < bodyEdits.length
			&& bodyEdits[firstPossibleBody]!.end < (diskEdit.flexStart ?? diskEdit.start)) firstPossibleBody++;
		for (let bodyIndex = firstPossibleBody; bodyIndex < bodyEdits.length; bodyIndex++) {
			const bodyEdit = bodyEdits[bodyIndex]!;
			if ((bodyEdit.flexStart ?? bodyEdit.start) > diskEdit.end) break;
			// Identical edits join a region too: if nothing else overlaps them the
			// region resolves cleanly (both sides agree); if another edit overlaps
			// one of them, the shared edit must sit inside that conflict region.
			if (!sameEdit(diskEdit, bodyEdit) && !editsOverlap(diskEdit, bodyEdit, base.length)) continue;
			overlappingDisk.add(diskIndex);
			overlappingBody.add(bodyIndex);
			components.join(diskIndex, diskEdits.length + bodyIndex);
		}
	}

	const groups = new Map<number, { disk: number[]; body: number[] }>();
	for (const index of overlappingDisk) {
		const root = components.find(index);
		const group = groups.get(root) ?? { disk: [], body: [] };
		group.disk.push(index);
		groups.set(root, group);
	}
	for (const index of overlappingBody) {
		const root = components.find(diskEdits.length + index);
		const group = groups.get(root) ?? { disk: [], body: [] };
		group.body.push(index);
		groups.set(root, group);
	}

	// A region whose two sides produce the same text is a clean (shared) change.
	const conflictingDisk = new Set<number>();
	const conflictingBody = new Set<number>();
	const resolvedRegions: SideEdit[] = [];
	const conflicts: ThreeWayConflict[] = [];
	for (const group of groups.values()) {
		const disks = group.disk.map((index) => diskEdits[index]!);
		const bodies = group.body.map((index) => bodyEdits[index]!);
		const all = [...disks, ...bodies];
		const baseStart = Math.min(...all.map((edit) => edit.start));
		const baseEnd = Math.max(...all.map((edit) => edit.end));
		const diskText = localAlternative(base, baseStart, baseEnd, disks);
		const bodyText = localAlternative(base, baseStart, baseEnd, bodies);
		for (const index of group.disk) conflictingDisk.add(index);
		for (const index of group.body) conflictingBody.add(index);
		if (diskText === bodyText) {
			resolvedRegions.push({ start: baseStart, end: baseEnd, replacement: diskText });
			continue;
		}
		conflicts.push({ baseStart, baseEnd, base: base.slice(baseStart, baseEnd), disk: diskText, body: bodyText });
	}
	conflicts.sort((left, right) => left.baseStart - right.baseStart);

	const cleanEdits: ThreeWayEdit[] = [
		...diskEdits.flatMap((edit, index) => conflictingDisk.has(index)
			? [] : [publicEdit(edit, "disk")]),
		...bodyEdits.flatMap((edit, index) => conflictingBody.has(index)
			? [] : [publicEdit(edit, "body")]),
		...resolvedRegions.map((edit) => publicEdit(edit, "disk")),
	];
	if (conflicts.length === 0) {
		return { kind: "clean", outcome: "clean-merged", content: applyEdits(base, cleanEdits), edits: cleanEdits };
	}
	return { kind: "conflict", outcome: "conflict", base, cleanEdits, conflicts };
}
