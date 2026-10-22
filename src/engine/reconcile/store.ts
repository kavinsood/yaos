/**
 * Disk-side persistence (DESIGN §e.1/§e.2): synced, baseText, localTree,
 * intents. In-memory mirrors of synced / localTree / intents are updated only
 * after a commit succeeds, so a failed or crashed tx never leaves the engine
 * believing something that is not durable.
 *
 * T_synced = one tx writing synced + baseText + localTree + intents together.
 * CPU work (deflate / inflate / hashing) is never done inside a tx body.
 */

import { deflateSync, inflateSync } from "fflate";
import type { ContentHash, DocId, PathKey, SyncedEntry } from "../../core/types";
import { MAX_BASE_TEXT_CHARS } from "../../core/limits";
import { markdownContentHash } from "../../core/hash/markdownLf";
import { utf8Decode, utf8Encode } from "../../core/codec/lib0";
import type { HashPort } from "../../ports/crypto";
import type { StorageDb } from "../../ports/storage";
import { STORE, type BaseTextRecord, type HeldTextRecord, type IntentRecord, type LocalTreeRecord, type SyncedRecord, type YaosSchema } from "../store/schema";

export interface DiskChange {
	readonly syncedPut?: readonly SyncedRecord[];
	readonly syncedDrop?: readonly DocId[];
	/** Bases to store; a docId listed in baseDrop is deleted. A base put replaces any old one. */
	readonly basePut?: readonly BaseTextRecord[];
	readonly baseDrop?: readonly DocId[];
	/** Rebind: move docId's base to another docId (inside the tx). */
	readonly baseMove?: readonly { readonly from: DocId; readonly to: DocId }[];
	readonly localPut?: readonly LocalTreeRecord[];
	readonly localDrop?: readonly PathKey[];
	readonly intentPut?: readonly IntentRecord[];
	readonly intentDrop?: readonly string[];
	/**
	 * Held edits' texts (SyncedEntry.held.bytes, heldText store), each with its record in syncedPut. A row whose record
	 * leaves (dropped, or put without held.bytes) is deleted in the same transaction.
	 */
	readonly heldPut?: readonly HeldTextRecord[];
}

/**
 * YaosSchema is an interface, which TypeScript does not treat as having an
 * index signature, so it does not satisfy SchemaShape directly. The mapped
 * alias is structurally identical and does (frozen schema.ts left untouched).
 */
export type DiskSchema = { readonly [K in keyof YaosSchema]: YaosSchema[K] };

const TX_STORES = [STORE.synced, STORE.baseText, STORE.heldText, STORE.localTree, STORE.intents] as const;

/** Base record for `text` (`hash` = its markdownContentHash), or null when it is too large to keep (hasBase = false). */
export function makeBase(docId: DocId, text: string, hash: ContentHash): BaseTextRecord | null {
	if (text.length > MAX_BASE_TEXT_CHARS) return null;
	return { docId, contentHash: hash, deflated: deflateSync(utf8Encode(text)), chars: text.length };
}

/** makeBase for a text whose hash is not known yet (a canvas merge text); hashed only when it is kept. */
export async function hashBase(hash: HashPort, docId: DocId, text: string): Promise<BaseTextRecord | null> {
	if (text.length > MAX_BASE_TEXT_CHARS) return null;
	return makeBase(docId, text, await markdownContentHash(hash, text));
}

/** Inflate + verify. null = corrupt or mismatched (treated as "no base"). */
/** A stored base text (a baseText row, or an old epoch's base by path) if it reads back as written; else null. */
export async function readBase(rec: Pick<BaseTextRecord, "contentHash" | "deflated" | "chars">, hash: HashPort): Promise<string | null> {
	let text: string;
	try {
		text = utf8Decode(inflateSync(rec.deflated));
	} catch {
		return null;
	}
	if (text.length !== rec.chars || (await markdownContentHash(hash, text)) !== rec.contentHash) return null;
	return text;
}

export class ReconcileStore {
	readonly synced = new Map<DocId, SyncedRecord>();
	readonly localTree = new Map<PathKey, LocalTreeRecord>();
	readonly intents = new Map<string, IntentRecord>();
	/**
	 * After each commit that kept or cleared held texts: the rows put, and the held edits whose texts left (docId and
	 * hash). The vault runtime's held-text mirror writes / removes their side files (compose/heldMirror.ts).
	 */
	onHeld: ((put: readonly HeldTextRecord[], gone: readonly { readonly docId: DocId; readonly hash: ContentHash }[]) => void) | null = null;

	private constructor(readonly db: StorageDb<DiskSchema>, private readonly hash: HashPort) {}

	static async open(db: StorageDb<DiskSchema>, hash: HashPort): Promise<ReconcileStore> {
		const s = new ReconcileStore(db, hash);
		const [synced, local, intents] = await db.tx(TX_STORES, "readonly", async (tx) =>
			Promise.all([tx.getAll(STORE.synced), tx.getAll(STORE.localTree), tx.getAll(STORE.intents)]),
		);
		for (const r of synced) s.synced.set(r.docId, r);
		for (const r of local) s.localTree.set(r.pathKey, r);
		for (const r of intents) s.intents.set(r.id, r);
		return s;
	}

	syncedEntries(): ReadonlyMap<DocId, SyncedEntry> {
		return this.synced;
	}

	async loadBase(docId: DocId): Promise<string | null> {
		const rec = await this.db.tx([STORE.baseText], "readonly", async (tx) => tx.get(STORE.baseText, docId));
		return rec ? readBase(rec, this.hash) : null;
	}

	/** The texts of `docId`'s held edit (heldText), if they are kept and still its record's (hash). Read from IDB only. */
	async loadHeld(docId: DocId): Promise<HeldTextRecord | null> {
		const hash = this.synced.get(docId)?.held;
		if (hash?.bytes === undefined) return null;
		const rec = await this.db.tx([STORE.heldText], "readonly", async (tx) => tx.get(STORE.heldText, docId));
		return rec && rec.hash === hash.hash ? rec : null;
	}

	/**
	 * SyncedEntry.held lasts until the next sync point: a record with another content hash than the stored one (the
	 * held content committed or published, or merged into something else) drops it, as one whose content is the held
	 * one does. Records spread from the old one (`{ ...s, contentHash }`) would carry it on otherwise.
	 */
	private heldKept(r: SyncedRecord): SyncedRecord {
		const prior = this.synced.get(r.docId);
		if (r.held!.hash !== r.contentHash && (!prior || prior.contentHash === r.contentHash)) return r;
		const { held: _held, ...rest } = r;
		return rest;
	}

	async commit(c: DiskChange): Promise<void> {
		const empty = !c.syncedPut?.length && !c.syncedDrop?.length && !c.basePut?.length && !c.baseDrop?.length && !c.baseMove?.length
			&& !c.localPut?.length && !c.localDrop?.length && !c.intentPut?.length && !c.intentDrop?.length && !c.heldPut?.length;
		if (empty) return;
		if (c.syncedPut?.some((r) => r.held !== undefined)) c = { ...c, syncedPut: c.syncedPut.map((r) => (r.held === undefined ? r : this.heldKept(r))) };
		// Held texts whose record no longer keeps them go with it (heldKept, a drop, a put without held.bytes).
		const keptBefore = (id: DocId): ContentHash | null => {
			const h = this.synced.get(id)?.held;
			return h?.bytes === undefined ? null : h.hash;
		};
		const heldGone = [
			...(c.syncedDrop ?? []).filter((id) => keptBefore(id) !== null),
			...(c.syncedPut ?? []).filter((r) => keptBefore(r.docId) !== null && (r.held?.bytes === undefined || r.held.hash !== keptBefore(r.docId))).map((r) => r.docId),
		];
		const goneHashes = heldGone.map((docId) => ({ docId, hash: keptBefore(docId)! }));
		await this.db.tx(TX_STORES, "readwrite", async (tx) => {
			for (const m of c.baseMove ?? []) {
				const rec = await tx.get(STORE.baseText, m.from);
				tx.delete(STORE.baseText, m.from);
				if (rec) tx.put(STORE.baseText, { ...rec, docId: m.to });
			}
			for (const id of c.syncedDrop ?? []) tx.delete(STORE.synced, id);
			for (const r of c.syncedPut ?? []) tx.put(STORE.synced, r);
			for (const id of c.baseDrop ?? []) tx.delete(STORE.baseText, id);
			for (const r of c.basePut ?? []) tx.put(STORE.baseText, r);
			for (const id of heldGone) if (!c.heldPut?.some((r) => r.docId === id)) tx.delete(STORE.heldText, id);
			for (const r of c.heldPut ?? []) tx.put(STORE.heldText, r);
			for (const k of c.localDrop ?? []) tx.delete(STORE.localTree, k);
			for (const r of c.localPut ?? []) tx.put(STORE.localTree, r);
			for (const id of c.intentDrop ?? []) tx.delete(STORE.intents, id);
			for (const r of c.intentPut ?? []) tx.put(STORE.intents, r);
		});
		for (const id of c.syncedDrop ?? []) this.synced.delete(id);
		for (const r of c.syncedPut ?? []) this.synced.set(r.docId, r);
		for (const k of c.localDrop ?? []) this.localTree.delete(k);
		for (const r of c.localPut ?? []) this.localTree.set(r.pathKey, r);
		for (const id of c.intentDrop ?? []) this.intents.delete(id);
		for (const r of c.intentPut ?? []) this.intents.set(r.id, r);
		if ((c.heldPut?.length || goneHashes.length > 0) && this.onHeld) this.onHeld(c.heldPut ?? [], goneHashes);
	}
}
