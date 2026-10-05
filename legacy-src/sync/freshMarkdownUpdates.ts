import * as Y from "yjs";
import { MAX_DURABLE_UPDATE_BYTES } from "@shared/durableLimits";

/**
 * Keep substantial headroom for Yjs struct metadata and the independently
 * generated frontmatter-semantic update. The durable boundary is asserted on
 * every encoded frame below; this target is not itself the safety proof.
 */
export const FRESH_MARKDOWN_TEXT_CHUNK_BYTES = 1024 * 1024;

export interface FreshMarkdownUpdateSet {
	/** Exact aggregate used by existing candidate persistence and digest logic. */
	readonly encodedUpdate: Uint8Array;
	/** Ordered, independently valid Yjs updates; each fits one durable row. */
	readonly encodedUpdates: readonly Uint8Array[];
}

/** Split UTF-8 without ever bisecting a scalar or JavaScript surrogate pair. */
export function splitUtf8Text(value: string, maximumBytes = FRESH_MARKDOWN_TEXT_CHUNK_BYTES): string[] {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
		throw new Error("fresh Markdown chunk limit must be at least four bytes");
	}
	if (value.length === 0) return [];
	const encoded = new TextEncoder().encode(value);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const chunks: string[] = [];
	for (let offset = 0; offset < encoded.byteLength;) {
		let end = Math.min(encoded.byteLength, offset + maximumBytes);
		if (end < encoded.byteLength) {
			while (end > offset && (encoded[end]! & 0xc0) === 0x80) end--;
		}
		if (end <= offset) throw new Error("fresh Markdown chunk boundary did not advance");
		chunks.push(decoder.decode(encoded.subarray(offset, end)));
		offset = end;
	}
	return chunks;
}

/**
 * Materialize a fresh body as bounded valid Yjs transactions. The semantic
 * mirror is intentionally seeded only after the complete Markdown text exists,
 * so partial YAML/frontmatter is never interpreted as an intermediate model.
 */
export function materializeFreshMarkdownUpdates(
	doc: Y.Doc,
	content: string,
	seedSemanticRoots: () => void,
): FreshMarkdownUpdateSet {
	const text = doc.getText("body");
	if (text.length !== 0) throw new Error("fresh Markdown framing requires an empty body");
	const encodedUpdates: Uint8Array[] = [];
	const capture = (update: Uint8Array) => encodedUpdates.push(update.slice());
	doc.on("update", capture);
	try {
		for (const chunk of splitUtf8Text(content)) {
			doc.transact(() => text.insert(text.length, chunk), "fresh-markdown-frame");
		}
		seedSemanticRoots();
	} finally {
		doc.off("update", capture);
	}
	if (encodedUpdates.length === 0) throw new Error("fresh Markdown produced no candidate updates");
	for (const update of encodedUpdates) {
		if (update.byteLength === 0 || update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error(`fresh Markdown update exceeds durable value limit (${update.byteLength})`);
		}
	}
	return {
		encodedUpdate: encodedUpdates.length === 1 ? encodedUpdates[0]!.slice() : Y.mergeUpdates(encodedUpdates),
		encodedUpdates,
	};
}
