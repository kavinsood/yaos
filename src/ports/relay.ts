/**
 * RelayPort: the opaque ordered mailbox. DESIGN §b, §h, §i.6.
 *
 * Contract assumptions this client depends on (checked against
 * server/src/streams/{protocol,relay}.ts; relay-wire.md is authoritative):
 *  R1 Every committed frame gets a vault-wide seq within vaultEpoch.
 *  R2 After subscribe() returns headSeq H, the session delivers every committed
 *     frame with seq > H appended by OTHER sessions, in seq order, without gaps,
 *     until it closes. Frames appended on this session are never echoed; their
 *     outcome is a receipt. (Other sessions of the same device see them as
 *     ordinary committed frames.) A receipt for seq s arrives after every
 *     committed frame with seq < s has been delivered on this session.
 *  R3 Frames appended on one session are committed in send order. A per-frame
 *     rejection does NOT fence later frames; a close (1009/1013/4403) drops
 *     every unreceipted frame. The client never relies on fencing: ns ops are
 *     intents re-derived by the planner, body updates tolerate causal holes.
 *  R4 append is idempotent by (deviceId, clientFrameId): a resend returns the
 *     original seq with deduped = true; the same id with different bytes is
 *     refused ("frame-id-conflict").
 *  R5 read() returns the latest checkpoint (if its coversSeq > afterSeq) plus
 *     every row of the stream with seq > max(afterSeq, checkpoint.coversSeq).
 *  R6 putCheckpoint is a CAS on the stream's current checkpoint coversSeq.
 *  R7 b:/c: frames are broadcast PROVISIONAL (no seq) before the commit, then
 *     a COMMIT_NOTICE (seq, no payload) to sockets holding the provisional.
 *     The adapter joins them into "committed"; a failed commit yields
 *     "provisionalDropped".
  */

import type { Unsubscribe } from "./common";
import type { ClientFrameId, DeviceId, Seq, StreamName, VaultEpoch, VaultId } from "../core/types";

export interface RelayConnectParams {
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
	/** null on first connect; a mismatch closes with 4409. */
	readonly expectedEpoch: VaultEpoch | null;
}

export interface RelayLimits {
	readonly maxFrameBytes: number;
	readonly maxCheckpointBytes: number;
	readonly appendBytesPerSec: number;
	/** Rows returned per read()/feed() page. */
	readonly pageRows: number;
}

export type SubscribeSpec =
	| { readonly t: "all" }
	| { readonly t: "streams"; readonly streams: readonly StreamName[]; readonly prefixes: readonly string[] };

export interface AppendFrame {
	readonly stream: StreamName;
	readonly clientFrameId: ClientFrameId;
	/** Sealed envelope bytes. */
	readonly payload: Uint8Array;
}

export interface CommittedFrame {
	readonly stream: StreamName;
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/**
	 * null only when the relay sent a COMMIT_NOTICE and the adapter no longer
	 * holds the matching PROVISIONAL payload; the engine then fetches the row
	 * with read(stream, seq - 1).
	 */
	readonly payload: Uint8Array | null;
}

export interface RelayRow {
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly payload: Uint8Array;
}

export interface FeedPage {
	/** Streams with commits in (afterSeq, throughSeq], with their last seq. */
	readonly entries: readonly { readonly stream: StreamName; readonly lastSeq: Seq }[];
	/** Every commit <= throughSeq is described by this and earlier pages. */
	readonly throughSeq: Seq;
	readonly headSeq: Seq;
	readonly more: boolean;
}

export interface ReadPage {
	readonly checkpoint: { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null;
	readonly rows: readonly RelayRow[];
	/** Pass as afterSeq for the next page. */
	readonly nextAfterSeq: Seq;
	readonly more: boolean;
}

export type PutCheckpointResult =
	| { readonly t: "ok" }
	| { readonly t: "conflict"; readonly currentCoversSeq: Seq };

export type RefusalReason =
	| "oversize"
	| "rate"
	| "invalid"
	| "forbidden"
	/** Free-plan daily row limit latched; resend after resetAtMs. */
	| "daily-limit"
	/** Commit failed server-side; nothing was written; resend. */
	| "durability"
	/** Same clientFrameId already committed with different bytes (seq given). */
	| "frame-id-conflict";

export type RelayEvent =
	| { readonly t: "receipt"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly seq: Seq; readonly deduped: boolean }
	| { readonly t: "committed"; readonly frame: CommittedFrame }
	| { readonly t: "provisional"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	/** One frame was not committed (R3: later frames are unaffected unless the session closes). */
	| { readonly t: "refused"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly reason: RefusalReason; readonly retryAfterMs: number | null; readonly conflictSeq: Seq | null }
	/** A PROVISIONAL from another device will never commit under that id. */
	| { readonly t: "provisionalDropped"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId }
	/** Relay restarted and may have lost buffered frames: resend every unreceipted frame (deduped by R4). */
	| { readonly t: "resendUnreceipted"; readonly headSeq: Seq }
	/** Relay asks the client to slow down before it closes with 1013. */
	| { readonly t: "backpressure" }
	/** Optional heartbeat letting the cursor advance past own-only commits. */
	| { readonly t: "head"; readonly headSeq: Seq }
	| { readonly t: "closed"; readonly code: number; readonly reason: string; readonly wasClean: boolean };

export interface RelaySession {
	readonly vaultEpoch: VaultEpoch;
	/** false for read-only members: the engine never appends or puts checkpoints. */
	readonly canWrite: boolean;
	readonly limits: RelayLimits;
	subscribe(spec: SubscribeSpec): Promise<{ readonly headSeq: Seq }>;
	/** Queued and sent in call order. Outcome arrives as receipt/refused/closed events. */
	append(frame: AppendFrame): void;
	/** Bytes queued but not yet written to the socket (backpressure). */
	bufferedBytes(): number;
	feed(afterSeq: Seq): Promise<FeedPage>;
	read(stream: StreamName, afterSeq: Seq): Promise<ReadPage>;
	putCheckpoint(stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): Promise<PutCheckpointResult>;
	onEvent(listener: (event: RelayEvent) => void): Unsubscribe;
	close(code: number, reason: string): void;
}

export type RelayConnectResult =
	| { readonly ok: true; readonly session: RelaySession }
	| { readonly ok: false; readonly code: number; readonly reason: string; readonly retryAfterMs: number | null };

export interface RelayPort {
	connect(params: RelayConnectParams): Promise<RelayConnectResult>;
}
