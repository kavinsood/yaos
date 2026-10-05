/**
 * Line-based diff3 (ported from legacy-src/sync/lineMerge.ts; the policy
 * wrappers and ThreeWayConflict regions are dropped).
 *
 * base = merge base, disk = the file, crdt = the replica text.
 *
 * Rules (unchanged from legacy):
 * - A line is the text up to and including "\n". A final line without a
 *   terminator is a different line from the same text with one.
 * - Two hunks conflict when their base ranges properly overlap, when both are
 *   insertions at the same line, or when an insertion lands strictly inside
 *   the other side's replaced range. Touching hunks merge cleanly. Identical
 *   hunks on both sides are applied once. Two hunks that both reach the end
 *   of the file always conflict.
 * - Transitively overlapping hunks form one region; a region whose two local
 *   results are equal is not a conflict.
 * - Pure insertions/deletions slide to their rightmost equivalent line; the
 *   equivalent range [flexStart, start] counts for overlap.
 * - Over the Myers budget the middle becomes one coarse hunk: still exact,
 *   only coarser (a clean merge may become a conflict, never lost text).
 *
 * Conflict output: `text` = base with every non-conflicting edit of both
 * sides applied and every conflict region taking the crdt alternative, i.e.
 * "crdt + the disk hunks that do not overlap" (DESIGN §f.3).
 */

import { LINE_BUDGET, LineInterner, diffTokens, type LineText, type MyersBudget } from "./myers";

interface LineHunk {
	start: number;
	end: number;
	lines: number[];
	flexStart?: number;
}

interface SideEdit {
	readonly start: number;
	readonly end: number;
	readonly replacement: string;
	readonly flexStart?: number;
}

export type Diff3Result =
	| { readonly kind: "clean"; readonly text: string }
	| { readonly kind: "conflict"; readonly text: string; readonly regions: number }
	| { readonly kind: "too-large" };

function lineHunks(base: Int32Array, changed: Int32Array, budget: MyersBudget): LineHunk[] {
	return diffTokens(base, changed, budget).hunks.map((h) => ({
		start: h.aStart,
		end: h.aEnd,
		lines: Array.from(changed.subarray(h.bStart, h.bEnd)),
	}));
}

function slideRight(base: Int32Array, hunks: LineHunk[]): LineHunk[] {
	for (let index = 0; index < hunks.length; index++) {
		const hunk = hunks[index]!;
		const next = hunks[index + 1];
		const previous = index > 0 ? hunks[index - 1]! : undefined;
		const limit = next === undefined ? base.length : next.start - 1;
		const lowerLimit = previous === undefined ? 0 : previous.end + 1;
		if (hunk.start === hunk.end && hunk.lines.length > 0) {
			let { start } = hunk;
			const lines = hunk.lines.slice();
			while (start < limit && base[start] === lines[0]) {
				lines.push(lines.shift()!);
				start++;
			}
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

function editsOverlap(left: SideEdit, right: SideEdit, baseLength: number): boolean {
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

function sameEdit(left: SideEdit, right: SideEdit): boolean {
	return left.start === right.start && left.end === right.end && left.replacement === right.replacement;
}

/** Apply non-overlapping edits right to left; on equal starts the wider edit first (insertions land before it). */
export function applyLineEdits(base: string, edits: readonly { start: number; end: number; replacement: string }[]): string {
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
	return applyLineEdits(base.slice(start, end), edits.map((edit) => ({
		start: edit.start - start,
		end: edit.end - start,
		replacement: edit.replacement,
	})));
}

/** Line diff3. Caller handles identical / one-sided / size checks (merge.ts). */
export function diff3(base: string, disk: string, crdt: string, maxEditsPerSide: number, budget: MyersBudget = LINE_BUDGET): Diff3Result {
	const interner = new LineInterner();
	const baseLines = interner.tokenize(base);
	const diskLines = interner.tokenize(disk);
	const crdtLines = interner.tokenize(crdt);
	const diskHunks = slideRight(baseLines.ids, lineHunks(baseLines.ids, diskLines.ids, budget));
	if (diskHunks.length > maxEditsPerSide) return { kind: "too-large" };
	const crdtHunks = slideRight(baseLines.ids, lineHunks(baseLines.ids, crdtLines.ids, budget));
	if (crdtHunks.length > maxEditsPerSide) return { kind: "too-large" };
	const diskEdits = toSideEdits(baseLines, diskHunks, interner.texts);
	const crdtEdits = toSideEdits(baseLines, crdtHunks, interner.texts);

	const components = new Components(diskEdits.length + crdtEdits.length);
	const overlappingDisk = new Set<number>();
	const overlappingCrdt = new Set<number>();
	let firstPossible = 0;
	for (let diskIndex = 0; diskIndex < diskEdits.length; diskIndex++) {
		const diskEdit = diskEdits[diskIndex]!;
		while (firstPossible < crdtEdits.length
			&& crdtEdits[firstPossible]!.end < (diskEdit.flexStart ?? diskEdit.start)) firstPossible++;
		for (let crdtIndex = firstPossible; crdtIndex < crdtEdits.length; crdtIndex++) {
			const crdtEdit = crdtEdits[crdtIndex]!;
			if ((crdtEdit.flexStart ?? crdtEdit.start) > diskEdit.end) break;
			if (!sameEdit(diskEdit, crdtEdit) && !editsOverlap(diskEdit, crdtEdit, base.length)) continue;
			overlappingDisk.add(diskIndex);
			overlappingCrdt.add(crdtIndex);
			components.join(diskIndex, diskEdits.length + crdtIndex);
		}
	}

	const groups = new Map<number, { disk: number[]; crdt: number[] }>();
	for (const index of overlappingDisk) {
		const root = components.find(index);
		const group = groups.get(root) ?? { disk: [], crdt: [] };
		group.disk.push(index);
		groups.set(root, group);
	}
	for (const index of overlappingCrdt) {
		const root = components.find(diskEdits.length + index);
		const group = groups.get(root) ?? { disk: [], crdt: [] };
		group.crdt.push(index);
		groups.set(root, group);
	}

	const edits: { start: number; end: number; replacement: string }[] = [];
	let conflicts = 0;
	for (const group of groups.values()) {
		const disks = group.disk.map((index) => diskEdits[index]!);
		const crdts = group.crdt.map((index) => crdtEdits[index]!);
		let start = Infinity;
		let end = -Infinity;
		for (const edit of disks) { start = Math.min(start, edit.start); end = Math.max(end, edit.end); }
		for (const edit of crdts) { start = Math.min(start, edit.start); end = Math.max(end, edit.end); }
		const diskText = localAlternative(base, start, end, disks);
		const crdtText = localAlternative(base, start, end, crdts);
		if (diskText !== crdtText) conflicts++;
		// Shared change, or conflict region resolved to the crdt side.
		edits.push({ start, end, replacement: crdtText });
	}
	diskEdits.forEach((edit, index) => { if (!overlappingDisk.has(index)) edits.push(edit); });
	crdtEdits.forEach((edit, index) => { if (!overlappingCrdt.has(index)) edits.push(edit); });
	const text = applyLineEdits(base, edits);
	return conflicts === 0 ? { kind: "clean", text } : { kind: "conflict", text, regions: conflicts };
}
