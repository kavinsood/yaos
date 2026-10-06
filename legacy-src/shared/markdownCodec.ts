/**
 * Canonical Markdown representation shared by every YAOS host.
 *
 * Version 1 removes one leading Unicode BOM and converts CRLF and lone CR
 * line endings to LF. It deliberately preserves final-newline presence,
 * trailing whitespace, all other Unicode code points, and empty content.
 */
export const MARKDOWN_CANONICAL_VERSION = "markdown-lf-v1" as const;

export type MarkdownCanonicalVersion = typeof MARKDOWN_CANONICAL_VERSION;

const encoder = new TextEncoder();

export function canonicalizeMarkdown(content: string): string {
	const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
	return withoutBom.replace(/\r\n?/g, "\n");
}

/** Canonical text and its exact UTF-8 bytes, prepared with one normalization pass. */
export function prepareCanonicalMarkdown(content: string): { content: string; bytes: Uint8Array } {
	const canonical = canonicalizeMarkdown(content);
	return { content: canonical, bytes: encoder.encode(canonical) };
}

export function canonicalMarkdownBytes(content: string): Uint8Array {
	return prepareCanonicalMarkdown(content).bytes;
}

export function exactMarkdownDiskBytes(content: string): Uint8Array {
	return encoder.encode(content);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let output = "";
	for (const byte of digest) output += byte.toString(16).padStart(2, "0");
	return output;
}

/** SHA-256 identity of bytes already produced by canonicalMarkdownBytes. */
export function canonicalMarkdownBytesHash(bytes: Uint8Array): Promise<string> {
	return sha256Hex(bytes);
}

/** SHA-256 identity of canonical Markdown UTF-8 bytes. */
export function canonicalMarkdownHash(content: string): Promise<string> {
	return canonicalMarkdownBytesHash(canonicalMarkdownBytes(content));
}

/**
 * Fingerprint of the exact UTF-8 text observed at a disk boundary.
 *
 * This is write/self-echo evidence, not logical-content identity: CRLF, BOM,
 * and final-newline differences remain visible.
 */
export async function exactMarkdownDiskFingerprint(
	content: string,
): Promise<{ bytes: number; hash: string }> {
	const bytes = exactMarkdownDiskBytes(content);
	return { bytes: bytes.byteLength, hash: await sha256Hex(bytes) };
}
