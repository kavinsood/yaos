/**
 * Held-text files (DESIGN §e.4 "Held-text files", §f.6 "Held edits"): the texts of each held edit
 * (SyncedEntry.held, heldText store) in a side file of its own, `held/<docId>.<hash>.bin`, so they survive an
 * IndexedDB loss with the mirrors kept. Written once when the edit is kept, removed when it is cleared
 * (ReconcileStore.onHeld), never rewritten: the synced mirror carries only each held edit's hash and size, so a write
 * of it (every synced change) costs nothing per held text.
 *
 * `sync` (at start) brings the dir to the store: it writes the files of kept texts that have none (inherited from a
 * lineage dir, a crash between a commit and its write) and removes files no record keeps (a crash before a removal).
 * Writes run one at a time, in commit order. A file not written yet when the store is lost only costs that edit's
 * texts: recovery keeps the held hash alone (runtime/mirrors.ts recoverHeldTexts).
 */

import type { ContentHash, DocId } from "../../core/types";
import { encodeHeldTextFile, heldTextFileName } from "../../core/codec/mirrors";
import type { HashPort } from "../../ports/crypto";
import type { SideFilePort } from "../../ports/vault";
import type { MirrorIdentity } from "../runtime/mirrors";
import type { HeldTextRecord } from "../store/schema";
import type { ReconcileStore } from "../reconcile/store";

export class HeldTextMirror {
	private chain: Promise<void> = Promise.resolve();
	stats = { writes: 0, removes: 0, bytes: 0, failures: 0 };

	constructor(private readonly deps: {
		readonly side: SideFilePort; readonly hash: HashPort; readonly identity: () => MirrorIdentity; readonly onError?: (e: unknown) => void;
	}) {}

	/** ReconcileStore.onHeld: write the kept texts' files, remove the cleared ones'. */
	onHeld(put: readonly HeldTextRecord[], gone: readonly { readonly docId: DocId; readonly hash: ContentHash }[]): void {
		const puts = [...put];
		const drops = [...gone];
		this.run(async () => {
			for (const r of puts) await this.write(r);
			for (const g of drops) {
				if (puts.some((r) => r.docId === g.docId && r.hash === g.hash)) continue;
				await this.deps.side.remove(heldTextFileName(g.docId, g.hash));
				this.stats.removes++;
			}
		});
	}

	/** Start: the files for exactly the store's kept texts. */
	sync(store: ReconcileStore): Promise<void> {
		this.run(async () => {
			const want = new Map<string, DocId>();
			for (const s of store.synced.values()) if (s.held?.bytes !== undefined) want.set(heldTextFileName(s.docId, s.held.hash), s.docId);
			const have = new Set<string>(await this.deps.side.list("held/"));
			for (const name of have) {
				if (want.has(name)) continue;
				await this.deps.side.remove(name as `held/${string}.bin`);
				this.stats.removes++;
			}
			for (const [name, docId] of want) {
				if (have.has(name)) continue;
				const r = await store.loadHeld(docId);
				if (r) await this.write(r);
			}
		});
		return this.idle();
	}

	/** Resolves once every write asked for so far is done. */
	idle(): Promise<void> {
		return this.chain;
	}

	private run(job: () => Promise<void>): void {
		this.chain = this.chain.then(job).catch((e: unknown) => {
			this.stats.failures++;
			this.deps.onError?.(e);
		});
	}

	private async write(r: HeldTextRecord): Promise<void> {
		const bytes = await encodeHeldTextFile({ ...this.deps.identity(), docId: r.docId, hash: r.hash, text: r.text, base: r.base }, this.deps.hash);
		await this.deps.side.write(heldTextFileName(r.docId, r.hash), bytes);
		this.stats.writes++;
		this.stats.bytes += bytes.length;
	}
}
