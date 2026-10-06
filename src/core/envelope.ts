/**
 * Client envelope carried in every relay payload (frames and checkpoints).
 * Types, wire constants and tiny pure helpers only; the codec lives in
 * src/core/codec/envelope.ts (WP-A). Byte layout: DESIGN §b, e2ee-design §7.
 *
 *   outer (plaintext, AAD-bound):
 *     u8      formatVersion   = ENVELOPE_FORMAT_VERSION
 *     u8      cryptoSuite     (0 = none, 1 = aes256gcm)
 *     varuint keyEpoch        (0 iff suite = 0)
 *     bytes   sealed          (suite 0: inner verbatim; suite 1: AEAD of inner ‖ Padmé pad)
 *   inner (after CryptoPort.open and, for suite ≠ 0, unpad):
 *     u8      kind            (EnvelopeKindCode)
 *     varuint authorNsSeq
 *     varuint flags           (EnvelopeFlag bits)
 *     varuint frameNo         (nsOps/cfgOps: per-(device, stream) counter ≥ 1; every other kind 0)
 *     bytes   content         (kind-specific, see below)
 */

import type { ClientFrameId, ContentHash, DeviceId, Seq, StreamName } from "./types";

export const ENVELOPE_FORMAT_VERSION = 1;

export const CryptoSuite = {
	none: 0,
	/** AES-256-GCM over WebCrypto with per-vault key epochs (e2ee-design §4.1). Id 1 was a never-shipped reservation. */
	aes256gcm: 1,
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
	/** Snapshot index ops (`snap` stream, DESIGN §j.4). */
	snapOps: 8,
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
	/** Replay counter (e2ee-design §8.2): ≥ 1 for nsOps and cfgOps, 0 for every other kind. */
	readonly frameNo: number;
	readonly content: Uint8Array;
}

/** Kinds that carry a frameNo ≥ 1 and pass the fold's replay window (e2ee-design §8.2). */
export function kindHasFrameNo(kind: EnvelopeKind): boolean {
	return kind === "nsOps" || kind === "cfgOps";
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
 * snapOps:        varuint opCount, then per op: u8 tag, varuint bodyLen, body (SnapOpTag, core/snap/record.ts).
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
	/** Canonical SnapFoldState bytes (`snap` stream). */
	snapFoldV1: 5,
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

/**
 * What the AAD binds besides the header (e2ee-design §7.2). Frames bind the
 * author's deviceId and clientFrameId; checkpoints bind coversSeq.
 */
export type EnvelopeBinding =
	| { readonly t: "frame"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId }
	| { readonly t: "checkpoint"; readonly stream: StreamName; readonly coversSeq: Seq };

/**
 * Envelope-stage failures (DESIGN §d.6, e2ee-design §9.2). "suite-downgrade":
 * a suite-1 reader got suite-0 bytes; "bad-padding": a valid tag over bad
 * Padmé padding. Replay is a fold decision, not an open failure.
 */
export type EnvelopeOpenFailure =
	| "malformed" | "unsupported-version" | "unsupported-suite" | "suite-downgrade"
	| "unknown-key" | "auth-failed" | "bad-padding" | "kind-stream-mismatch";

/** Result of the ingest gate's envelope stage. `header` is present on failures once the outer header decoded. */
export type EnvelopeOpenResult =
	| { readonly ok: true; readonly header: EnvelopeHeader; readonly inner: InnerEnvelope }
	| { readonly ok: false; readonly reason: EnvelopeOpenFailure; readonly header?: EnvelopeHeader };

/** Which envelope kinds a stream class may carry. Anything else is quarantined. */
export const ALLOWED_KINDS: Readonly<Record<"ns" | "cfg" | "snap" | "body" | "canvas" | "blobchunk", readonly EnvelopeKind[]>> = {
	ns: ["nsOps", "checkpoint"],
	cfg: ["cfgOps", "checkpoint"],
	snap: ["snapOps", "checkpoint"],
	body: ["bodyUpdate", "bodyUpdateRef", "checkpoint"],
	canvas: ["canvasUpdate", "bodyUpdateRef", "checkpoint"],
	blobchunk: ["blobChunk", "checkpoint"],
};

/** AAD prefixes for frames and checkpoints (UTF-8, e2ee-design §7.2). */
export const AAD_FRAME_PREFIX = "yaos/f2";
export const AAD_CHECKPOINT_PREFIX = "yaos/c2";
/** AAD prefix of suite-1 sealed blobs (e2ee-design §7.2, §10.2). */
export const AAD_BLOB_PREFIX = "yaos/b2";
/** AAD prefix of k-record key wraps (e2ee-design §11.2). */
export const AAD_KEYRING_PREFIX = "yaos/k2";
/** Sealed-blob format byte (e2ee-design §10.2). */
export const BLOB_FORMAT_VERSION = 1;
