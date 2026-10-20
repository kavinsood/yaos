/**
 * The old epoch's bases by path (DESIGN §c.12 steps 3–4), as the new epoch's reconcile merges read them
 * (ReconcilerDeps.pathBase / pathBaseKeys). They are stored in the new DB's meta (MetaPathBase), written with its
 * identity by Repo.open, so a crash or restart between the migration and the merges keeps them (sim suite-1 seed
 * 65). Memory holds the verified texts; `keys` is live, so the planner sees a retired path at once.
 *
 * A base is retired once its path is settled in the new epoch. Then neither use of it can come up again:
 *  - the ns winner at the path is committed (not an own pending create) and is the one doc synced there: its
 *    merge ran, the migrated-loser collapse needs a winner not synced, and a doc with a synced record merges
 *    against its own base;
 *  - or the path holds nothing (no remote doc, no synced record, no file): a file written there later is new.
 */

import * as Y from "yjs";
import type { DocId, PathKey, SyncedEntry } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import type { TextDeletes } from "../reconcile/contentSteps";
import type { RemoteView } from "../reconcile/deps";
import { readBase } from "../reconcile/store";
import type { Repo } from "../store/repo";
import type { MetaPathBase } from "../store/schema";

const PREFIX = "pathBase:";

export function pathBaseKey(k: PathKey): MetaPathBase["key"] {
	return `${PREFIX}${k}`;
}

export class EpochBases {
	/** Path keys with a base (live: the planner's migrated-loser check reads it). */
	readonly keys = new Set<PathKey>();

	private constructor(
		private readonly repo: Repo,
		private readonly texts: Map<PathKey, string>,
		private readonly dels: Map<PathKey, ReadonlySet<string>>,
		private readonly textDels: Map<PathKey, TextDeletes>,
	) {
		for (const k of texts.keys()) this.keys.add(k);
	}

	/** The stored bases that still read back as written (readBase); the others are dropped. */
	static async load(repo: Repo, hash: HashPort): Promise<EpochBases> {
		const texts = new Map<PathKey, string>();
		const dels = new Map<PathKey, ReadonlySet<string>>();
		const textDels = new Map<PathKey, TextDeletes>();
		const bad: MetaPathBase["key"][] = [];
		for (const r of await repo.pathBases()) {
			const text = await readBase(r, hash);
			if (text === null) {
				bad.push(r.key);
				continue;
			}
			const k = r.key.slice(PREFIX.length) as PathKey;
			texts.set(k, text);
			if (r.deleted && r.deleted.length > 0) dels.set(k, new Set(r.deleted));
			if (r.textDeletes) {
				try {
					textDels.set(k, { docId: r.textDeletes.docId, ds: Y.decodeUpdate(r.textDeletes.update).ds });
				} catch {
					// Unreadable: the base still merges, the deletes are not carried.
				}
			}
		}
		if (bad.length > 0) await repo.dropPathBases(bad);
		return new EpochBases(repo, texts, dels, textDels);
	}

	get(k: PathKey): string | null {
		return this.texts.get(k) ?? null;
	}

	/** The old markdown doc's delete set at the path (MetaPathBase.textDeletes); null = none. */
	textDeletes(k: PathKey): TextDeletes | null {
		return this.textDels.get(k) ?? null;
	}

	/** Canvas record keys deleted in the old doc at the path (MetaPathBase.deleted); null = none. */
	deleted(k: PathKey): ReadonlySet<string> | null {
		return this.dels.get(k) ?? null;
	}

	/** Retire the bases of settled paths (module comment); returns how many. Needs the ns view caught up. */
	async settle(view: RemoteView, synced: Iterable<SyncedEntry>, hasLocal: (k: PathKey) => boolean): Promise<number> {
		if (this.keys.size === 0 || !view.nsReady) return 0;
		const at = new Map<PathKey, DocId[]>();
		for (const s of synced) {
			if (s.fileGone || !this.keys.has(s.pathKey)) continue;
			const list = at.get(s.pathKey);
			if (list) list.push(s.docId);
			else at.set(s.pathKey, [s.docId]);
		}
		const done: PathKey[] = [];
		for (const k of this.keys) {
			const docs = at.get(k) ?? [];
			const w = view.remoteByPathKey.get(k);
			if (w === undefined) {
				if (docs.length === 0 && !hasLocal(k)) done.push(k);
				continue;
			}
			const r = view.remote.get(w);
			if (r?.state === "live" && !r.pendingLocal && docs.length === 1 && docs[0] === w) done.push(k);
		}
		if (done.length === 0) return 0;
		await this.repo.dropPathBases(done.map(pathBaseKey));
		for (const k of done) {
			this.keys.delete(k);
			this.texts.delete(k);
			this.dels.delete(k);
			this.textDels.delete(k);
		}
		return done.length;
	}
}
