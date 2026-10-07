/**
 * SimBlobStore: the relay's R2 blob store as the sim sees it (relay-wire §11.3, §11.3.1), one per vault.
 *
 * - Upload times are the run's clock (the "server" clock: true time, never a device's skewed one); a PUT,
 *   overwrite included, refreshes the time like R2's `uploaded` (server/src/router.ts:786-807).
 * - list() answers address order after the cursor, `pageSize` at a time; `next` is the last address returned
 *   while more remain, so deletes between pages do not move the walk.
 * - deleteIfUploadedBefore() checks every address first, then deletes the old ones in one step, like the
 *   relay's HEADs-then-one-delete (server/src/router.ts:821-835): a PUT that lands in between (the
 *   `beforeDelete` hook) is still deleted and reported "deleted".
 * - Hooks run concurrent work at the two interesting points of a sweep; `fail` throws for one call.
 */

import { BLOB_DELETE_BATCH, type BlobDeleteResult, type BlobListItem, type BlobListPage, type BlobPort } from "../ports/blob";
import type { BlobAddress, SealedBlobParts } from "../ports/crypto";
import { concatBytes } from "../core/codec/lib0";

export type SimBlobRoute = "has" | "put" | "get" | "list" | "delete";

export interface SimBlobHooks {
	/** Before a list page is computed (another device PUTs or deletes between pages). */
	beforeList?: (cursor: BlobAddress | null) => void | Promise<void>;
	/** After a delete call's checks, before its delete (the HEAD -> delete window). */
	beforeDelete?: (addresses: readonly BlobAddress[]) => void | Promise<void>;
	/** An error to throw for this call instead of answering (network, exhausted 429/503 retries). */
	fail?: (route: SimBlobRoute) => Error | null;
}

export interface SimBlobStoreOptions {
	/** The store's clock (ms). */
	readonly now: () => number;
	readonly pageSize?: number;
	readonly maxBlobBytes?: number;
}

interface SimObject {
	readonly bytes: Uint8Array;
	readonly uploadedAt: number;
}

export class SimBlobStore implements BlobPort {
	readonly maxBlobBytes: number;
	readonly objects = new Map<BlobAddress, SimObject>();
	readonly calls: Record<SimBlobRoute, number> = { has: 0, put: 0, get: 0, list: 0, delete: 0 };
	/** Every address a delete call removed, in order. */
	readonly deleted: BlobAddress[] = [];
	hooks: SimBlobHooks = {};
	private readonly pageSize: number;

	constructor(private readonly opts: SimBlobStoreOptions) {
		this.maxBlobBytes = opts.maxBlobBytes ?? 10 * 1024 * 1024;
		this.pageSize = opts.pageSize ?? 1000;
	}

	private enter(route: SimBlobRoute): void {
		this.calls[route]++;
		const error = this.hooks.fail?.(route) ?? null;
		if (error) throw error;
	}

	async has(addresses: readonly BlobAddress[]): Promise<ReadonlySet<BlobAddress>> {
		this.enter("has");
		return new Set(addresses.filter((a) => this.objects.has(a)));
	}

	async put(address: BlobAddress, parts: SealedBlobParts): Promise<void> {
		this.enter("put");
		const bytes = concatBytes(parts);
		if (bytes.byteLength > this.maxBlobBytes) throw new Error("sim blob put: 413 too large");
		this.objects.set(address, { bytes, uploadedAt: this.opts.now() });
	}

	async get(address: BlobAddress): Promise<Uint8Array | null> {
		this.enter("get");
		return this.objects.get(address)?.bytes.slice() ?? null;
	}

	async list(cursor: BlobAddress | null, signal?: AbortSignal): Promise<BlobListPage> {
		if (signal?.aborted) throw new Error("sim blob list: aborted");
		this.enter("list");
		await this.hooks.beforeList?.(cursor);
		const after = [...this.objects.keys()].filter((a) => cursor === null || a > cursor).sort();
		const page = after.slice(0, this.pageSize);
		const items: BlobListItem[] = page.map((address) => ({ address, uploadedAt: this.objects.get(address)!.uploadedAt }));
		return { items, next: after.length > page.length ? page[page.length - 1]! : null };
	}

	async deleteIfUploadedBefore(addresses: readonly BlobAddress[], cutoffMs: number, signal?: AbortSignal): Promise<readonly BlobDeleteResult[]> {
		if (signal?.aborted) throw new Error("sim blob delete: aborted");
		if (addresses.length === 0 || addresses.length > BLOB_DELETE_BATCH || new Set(addresses).size !== addresses.length) {
			throw new Error("sim blob delete: 400 invalid_addresses");
		}
		this.enter("delete");
		const results = addresses.map((address): BlobDeleteResult => {
			const o = this.objects.get(address);
			if (!o) return { address, result: "absent" };
			return o.uploadedAt < cutoffMs ? { address, result: "deleted", uploadedAt: o.uploadedAt } : { address, result: "newer", uploadedAt: o.uploadedAt };
		});
		await this.hooks.beforeDelete?.(addresses);
		for (const r of results) {
			if (r.result !== "deleted") continue;
			this.objects.delete(r.address);
			this.deleted.push(r.address);
		}
		return results;
	}

	uploadedAt(address: BlobAddress): number | null {
		return this.objects.get(address)?.uploadedAt ?? null;
	}
}
