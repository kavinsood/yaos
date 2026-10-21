/**
 * The log side as the disk side sees it (DESIGN §f.1): LogPort (reconcile),
 * CfgLogPort (settings) and SnapIndexPort (snapshots) over one LogEngine.
 *
 * view() joins the optimistic ns overlay (committed fold + own pending ns
 * frames, core/ns/overlay) with per-doc body info from the stream records. It
 * is memoized: the reconcile context reads it per synced write (touchSeq), so
 * the owner invalidates it on fold / submit / body change and before a pass.
 */

import { digestHex } from "../../core/hash/digest";
import { markdownCanonicalBytes } from "../../core/hash/markdownLf";
import { sha256Hex } from "../../core/hash/sha256";
import { SYNC_HASH_MAX_BYTES } from "../../core/limits";
import { pathKey } from "../../core/paths/pathKey";
import { EMPTY_CONTENT_HASH } from "../../core/plan/planner";
import type * as Y from "yjs";
import type { Handle } from "../body/handles";
import { prunedRestoreDuty } from "../../core/ns/pruned";
import { canvasDocHashInput } from "../reconcile/canvasDoc";
import {
	docStream, type BodyVersion, type CfgFoldState, type CfgOp, type ContentHash, type DeviceId, type DocId, type NsOp,
	type PathKey, type RemoteEntry, type Seq, type StreamName,
} from "../../core/types";
import type { BodyHandle, LogPort, RemoteView, SubmitNsOptions } from "../reconcile/deps";
import type { LogEngine } from "../runtime/engine";
import type { CreatorStatus } from "./creatorStatus";
import type { CfgLogPort } from "../settings/cfgSync";
import type { SnapIndexPort } from "../snapshots/snapIndex";
import type { SnapOp } from "../../core/snap/record";

export class ComposedLog implements LogPort {
	private memo: RemoteView | null = null;
	/** Set once the log reached `live` in this runtime (§f.2 gate: ns caught up once in this session). */
	nsCaughtUp = false;
	private readonly hashMemo = new Map<DocId, { key: string; hash: ContentHash }>();
	stats = { views: 0, viewMemoHits: 0, acquires: 0 };

	constructor(readonly log: LogEngine, private readonly onSubmit: () => void = () => undefined, private readonly creators: CreatorStatus | null = null) {}

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
		const prunedBody = new Map<DocId, BodyVersion>();
		const lostCreateBody = new Set<DocId>();
		const ask = new Set<DeviceId>();
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
			// A create whose initial body never reached the relay (ns and stream heads read in this session, no row
			// anywhere, no own frame left) and never will: an own create (this store's, or an earlier store's of this
			// install: identity-per-store §5.2) lost with the store (wipe, mirror lag), or a create of a store the
			// server reports retired (DESIGN §i.5 "Abandoned creates"; asked about here, decided by CreatorStatus).
			if (this.nsCaughtUp && e.state === "live" && body.caughtUp && !body.hasContent && e.createHash !== EMPTY_CONTENT_HASH && !pending.has(e.docId)) {
				if (e.createdBy === c.self || c.lineage.has(e.createdBy) || this.creators?.abandoned(e.createdBy)) lostCreateBody.add(e.docId);
				else ask.add(e.createdBy);
			}
			if (body.caughtUp && e.state === "live") {
				const h = this.knownHash(e.docId, e.kind as "markdown" | "canvas", body.stream, body.version);
				if (h) textHash.set(e.docId, h);
			}
		}
		// Pruned docs (§c.9): a doc the view no longer holds keeps its restore duty while this device's stream record of
		// it does (tDropStream keeps it while a synced record names the doc): rows past the removed delete's base. Its
		// replica's version tells the planner whether the file holds what the replica has.
		for (const rec of c.repo.streams()) {
			if ((rec.cls !== "body" && rec.cls !== "canvas") || !rec.docId || ns.state.entries.has(rec.docId)) continue;
			const base = c.ns.removedDeletes.get(rec.docId)?.deleteBaseBodySeq ?? rec.prunedDeleteBase;
			const duty = prunedRestoreDuty(rec, base, c.ns.state.entries.get(rec.docId));
			if (duty) restoreDuty.add(rec.docId);
			if (duty || pending.has(rec.docId)) prunedBody.set(rec.docId, rec.bodyVersion);
		}
		this.creators?.seen(ask);
		for (const [key, id] of ns.index.byPathKey) remoteByPathKey.set(key, id);
		const pendingMoves = new Map<DocId, Set<PathKey>>();
		for (const f of ns.pending) {
			for (const op of f.ops) {
				if (op.t !== "rename" && op.t !== "restore") continue;
				let keys = pendingMoves.get(op.docId);
				if (!keys) pendingMoves.set(op.docId, (keys = new Set()));
				keys.add(pathKey(op.path));
			}
		}
		this.memo = {
			remote, remoteByPathKey, nsCoversSeq: ns.coversSeq,
			nsReady: this.nsCaughtUp && ns.halted === null && !ns.overlayHalted,
			docsWithPendingBody: pending, restoreDuty, prunedBody, lostCreateBody, textHash, appliedSeq, pendingMoves,
		};
		return this.memo;
	}

	/**
	 * streams.textHash for a caught-up replica: what warmTextHashes took for its body version. Never loads a doc and
	 * never blocks on a digest: a resident replica that changed since (a remote row or a keystroke after the warm) is
	 * hashed here only when its text is at most SYNC_HASH_MAX_BYTES, else it has no textHash in this view (the next
	 * pass warms it). A replica evicted since it was hashed keeps the hash while its body version is the one hashed:
	 * the memo already pairs a hash with a version for resident replicas, as the planner's Rc pairs S with one, and
	 * an evicted replica had no open frame (eviction is clean-only) and gets no keystroke. Without it, a doc loaded for
	 * its hash (runner loadTextHash) that the residency budget evicts again at once never has one.
	 */
	private knownHash(docId: DocId, kind: "markdown" | "canvas", stream: StreamName, v: BodyVersion): ContentHash | null {
		const h = this.log.c.handles.peek(stream);
		const key = versionKey(v);
		const m = this.hashMemo.get(docId);
		if (h === undefined) return m && m.key === key ? m.hash : null;
		if (!hashable(h)) return null;
		if (m && m.key === key) return m.hash;
		const input = textHashInput(kind, h.doc, SYNC_HASH_MAX_BYTES);
		if (input === null || input.length > SYNC_HASH_MAX_BYTES) return null;
		return this.remember(docId, key, sha256Hex(input) as ContentHash);
	}

	/**
	 * Take the textHash of every resident, framed replica whose body version has none yet, through HashPort, one
	 * at a time (a reconcile pass, before it reads the view). The key is the version the text was read at: a
	 * replica that moves on during the digest keeps its old key, so view() never pairs a hash with a newer text.
	 */
	async warmTextHashes(): Promise<void> {
		const log = this.log;
		let added = false;
		for (const h of [...log.c.handles.all()]) {
			if (!hashable(h)) continue;
			const kind = h.cls === "canvas" ? "canvas" : "markdown";
			const body = log.bodyInfo(h.docId, kind);
			if (!body || !body.caughtUp) continue;
			const key = versionKey(body.version);
			if (this.hashMemo.get(h.docId)?.key === key) continue;
			const input = textHashInput(kind, h.doc, Infinity);
			if (input === null) continue;
			this.remember(h.docId, key, (await digestHex(log.c.ports.hash, input)) as ContentHash);
			added = true;
		}
		if (added) this.invalidate();
	}

	private remember(docId: DocId, key: string, hash: ContentHash): ContentHash {
		this.hashMemo.delete(docId);
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

	wantFresh(docIds: readonly DocId[]): void {
		this.log.wantFresh(docIds);
	}

	async acquireBody(docId: DocId, kind: "markdown" | "canvas"): Promise<BodyHandle | null> {
		const view = this.view();
		const known = view.remote.get(docId);
		// A pruned doc with a restore duty: its replica is merged into the file before the re-create (§c.9).
		const pruned = !known && view.prunedBody.has(docId) && this.log.c.repo.stream(docStream(kind, docId)!) !== undefined;
		if (!pruned && (!known || known.kind !== kind)) return null;
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

	// ---- settings + snapshots ------------------------------------------------------

	readonly cfg: CfgLogPort = {
		view: (): CfgFoldState => this.log.cfgView(),
		submitCfg: async (ops: readonly CfgOp[]): Promise<void> => {
			if (ops.length > 0) await this.log.submitCfg(ops);
		},
	};

	readonly snap: SnapIndexPort = snapIndexPort(() => this.log, () => this.nsCaughtUp);
}

function snapIndexPort(log: () => LogEngine, liveOnce: () => boolean): SnapIndexPort {
	return {
		get self() {
			return log().c.self;
		},
		get lineage() {
			return log().c.lineage;
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

/** A replica whose text is the doc's (no open frame, no unresolved ref row). */
function hashable(h: Handle | undefined): h is Handle {
	return h !== undefined && h.builder.empty && h.unresolvedRefs === 0;
}

function versionKey(v: BodyVersion): string {
	return `${v.remoteSeq}:${v.localOrder}`;
}

/**
 * What streams.textHash digests: markdownCanonicalBytes of the text, or the canvas projection's hash input (null =
 * invalid canvas). null also when a markdown text cannot fit in `maxBytes`, so a large doc is not encoded for
 * nothing: its canonical bytes are at least (UTF-16 length - 1) / 2 (one leading BOM is stripped, a CRLF pair is 2
 * units and 1 byte, every other unit at least 1 byte).
 */
function textHashInput(kind: "markdown" | "canvas", doc: Y.Doc, maxBytes: number): Uint8Array | null {
	if (kind === "canvas") return canvasDocHashInput(doc);
	const text = doc.getText("text");
	return text.length > 2 * maxBytes + 1 ? null : markdownCanonicalBytes(text.toString());
}
