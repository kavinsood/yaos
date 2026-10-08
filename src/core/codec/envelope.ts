/**
 * Envelope codec (DESIGN §b.1, e2ee-design §7). Pure; the async seal/open
 * helpers take the CryptoPort as a parameter.
 *
 * Decisions (docs/client-remake/wp-a-notes.md, e2ee-design §7, §9.2):
 * - Unknown formatVersion -> "unsupported-version"; suite byte outside
 *   CryptoSuite -> "unsupported-suite" (both reader-dependent: ns/cfg halt).
 * - Suite 0 with keyEpoch != 0, suite ≠ 0 with keyEpoch 0, non-minimal
 *   varuints, unknown kind codes, a frameNo that breaks kindHasFrameNo,
 *   empty/invalid/oversized deflate content -> "malformed" (deterministic).
 * - Suite ≠ 0 pads with Padmé inside the AEAD; bad padding under a valid tag
 *   -> "bad-padding" (deterministic). Suite 0 never pads.
 * - Unknown flag bits are ignored. Decoded content is always uncompressed;
 *   `flags` is returned as on the wire (the deflate bit is informational).
 * - Inflate is bounded: output beyond maxContentBytes is malformed.
 */

import { deflateSync, Inflate } from "fflate";
import {
	AAD_CHECKPOINT_PREFIX,
	AAD_FRAME_PREFIX,
	ALLOWED_KINDS,
	CryptoSuite,
	ENVELOPE_FORMAT_VERSION,
	EnvelopeFlag,
	EnvelopeKindCode,
	kindHasFrameNo,
	type EnvelopeBinding,
	type EnvelopeHeader,
	type EnvelopeKind,
	type EnvelopeOpenResult,
	type InnerEnvelope,
} from "../envelope";
import type { BlobAddress, CryptoPort, HashPort } from "../../ports/crypto";
import type { DeviceId, Seq, StreamName, VaultId } from "../types";
import { streamClass } from "../types";
import { MAX_DOC_TEXT_CHARS } from "../limits";
import { CodecError, Reader, Writer, bytesToHex, utf8Encode } from "./lib0";
import { pad, unpad } from "./padme";

/** CryptoPort.diagHash length in hex characters (e2ee-design §18.1). */
export const DIAG_HASH_HEX_CHARS = 16;

/** Compress content of at least this many bytes ... */
export const DEFLATE_MIN_BYTES = 4096;
/** ... when deflate saves at least 10 % (compressed <= 90 % of the input). */
export const DEFLATE_MAX_RATIO = 0.9;
/**
 * Default inflate bound. Largest legitimate content: a 4 MiB checkpoint state
 * or an 8M-char initial body chunk inflates well below this.
 */
export const DEFAULT_MAX_CONTENT_BYTES = Math.max(64 * 1024 * 1024, MAX_DOC_TEXT_CHARS * 3 + 1024 * 1024);

const KIND_BY_CODE = new Map<number, EnvelopeKind>(
	(Object.keys(EnvelopeKindCode) as EnvelopeKind[]).map((k) => [EnvelopeKindCode[k], k]),
);
const SUITES = new Set<number>(Object.values(CryptoSuite));

export function kindFromCode(code: number): EnvelopeKind | null {
	return KIND_BY_CODE.get(code) ?? null;
}

// ---- outer ----------------------------------------------------------------------

export function encodeOuter(header: EnvelopeHeader, sealed: Uint8Array): Uint8Array {
	if ((header.suite === CryptoSuite.none) !== (header.keyEpoch === 0)) throw new CodecError("keyEpoch must be 0 iff suite is 0");
	const w = new Writer(sealed.length + 16);
	w.u8(header.formatVersion).u8(header.suite).varuint(header.keyEpoch).raw(sealed);
	return w.finish();
}

export type OuterDecodeResult =
	| { readonly ok: true; readonly header: EnvelopeHeader; readonly sealed: Uint8Array }
	| { readonly ok: false; readonly reason: "malformed" | "unsupported-version" | "unsupported-suite" };

export function decodeOuter(bytes: Uint8Array): OuterDecodeResult {
	try {
		const r = new Reader(bytes);
		const formatVersion = r.u8();
		if (formatVersion !== ENVELOPE_FORMAT_VERSION) return { ok: false, reason: "unsupported-version" };
		const suite = r.u8();
		if (!SUITES.has(suite)) return { ok: false, reason: "unsupported-suite" };
		const keyEpoch = r.varuint();
		if ((suite === CryptoSuite.none) !== (keyEpoch === 0)) return { ok: false, reason: "malformed" };
		return { ok: true, header: { formatVersion, suite: suite as CryptoSuite, keyEpoch }, sealed: r.rest() };
	} catch (e) {
		if (e instanceof CodecError) return { ok: false, reason: "malformed" };
		throw e;
	}
}

// ---- inner ----------------------------------------------------------------------

/** True iff the content should be sent deflated (DESIGN §b.1). Returns the compressed bytes or null. */
export function maybeDeflate(content: Uint8Array): Uint8Array | null {
	if (content.length < DEFLATE_MIN_BYTES) return null;
	const z = deflateSync(content, { level: 6 });
	return z.length <= content.length * DEFLATE_MAX_RATIO ? z : null;
}

function checkFrameNo(kind: EnvelopeKind, frameNo: number): boolean {
	return Number.isSafeInteger(frameNo) && (kindHasFrameNo(kind) ? frameNo >= 1 : frameNo === 0);
}

/**
 * Encode the inner envelope; returns the bytes and the flags as written. The
 * deflate flag in `inner.flags` is ignored: compression is decided here by
 * the DESIGN §b.1 rule (or forced with `deflate: "never"`).
 */
export function encodeInnerFlags(inner: InnerEnvelope, opts?: { readonly deflate?: "auto" | "never" }): { readonly bytes: Uint8Array; readonly flags: number } {
	const kindCode = EnvelopeKindCode[inner.kind];
	if (kindCode === undefined) throw new CodecError(`unknown kind ${String(inner.kind)}`);
	if (!checkFrameNo(inner.kind, inner.frameNo)) throw new CodecError(`frameNo ${inner.frameNo} not allowed for ${inner.kind}`);
	const z = opts?.deflate === "never" ? null : maybeDeflate(inner.content);
	const flags = z ? inner.flags | EnvelopeFlag.deflate : inner.flags & ~EnvelopeFlag.deflate;
	const body = z ?? inner.content;
	const w = new Writer(body.length + 32);
	w.u8(kindCode).varuint(inner.authorNsSeq).varuint(flags).varuint(inner.frameNo).raw(body);
	return { bytes: w.finish(), flags };
}

export function encodeInner(inner: InnerEnvelope, opts?: { readonly deflate?: "auto" | "never" }): Uint8Array {
	return encodeInnerFlags(inner, opts).bytes;
}

/** Bounded deflate-raw inflate. Throws CodecError on invalid streams or output > maxBytes. */
export function inflateBounded(z: Uint8Array, maxBytes: number): Uint8Array {
	if (z.length === 0) throw new CodecError("empty deflate stream");
	const parts: Uint8Array[] = [];
	let total = 0;
	const s = new Inflate((chunk) => {
		total += chunk.length;
		if (total > maxBytes) throw new CodecError("inflated content too large");
		parts.push(chunk);
	});
	const STEP = 1024;
	try {
		for (let i = 0; i < z.length; i += STEP) s.push(z.subarray(i, i + STEP), i + STEP >= z.length);
	} catch (e) {
		if (e instanceof CodecError) throw e;
		throw new CodecError(`invalid deflate stream: ${e instanceof Error ? e.message : String(e)}`);
	}
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

export type InnerDecodeResult =
	| { readonly ok: true; readonly inner: InnerEnvelope }
	| { readonly ok: false; readonly reason: "malformed" };

export function decodeInner(plaintext: Uint8Array, maxContentBytes = DEFAULT_MAX_CONTENT_BYTES): InnerDecodeResult {
	try {
		const r = new Reader(plaintext);
		const kind = kindFromCode(r.u8());
		if (kind === null) return { ok: false, reason: "malformed" };
		const authorNsSeq = r.varuint();
		const flags = r.varuint();
		const frameNo = r.varuint();
		if (!checkFrameNo(kind, frameNo)) return { ok: false, reason: "malformed" };
		let content = r.rest();
		if (flags & EnvelopeFlag.deflate) content = inflateBounded(content, maxContentBytes);
		else if (content.length > maxContentBytes) return { ok: false, reason: "malformed" };
		return { ok: true, inner: { kind, authorNsSeq, flags, frameNo, content } };
	} catch (e) {
		if (e instanceof CodecError) return { ok: false, reason: "malformed" };
		throw e;
	}
}

// ---- AAD (e2ee-design §7.2) ------------------------------------------------------

function aadHeader(w: Writer, prefix: string, h: EnvelopeHeader, vaultId: string, stream: string): Writer {
	return w.raw(utf8Encode(prefix)).u8(h.formatVersion).u8(h.suite).varuint(h.keyEpoch).varstring(vaultId).varstring(stream);
}

/** "yaos/f2" ‖ u8 formatVersion ‖ u8 suite ‖ varuint keyEpoch ‖ vaultId ‖ stream ‖ deviceId ‖ clientFrameId. */
export function frameAad(h: EnvelopeHeader, vaultId: VaultId | string, stream: StreamName | string, deviceId: DeviceId | string, clientFrameId: string): Uint8Array {
	return aadHeader(new Writer(128), AAD_FRAME_PREFIX, h, vaultId, stream).varstring(deviceId).varstring(clientFrameId).finish();
}

/** "yaos/c2" ‖ u8 formatVersion ‖ u8 suite ‖ varuint keyEpoch ‖ vaultId ‖ stream ‖ varuint coversSeq. */
export function checkpointAad(h: EnvelopeHeader, vaultId: VaultId | string, stream: StreamName | string, coversSeq: Seq): Uint8Array {
	return aadHeader(new Writer(96), AAD_CHECKPOINT_PREFIX, h, vaultId, stream).varuint(coversSeq).finish();
}

export function bindingAad(h: EnvelopeHeader, vaultId: VaultId | string, binding: EnvelopeBinding): Uint8Array {
	return binding.t === "frame"
		? frameAad(h, vaultId, binding.stream, binding.deviceId, binding.clientFrameId)
		: checkpointAad(h, vaultId, binding.stream, binding.coversSeq);
}

// ---- binding checks -------------------------------------------------------------

/**
 * Stage-1 kind checks that run even with suite 0 (DESIGN §b.1): kind allowed
 * for the stream class, and frame vs checkpoint kind. The checkpoint content
 * checks (encoding per class, inner coversSeq) are the gate's (ingest/gate.ts).
 */
export function checkBinding(binding: EnvelopeBinding, inner: InnerEnvelope): "ok" | "kind-stream-mismatch" {
	const cls = streamClass(binding.stream);
	if (cls === "other" || cls === "keyring") return "kind-stream-mismatch";
	if (!ALLOWED_KINDS[cls].includes(inner.kind)) return "kind-stream-mismatch";
	return (binding.t === "checkpoint") === (inner.kind === "checkpoint") ? "ok" : "kind-stream-mismatch";
}

// ---- seal / open ----------------------------------------------------------------

export interface SealInput {
	readonly vaultId: VaultId | string;
	readonly binding: EnvelopeBinding;
	readonly inner: InnerEnvelope;
	readonly deflate?: "auto" | "never";
}

export interface SealedEnvelope {
	/** Exact relay payload. */
	readonly sealed: Uint8Array;
	/** Flags as sealed (deflate bit included when compressed). */
	readonly flags: number;
	/** The header's key epoch (e2ee-design §14.2: the outbox keeps it for the revoke re-seal). */
	readonly keyEpoch: number;
}

/** Seal under crypto.sealEpoch(), read once, so the header and the AAD agree even across a concurrent roll. */
export async function sealEnvelope(crypto: CryptoPort, input: SealInput): Promise<SealedEnvelope> {
	const inner = encodeInnerFlags(input.inner, { deflate: input.deflate ?? "auto" });
	const header: EnvelopeHeader = { formatVersion: ENVELOPE_FORMAT_VERSION, suite: crypto.suite, keyEpoch: crypto.sealEpoch() };
	const plaintext = header.suite === CryptoSuite.none ? inner.bytes : pad(inner.bytes);
	const sealed = await crypto.seal({ purpose: input.binding.t, keyEpoch: header.keyEpoch, aad: bindingAad(header, input.vaultId, input.binding), plaintext });
	return { sealed: encodeOuter(header, sealed), flags: inner.flags, keyEpoch: header.keyEpoch };
}

export interface OpenInput {
	readonly vaultId: VaultId | string;
	readonly binding: EnvelopeBinding;
	readonly bytes: Uint8Array;
	readonly maxContentBytes?: number;
}

/** Gate stage 1 (DESIGN §d.6): header, open, unpad, inner decode, kind checks. Never throws on bad bytes. */
export async function openEnvelope(crypto: CryptoPort, input: OpenInput): Promise<EnvelopeOpenResult> {
	const outer = decodeOuter(input.bytes);
	if (!outer.ok) return outer;
	const header = outer.header;
	const opened = await crypto.open({
		purpose: input.binding.t,
		suite: header.suite,
		keyEpoch: header.keyEpoch,
		aad: bindingAad(header, input.vaultId, input.binding),
		sealed: outer.sealed,
	});
	if (!opened.ok) return { ok: false, reason: opened.reason, header };
	const plaintext = header.suite === CryptoSuite.none ? opened.plaintext : unpad(opened.plaintext);
	if (plaintext === null) return { ok: false, reason: "bad-padding", header };
	const dec = decodeInner(plaintext, input.maxContentBytes);
	if (!dec.ok) return { ok: false, reason: dec.reason, header };
	const b = checkBinding(input.binding, dec.inner);
	if (b !== "ok") return { ok: false, reason: b, header };
	return { ok: true, header, inner: dec.inner };
}

/**
 * Suite-0 CryptoPort (identity). Handy for tests; production and the sim use
 * engine/adapters/noopCrypto. diagHash needs a HashPort (core's own sha256 takes only SYNC_HASH_MAX_BYTES).
 */
export function identityCrypto(hash?: HashPort): CryptoPort {
	return {
		suite: CryptoSuite.none,
		sealEpoch: () => 0,
		keyState: (keyEpoch) => ({ held: keyEpoch === 0, verified: true }),
		seal: async ({ plaintext }) => plaintext.slice(),
		open: async ({ suite, keyEpoch, sealed }) =>
			suite !== CryptoSuite.none ? { ok: false, reason: "unsupported-suite" }
			: keyEpoch !== 0 ? { ok: false, reason: "unknown-key" }
			: { ok: true, plaintext: sealed.slice() },
		sealBlob: async ({ plaintext }) => [plaintext.slice()],
		openBlob: async ({ sealed }) => ({ ok: true, plaintext: sealed.slice() }),
		blobAddress: async (h) => h as string as BlobAddress,
		diagHash: async (bytes) => {
			if (!hash) throw new Error("identityCrypto: diagHash needs a HashPort");
			return bytesToHex(await hash.sha256(bytes)).slice(0, DIAG_HASH_HEX_CHARS);
		},
	};
}
