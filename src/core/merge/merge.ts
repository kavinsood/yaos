/**
 * THE merge engine (DESIGN §f.3, M2). Pure and bounded by MergeLimits.
 *
 * 1. disk === crdt                 -> identical
 * 2. base === null                 -> conflict(no-base): text = crdt, copy = disk
 * 3. crdt === base / disk === base -> disk-only / crdt-only
 * 4. any input > maxInputChars     -> conflict(too-large)   (base counts too)
 * 5. line diff3: clean | conflict(both-edited) | over maxEditsPerSide -> conflict(too-large)
 *
 * Every conflict keeps the crdt side in `text` (plus clean disk hunks for
 * both-edited) and puts the FULL disk text in `conflictCopy`, so no line of
 * either side is ever lost.
 */

import type { MergeFn, MergeInput, MergeLimits, MergeResult } from "../types";
import { MERGE_MAX_EDITS_PER_SIDE, MERGE_MAX_INPUT_CHARS } from "../limits";
import { diff3 } from "./diff3";

export const DEFAULT_MERGE_LIMITS: MergeLimits = {
	maxInputChars: MERGE_MAX_INPUT_CHARS,
	maxEditsPerSide: MERGE_MAX_EDITS_PER_SIDE,
};

export const merge: MergeFn = (input: MergeInput): MergeResult => {
	const { base, disk, crdt, limits } = input;
	if (disk === crdt) return { kind: "identical" };
	if (base === null) return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "no-base" };
	if (crdt === base) return { kind: "disk-only", text: disk };
	if (disk === base) return { kind: "crdt-only", text: crdt };
	if (Math.max(base.length, disk.length, crdt.length) > limits.maxInputChars) {
		return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "too-large" };
	}
	const result = diff3(base, disk, crdt, limits.maxEditsPerSide);
	switch (result.kind) {
		case "clean": return { kind: "clean", text: result.text };
		case "conflict": return { kind: "conflict", text: result.text, conflictCopy: disk, reason: "both-edited" };
		case "too-large": return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "too-large" };
	}
};

/**
 * Canvas (and any structured text): a clean/one-sided result that fails
 * `valid` becomes conflict(both-edited) with the crdt side kept. Not a policy
 * wrapper around a second engine: it is the "merged text must parse" rule of
 * §f.3 applied to the ONE engine's output.
 */
export function mergeValidated(input: MergeInput, valid: (text: string) => boolean): MergeResult {
	const result = merge(input);
	if ((result.kind === "clean" || result.kind === "disk-only") && !valid(result.text)) {
		return { kind: "conflict", text: input.crdt, conflictCopy: input.disk, reason: "both-edited" };
	}
	if (result.kind === "conflict" && !valid(result.text)) {
		return { kind: "conflict", text: input.crdt, conflictCopy: input.disk, reason: result.reason };
	}
	return result;
}
