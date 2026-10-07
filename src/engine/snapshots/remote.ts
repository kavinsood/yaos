/**
 * Snapshot parts in the blob store (DESIGN §j.4). Parts go through the attachments' one blob path (putAt /
 * getOpened: CryptoPort.blobAddress of the part's SHA-256, sealBlob / openBlob), so a crypto suite change applies
 * unchanged. Upload is idempotent and resumable per part: a part already present is not read or sent again when
 * the put policy re-uses it (a live snap record names it, or this device stored it less than half the GC grace
 * ago, e2ee-design §10.4 R2), and the index record is appended only after every part is stored and only if the
 * index does not have it yet.
 */
import { retentionFloor, snapLive } from "../../core/snap/fold";
import { sha256Hex } from "../../core/hash/sha256";
import { snapKey, type SnapOp, type SnapRecord } from "../../core/snap/record";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort } from "../../ports/crypto";
import type { SideFilePort } from "../../ports/vault";
import { getOpened, putAt, storePlaintextCap, type PutPolicy } from "../blobs/blobStore";
import { dlName, partName } from "./localStore";
import type { SnapIndexPort } from "./snapIndex";

export interface RemoteDeps {
	readonly store: BlobPort;
	readonly crypto: CryptoPort;
	readonly index: SnapIndexPort;
	readonly touch: PutPolicy;
}

export type UploadOutcome = "uploaded" | "present" | "deleted" | "not-ready";

export class SnapshotUploadError extends Error {}

/**
 * Uploads local snapshot `record` and appends its index record (plus a floor op that keeps the newest `keep`
 * of this device's uploads). Throws on store errors and on local parts that no longer match the descriptor.
 */
export async function uploadSnapshot(r: RemoteDeps, side: SideFilePort, record: SnapRecord, keep: number): Promise<UploadOutcome> {
	const { index, store, crypto, touch } = r;
	const before = index.view();
	if (!before.ready) return "not-ready";
	const key = snapKey(index.self, record.snapshotId);
	if (before.state.records.has(key)) return "present";
	if (before.state.dels.has(key) || record.createdAtMs < (before.state.floors.get(index.self) ?? 0)) return "deleted";
	const cap = storePlaintextCap(crypto, store);
	for (const p of record.parts) {
		if (p.size > cap) throw new SnapshotUploadError(`part of ${p.size} bytes exceeds the store limit ${cap}`);
	}
	const addresses: BlobAddress[] = [];
	for (const p of record.parts) addresses.push(await crypto.blobAddress(p.sha256));
	const have = await store.has(addresses);
	for (let i = 0; i < record.parts.length; i++) {
		const want = record.parts[i]!;
		if (have.has(addresses[i]!) && await touch.reuse(want.sha256, addresses[i]!)) continue;
		const bytes = await side.read(partName(record.snapshotId, i));
		if (!bytes || bytes.length !== want.size || sha256Hex(bytes) !== want.sha256) {
			throw new SnapshotUploadError(`local part ${i + 1}/${record.parts.length} of ${record.snapshotId} is missing or damaged`);
		}
		await putAt(store, crypto, touch, want.sha256, addresses[i]!, bytes);
	}
	const put: SnapRecord = { ...record, parts: record.parts.map((p, i) => ({ ...p, address: addresses[i]! })) };
	const view = index.view();
	if (view.state.records.has(key)) return "present";
	const ops: SnapOp[] = [{ t: "put", record: put }];
	const own = snapLive(view.state, Number.MAX_SAFE_INTEGER).filter((e) => e.deviceId === index.self).map((e) => e.record.createdAtMs);
	const floor = retentionFloor([...own, put.createdAtMs], keep);
	if (floor !== null && floor > (view.state.floors.get(index.self) ?? 0)) ops.push({ t: "floor", createdAtMs: floor });
	await index.submit(ops);
	return "uploaded";
}

/** A part this device cannot open for a reader-dependent reason (e2ee-design §9.2): not corruption. */
export class SnapshotPartUnavailable extends Error {}

/**
 * Part source for verifyBundle over a remote record: part i is fetched by the hash the record names, through the
 * blob path (the address is recomputed from the sha256, never taken from the record). Absent, or failing to open
 * deterministically (tampered at rest under a verified key, malformed), is part-missing: content_corrupt, fail
 * closed. A store error throws, and so does a reader-dependent failure (unknown key, a key not verified yet, an
 * unsupported suite; blobStore.ts getOpened): the request fails like a transport error, without a corruption
 * notice. verifyBundle checks its size and hash before asking for the next part; `keepPart` (its onPart) then
 * writes it to the download cache.
 */
export function remotePart(r: RemoteDeps, record: SnapRecord): (i: number) => Promise<Uint8Array | null> {
	return async (i) => {
		const got = await getOpened(r.store, r.crypto, record.parts[i]!.sha256, null);
		if (got.ok) return got.bytes;
		if (!got.deterministic && got.reason !== "absent") {
			throw new SnapshotPartUnavailable(`snapshot part ${i + 1}/${record.parts.length} cannot be opened on this device (${got.reason})`);
		}
		return null;
	};
}

export function keepPart(side: SideFilePort): (i: number, bytes: Uint8Array) => Promise<void> {
	return (i, bytes) => side.write(dlName(i), bytes);
}
