/**
 * What the disk side (WP-B) needs from the rest of the engine. DESIGN §f, §d, §g.
 *
 * WP-C implements LogPort over the body engine + ns runtime; WP-D's engine
 * glue implements DiskGateway over the main<->engine protocol (`readRequest` /
 * `diskOps` round trips). Tests use src/engine/reconcile/testkit/*.
 */

import type * as Y from "yjs";
import type {
	BodyVersion, ContentHash, DocId, NsOp, NsOpOutcome, PathKey, RemoteEntry, Seq,
} from "../../core/types";
import type { DiskOp, DiskOpResult, DiskReadRequest, DiskReadResult, Lane } from "../../protocol/messages";

/**
 * Engine side of `readRequest` / `diskOps` (DESIGN §g.2). The host executes ops in order.
 * `exec` transfers write bytes ([T]): after the call they are detached, never reuse them.
 */
export interface DiskGateway {
	read(reads: readonly DiskReadRequest[], lane: Lane): Promise<readonly DiskReadResult[]>;
	exec(ops: readonly DiskOp[], lane: Lane): Promise<readonly DiskOpResult[]>;
}

/** Snapshot of the log side's view used to build a PlannerInput (+ PlannerContext). */
export interface RemoteView {
	/** OptimisticRemote (committed fold + own pending ns ops) joined with body info. */
	readonly remote: ReadonlyMap<DocId, RemoteEntry>;
	readonly remoteByPathKey: ReadonlyMap<PathKey, DocId>;
	readonly nsCoversSeq: Seq;
	/** ns caught up once in this session and not halted (§f.2 gates). */
	readonly nsReady: boolean;
	/** V3 digest mismatch (§b.5). */
	readonly divergence: boolean;
	readonly docsWithPendingBody: ReadonlySet<DocId>;
	/** Restore duty (§c.7) beyond docsWithPendingBody. */
	readonly restoreDuty: ReadonlySet<DocId>;
	/** streams.textHash of caught-up md/canvas docs. */
	readonly textHash: ReadonlyMap<DocId, ContentHash>;
	/** streams.appliedSeq per doc (nsDelete.baseBodySeq). */
	readonly appliedSeq: ReadonlyMap<DocId, Seq>;
}

/**
 * A resident worker replica held by a job (DESIGN §d.1). While held the doc is
 * not evicted. Markdown: the Y.Text "text" of `doc`. Canvas: maps "nodes",
 * "edges", "doc" (§j.2).
 */
export interface BodyHandle {
	readonly docId: DocId;
	readonly doc: Y.Doc;
	/** Origin tag for merge-engine transactions (the body engine's MERGE symbol). */
	readonly mergeOrigin: unknown;
	/** A main replica is attached (open note): the projection never writes the file (§d.2). */
	readonly bound: boolean;
	/**
	 * T_edit for everything applied with `mergeOrigin` since acquire / the last
	 * call: the frame builder closes the frame(s) into the outbox (§d.4). The
	 * returned version is the body version after those frames.
	 */
	commitEdits(): Promise<BodyVersion>;
	/** Current body version (streams.bodyVersion incl. own frames). */
	version(): BodyVersion;
	release(): void;
}

export interface LogPort {
	view(): RemoteView;
	/**
	 * Hand ns ops to the ns runtime: framed (<= MAX_NS_OPS_PER_FRAME), put in the
	 * outbox (T_edit) and reflected in the optimistic overlay before resolving.
	 */
	submitNs(ops: readonly NsOp[]): Promise<void>;
	/** Load (or pin) the worker replica. null = the doc has no body stream (unknown / blob). */
	acquireBody(docId: DocId, kind: "markdown" | "canvas"): Promise<BodyHandle | null>;
}

/**
 * One own ns op as the committed fold decided it (DESIGN §c.13). The ns runtime
 * (WP-C) hands these to Reconciler.applyOwnFold for the S1 synced update.
 */
export interface OwnFoldEvent {
	readonly op: NsOp;
	readonly seq: Seq;
	readonly outcome: NsOpOutcome;
	/** Committed entry after the op (null if unknown). */
	readonly entry: RemoteEntry | null;
}
