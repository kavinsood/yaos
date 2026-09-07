/**
 * Character-level diff utility for applying external text changes to a Y.Text
 * as targeted inserts/deletes rather than a wholesale replace.
 *
 * This preserves CRDT history and cursor positions when an external tool
 * (git, another editor) modifies a file that's currently open.
 */
import diff from "fast-diff";
import * as Y from "yjs";
import { yTextToString } from "../utils/format";

/**
 * Diff operation: retain N chars, delete N chars, or insert a string.
 */
type DiffOp =
	| { type: "retain"; count: number }
	| { type: "delete"; count: number }
	| { type: "insert"; text: string };

/**
 * Compute a character diff between `oldText` and `newText`, then
 * apply it to the Y.Text as a series of targeted operations.
 *
 * Uses `fast-diff`, a compact Myers-style diff implementation.
 */
export function applyDiffToYText(
	ytext: Y.Text,
	oldText: string,
	newText: string,
	origin: string,
): void {
	if (oldText === newText) return;

	// `fast-diff` gives us a synchronous Myers-style patch without building
	// the old quadratic DP matrix that used to freeze on large notes.
	const charOps = diffToCharOps(diff(oldText, newText));
	if (charOps.length === 0) return;

	// Apply to Y.Text in a single transaction so collaborators see one patch.
	ytext.doc?.transact(() => {
		let cursor = 0;
		for (const op of charOps) {
			switch (op.type) {
				case "retain":
					cursor += op.count;
					break;
				case "delete":
					ytext.delete(cursor, op.count);
					break;
				case "insert":
					ytext.insert(cursor, op.text);
					cursor += op.text.length;
					break;
			}
		}
	}, origin);
}

export type SafeTextApplyOutcome = "applied" | "unchanged" | "superseded";

/** Ordinary sync commit: stale observations never replace newer Y.Text state. */
export function tryApplyDiffToYText(
	ytext: Y.Text,
	expectedCurrentText: string,
	newText: string,
	origin: string,
): SafeTextApplyOutcome {
	const currentText = yTextToString(ytext) ?? "";
	if (currentText !== expectedCurrentText) return "superseded";
	if (currentText === newText) return "unchanged";
	applyDiffToYText(ytext, expectedCurrentText, newText, origin);
	return (yTextToString(ytext) ?? "") === newText ? "applied" : "superseded";
}

export interface DiffPostconditionResult {
	diffSkippedDueToStaleBase: boolean;
	matchesAfterDiff: boolean;
	forceReplaceApplied: boolean;
	finalMatchesExpected: boolean;
	finalLength: number;
}

export function applyDiffToYTextWithPostcondition(
	ytext: Y.Text,
	oldText: string,
	newText: string,
	origin: string,
): DiffPostconditionResult {
	const currentText = yTextToString(ytext) ?? "";
	if (currentText !== oldText) {
		forceReplaceYText(ytext, newText, origin);
		const afterForce = yTextToString(ytext) ?? "";
		return {
			diffSkippedDueToStaleBase: true,
			matchesAfterDiff: false,
			forceReplaceApplied: true,
			finalMatchesExpected: afterForce === newText,
			finalLength: afterForce.length,
		};
	}

	applyDiffToYText(ytext, oldText, newText, origin);

	const afterDiff = yTextToString(ytext) ?? "";
	if (afterDiff === newText) {
		return {
			diffSkippedDueToStaleBase: false,
			matchesAfterDiff: true,
			forceReplaceApplied: false,
			finalMatchesExpected: true,
			finalLength: afterDiff.length,
		};
	}

	forceReplaceYText(ytext, newText, origin);
	const afterForce = yTextToString(ytext) ?? "";
	return {
		diffSkippedDueToStaleBase: false,
		matchesAfterDiff: false,
		forceReplaceApplied: true,
		finalMatchesExpected: afterForce === newText,
		finalLength: afterForce.length,
	};
}

export function forceReplaceYText(
	ytext: Y.Text,
	newText: string,
	origin: unknown,
): void {
	// Recovery-only. Do not use for normal sync/edit propagation.
	// Callers must already have chosen newText as the authority. This fallback
	// intentionally discards current Y.Text content when a targeted recovery
	// diff cannot satisfy its postcondition.
	//
	// `origin` is `unknown` rather than `string` because a Yjs transaction
	// origin is an arbitrary value — it is only ever compared by identity or by
	// isLocalOrigin(), never parsed. Every product caller passes one of the
	// ORIGIN_* string constants; a caller that needs a write classified as
	// remote (the QA harness routes recovery writes through the provider
	// object) passes that object, exactly as Y.Doc.transact allows.
	const replace = () => {
		const currentLength = ytext.length;
		if (currentLength > 0) ytext.delete(0, currentLength);
		if (newText.length > 0) ytext.insert(0, newText);
	};
	if (ytext.doc) {
		ytext.doc.transact(replace, origin);
	} else {
		replace();
	}
}

function diffToCharOps(segments: Array<[-1 | 0 | 1, string]>): DiffOp[] {
	const ops: DiffOp[] = [];

	for (const [kind, text] of segments) {
		if (text.length === 0) continue;

		switch (kind) {
			case 0:
				pushRetain(ops, text.length);
				break;
			case -1:
				pushDelete(ops, text.length);
				break;
			case 1:
				pushInsert(ops, text);
				break;
		}
	}

	return ops;
}

function pushRetain(ops: DiffOp[], count: number): void {
	if (count <= 0) return;
	const last = ops[ops.length - 1];
	if (last?.type === "retain") {
		last.count += count;
		return;
	}
	ops.push({ type: "retain", count });
}

function pushDelete(ops: DiffOp[], count: number): void {
	if (count <= 0) return;
	const last = ops[ops.length - 1];
	if (last?.type === "delete") {
		last.count += count;
		return;
	}
	ops.push({ type: "delete", count });
}

function pushInsert(ops: DiffOp[], text: string): void {
	if (text.length === 0) return;
	const last = ops[ops.length - 1];
	if (last?.type === "insert") {
		last.text += text;
		return;
	}
	ops.push({ type: "insert", text });
}
