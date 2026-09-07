import { boundedTextDiff } from "./boundedTextDiff";

export interface ThreeWayEdit {
	start: number;
	end: number;
	replacement: string;
	source: "disk" | "body";
}

export interface ThreeWayConflict {
	baseStart: number;
	baseEnd: number;
	base: string;
	disk: string;
	body: string;
}

export type ThreeWayMergeOutcome = "identical" | "disk-only" | "body-only" | "clean-merged";
export type ThreeWayMergeResult =
	| { kind: "clean"; outcome: ThreeWayMergeOutcome; content: string; edits: ThreeWayEdit[] }
	| { kind: "conflict"; outcome: "conflict"; base: string; cleanEdits: ThreeWayEdit[]; conflicts: ThreeWayConflict[] }
	| { kind: "too-large"; outcome: "too-large"; reason: "input" | "edit-count" };

export type ThreeWayConflictChoice = "disk" | "body" | "base";
export interface ThreeWayMergeLimits {
	maxInputCharacters: number;
	maxEditsPerSide: number;
}

const DEFAULT_LIMITS: ThreeWayMergeLimits = {
	maxInputCharacters: 2 * 1024 * 1024,
	maxEditsPerSide: 10_000,
};

interface SideEdit {
	start: number;
	end: number;
	replacement: string;
}

function editsFromBase(base: string, changed: string): SideEdit[] {
	const operations = boundedTextDiff(base, changed);
	const edits: SideEdit[] = [];
	let baseOffset = 0;
	let pending: SideEdit | null = null;
	const flush = () => {
		if (!pending) return;
		edits.push(pending);
		pending = null;
	};
	for (const [kind, value] of operations) {
		if (kind === 0) {
			flush();
			baseOffset += value.length;
			continue;
		}
		if (!pending) pending = { start: baseOffset, end: baseOffset, replacement: "" };
		if (kind === -1) {
			pending.end += value.length;
			baseOffset += value.length;
		} else {
			pending.replacement += value;
		}
	}
	flush();
	return edits;
}

function editsOverlap(left: SideEdit, right: SideEdit): boolean {
	if (left.start === left.end && right.start === right.end) return left.start === right.start;
	if (left.start === left.end) return left.start >= right.start && left.start <= right.end;
	if (right.start === right.end) return right.start >= left.start && right.start <= left.end;
	return left.start < right.end && right.start < left.end;
}

function sameEdit(left: SideEdit, right: SideEdit): boolean {
	return left.start === right.start && left.end === right.end && left.replacement === right.replacement;
}

function applyEdits(base: string, edits: readonly SideEdit[]): string {
	let output = base;
	for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
		output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
	}
	return output;
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

/** Conservative bounded character diff3 with one conflict per transitive overlap region. */
export function mergeThreeWayText(
	base: string,
	disk: string,
	body: string,
	limits: ThreeWayMergeLimits = DEFAULT_LIMITS,
): ThreeWayMergeResult {
	if (Math.max(base.length, disk.length, body.length) > limits.maxInputCharacters) {
		return { kind: "too-large", outcome: "too-large", reason: "input" };
	}
	if (disk === body) return { kind: "clean", outcome: "identical", content: disk, edits: [] };
	if (disk === base) {
		return { kind: "clean", outcome: "body-only", content: body,
			edits: editsFromBase(base, body).map((edit) => ({ ...edit, source: "body" })) };
	}
	if (body === base) {
		return { kind: "clean", outcome: "disk-only", content: disk,
			edits: editsFromBase(base, disk).map((edit) => ({ ...edit, source: "disk" })) };
	}

	const diskEdits = editsFromBase(base, disk);
	const bodyEdits = editsFromBase(base, body);
	if (diskEdits.length > limits.maxEditsPerSide || bodyEdits.length > limits.maxEditsPerSide) {
		return { kind: "too-large", outcome: "too-large", reason: "edit-count" };
	}
	const components = new Components(diskEdits.length + bodyEdits.length);
	const conflictingDisk = new Set<number>();
	const conflictingBody = new Set<number>();
	const duplicateBody = new Set<number>();
	let firstPossibleBody = 0;
	for (let diskIndex = 0; diskIndex < diskEdits.length; diskIndex++) {
		const diskEdit = diskEdits[diskIndex]!;
		while (firstPossibleBody < bodyEdits.length
			&& bodyEdits[firstPossibleBody]!.end < diskEdit.start) firstPossibleBody++;
		for (let bodyIndex = firstPossibleBody; bodyIndex < bodyEdits.length; bodyIndex++) {
			const bodyEdit = bodyEdits[bodyIndex]!;
			if (bodyEdit.start > diskEdit.end) break;
			if (!editsOverlap(diskEdit, bodyEdit)) continue;
			if (sameEdit(diskEdit, bodyEdit)) {
				duplicateBody.add(bodyIndex);
				continue;
			}
			conflictingDisk.add(diskIndex);
			conflictingBody.add(bodyIndex);
			components.join(diskIndex, diskEdits.length + bodyIndex);
		}
	}

	if (conflictingDisk.size === 0) {
		const combined: ThreeWayEdit[] = [
			...diskEdits.map((edit) => ({ ...edit, source: "disk" as const })),
			...bodyEdits.flatMap((edit, index) => duplicateBody.has(index)
				? [] : [{ ...edit, source: "body" as const }]),
		];
		return { kind: "clean", outcome: "clean-merged", content: applyEdits(base, combined), edits: combined };
	}

	const groups = new Map<number, { disk: SideEdit[]; body: SideEdit[] }>();
	for (const index of conflictingDisk) {
		const root = components.find(index);
		const group = groups.get(root) ?? { disk: [], body: [] };
		group.disk.push(diskEdits[index]!);
		groups.set(root, group);
	}
	for (const index of conflictingBody) {
		const root = components.find(diskEdits.length + index);
		const group = groups.get(root) ?? { disk: [], body: [] };
		group.body.push(bodyEdits[index]!);
		groups.set(root, group);
	}
	const conflicts = [...groups.values()].map((group): ThreeWayConflict => {
		const edits = [...group.disk, ...group.body];
		const baseStart = Math.min(...edits.map((edit) => edit.start));
		const baseEnd = Math.max(...edits.map((edit) => edit.end));
		return {
			baseStart,
			baseEnd,
			base: base.slice(baseStart, baseEnd),
			disk: localAlternative(base, baseStart, baseEnd, group.disk),
			body: localAlternative(base, baseStart, baseEnd, group.body),
		};
	}).sort((left, right) => left.baseStart - right.baseStart);

	return {
		kind: "conflict",
		outcome: "conflict",
		base,
		cleanEdits: [
			...diskEdits.flatMap((edit, index) => conflictingDisk.has(index)
				? [] : [{ ...edit, source: "disk" as const }]),
			...bodyEdits.flatMap((edit, index) => conflictingBody.has(index) || duplicateBody.has(index)
				? [] : [{ ...edit, source: "body" as const }]),
		],
		conflicts,
	};
}

export function resolveThreeWayText(
	result: Extract<ThreeWayMergeResult, { kind: "conflict" }>,
	choices: readonly ThreeWayConflictChoice[],
): string {
	if (choices.length !== result.conflicts.length) throw new Error("every three-way conflict requires an explicit choice");
	const resolutions: SideEdit[] = result.conflicts.map((conflict, index) => ({
		start: conflict.baseStart,
		end: conflict.baseEnd,
		replacement: choices[index] === "disk" ? conflict.disk
			: choices[index] === "body" ? conflict.body : conflict.base,
	}));
	return applyEdits(result.base, [...result.cleanEdits, ...resolutions]);
}
