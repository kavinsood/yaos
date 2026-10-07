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
import { utf8Decode, utf8Encode } from "./utf8";

export const MARKDOWN_CODEC = "markdown-lf-v1" as const;

export function canonicalizeMarkdown(content: string): string {
	const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
	return withoutBom.replace(/\r\n?/g, "\n");
}

/** Markdown file bytes -> logical text. Malformed UTF-8 decodes with U+FFFD. */
export function markdownTextFromBytes(bytes: Uint8Array): string {
	return canonicalizeMarkdown(utf8Decode(bytes));
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

/** True when the text is already canonical (writing it back changes no bytes). */
export function isCanonicalMarkdown(content: string): boolean {
	return !content.startsWith("\uFEFF") && content.indexOf("\r") < 0;
}
