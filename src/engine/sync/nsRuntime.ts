/**
 * Namespace runtime (DESIGN §c, §d.7 step 5, §e.1 dependsOn).
 *
 * State = nsFoldV1 snapshot + fold of ns tail rows in (snapshot, appliedSeq],
 * in seq order. Rows are folded only once the ns stream has them all
 * (appliedSeq), so live rows of a stale ns stream wait in tail. A tail row
 * flagged LOCAL_FLAG_UNOPENED (reader-dependent gate failure) halts the fold.
 *
 * reconcileHeld() is state-based so it is crash-safe: a held record whose
 * dependency record is gone is released when the fold has its doc (live /
 * deleted), deleted when the doc was merged away, and waits while the doc is
 * absent (create not folded yet).
 *
 * Fold / codecs are stand-ins (../sync/__standins__/nsFold) until WP-A lands.
 */

import { CheckpointEncoding } from "../../core/envelope";
import { NS_STREAM, streamClass, streamDocId, type DocId, type DocKind, type NsEntry, type NsFoldEvent, type NsFoldIndex, type NsFoldState, type NsOp, type PathKey, type Seq, type VaultPath, type DeviceId } from "../../core/types";
import type { OutboxChange, Repo } from "../store/repo";
import type { OutboxRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";
import { buildIndex, decodeNsFoldV1, emptyNsState, encodeNsFoldV1, foldNsFrameStandin, pathKeyStandin } from "./__standins__/nsFold";
import { decodeNsOps } from "./__standins__/nsOps";

/** Local-only tail flag (never on the wire): the row failed a reader-dependent gate check; content = raw payload. */
export const LOCAL_FLAG_UNOPENED = 1 << 20;
/** FOLD (V3): an ns row s is a candidate iff floor(s / M) > floor(prev / M). */
export const NS_CANDIDATE_MODULUS = 1000;

export interface NsCandidate {
	readonly seq: Seq;
	readonly bytes: Uint8Array;
	readonly authoredBySelf: boolean;
}

export interface DocInfo {
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly kind: DocKind;
	readonly state: NsEntry["state"] | "pending";
	readonly aliasOf: DocId | null;
}

export class NsRuntime {
	state: NsFoldState = emptyNsState();
	index: NsFoldIndex = buildIndex(this.state);
	halted: { readonly seq: Seq; readonly reason: string } | null = null;
	candidate: NsCandidate | null = null;
	/** Highest ns tail seq looked at (rows in (through, appliedSeq] are next). */
	private through: Seq = 0;
	private prevSeq: Seq = 0;
	private busy: Promise<NsFoldEvent[]> = Promise.resolve([]);
	foldedRows = 0;

	constructor(private readonly repo: Repo, private readonly self: DeviceId, private readonly candidateModulus = NS_CANDIDATE_MODULUS) {}

	/** (Re)load from the snapshot and refold the tail. */
	async load(): Promise<NsFoldEvent[]> {
		const snap = await this.repo.getSnapshot(NS_STREAM);
		this.state = snap && snap.encoding === CheckpointEncoding.nsFoldV1 && snap.bytes.length > 0 ? decodeNsFoldV1(snap.bytes) : emptyNsState();
		this.index = buildIndex(this.state);
		this.halted = null;
		this.through = Math.max(this.state.coversSeq, snap?.coversSeq ?? 0);
		this.prevSeq = this.state.coversSeq;
		return this.advance();
	}

	/** Fold every newly available row (serialized). */
	advance(): Promise<NsFoldEvent[]> {
		const p = this.busy.then(() => this.doAdvance(), () => this.doAdvance());
		this.busy = p.catch(() => []);
		return p;
	}

	private async doAdvance(): Promise<NsFoldEvent[]> {
		const rec = this.repo.stream(NS_STREAM);
		if (!rec || this.halted) return [];
		if (rec.appliedSeq <= this.through) return [];
		const target = rec.appliedSeq;
		const rows = await this.repo.getTail(NS_STREAM, this.through, target);
		const events: NsFoldEvent[] = [];
		for (const row of rows) {
			if (row.seq <= this.state.coversSeq) continue;
			if (row.flags & LOCAL_FLAG_UNOPENED) {
				this.halted = { seq: row.seq, reason: "reader-dependent" };
				this.through = row.seq - 1;
				return events;
			}
			let ops: NsOp[] = [];
			if (row.kind === "nsOps" && row.content.length > 0) {
				try {
					ops = decodeNsOps(row.content);
				} catch {
					ops = []; // deterministic malformation folds as an empty frame (§c.3)
				}
			}
			events.push(...foldNsFrameStandin(this.state, this.index, { seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, authorNsSeq: row.authorNsSeq, ops }));
			this.foldedRows++;
			const m = this.candidateModulus;
			if (Math.floor(row.seq / m) > Math.floor(this.prevSeq / m)) {
				this.candidate = { seq: row.seq, bytes: encodeNsFoldV1(this.state), authoredBySelf: row.deviceId === this.self };
			}
			this.prevSeq = row.seq;
		}
		this.through = target;
		return events;
	}

	get coversSeq(): Seq {
		return this.state.coversSeq;
	}

	entry(docId: DocId): NsEntry | undefined {
		return this.state.entries.get(docId);
	}

	/** Alias-resolved live entry. */
	resolve(docId: DocId): NsEntry | undefined {
		const e = this.state.entries.get(docId);
		if (e && e.state === "merged" && e.aliasOf) return this.state.entries.get(e.aliasOf);
		return e;
	}

	docAt(path: VaultPath): DocId | null {
		return this.index.byPathKey.get(pathKeyStandin(path) as PathKey) ?? null;
	}

	/**
	 * Docs: fold entries plus own pending creates (outbox ns frames not folded
	 * yet) as an overlay (§f.1).
	 */
	listDocs(outbox: OutboxCache): DocInfo[] {
		const out = new Map<DocId, DocInfo>();
		for (const e of this.state.entries.values()) out.set(e.docId, { docId: e.docId, path: e.path, kind: e.kind, state: e.state, aliasOf: e.aliasOf });
		for (const op of pendingNsOps(outbox)) {
			if (op.t === "create" && !out.has(op.docId)) out.set(op.docId, { docId: op.docId, path: op.path, kind: op.kind, state: "pending", aliasOf: null });
			else if (op.t === "rename") {
				const d = out.get(op.docId);
				if (d) out.set(op.docId, { ...d, path: op.path });
			} else if (op.t === "delete") {
				const d = out.get(op.docId);
				if (d && d.state !== "merged") out.set(op.docId, { ...d, state: "deleted" });
			}
		}
		return [...out.values()];
	}

	/** dependsOn rule for ns creates (DESIGN §e.1). */
	reconcileHeld(outbox: OutboxCache): OutboxChange[] {
		const changes: OutboxChange[] = [];
		for (const r of outbox.values()) {
			if (r.state !== "held" || !r.dependsOn || outbox.has(r.dependsOn)) continue;
			const cls = streamClass(r.stream);
			const docId = cls === "body" || cls === "canvas" ? streamDocId(r.stream) : null;
			if (!docId) {
				changes.push({ t: "release", clientFrameId: r.clientFrameId });
				continue;
			}
			const e = this.state.entries.get(docId);
			if (!e) continue; // create not folded yet (or still stale): wait
			if (e.state === "merged") {
				changes.push({ t: "delete", clientFrameId: r.clientFrameId });
				continue;
			}
			if (r.kind === "bodyUpdateRef") {
				const chunk = outbox.lastChunkBefore(r.order);
				if (chunk) {
					changes.push({ t: "repoint", clientFrameId: r.clientFrameId, dependsOn: chunk.clientFrameId });
					continue;
				}
			}
			changes.push({ t: "release", clientFrameId: r.clientFrameId });
		}
		return changes;
	}
}

/** Ops of own ns frames still in the outbox, in order. */
export function pendingNsOps(outbox: OutboxCache): NsOp[] {
	const ops: NsOp[] = [];
	for (const r of outbox.ofStream(NS_STREAM)) {
		if (r.state === "poisoned" || r.content.length === 0) continue;
		try {
			ops.push(...decodeNsOps(r.content));
		} catch {
			// own frame; cannot happen
		}
	}
	return ops;
}

export function isOwnNsRecord(r: OutboxRecord): boolean {
	return r.stream === NS_STREAM;
}
