/**
 * RelayPort: the opaque ordered mailbox. DESIGN §b, §h, §i.6.
 *
 * Contract assumptions this client depends on (to reconcile with
 * docs/client-remake/relay-wire.md when it lands):
 *  R1 Every committed frame gets a vault-wide seq within vaultEpoch.
 *  R2 After subscribe() returns headSeq H, the session delivers every committed
 *     frame with seq > H from OTHER devices, in seq order, without gaps, until
 *     the session closes. Own frames are either echoed in the same order
 *     (payload may be elided) or only receipted; the client handles both.
 *  R3 Frames appended on one session are committed in send order; a refused
 *     frame fences the session (later frames on it are dropped, not committed).
 *  R4 append is idempotent by (deviceId, clientFrameId): a resend returns the
 *     original seq with deduped = true.
 *  R5 read() returns the latest checkpoint (if its coversSeq > afterSeq) plus
 *     every row of the stream with seq > max(afterSeq, checkpoint.coversSeq).
 *  R6 putCheckpoint is a CAS on the stream's current checkpoint coversSeq.
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
	/** Ask the relay for an early provisional broadcast (b:/c: only). */
	readonly provisional: boolean;
}

export interface CommittedFrame {
	readonly stream: StreamName;
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** null only for own frames when the relay elides the echo payload. */
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

export type RefusalReason = "oversize" | "rate" | "invalid" | "quota" | "forbidden";

export type RelayEvent =
	| { readonly t: "receipt"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly seq: Seq; readonly deduped: boolean }
	| { readonly t: "committed"; readonly frame: CommittedFrame }
	| { readonly t: "provisional"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	/** Session is fenced after a refusal (R3): reconnect and resend from this frame. */
	| { readonly t: "refused"; readonly clientFrameId: ClientFrameId; readonly reason: RefusalReason; readonly retryAfterMs: number | null }
	/** Optional heartbeat letting the cursor advance past own-only commits. */
	| { readonly t: "head"; readonly headSeq: Seq }
	| { readonly t: "closed"; readonly code: number; readonly reason: string; readonly wasClean: boolean };

export interface RelaySession {
	readonly vaultEpoch: VaultEpoch;
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
