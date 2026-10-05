/**
 * Client envelope carried in every relay payload (frames and checkpoints).
 * Types, wire constants and tiny pure helpers only; the codec lives in
 * src/core/codec/envelope.ts (WP-A). Byte layout: DESIGN §b.
 *
 *   outer (plaintext, AAD-bound):
 *     u8      formatVersion   = ENVELOPE_FORMAT_VERSION
 *     u8      cryptoSuite     (0 = none)
 *     varuint keyEpoch        (0 when suite = 0)
 *     bytes   sealed          (suite 0: inner verbatim)
 *   inner (after CryptoPort.open):
 *     u8      kind            (EnvelopeKindCode)
 *     varuint authorNsSeq
 *     varuint flags           (EnvelopeFlag bits)
 *     bytes   content         (kind-specific, see below)
 */

import type { ClientFrameId, ContentHash, Seq, StreamName } from "./types";

export const ENVELOPE_FORMAT_VERSION = 1;

export const CryptoSuite = {
	none: 0,
	/** Reserved: XChaCha20-Poly1305 with per-vault key epochs. */
	xchacha20poly1305: 1,
} as const;
export type CryptoSuite = (typeof CryptoSuite)[keyof typeof CryptoSuite];

export const EnvelopeKindCode = {
	nsOps: 1,
	bodyUpdate: 2,
	canvasUpdate: 3,
	cfgOps: 4,
	checkpoint: 5,
	blobChunk: 6,
	bodyUpdateRef: 7,
} as const;
export type EnvelopeKindCode = (typeof EnvelopeKindCode)[keyof typeof EnvelopeKindCode];
export type EnvelopeKind = keyof typeof EnvelopeKindCode;

export const EnvelopeFlag = {
	/** First frame of a newly created doc (carries the initial content). */
	initial: 1 << 0,
	/** Re-appended provisional frame of another device (adopt orphan). */
	adopted: 1 << 1,
	/** content is deflate-raw (fflate) compressed. */
	deflate: 1 << 2,
	/** Content produced by the merge engine from a disk edit (diagnostics only). */
	fromDisk: 1 << 3,
} as const;

/** Outer header, plaintext. */
export interface EnvelopeHeader {
	readonly formatVersion: number;
	readonly suite: CryptoSuite;
	readonly keyEpoch: number;
}

/** Decoded inner envelope; content still kind-encoded. */
export interface InnerEnvelope {
	readonly kind: EnvelopeKind;
	readonly authorNsSeq: Seq;
	readonly flags: number;
	readonly content: Uint8Array;
}

/**
 * Kind-specific content layouts (lib0 encoding):
 *
 * nsOps:          varuint opCount, then per op: u8 tag, varuint bodyLen, body
 *                 (NsOpTag below). Trailing bytes inside a body are ignored
 *                 (optional fields that never affect the fold); an unknown tag
 *                 makes the whole frame malformed, folded as empty (DESIGN §c.3).
 * bodyUpdate:     Yjs update v1 bytes.
 * canvasUpdate:   Yjs update v1 bytes.
 * cfgOps:         varuint opCount, then per op: u8 tag, varuint bodyLen, body (CfgOpTag).
 * checkpoint:     u8 CheckpointEncoding, varuint coversSeq, varuint foldRulesVersion, bytes state.
 * blobChunk:      32B sha256, varuint index, varuint total, varuint totalSize, bytes chunk.
 * bodyUpdateRef:  32B sha256 of the update bytes, varuint size (update stored in the blob store).
 */
export const NsOpTag = {
	create: 1,
	rename: 2,
	delete: 3,
	restore: 4,
	setBlob: 5,
	upgradeRules: 6,
} as const;
export type NsOpTag = (typeof NsOpTag)[keyof typeof NsOpTag];

export const CfgOpTag = {
	jsonSet: 1,
	jsonDel: 2,
	filePut: 3,
	fileDel: 4,
	pluginSet: 5,
	pluginDel: 6,
} as const;
export type CfgOpTag = (typeof CfgOpTag)[keyof typeof CfgOpTag];

export const DocKindCode = { markdown: 1, canvas: 2, blob: 3 } as const;

export const CheckpointEncoding = {
	/** Y.encodeStateAsUpdate (v1) of a scratch doc holding exactly the committed rows <= coversSeq. */
	yjsStateV1: 1,
	/** Canonical NsFoldState bytes (DESIGN §b.5). */
	nsFoldV1: 2,
	/** Canonical CfgFoldState bytes. */
	cfgFoldV1: 3,
	/** Empty state: GC marker for retired streams (pruned tombstones, abandoned merged bodies). */
	retired: 4,
} as const;
export type CheckpointEncoding = (typeof CheckpointEncoding)[keyof typeof CheckpointEncoding];

export interface CheckpointContent {
	readonly encoding: CheckpointEncoding;
	readonly coversSeq: Seq;
	readonly foldRulesVersion: number;
	readonly state: Uint8Array;
}

export interface BlobChunkContent {
	readonly hash: ContentHash;
	readonly index: number;
	readonly total: number;
	readonly totalSize: number;
	readonly chunk: Uint8Array;
}

export interface BodyUpdateRefContent {
	readonly hash: ContentHash;
	readonly size: number;
}

/** What the AAD binds. Frames bind clientFrameId; checkpoints bind coversSeq. */
export type EnvelopeBinding =
	| { readonly t: "frame"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId }
	| { readonly t: "checkpoint"; readonly stream: StreamName; readonly coversSeq: Seq };

/** Result of the ingest gate's envelope stage (DESIGN §d.6). */
export type EnvelopeOpenResult =
	| { readonly ok: true; readonly header: EnvelopeHeader; readonly inner: InnerEnvelope }
	| { readonly ok: false; readonly reason: "malformed" | "unsupported-version" | "unsupported-suite" | "unknown-key" | "auth-failed" | "kind-stream-mismatch" };

/** Which envelope kinds a stream class may carry. Anything else is quarantined. */
export const ALLOWED_KINDS: Readonly<Record<"ns" | "cfg" | "body" | "canvas" | "blobchunk", readonly EnvelopeKind[]>> = {
	ns: ["nsOps", "checkpoint"],
	cfg: ["cfgOps", "checkpoint"],
	body: ["bodyUpdate", "bodyUpdateRef", "checkpoint"],
	canvas: ["canvasUpdate", "bodyUpdateRef", "checkpoint"],
	blobchunk: ["blobChunk", "checkpoint"],
};

/** AAD prefix for frames and checkpoints (UTF-8). */
export const AAD_FRAME_PREFIX = "yaos/f1";
export const AAD_CHECKPOINT_PREFIX = "yaos/c1";
