/**
 * Engine-side hashing for the host (DESIGN §d.2: the main thread never hashes).
 *
 *  - hashRequest: the host reads raw bytes (write preconditions, config writes) and transfers them
 *    here; per item the engine answers the hash asked for and `textLength`, the UTF-16 length of the
 *    bytes decoded as UTF-8 with any BOM kept (U+FFFD per maximal invalid subpart, WHATWG; what
 *    TextDecoder("utf-8", { ignoreBOM: true }) and Node's Buffer#toString("utf8") return, so what
 *    Obsidian's vault.process hands its callback on desktop). The host's text CAS compares lengths
 *    with it instead of decoding on main.
 *  - Definitions (identical to the engine's own, reconcile/localState.ts hashBytes):
 *    fingerprint = sha256 hex of the exact bytes; contentHash = markdown-lf-v1 for markdown (decode
 *    keeping a BOM, strip ONE BOM, CRLF/CR -> LF, sha256 of the UTF-8), json-canvas-canonical-v1 for
 *    canvas (core canvasContentHash; invalid JSON falls back to its exact bytes), exact bytes otherwise.
 *  - Items run one at a time through the HashPort (WebCrypto in the worker), yielding a macrotask
 *    after every YIELD_EVERY_BYTES of input so a large batch never runs as one synchronous loop.
 *  - writeFingerprint / withFingerprints: the fingerprint of the bytes a write op carries, computed
 *    before the op is posted (its bytes are transferred, detached afterwards) and attached to the
 *    host's result, so WriteOutcome needs no main-thread hashing.
 */

import { canvasContentHash } from "../../core/hash/canvasCanonical";
import { digestHex } from "../../core/hash/digest";
import { canonicalizeMarkdown, exactFingerprint } from "../../core/hash/markdownLf";
import { utf8Decode, utf8Encode } from "../../core/hash/utf8";
import { kindOfPath, type DiskFingerprint, type VaultPath } from "../../core/types";
import type { ClockPort } from "../../ports/clock";
import type { HashPort } from "../../ports/crypto";
import { ProtocolFailure } from "../../protocol/errors";
import type { DiskOp, DiskOpResult, DiskWriteData, EngineResultValue, MainToEngine } from "../../protocol/messages";
import type { ExecResult } from "../reconcile/deps";

export type HashRequestItem = Extract<MainToEngine, { t: "hashRequest" }>["items"][number];
export type HashValue = Extract<EngineResultValue, { t: "hashes" }>["values"][number];

/** Input bytes hashed between two yields. */
export const YIELD_EVERY_BYTES = 1 << 20;

export interface HashServiceDeps {
	readonly hash: HashPort;
	/** One macrotask (ClockPort.yieldNow). */
	readonly yieldNow: () => Promise<void>;
}

/**
 * UTF-16 length of `bytes` decoded as UTF-8 with any BOM kept, without building the string. Mirrors
 * core utf8Decode (non-fatal): a valid sequence counts 1 unit (2 above U+FFFF), each maximal invalid
 * subpart counts 1 (its U+FFFD).
 */
export function utf16LengthOfUtf8(bytes: Uint8Array): number {
	let units = 0;
	let i = 0;
	const n = bytes.length;
	while (i < n) {
		const b0 = bytes[i]!;
		if (b0 < 0x80) { units++; i++; continue; }
		let need = 0;
		let lower = 0x80;
		let upper = 0xbf;
		if (b0 >= 0xc2 && b0 <= 0xdf) need = 1;
		else if (b0 >= 0xe0 && b0 <= 0xef) {
			need = 2;
			if (b0 === 0xe0) lower = 0xa0;
			if (b0 === 0xed) upper = 0x9f;
		} else if (b0 >= 0xf0 && b0 <= 0xf4) {
			need = 3;
			if (b0 === 0xf0) lower = 0x90;
			if (b0 === 0xf4) upper = 0x8f;
		} else { units++; i++; continue; }
		let j = 1;
		for (; j <= need; j++) {
			const b = i + j < n ? bytes[i + j]! : -1;
			if (b < (j === 1 ? lower : 0x80) || b > (j === 1 ? upper : 0xbf)) break;
		}
		if (j <= need) { units++; i += j; continue; }
		units += need === 3 ? 2 : 1;
		i += need + 1;
	}
	return units;
}

/** One item: the hash asked for + textLength. */
export async function hashOne(item: HashRequestItem, hash: HashPort): Promise<HashValue> {
	const { bytes } = item;
	const kind = kindOfPath(item.path as VaultPath);
	if (item.want === "contentHash" && kind === "markdown") {
		const text = utf8Decode(bytes); // keeps a BOM: canonicalizeMarkdown strips exactly one
		return { hash: await digestHex(hash, utf8Encode(canonicalizeMarkdown(text))), textLength: text.length };
	}
	const value = item.want === "contentHash" && kind === "canvas" ? await canvasContentHash(hash, bytes) : await digestHex(hash, bytes);
	return { hash: value, textLength: utf16LengthOfUtf8(bytes) };
}

/** Hash items in order, yielding a macrotask after every YIELD_EVERY_BYTES of input. */
export async function hashItems(items: readonly HashRequestItem[], deps: HashServiceDeps): Promise<HashValue[]> {
	const out: HashValue[] = [];
	let sinceYield = 0;
	for (const item of items) {
		out.push(await hashOne(item, deps.hash));
		sinceYield += item.bytes.byteLength;
		if (sinceYield >= YIELD_EVERY_BYTES) {
			sinceYield = 0;
			await deps.yieldNow();
		}
	}
	return out;
}

/** protocolEngine's answer to hashRequest. */
export async function answerHashRequest(items: readonly HashRequestItem[], ports: { readonly hash: HashPort; readonly clock: ClockPort } | null): Promise<EngineResultValue> {
	if (!ports) throw new ProtocolFailure({ code: "not-ready", message: "engine ports not ready", retryable: true });
	return { t: "hashes", values: await hashItems(items, { hash: ports.hash, yieldNow: () => ports.clock.yieldNow() }) };
}

/** Fingerprint of the bytes a write puts on disk: text as UTF-8 (lone surrogates -> U+FFFD, like the host's writers). */
export function writeFingerprint(hash: HashPort, data: DiskWriteData): Promise<DiskFingerprint> {
	return exactFingerprint(hash, data.t === "text" ? utf8Encode(data.text) : data.bytes);
}

/**
 * Per op: the fingerprint of its write data (null for other ops), one digest at a time. Call BEFORE posting: write
 * bytes are transferred.
 */
export async function fingerprintWrites(hash: HashPort, ops: readonly DiskOp[]): Promise<(DiskFingerprint | null)[]> {
	const out: (DiskFingerprint | null)[] = [];
	for (const op of ops) out.push(op.t === "write" ? await writeFingerprint(hash, op.data) : null);
	return out;
}

/** Attach the pre-computed fingerprints to the host's results (one result per op, in op order). */
export function withFingerprints(ops: readonly DiskOp[], fps: readonly (DiskFingerprint | null)[], results: readonly DiskOpResult[]): ExecResult[] {
	if (results.length !== ops.length) throw new Error(`diskOps answered ${results.length} results for ${ops.length} ops`);
	return results.map((r, i): ExecResult => {
		const op = ops[i] as DiskOp;
		if (r.opId !== op.opId) throw new Error(`diskOps result ${i} is op ${r.opId}, expected ${op.opId}`);
		if (r.t !== "write" || !r.outcome.ok) return r as ExecResult;
		const fingerprint = fps[i];
		if (!fingerprint) throw new Error(`diskOps result ${i}: write result for a non-write op`);
		return { ...r, outcome: { ...r.outcome, fingerprint } };
	});
}
