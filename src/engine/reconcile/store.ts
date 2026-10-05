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
import { utf8Decode, utf8Encode } from "../../core/hash/utf8";
import type { StorageDb } from "../../ports/storage";
import { STORE, type BaseTextRecord, type IntentRecord, type LocalTreeRecord, type SyncedRecord, type YaosSchema } from "../store/schema";

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
}

/**
 * YaosSchema is an interface, which TypeScript does not treat as having an
 * index signature, so it does not satisfy SchemaShape directly. The mapped
 * alias is structurally identical and does (frozen schema.ts left untouched).
 */
export type DiskSchema = { readonly [K in keyof YaosSchema]: YaosSchema[K] };

const TX_STORES = [STORE.synced, STORE.baseText, STORE.localTree, STORE.intents] as const;

/** Base record for `text`, or null when it is too large to keep (hasBase = false). */
export function makeBase(docId: DocId, text: string, hash: ContentHash = markdownContentHash(text)): BaseTextRecord | null {
	if (text.length > MAX_BASE_TEXT_CHARS) return null;
	return { docId, contentHash: hash, deflated: deflateSync(utf8Encode(text)), chars: text.length };
}

/** Inflate + verify. null = corrupt or mismatched (treated as "no base"). */
export function readBase(rec: BaseTextRecord, hashOf: (text: string) => ContentHash = markdownContentHash): string | null {
	try {
		const text = utf8Decode(inflateSync(rec.deflated));
		if (text.length !== rec.chars || hashOf(text) !== rec.contentHash) return null;
		return text;
	} catch {
		return null;
	}
}

export class ReconcileStore {
	readonly synced = new Map<DocId, SyncedRecord>();
	readonly localTree = new Map<PathKey, LocalTreeRecord>();
	readonly intents = new Map<string, IntentRecord>();

	private constructor(readonly db: StorageDb<DiskSchema>) {}

	static async open(db: StorageDb<DiskSchema>): Promise<ReconcileStore> {
		const s = new ReconcileStore(db);
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
		return rec ? readBase(rec) : null;
	}

	async commit(c: DiskChange): Promise<void> {
		const empty = !c.syncedPut?.length && !c.syncedDrop?.length && !c.basePut?.length && !c.baseDrop?.length && !c.baseMove?.length
			&& !c.localPut?.length && !c.localDrop?.length && !c.intentPut?.length && !c.intentDrop?.length;
		if (empty) return;
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
	}
}
