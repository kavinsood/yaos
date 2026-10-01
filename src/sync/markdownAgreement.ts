import { canonicalizeMarkdown } from "@shared/markdownCodec";
import { mergeThreeWayText, type ThreeWayMergeResult } from "./threeWayMerge";

export type MarkdownAgreementPlan =
	| { kind: "agree" }
	| { kind: "project-body" }
	| { kind: "import-local" }
	| { kind: "merge"; merge: Extract<ThreeWayMergeResult, { kind: "clean" }> }
	| { kind: "preserve"; merge: Exclude<ThreeWayMergeResult, { kind: "clean" }> | null };

export function planMarkdownAgreement(input: {
	local: string;
	body: string;
	base: string | null;
	localMatchesAgreement?: boolean;
	bodyMatchesAgreement?: boolean;
	localInput?: "unbound-disk" | "known-base";
}): MarkdownAgreementPlan {
	const local = canonicalizeMarkdown(input.local);
	const body = canonicalizeMarkdown(input.body);
	const base = input.base === null ? null : canonicalizeMarkdown(input.base);
	if (local === body) return { kind: "agree" };
	if (input.localMatchesAgreement || (base !== null && local === base)) return { kind: "project-body" };
	if (input.bodyMatchesAgreement || (base !== null && body === base)) {
		if (input.localInput === "unbound-disk") {
			const change = mergeThreeWayText(body, local, body);
			if (change.kind !== "clean" || change.edits.some((edit) => edit.end > edit.start)) {
				return { kind: "preserve", merge: null };
			}
		}
		return { kind: "import-local" };
	}
	if (base === null) return { kind: "preserve", merge: null };
	const merge = mergeThreeWayText(base, local, body);
	return merge.kind === "clean" ? { kind: "merge", merge } : { kind: "preserve", merge };
}
