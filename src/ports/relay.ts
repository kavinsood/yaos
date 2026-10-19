/**
 * RelayPort: the opaque ordered mailbox. DESIGN §b, §d.7, §h, §i.6.
 * Normative wire contract: docs/client-remake/relay-wire.md. The adapter
 * (WP-C, src/engine/relay/wsRelay.ts) maps that wire onto this port.
 *
 * Contract assumptions this client depends on:
 *  R1 Every committed row gets the next vault-wide seq: contiguous from 1
 *     within one vaultEpoch (= the relay's vaultGeneration string). This seq
 *     space is unrelated to any legacy vault sequence.
 *  R2 A session admitted with headSeq H delivers every seq > H committed while
 *     it is open exactly once, in seq order: as "committed" (another device's
 *     frame, payload joined from PROVISIONAL + COMMIT_NOTICE for b:/c:), as a
 *     "receipt" (own frame; never echoed), or as a "skipped" row (another
 *     device's b:/c: row outside the session's subscription: only (stream,
 *     seq), the payload is read later). Receipts for one group commit come
 *     after that commit's broadcasts and skips, so a receipt for seq s arrives
 *     after every seq < s was delivered. A gap means a lost socket or a bug:
 *     the engine recovers with feed + read (DESIGN §d.7).
 *  R3 Payloads are pushed for every vault-global stream (anything not b:/c:),
 *     for the b:/c: streams of the session's last subscribe() set, and for
 *     rows of this device's other sockets; every other b:/c: row is skipped.
 *     A session that has not subscribed yet has the empty set. The relay keeps
 *     the set across a runtime restart only when it is small; the adapter
 *     resends it on STREAM_RESEND, and until then the session may have the
 *     empty set again. Any set is correct: it only moves rows between "pushed
 *     now" and "skipped, read later".
 *     Frames are committed in arrival order; a group commit fails or succeeds
 *     as a whole and does NOT fence later frames; a close or a relay restart
 *     ("resendUnreceipted") loses every unreceipted frame. The client never
 *     relies on fencing.
 *  R4 Dedupe by (deviceId, clientFrameId) is exact only within a recent
 *     per-stream window; outside it a resend is appended again with a new seq.
 *     Every payload must be idempotent to fold/apply twice (ns/cfg: fold
 *     dedupe ring + send window, DESIGN §c.3; bodies: CRDT idempotence).
 *     Same id with different bytes is refused ("frame-id-conflict").
 *  R5 read() returns the stream's checkpoint when the rows below gcSeq are
 *     gone, or when preferCheckpoint is set and the checkpoint is newer than
 *     afterSeq; rows then start after checkpoint.coversSeq. Reads and feeds do
 *     not flush the group-commit buffer: they may lag live delivery.
 *  R6 putCheckpoint is a CAS on the stream's current checkpoint coversSeq; it
 *     travels over HTTP (<= maxCheckpointBytes), not the socket.
 *  R7 A COMMIT_NOTICE for a store-deduped resend may carry an OLDER seq: the
 *     adapter still emits "committed"; the engine treats seq <= the stream's
 *     appliedSeq as a settle, not progress.
 */

import type { Unsubscribe } from "./common";
import type { ClientFrameId, DeviceId, Seq, StreamName, VaultEpoch, VaultId } from "../core/types";

export interface RelayConnectParams {
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
}

/** From VAULT_READY.limits. */
export interface RelayLimits {
	/** maxPayloadBytes (1 MiB): the sealed envelope must fit. */
	readonly maxFrameBytes: number;
	readonly maxCheckpointBytes: number;
	/** Per-device token bucket shared by its sockets (rateBytesPerSec / burstBytes); overdraft closes 1013. */
	readonly appendBytesPerSec: number;
	readonly burstBytes: number;
	/** Streams per feed() page. */
	readonly feedPageRows: number;
	/** Payload bytes per read() page, and per readBatch() request. */
	readonly readPageBytes: number;
	/** Streams per readBatch() request (VAULT_READY readBatchMaxStreams, required). */
	readonly readBatchStreams: number;
	/** Streams per subscribe() set (VAULT_READY limits.maxSubscriptions). */
	readonly maxSubscriptions: number;
}

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
	 * null only when a COMMIT_NOTICE arrived and the adapter no longer holds
	 * the matching PROVISIONAL payload; the engine marks the stream stale and
	 * catches up with read() (DESIGN §d.7).
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
	/** Streams with commits in (afterSeq, throughSeq], each with its last seq. */
	readonly entries: readonly { readonly stream: StreamName; readonly lastSeq: Seq }[];
	/** Every commit <= throughSeq is described by this and earlier pages (wire: nextAfter, or head on the last page). */
	readonly throughSeq: Seq;
	readonly headSeq: Seq;
	readonly more: boolean;
}

export interface ReadPage {
	readonly checkpoint: { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null;
	readonly rows: readonly RelayRow[];
	/** Stream's last committed seq at read time (0 = unknown stream). */
	readonly lastSeq: Seq;
	/** Stream's current checkpoint coversSeq (0 = none): the CAS base for putCheckpoint. */
	readonly checkpointSeq: Seq;
	/** Highest collected seq (0 = none): rows at or below it are gone, every row above it is still served (relay-wire §7). */
	readonly gcSeq: Seq;
	/** Pass as afterSeq for the next page. */
	readonly nextAfterSeq: Seq;
	readonly more: boolean;
}

/** One entry of readBatch(): the same arguments as read(). */
export interface ReadRequest {
	readonly stream: StreamName;
	readonly afterSeq: Seq;
	readonly preferCheckpoint: boolean;
}

export type PutCheckpointResult =
	| { readonly t: "ok" }
	/** Another device won the CAS. */
	| { readonly t: "conflict"; readonly currentCoversSeq: Seq }
	| { readonly t: "refused"; readonly reason: "not-advancing" | "ahead-of-stream" | "stream-not-found" | "too-large" | "daily-limit" | "forbidden"; readonly retryAfterMs: number | null };

/**
 * Wire mapping: STREAM_APPEND_REJECTED client_frame_id_conflict -> frame-id-conflict,
 * write_forbidden -> forbidden; VAULT_ERROR durability_failed -> durability,
 * cf_daily_limit -> daily-limit (one event per listed clientFrameId).
 * Oversize/malformed/rate are socket closes (1009/1008/1013), not refusals.
 */
export type RefusalReason =
	| "forbidden"
	/** Free-plan daily row limit latched; resend after retryAfterMs (wire resetAt). */
	| "daily-limit"
	/** Commit failed server-side; nothing was written; resend. */
	| "durability"
	/** Same clientFrameId already used with different bytes or stream (conflictSeq when known). */
	| "frame-id-conflict";

export type RelayEvent =
	| { readonly t: "receipt"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly seq: Seq; readonly deduped: boolean }
	| { readonly t: "committed"; readonly frame: CommittedFrame }
	/** b:/c: only, before the commit. Never advances a cursor. */
	| { readonly t: "provisional"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	/** One frame was not committed (later frames are unaffected). */
	| { readonly t: "refused"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly reason: RefusalReason; readonly retryAfterMs: number | null; readonly conflictSeq: Seq | null }
	/** A PROVISIONAL from another device will never commit under that id. */
	| { readonly t: "provisionalDropped"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId }
	/**
	 * STREAM_RESEND: the relay runtime restarted. Unreceipted frames may be
	 * lost: resend all of them in original order. Held PROVISIONALs without a
	 * notice are discarded by the adapter (their streams may need a read).
	 */
	| { readonly t: "resendUnreceipted"; readonly headSeq: Seq }
	/**
	 * STREAM_SKIPPED: committed rows of other devices' b:/c: streams outside this session's subscription (R2, R3),
	 * in seq order. Each seq is accounted like a committed row whose payload the engine reads later.
	 */
	| { readonly t: "skipped"; readonly rows: readonly { readonly stream: StreamName; readonly seq: Seq }[] }
	/** VAULT_BACKPRESSURE: a 1013 close follows. */
	| { readonly t: "backpressure" }
	/** Head hint (STREAM_RECEIPTS.head, VAULT_PONG.head): a gap probe. */
	| { readonly t: "head"; readonly headSeq: Seq }
	/** errorCode: the control error preceding the close (e.g. "unauthorized", "update_required", "authority_superseded"). */
	| { readonly t: "closed"; readonly code: number; readonly errorCode: string | null; readonly wasClean: boolean };

export interface RelaySession {
	/** VAULT_READY.vaultEpoch. The engine compares it with its DB identity (DESIGN §c.12). */
	readonly vaultEpoch: VaultEpoch;
	/** VAULT_READY.head: every seq > headSeq is delivered on this session (R2). */
	readonly headSeq: Seq;
	/** false for read-only members: the engine never appends or puts checkpoints. */
	readonly canWrite: boolean;
	readonly limits: RelayLimits;
	/** Queued and sent in call order. Outcome arrives as receipt / refused / closed / resendUnreceipted. */
	append(frame: AppendFrame): void;
	/** Bytes queued but not yet written to the socket (backpressure). */
	bufferedBytes(): number;
	/**
	 * Replace the set of b:/c: streams whose rows are pushed live (R3); at most limits.maxSubscriptions names. No
	 * reply: the set takes effect for commits after the relay processed it. The adapter keeps the last set and
	 * sends it again on STREAM_RESEND. Until the first set: the empty set (R3).
	 */
	subscribe(streams: readonly StreamName[]): void;
	feed(afterSeq: Seq): Promise<FeedPage>;
	/** preferCheckpoint: also take a newer checkpoint when rows still exist (fresh docs). */
	read(stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean): Promise<ReadPage>;
	/**
	 * The first page of each request, for a non-empty prefix of `reqs` in order: one relay request under one
	 * readPageBytes budget (relay-wire §7.1). Requests without a page are re-requested later. At most
	 * readBatchStreams requests are sent; a single request is read(reqs[0]).
	 */
	readBatch(reqs: readonly ReadRequest[]): Promise<readonly ReadPage[]>;
	putCheckpoint(stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): Promise<PutCheckpointResult>;
	/** Events received before the first listener is attached are buffered, so nothing after headSeq is lost. */
	onEvent(listener: (event: RelayEvent) => void): Unsubscribe;
	/**
	 * One round trip on this socket with the liveness frames (VAULT_PING / VAULT_PONG, relay-wire §4.2-4.3): resolves with the
	 * pong's head once the pong for this probe arrives, rejects when the session closes first. No deadline of its own.
	 * Only the device check calls it (engine/compose/deviceCheck.ts).
	 */
	ping(): Promise<{ readonly headSeq: Seq }>;
	close(code: number, reason: string): void;
}

export type RelayConnectResult =
	| { readonly ok: true; readonly session: RelaySession }
	| {
		readonly ok: false;
		/**
		 * unauthorized: ticket 401 / upgrade "unauthorized" -> stop, re-pair.
		 * superseded: 409 authority_superseded -> re-ticket and retry.
		 * update-required: streams version mismatch.
		 * unavailable: network, 5xx, 429, draining -> backoff.
		 */
		readonly reason: "unauthorized" | "superseded" | "update-required" | "unclaimed" | "not-found" | "unavailable" | "daily-limit";
		readonly retryAfterMs: number | null;
	};

export interface RelayPort {
	connect(params: RelayConnectParams): Promise<RelayConnectResult>;
}
