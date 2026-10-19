/**
 * markdown-lf-v1 (ported from server/src/shared/markdownCodec.ts).
 *
 * Logical content of a markdown file: strip ONE leading BOM, then CRLF and
 * lone CR become LF. The ContentHash of a markdown file is sha256 of the UTF-8
 * of that canonical text; the DiskFingerprint is sha256 of the exact bytes.
 */

import type { HashPort } from "../../ports/crypto";
import type { ContentHash, DiskFingerprint } from "../types";
import { digestHex } from "./digest";
import { utf8Encode } from "../codec/lib0";

export const MARKDOWN_CODEC = "markdown-lf-v1" as const;

export function canonicalizeMarkdown(content: string): string {
	const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
	return withoutBom.replace(/\r\n?/g, "\n");
}

export function markdownCanonicalBytes(content: string): Uint8Array {
	return utf8Encode(canonicalizeMarkdown(content));
}

/** Logical hash: sha256 of markdownCanonicalBytes, through HashPort. */
export async function markdownContentHash(hash: HashPort, content: string): Promise<ContentHash> {
	return (await digestHex(hash, markdownCanonicalBytes(content))) as ContentHash;
}

/** DiskFingerprint: sha256 of the exact bytes, through HashPort. */
export async function exactFingerprint(hash: HashPort, bytes: Uint8Array): Promise<DiskFingerprint> {
	return (await digestHex(hash, bytes)) as DiskFingerprint;
}

