/**
 * The log side as the disk side sees it (DESIGN §f.1): LogPort (reconcile),
 * CfgLogPort (settings) and BlobChunkLog (x: chunks) over one LogEngine.
 *
 * view() joins the optimistic ns overlay (committed fold + own pending ns
 * frames, core/ns/overlay) with per-doc body info from the stream records. It
 * is memoized: the reconcile context reads it per synced write (touchSeq), so
 * the owner invalidates it on fold / submit / body change and before a pass.
 */

import type { BlobChunkContent } from "../../core/envelope";
import { markdownContentHash } from "../../core/hash/markdownLf";
import { EMPTY_CONTENT_HASH } from "../../core/plan/planner";
import { canvasDocHash } from "../reconcile/canvasDoc";
import type {
	BodyVersion, CfgFoldState, CfgOp, ContentHash, DocId, NsOp, PathKey, RemoteEntry, Seq, StreamName,
} from "../../core/types";
import type { BlobChunkLog } from "../blobs/chunks";
import type { BodyHandle, LogPort, RemoteView, SubmitNsOptions } from "../reconcile/deps";
import type { LogEngine } from "../runtime/engine";
import type { CfgLogPort } from "../settings/cfgSync";
import type { SnapIndexPort } from "../snapshots/snapIndex";
import type { SnapOp } from "../../core/snap/record";

export class ComposedLog implements LogPort {
	private memo: RemoteView | null = null;
	/** Set once the log reached `live` in this runtime (§f.2 gate: ns caught up once in this session). */
	nsCaughtUp = false;
	private readonly hashMemo = new Map<DocId, { key: string; hash: ContentHash }>();
	stats = { views: 0, viewMemoHits: 0, acquires: 0 };

	constructor(readonly log: LogEngine, private readonly onSubmit: () => void = () => undefined) {}

	invalidate(): void {
		this.memo = null;
	}

	// ---- RemoteView --------------------------------------------------------------

	view(): RemoteView {
		if (this.memo) {
			this.stats.viewMemoHits++;
			return this.memo;
		}
		this.stats.views++;
		const log = this.log;
		const c = log.c;
		const ns = log.nsView();
		const remote = new Map<DocId, RemoteEntry>();
		const remoteByPathKey = new Map<PathKey, DocId>();
		const textHash = new Map<DocId, ContentHash>();
		const appliedSeq = new Map<DocId, Seq>();
		const restoreDuty = new Set<DocId>();
		const lostCreateBody = new Set<DocId>();
		const pending = log.docsWithPendingBody();
		for (const h of c.handles.all()) if (!h.builder.empty) pending.add(h.docId);
		for (const e of ns.state.entries.values()) {
			const body = e.kind === "blob" ? null : log.bodyInfo(e.docId, e.kind);
			remote.set(e.docId, {
				docId: e.docId, kind: e.kind, path: e.path, pathKey: e.pathKey, state: e.state, lastTouchSeq: e.lastTouchSeq,
				deletedSeq: e.deletedSeq, deleteBaseBodySeq: e.deleteBaseBodySeq, createHash: e.createHash, blob: e.blob,
				aliasOf: e.aliasOf, pendingLocal: ns.pendingDocs.has(e.docId), body,
			});
			if (!body) continue;
			const rec = c.repo.stream(body.stream);
			if (rec) appliedSeq.set(e.docId, Math.max(rec.appliedSeq, rec.lastOwnSeq));
			// Primary restore duty (§c.7): this device authored body rows the deleter had not seen.
			// Fallback duty, here without the 30 s grace (integration-notes deviation): rows exist
			// past the delete base, so some edit was not seen by the deleter whoever authored it.
			if (e.state === "deleted" && rec && (rec.lastOwnSeq > e.deleteBaseBodySeq || rec.remoteHeadSeq > e.deleteBaseBodySeq)) restoreDuty.add(e.docId);
			// Own create, ns and stream heads read in this session, no row anywhere and no own frame left: the
			// initial body was lost with this device's store (wipe, mirror lag). Nobody else can supply it.
			if (this.nsCaughtUp && e.state === "live" && e.createdBy === c.self && body.caughtUp && !body.hasContent
				&& e.createHash !== EMPTY_CONTENT_HASH && !pending.has(e.docId)) lostCreateBody.add(e.docId);
			if (body.caughtUp && e.state === "live") {
				const h = this.residentHash(e.docId, e.kind as "markdown" | "canvas", body.stream, body.version);
				if (h) textHash.set(e.docId, h);
			}
		}
		for (const [key, id] of ns.index.byPathKey) remoteByPathKey.set(key, id);
		this.memo = {
			remote, remoteByPathKey, nsCoversSeq: ns.coversSeq,
			nsReady: this.nsCaughtUp && ns.halted === null && !ns.overlayHalted,
			divergence: false,
			docsWithPendingBody: pending, restoreDuty, lostCreateBody, textHash, appliedSeq,
		};
		return this.memo;
	}

	/** streams.textHash for a resident, framed replica (memoized per body version). Never loads a doc. */
	private residentHash(docId: DocId, kind: "markdown" | "canvas", stream: StreamName, v: BodyVersion): ContentHash | null {
		const h = this.log.c.handles.peek(stream);
		if (!h || !h.builder.empty || h.unresolvedRefs > 0) return null;
		const key = `${v.remoteSeq}:${v.localOrder}`;
		const m = this.hashMemo.get(docId);
		if (m && m.key === key) return m.hash;
		const hash = kind === "canvas" ? canvasDocHash(h.doc) : markdownContentHash(h.doc.getText("text").toString());
		if (hash === null) return null;
		this.hashMemo.set(docId, { key, hash });
		if (this.hashMemo.size > 4096) this.hashMemo.delete(this.hashMemo.keys().next().value as DocId);
		return hash;
	}

	// ---- LogPort writes ----------------------------------------------------------

	async submitNs(ops: readonly NsOp[], opts?: SubmitNsOptions): Promise<void> {
		if (ops.length === 0) return;
		try {
			await this.log.submitNs(ops, opts);
		} finally {
			this.invalidate();
			this.onSubmit();
		}
	}

	corkNs(): () => void {
		return this.log.corkNs();
	}

	async acquireBody(docId: DocId, kind: "markdown" | "canvas"): Promise<BodyHandle | null> {
		const known = this.view().remote.get(docId);
		if (!known || known.kind !== kind) return null;
		this.stats.acquires++;
		const h = await this.log.openBody(docId, kind);
		if (!h) return null;
		const invalidate = (): void => this.invalidate();
		return {
			docId, doc: h.doc, mergeOrigin: h.mergeOrigin,
			get bound() {
				return h.bound;
			},
			commitEdits: async () => {
				try {
					return await h.commitEdits();
				} finally {
					invalidate();
				}
			},
			version: () => h.version(),
			release: () => h.release(),
		};
	}

	// ---- settings + blobs ----------------------------------------------------------

	readonly cfg: CfgLogPort = {
		view: (): CfgFoldState => this.log.cfgView(),
		submitCfg: async (ops: readonly CfgOp[]): Promise<void> => {
			if (ops.length > 0) await this.log.submitCfg(ops);
		},
	};

	readonly snap: SnapIndexPort = snapIndexPort(() => this.log, () => this.nsCaughtUp);

	readonly chunks: BlobChunkLog = {
		appendChunks: (hash: ContentHash, chunks: readonly BlobChunkContent[]) => this.log.appendBlobChunks(hash, chunks),
		readChunks: (hash: ContentHash) => this.log.readBlobChunks(hash),
	};
}

function snapIndexPort(log: () => LogEngine, liveOnce: () => boolean): SnapIndexPort {
	return {
		get self() {
			return log().c.self;
		},
		view: () => {
			const v = log().snapView();
			return { state: v.state, ready: liveOnce() && v.caughtUp };
		},
		submit: async (ops: readonly SnapOp[]): Promise<void> => {
			if (ops.length > 0) await log().submitSnap(ops);
		},
	};
}
