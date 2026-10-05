import * as Y from "yjs";
import { canonicalizeMarkdown } from "@shared/markdownCodec";
import { parseSemanticEpoch, type SemanticEpoch } from "@shared/semanticEpoch";
import { applyDiffToYText } from "./diff";
import { ORIGIN_SEMANTIC_EPOCH_REBASE } from "./origins";
import { SCHEMA_VERSION } from "./schema";
import { mergeThreeWayText, type ThreeWayConflict, type ThreeWayEdit } from "./threeWayMerge";

export interface SemanticEpochTransitionInput {
	bodyId: string;
	previousBodyEpoch: SemanticEpoch;
	nextBodyEpoch: SemanticEpoch;
	/** Canonical durable body content on which the pending local edit began. */
	previousBaseline: string;
	/** Current local Markdown intent. Old-epoch Yjs updates must never be supplied. */
	pendingMarkdown: string;
	/** Exact server state for nextBodyEpoch. */
	authoritativeEncodedState: Uint8Array;
}

export interface RootSemanticEpochTransitionInput {
	previousRootEpoch: SemanticEpoch;
	nextRootEpoch: SemanticEpoch;
	authoritativeEncodedState: Uint8Array;
}

export interface RootSemanticEpochTransition {
	rootEpoch: SemanticEpoch;
	document: Y.Doc;
}

export interface ReadySemanticEpochTransition {
	kind: "ready";
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	document: Y.Doc;
	authoritativeContent: string;
	rebasedContent: string;
	/** A new-epoch update only; null means the authoritative content already wins. */
	rebasedUpdate: Uint8Array | null;
	outcome: "identical" | "disk-only" | "body-only" | "clean-merged";
	edits: ThreeWayEdit[];
}

export type SemanticEpochTransitionResult = ReadySemanticEpochTransition
	| {
		kind: "conflict";
		bodyId: string;
		previousBodyEpoch: SemanticEpoch;
		nextBodyEpoch: SemanticEpoch;
		authoritativeContent: string;
		pendingMarkdown: string;
		conflicts: ThreeWayConflict[];
	}
	| {
		kind: "too-large";
		bodyId: string;
		previousBodyEpoch: SemanticEpoch;
		nextBodyEpoch: SemanticEpoch;
		authoritativeContent: string;
		pendingMarkdown: string;
		reason: "input" | "edit-count";
	};

/**
 * Installs a fresh server Y.Doc and reapplies only the user's textual intent.
 *
 * The old Y.Doc and its updates are deliberately absent from this API. That is
 * the safety property: stale struct identities cannot cross the epoch fence.
 * The caller owns `result.document` for a ready result and must destroy it.
 */
export function prepareSemanticEpochTransition(
	input: SemanticEpochTransitionInput,
): SemanticEpochTransitionResult {
	if (!input.bodyId || input.bodyId === "root") throw new Error("semantic body transition requires a body ID");
	const previousBodyEpoch = parseSemanticEpoch(input.previousBodyEpoch, "previous body epoch");
	const nextBodyEpoch = parseSemanticEpoch(input.nextBodyEpoch, "next body epoch");
	if (nextBodyEpoch <= previousBodyEpoch) throw new Error("semantic body epoch must advance monotonically");

	const document = new Y.Doc({ guid: input.bodyId });
	let authoritativeContent: string;
	try {
		if (input.authoritativeEncodedState.byteLength > 0) {
			Y.applyUpdate(document, input.authoritativeEncodedState, "semantic-epoch-baseline");
		}
		const rawAuthoritativeContent = document.getText("body").toJSON();
		authoritativeContent = canonicalizeMarkdown(rawAuthoritativeContent);
		if (rawAuthoritativeContent !== authoritativeContent) {
			throw new Error("semantic epoch baseline is not canonical Markdown");
		}
	} catch (error) {
		document.destroy();
		throw error;
	}
	const previousBaseline = canonicalizeMarkdown(input.previousBaseline);
	const pendingMarkdown = canonicalizeMarkdown(input.pendingMarkdown);
	const merge = mergeThreeWayText(previousBaseline, pendingMarkdown, authoritativeContent);
	if (merge.kind === "conflict") {
		document.destroy();
		return {
			kind: "conflict", bodyId: input.bodyId, previousBodyEpoch, nextBodyEpoch,
			authoritativeContent, pendingMarkdown, conflicts: merge.conflicts,
		};
	}
	if (merge.kind === "too-large") {
		document.destroy();
		return {
			kind: "too-large", bodyId: input.bodyId, previousBodyEpoch, nextBodyEpoch,
			authoritativeContent, pendingMarkdown, reason: merge.reason,
		};
	}

	const baselineVector = Y.encodeStateVector(document);
	if (merge.content !== authoritativeContent) {
		applyDiffToYText(document.getText("body"), authoritativeContent, merge.content, ORIGIN_SEMANTIC_EPOCH_REBASE);
	}
	const rebasedUpdate = merge.content === authoritativeContent
		? null
		: Y.encodeStateAsUpdate(document, baselineVector);
	return {
		kind: "ready", bodyId: input.bodyId, bodyEpoch: nextBodyEpoch, document,
		authoritativeContent, rebasedContent: merge.content, rebasedUpdate,
		outcome: merge.outcome, edits: merge.edits,
	};
}

/** Root sockets are replication-only, so a reset installs the fresh root verbatim. */
export function prepareRootSemanticEpochTransition(
	input: RootSemanticEpochTransitionInput,
): RootSemanticEpochTransition {
	const previousRootEpoch = parseSemanticEpoch(input.previousRootEpoch, "previous root epoch");
	const nextRootEpoch = parseSemanticEpoch(input.nextRootEpoch, "next root epoch");
	if (nextRootEpoch <= previousRootEpoch) throw new Error("semantic root epoch must advance monotonically");
	const document = new Y.Doc({ guid: "root" });
	try {
		if (input.authoritativeEncodedState.byteLength > 0) {
			Y.applyUpdate(document, input.authoritativeEncodedState, "semantic-root-epoch-baseline");
		}
		if (document.getMap("sys").get("schemaVersion") !== SCHEMA_VERSION) {
			throw new Error(`semantic root baseline is not schema ${SCHEMA_VERSION}`);
		}
		return { rootEpoch: nextRootEpoch, document };
	} catch (error) {
		document.destroy();
		throw error;
	}
}
