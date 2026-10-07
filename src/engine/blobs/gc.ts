/**
 * Blob mark-and-sweep (e2ee-design §10.4, DESIGN §j.1): deletes stored blobs that nothing references any more and
 * that were uploaded more than the grace (EngineTuning.blobGcGraceMs) before the cutoff. One sweep per user
 * command (runtime/blobGc.ts runs the preconditions and builds the live set); calls are sequential and the
 * adapter honours Retry-After (adapters/httpBlob.ts).
 *
 *  1. R1 cutoff on the store's clock: PUT a random probe address, ask deleteIfUploadedBefore([probe], 0), which
 *     answers "newer" with the probe's upload time T; cutoff = T − grace. A probe that fails falls back to this
 *     device's clock, cutoff = now − grace − GC_CLOCK_SKEW_MARGIN_MS. The probe comes before the mark (see R3 in
 *     blobs/touch.ts): a reference committed after the mark was cleared less than 3/4·grace before it was sent.
 *  2. mark(): the live hashes (or a refusal: zero deletes), mapped to addresses (CryptoPort.blobAddress).
 *  3. Sweep: page list(); a listed address that is not live and was uploaded before the cutoff is a candidate;
 *     candidates are deleted in batches of ≤ BLOB_DELETE_BATCH with the same cutoff (the store re-checks the
 *     upload time, so a re-upload meanwhile survives as "newer").
 *     Safety net against an addressing mismatch (wrong suite or key: every live address would look unknown):
 *     nothing is deleted until a listed address is a live one (the committed ones if any, else any live one);
 *     a listing that never shows one is refused with zero deletes.
 *  4. R4: a PUT between the store's check and its delete is deleted anyway (relay-wire §11.3.1). After deleting,
 *     remark() reads to the head again; a deleted address that is live now is uploaded again from local bytes
 *     ("repaired"), or counted "lost" when this device has none.
 *  5. The probe is deleted (best effort; a stray probe is garbage for a later sweep).
 */

import { bytesToHex } from "../../core/codec/lib0";
import type { AttachmentCleanupRefusal } from "../../protocol/messages";
import type { ContentHash } from "../../core/types";
import { BLOB_DELETE_BATCH, type BlobPort } from "../../ports/blob";
import type { ClockPort } from "../../ports/clock";
import type { BlobAddress, CryptoPort, HashPort } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import { putAt, type PutPolicy } from "./blobStore";

/** Fallback cutoff margin when the store's clock could not be read (R1). */
export const GC_CLOCK_SKEW_MARGIN_MS = 24 * 60 * 60_000;

/**
 * Why a sweep deleted nothing (or, "interrupted", stopped part-way); every other refusal comes before the first
 * delete. no-store: the vault has no attachment store. keys-unverified: suite 1 without a pinned, verified key
 * (addresses would be computed under a key this device cannot trust). offline / read-only: no relay session, or
 * a read-only member. not-caught-up: ns / cfg / snap could not be read to the relay's head just now.
 * fold-incomplete: a ns / cfg / snap row or snapshot this reader cannot open or decode (references may be
 * missing). body-unreadable: a body row this reader cannot open (it may hold a ref). addressing-mismatch: none
 * of the referenced blobs is in the store's listing. busy: a sweep is running. interrupted: the store or relay
 * failed, or the engine stopped, mid-sweep.
 */
export type GcRefusal = AttachmentCleanupRefusal;

export interface GcOutcome {
	readonly deleted: number;
	/** Unreferenced blobs kept because they were uploaded after the cutoff. */
	readonly keptNewer: number;
	/** Deleted blobs that turned out live (R4) and were uploaded again. */
	readonly repaired: number;
	/** Deleted blobs that turned out live and that this device has no bytes for. */
	readonly lost: number;
	readonly refused: GcRefusal | null;
	readonly detail: string | null;
}

export type GcMark =
	| {
		readonly ok: true;
		/** Every hash a reader or this device may still need. */
		readonly live: ReadonlySet<ContentHash>;
		/** The subset the committed ns / cfg / snap folds reference (the safety net's witnesses). */
		readonly committed: ReadonlySet<ContentHash>;
	}
	| { readonly ok: false; readonly refused: GcRefusal; readonly detail: string };

export interface GcDeps {
	readonly store: BlobPort;
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly graceMs: number;
	/** Aborted when the engine stops. */
	readonly signal: AbortSignal;
	/** Preconditions and the live set, after the probe. */
	mark(): Promise<GcMark>;
	/** R4: the live set again, read to the head after the deletes. */
	remark(): Promise<GcMark>;
	/** Local plaintext of `hash`, or null (checked here). */
	bytes(hash: ContentHash): Promise<Uint8Array | null>;
	/** Notes R4 re-uploads (blobs/touch.ts). */
	readonly policy: PutPolicy;
	diag(code: string, fields: Record<string, string | number | boolean | null>): void;
}

export function gcRefused(refused: GcRefusal, detail: string): GcOutcome {
	return { deleted: 0, keptNewer: 0, repaired: 0, lost: 0, refused, detail };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function sweepBlobs(d: GcDeps): Promise<GcOutcome> {
	const probe = bytesToHex(d.random.bytes(32)) as BlobAddress;
	let probePut = false;
	try {
		const cutoffMs = await probeCutoff(d, probe, () => { probePut = true; });
		const mark = await d.mark();
		if (!mark.ok) return gcRefused(mark.refused, mark.detail);
		const addrOf = new Map<ContentHash, BlobAddress>();
		const address = async (h: ContentHash): Promise<BlobAddress> => {
			let a = addrOf.get(h);
			if (a === undefined) {
				a = await d.crypto.blobAddress(h);
				addrOf.set(h, a);
				if (addrOf.size % 256 === 0) await d.clock.yieldNow();
			}
			return a;
		};
		const live = new Set<BlobAddress>();
		const committed = new Set<BlobAddress>();
		for (const h of mark.live) live.add(await address(h));
		for (const h of mark.committed) committed.add(await address(h));
		const witnesses = committed.size > 0 ? committed : live;
		let witnessed = witnesses.size === 0;

		let deleted = 0;
		let keptNewer = 0;
		const gone = new Set<BlobAddress>();
		const candidates: BlobAddress[] = [];
		const flush = async (batch: readonly BlobAddress[]) => {
			const results = await d.store.deleteIfUploadedBefore(batch, cutoffMs, d.signal);
			for (const r of results) {
				if (r.result === "deleted") {
					deleted++;
					gone.add(r.address);
				} else if (r.result === "newer") keptNewer++;
			}
		};
		let error: string | null = null;
		try {
			let cursor: BlobAddress | null = null;
			do {
				if (d.signal.aborted) throw new Error("stopped");
				const page = await d.store.list(cursor, d.signal);
				for (const it of page.items) {
					if (it.address === probe) continue;
					if (live.has(it.address)) {
						if (witnesses.has(it.address)) witnessed = true;
						continue;
					}
					if (it.uploadedAt >= cutoffMs) keptNewer++;
					else candidates.push(it.address);
				}
				if (page.next !== null && cursor !== null && page.next <= cursor) throw new Error("blob listing did not advance");
				cursor = page.next;
				while (witnessed && candidates.length >= BLOB_DELETE_BATCH) await flush(candidates.splice(0, BLOB_DELETE_BATCH));
				await d.clock.yieldNow();
			} while (cursor !== null);
			if (!witnessed) {
				return gcRefused("addressing-mismatch", `none of the ${witnesses.size} referenced attachment(s) is stored on the server under this device's addressing`);
			}
			while (candidates.length > 0) await flush(candidates.splice(0, BLOB_DELETE_BATCH));
		} catch (e) {
			error = errText(e);
			d.diag("blob-gc-interrupted", { deleted, error });
		}

		let repaired = 0;
		let lost = 0;
		let repairNote: string | null = null;
		if (gone.size > 0 && !d.signal.aborted) {
			const again = await d.remark().catch((e: unknown): GcMark => ({ ok: false, refused: "interrupted", detail: errText(e) }));
			if (!again.ok) repairNote = `deleted attachments were not re-checked (${again.detail})`;
			else {
				for (const h of again.live) {
					const a = await address(h);
					if (!gone.has(a)) continue;
					const bytes = await d.bytes(h);
					if (bytes && bytesToHex(await d.hash.sha256(bytes)) === h) {
						try {
							await putAt(d.store, d.crypto, d.policy, h, a, bytes);
							repaired++;
							continue;
						} catch (e) {
							d.diag("blob-gc-repair-failed", { error: errText(e) });
						}
					}
					lost++;
				}
				if (repaired + lost > 0) d.diag("blob-gc-repair", { repaired, lost });
			}
		}
		d.diag("blob-gc-swept", { deleted, keptNewer, repaired, lost, interrupted: error !== null });
		const detail = [error, repairNote].filter((x): x is string => x !== null).join("; ") || null;
		return { deleted, keptNewer, repaired, lost, refused: error !== null ? "interrupted" : null, detail };
	} catch (e) {
		return gcRefused("interrupted", errText(e));
	} finally {
		if (probePut && !d.signal.aborted) await d.store.deleteIfUploadedBefore([probe], Number.MAX_SAFE_INTEGER, d.signal).catch(() => undefined);
	}
}

/** R1: the cutoff on the store's clock from a probe upload, else on this device's clock with the skew margin. */
async function probeCutoff(d: GcDeps, probe: BlobAddress, put: () => void): Promise<number> {
	try {
		await d.store.put(probe, d.random.bytes(1));
		put();
		const [r] = await d.store.deleteIfUploadedBefore([probe], 0, d.signal);
		if (r?.result !== "newer") throw new Error(`probe answered ${r?.result ?? "nothing"}`);
		return Math.max(0, Math.floor(r.uploadedAt - d.graceMs));
	} catch (e) {
		if (d.signal.aborted) throw e;
		d.diag("blob-gc-probe-failed", { error: errText(e) });
		return Math.max(0, Math.floor(d.clock.now() - d.graceMs - GC_CLOCK_SKEW_MARGIN_MS));
	}
}
