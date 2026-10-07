/**
 * Stub of the log side (ns runtime + body engine + relay + other devices) for
 * WP-B tests. Single process, deterministic:
 *  - ns: a minimal fold (create / rename / delete / restore / setBlob with
 *    suffixing, stale-delete and rev-mismatch). Own ops fold immediately, or
 *    are held (`holdNs = true`) and shown through an optimistic overlay with
 *    `pendingLocal` until `flushNs()`.
 *  - bodies: one Y.Doc replica per doc ("text" root for markdown; "nodes" /
 *    "edges" / "doc" maps for canvas, canvasDoc.ts). Durable state = remote
 *    rows + own committed frames. MERGE-origin updates are framed only by
 *    commitEdits() (T_edit); crash() drops replicas and unframed updates.
 *  - remote devices: remoteCreate / remoteEdit / remoteEditCanvas / remoteRename / remoteDelete / remoteSetBlob.
 *  - textHash: markdownContentHash of the text, canvasDocHash for canvas docs.
 * The real implementation is WP-C's; nothing here is shipped.
 */

import * as Y from "yjs";
import type {
	BodyVersion, ContentHash, DocId, DocKind, NsBlobRef, NsEntryState, NsOp, NsOpOutcome, PathKey, RemoteEntry, Seq, StreamName, VaultPath,
} from "../../../core/types";
import { kindOfPath } from "../../../core/types";
import { canvasContentHash, parseCanvasText, rankCanvasInFileOrder } from "../../../core/hash/canvasCanonical";
import { markdownContentHash } from "../../../core/hash/markdownLf";
import { sha256Hex } from "../../../core/hash/sha256";
import { utf8Encode, utf8Length } from "../../../core/hash/utf8";
import { joinPath, leafOf, parentOf, splitExt, standInPathKey } from "../../../core/plan/pathRules";
import { applyCanvas, canvasDocHash, projectCanvasBytes } from "../canvasDoc";
import type { BodyHandle, LogPort, OwnFoldEvent, RemoteView, SubmitNsOptions } from "../deps";

export const REMOTE = Symbol("REMOTE");
export const MERGE = Symbol("MERGE");
export const LOAD = Symbol("LOAD");
/** A bound editor's keystrokes (editorType): framed with the next commitEdits, like the engine's open frame. */
export const EDITOR = Symbol("EDITOR");

interface Entry {
	docId: DocId;
	kind: DocKind;
	path: VaultPath;
	state: NsEntryState;
	lastTouchSeq: Seq;
	deletedSeq: Seq;
	deleteBaseBodySeq: Seq;
	createHash: ContentHash;
	createSize: number;
	blob: NsBlobRef | null;
	aliasOf: DocId | null;
}

interface Body {
	durable: Uint8Array[];
	remoteSeq: Seq;
	localOrder: number;
	maxRowSeq: Seq;
	caughtUp: boolean;
	frozen: boolean;
	replica: Y.Doc | null;
	unframed: Uint8Array[];
	bound: boolean;
	holders: number;
}

function clone(e: Entry): Entry {
	return { ...e, blob: e.blob ? { ...e.blob } : null };
}

export class StubLog implements LogPort {
	seq = 0;
	private order = 0;
	private readonly entries = new Map<DocId, Entry>();
	private readonly bodies = new Map<DocId, Body>();
	private pending: NsOp[] = [];
	/** All ns ops submitted by this device, in order. */
	readonly submitted: NsOp[] = [];
	/** Own committed body frames (docId, update), in order. */
	readonly frames: { docId: DocId; update: Uint8Array }[] = [];
	holdNs = false;
	/** An own create onto a live create with the same kind and hash folds as `merged` (§c.5 identical duplicate). */
	mergeIdentical = false;
	nsReady = true;
	/** RemoteView.lostCreateBody as the test sets it. */
	lostCreateBody = new Set<DocId>();
	divergence = false;
	/** S1 hook (Reconciler.applyOwnFold). */
	onOwnFold: ((events: readonly OwnFoldEvent[]) => Promise<void>) | null = null;
	/** Called right before acquireBody returns (inject concurrent remote edits). */
	onAcquire: ((docId: DocId) => void) | null = null;
	/** Called as commitEdits starts, before the frame closes (inject editor keystrokes racing a merge). */
	onCommitEdits: ((docId: DocId) => void) | null = null;
	/** "cork", "uncork", "ns live|held" (submitNs), "frame <docId>" (commitEdits), in order. */
	readonly trace: string[] = [];
	private nextClient = 1000;
	private idCounter = 0;

	constructor(readonly pathKey: (p: VaultPath) => PathKey = standInPathKey) {}

	// ---- ns -------------------------------------------------------------------

	private byKey(entries: Map<DocId, Entry>, key: PathKey, except: DocId | null): DocId | undefined {
		for (const e of entries.values()) if (e.state === "live" && e.docId !== except && this.pathKey(e.path) === key) return e.docId;
		return undefined;
	}

	private place(entries: Map<DocId, Entry>, path: VaultPath, self: DocId): VaultPath {
		if (this.byKey(entries, this.pathKey(path), self) === undefined) return path;
		const { stem, ext } = splitExt(leafOf(path));
		for (let n = 2; ; n++) {
			const p = joinPath(parentOf(path), `${stem} (${n})${ext}`);
			if (this.byKey(entries, this.pathKey(p), self) === undefined) return p;
		}
	}

	/** Mini fold of one op at `seq` (mutates `entries`). */
	private foldOp(entries: Map<DocId, Entry>, op: NsOp, seq: Seq): NsOpOutcome {
		switch (op.t) {
			case "create": {
				if (entries.has(op.docId)) return { kind: "ignored", reason: "duplicate-docid" };
				const twin = this.mergeIdentical ? entries.get(this.byKey(entries, this.pathKey(op.path), op.docId) ?? ("" as DocId)) : undefined;
				if (twin && twin.kind === op.kind && twin.createHash === op.contentHash) {
					entries.set(op.docId, {
						docId: op.docId, kind: op.kind, path: twin.path, state: "merged", lastTouchSeq: seq, deletedSeq: 0, deleteBaseBodySeq: 0,
						createHash: op.contentHash, createSize: op.size, blob: null, aliasOf: twin.docId,
					});
					return { kind: "merged", into: twin.docId };
				}
				const finalPath = this.place(entries, op.path, op.docId);
				entries.set(op.docId, {
					docId: op.docId, kind: op.kind, path: finalPath, state: "live", lastTouchSeq: seq, deletedSeq: 0, deleteBaseBodySeq: 0,
					createHash: op.contentHash, createSize: op.size, blob: op.kind === "blob" ? { hash: op.contentHash, size: op.size, rev: seq } : null, aliasOf: null,
				});
				return finalPath === op.path ? { kind: "applied" } : { kind: "suffixed", requestedPath: op.path, finalPath };
			}
			case "rename": {
				const e = entries.get(op.docId);
				if (!e || e.state !== "live") return { kind: "ignored", reason: "unknown-docid" };
				const finalPath = this.place(entries, op.path, op.docId);
				e.path = finalPath;
				e.lastTouchSeq = seq;
				return finalPath === op.path ? { kind: "applied" } : { kind: "suffixed", requestedPath: op.path, finalPath };
			}
			case "delete": {
				const e = entries.get(op.docId);
				if (!e || e.state !== "live") return { kind: "ignored", reason: "already-deleted" };
				const b = this.bodies.get(op.docId);
				if (b && b.maxRowSeq > op.baseBodySeq) return { kind: "ignored", reason: "stale-delete" };
				e.state = "deleted";
				e.deletedSeq = seq;
				e.deleteBaseBodySeq = op.baseBodySeq;
				e.lastTouchSeq = seq;
				return { kind: "deleted" };
			}
			case "restore": {
				const e = entries.get(op.docId);
				if (!e || e.state !== "deleted") return { kind: "ignored", reason: "not-deleted" };
				if (e.deletedSeq !== op.againstDeleteSeq) return { kind: "ignored", reason: "restore-not-current" };
				const finalPath = this.place(entries, op.path, op.docId);
				e.state = "live";
				e.path = finalPath;
				e.deletedSeq = 0;
				e.deleteBaseBodySeq = 0;
				e.lastTouchSeq = seq;
				return { kind: "revived", finalPath };
			}
			case "setBlob": {
				const e = entries.get(op.docId);
				if (!e || e.state !== "live") return { kind: "ignored", reason: "unknown-docid" };
				if (e.kind !== "blob" || !e.blob) return { kind: "ignored", reason: "not-blob" };
				if (e.blob.rev !== op.baseRev) return { kind: "ignored", reason: "rev-mismatch" };
				e.blob = { hash: op.hash, size: op.size, rev: seq };
				e.lastTouchSeq = seq;
				return { kind: "applied" };
			}
			case "upgradeRules":
				return { kind: "ignored", reason: "noop" };
		}
	}

	corkNs(): () => void {
		this.trace.push("cork");
		let open = true;
		return () => {
			if (open) this.trace.push("uncork");
			open = false;
		};
	}

	async submitNs(ops: readonly NsOp[], opts?: SubmitNsOptions): Promise<void> {
		if (ops.length > 0) this.trace.push(opts?.liveCreates === true ? "ns live" : "ns held");
		this.submitted.push(...ops);
		this.pending.push(...ops);
		for (const op of ops) if (op.t === "create" && op.kind !== "blob") this.ensureBody(op.docId);
		if (!this.holdNs) await this.flushNs();
	}

	/** Fold every held own op as committed (receipt), then run the S1 hook. */
	async flushNs(): Promise<readonly OwnFoldEvent[]> {
		const ops = this.pending;
		this.pending = [];
		const events: OwnFoldEvent[] = [];
		for (const op of ops) {
			const seq = ++this.seq;
			const outcome = this.foldOp(this.entries, op, seq);
			const docId = "docId" in op ? op.docId : null;
			if (outcome.kind === "merged" && docId) this.bodies.delete(docId); // held initial frames are dropped (§e.2)
			events.push({ op, seq, outcome, entry: docId ? this.remoteEntry(this.entries.get(docId), false) : null });
		}
		if (events.length > 0 && this.onOwnFold) await this.onOwnFold(events);
		return events;
	}

	/** Drop held own ops (e.g. a test of the fold rejecting them). */
	dropPendingNs(): void {
		this.pending = [];
	}

	// ---- view -----------------------------------------------------------------

	private ensureBody(docId: DocId): Body {
		let b = this.bodies.get(docId);
		if (!b) {
			b = { durable: [], remoteSeq: 0, localOrder: 0, maxRowSeq: 0, caughtUp: true, frozen: false, replica: null, unframed: [], bound: false, holders: 0 };
			this.bodies.set(docId, b);
		}
		return b;
	}

	private durableDoc(b: Body): Y.Doc {
		const d = new Y.Doc();
		d.clientID = 1;
		Y.transact(d, () => {
			for (const u of b.durable) Y.applyUpdate(d, u, LOAD);
		}, LOAD);
		return d;
	}

	/** Text of the doc's durable state (what a fresh load would show). */
	durableText(docId: DocId): string {
		const b = this.bodies.get(docId);
		if (!b) return "";
		return this.durableDoc(b).getText("text").toString();
	}

	/** Text of the resident replica if any, else the durable text. */
	text(docId: DocId): string {
		const b = this.bodies.get(docId);
		if (b?.replica) return b.replica.getText("text").toString();
		return this.durableText(docId);
	}

	/** Canvas Y.Doc: the resident replica if any, else a fresh load of the durable state. */
	canvasDoc(docId: DocId): Y.Doc {
		const b = this.ensureBody(docId);
		return b.replica ?? this.durableDoc(b);
	}

	/** Disk projection text of a canvas doc (null = invalid CRDT). */
	canvasText(docId: DocId): string | null {
		const p = projectCanvasBytes(this.canvasDoc(docId));
		return p.ok ? p.text : null;
	}

	private remoteEntry(e: Entry | undefined, pendingLocal: boolean): RemoteEntry | null {
		if (!e) return null;
		const b = this.bodies.get(e.docId);
		return {
			docId: e.docId, kind: e.kind, path: e.path, pathKey: this.pathKey(e.path), state: e.state, lastTouchSeq: e.lastTouchSeq,
			deletedSeq: e.deletedSeq, deleteBaseBodySeq: e.deleteBaseBodySeq, createHash: e.createHash, blob: e.blob ? { ...e.blob } : null,
			aliasOf: e.aliasOf, pendingLocal,
			body: e.kind === "blob" ? null : {
				stream: `${e.kind === "canvas" ? "c" : "b"}:${e.docId}` as StreamName,
				version: { remoteSeq: b?.remoteSeq ?? 0, localOrder: b?.localOrder ?? 0 },
				caughtUp: b?.caughtUp ?? true,
				hasContent: (b?.durable.length ?? 0) > 0,
				frozen: b?.frozen ?? false,
			},
		};
	}

	view(): RemoteView {
		// Optimistic overlay: committed entries + held own ops at pseudo-seqs.
		const overlay = new Map<DocId, Entry>();
		for (const [id, e] of this.entries) overlay.set(id, clone(e));
		const touched = new Set<DocId>();
		let pseudo = this.seq;
		for (const op of this.pending) {
			this.foldOp(overlay, op, ++pseudo);
			if ("docId" in op) touched.add(op.docId);
		}
		const remote = new Map<DocId, RemoteEntry>();
		const byKey = new Map<PathKey, DocId>();
		const textHash = new Map<DocId, ContentHash>();
		const appliedSeq = new Map<DocId, Seq>();
		const docsWithPendingBody = new Set<DocId>();
		for (const e of [...overlay.values()].sort((a, b) => (a.docId < b.docId ? -1 : 1))) {
			const r = this.remoteEntry(e, touched.has(e.docId))!;
			remote.set(e.docId, r);
			if (r.state === "live") byKey.set(r.pathKey, e.docId);
			const b = this.bodies.get(e.docId);
			if (b && e.kind !== "blob") {
				appliedSeq.set(e.docId, b.maxRowSeq);
				const h = !b.caughtUp ? null : e.kind === "canvas" ? canvasDocHash(this.canvasDoc(e.docId)) : markdownContentHash(this.text(e.docId));
				if (h !== null) textHash.set(e.docId, h);
				if (b.unframed.length > 0) docsWithPendingBody.add(e.docId);
			}
		}
		return {
			remote, remoteByPathKey: byKey, nsCoversSeq: this.seq, nsReady: this.nsReady, divergence: this.divergence,
			docsWithPendingBody, restoreDuty: new Set(), lostCreateBody: this.lostCreateBody, textHash, appliedSeq,
		};
	}

	// ---- bodies -----------------------------------------------------------------

	async acquireBody(docId: DocId, kind: "markdown" | "canvas"): Promise<BodyHandle | null> {
		const created = this.pending.find((op): op is Extract<NsOp, { t: "create" }> => op.t === "create" && op.docId === docId);
		const known = this.entries.get(docId)?.kind ?? created?.kind;
		if (known !== kind) return null;
		const b = this.ensureBody(docId);
		if (!b.replica) {
			const d = this.durableDoc(b);
			d.clientID = 1; // this device
			d.on("update", (u: Uint8Array, origin: unknown) => {
				if (origin === MERGE || origin === EDITOR) b.unframed.push(u);
			});
			b.replica = d;
		}
		b.holders++;
		const replica = b.replica;
		this.onAcquire?.(docId);
		let released = false;
		return {
			docId,
			doc: replica,
			mergeOrigin: MERGE,
			bound: b.bound,
			commitEdits: async () => {
				this.onCommitEdits?.(docId);
				if (b.unframed.length > 0) {
					b.localOrder = ++this.order;
					for (const u of b.unframed) {
						b.durable.push(u);
						this.frames.push({ docId, update: u });
						this.trace.push(`frame ${docId}`);
						// Own rows get seqs on receipt; they do not change remoteSeq.
						b.maxRowSeq = ++this.seq;
					}
					b.unframed = [];
				}
				return { remoteSeq: b.remoteSeq, localOrder: b.localOrder };
			},
			version: (): BodyVersion => ({ remoteSeq: b.remoteSeq, localOrder: b.localOrder }),
			release: () => {
				if (!released) {
					released = true;
					b.holders--;
				}
			},
		};
	}

	/** Keystrokes in a bound editor on the pinned replica; they ride the next commitEdits frame. */
	editorType(docId: DocId, fn: (t: Y.Text) => void): void {
		const b = this.ensureBody(docId);
		if (!b.bound || !b.replica) throw new Error("editorType: not bound or no replica");
		const r = b.replica;
		r.transact(() => fn(r.getText("text")), EDITOR);
	}

	setBound(docId: DocId, bound: boolean): void {
		this.ensureBody(docId).bound = bound;
	}

	setCaughtUp(docId: DocId, caughtUp: boolean): void {
		this.ensureBody(docId).caughtUp = caughtUp;
	}

	/** Process death: replicas and unframed merge updates are lost; durable rows and held ns ops (outbox) survive. */
	crash(): void {
		for (const b of this.bodies.values()) {
			b.replica = null;
			b.unframed = [];
			b.holders = 0;
		}
		this.onOwnFold = null;
		this.onAcquire = null;
	}

	// ---- other devices -------------------------------------------------------------

	freshId(prefix = "r"): DocId {
		this.idCounter++;
		return `${prefix}${String(this.idCounter).padStart(21, "0")}`.slice(0, 22) as DocId;
	}

	private remoteRow(docId: DocId, fn: (doc: Y.Doc) => void): void {
		const b = this.ensureBody(docId);
		const base = this.durableDoc(b);
		const other = new Y.Doc();
		other.clientID = this.nextClient++;
		Y.applyUpdate(other, Y.encodeStateAsUpdate(base));
		const sv = Y.encodeStateVector(other);
		fn(other);
		const update = Y.encodeStateAsUpdate(other, sv);
		b.durable.push(update);
		const seq = ++this.seq;
		b.remoteSeq = seq;
		b.maxRowSeq = seq;
		if (b.replica) Y.applyUpdate(b.replica, update, REMOTE);
	}

	remoteCreate(path: VaultPath, content: string | Uint8Array, docId: DocId = this.freshId()): DocId {
		const kind = kindOfPath(path);
		if (kind === "blob") {
			const bytes = content as Uint8Array;
			const hash = sha256Hex(bytes) as ContentHash;
			this.foldOp(this.entries, { t: "create", docId, kind, path, contentHash: hash, size: bytes.length }, ++this.seq);
			return docId;
		}
		const text = content as string;
		if (kind === "canvas") {
			const parsed = parseCanvasText(text);
			if (parsed.kind !== "valid") throw new Error(`remoteCreate: invalid canvas ${parsed.kind}`);
			const hash = canvasContentHash(utf8Encode(text));
			this.foldOp(this.entries, { t: "create", docId, kind, path, contentHash: hash, size: utf8Length(text) }, ++this.seq);
			const ranked = rankCanvasInFileOrder(parsed.data);
			if (parsed.data.nodes.size + parsed.data.edges.size + Object.keys(parsed.data.rootFields).length > 0) {
				this.remoteRow(docId, (d) => applyCanvas(d, null, ranked));
			} else this.ensureBody(docId);
			return docId;
		}
		this.foldOp(this.entries, { t: "create", docId, kind, path, contentHash: markdownContentHash(text), size: utf8Length(text) }, ++this.seq);
		if (text.length > 0) this.remoteRow(docId, (d) => d.getText("text").insert(0, text));
		else this.ensureBody(docId);
		return docId;
	}

	remoteEdit(docId: DocId, fn: (t: Y.Text) => void): void {
		this.remoteRow(docId, (d) => fn(d.getText("text")));
	}

	/** A remote markdown create whose initial body frames have not arrived (caught up, no content); remoteEdit delivers them. */
	remoteCreateBodyless(path: VaultPath, text: string, docId: DocId = this.freshId()): DocId {
		this.foldOp(this.entries, { t: "create", docId, kind: "markdown", path, contentHash: markdownContentHash(text), size: utf8Length(text) }, ++this.seq);
		this.ensureBody(docId);
		return docId;
	}

	/** A remote device edits a canvas doc (raw Y.Doc access; canvasDoc.applyCanvas for record-level edits). */
	remoteEditCanvas(docId: DocId, fn: (doc: Y.Doc) => void): void {
		this.remoteRow(docId, fn);
	}

	remoteRename(docId: DocId, path: VaultPath): NsOpOutcome {
		return this.foldOp(this.entries, { t: "rename", docId, path }, ++this.seq);
	}

	remoteDelete(docId: DocId): NsOpOutcome {
		const b = this.bodies.get(docId);
		return this.foldOp(this.entries, { t: "delete", docId, baseBodySeq: b?.maxRowSeq ?? 0 }, ++this.seq);
	}

	remoteSetBlob(docId: DocId, bytes: Uint8Array): NsOpOutcome {
		const e = this.entries.get(docId);
		return this.foldOp(this.entries, { t: "setBlob", docId, hash: sha256Hex(bytes) as ContentHash, size: bytes.length, baseRev: e?.blob?.rev ?? 0 }, ++this.seq);
	}

	entry(docId: DocId): RemoteEntry | null {
		return this.remoteEntry(this.entries.get(docId), false);
	}

	liveByPath(path: VaultPath): DocId | undefined {
		return this.byKey(this.entries, this.pathKey(path), null);
	}
}
