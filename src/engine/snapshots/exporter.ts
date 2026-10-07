/**
 * Streaming snapshot export (DESIGN §j.4). Files are read through the DiskGateway in small batches (at most
 * READ_BATCH_BYTES planned, or one file) and added to a BundleBuilder one at a time; each finished zip part goes
 * straight to its side file. Peak memory: one part buffer, one read batch with its deflated copy, the central
 * directory and the manifest list. The descriptor is written last, so a crash leaves only orphan parts (swept).
 *
 * A file that would not pass restore verification (path rules, markdown not UTF-8, canvas that does not parse)
 * is left out as skipped "invalid": one bad file must not make the whole snapshot unrestorable.
 */
import { SNAP_MAX_BLOB_BYTES, maxEntryBytes, contentProblem } from "../../core/snap/bundle";
import { BundleBuilder, bundleRecord } from "../../core/snap/export";
import { SNAP_MAX_FILES, SNAP_MAX_TOTAL_BYTES, snapRecordProblem, type SnapReason, type SnapRecord } from "../../core/snap/record";
import { pathInvalidReason } from "../../core/paths/validate";
import type { ContentHash, DocKind, VaultPath } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import type { SideFilePort } from "../../ports/vault";
import { LANE } from "../../protocol/messages";
import type { DiskGateway } from "../reconcile/deps";
import { partName, writeDescriptor } from "./localStore";

const READ_BATCH_BYTES = 1024 * 1024;
const READ_BATCH_FILES = 32;

export interface ExportInput {
	readonly disk: DiskGateway;
	readonly side: SideFilePort;
	readonly hash: HashPort;
	readonly files: readonly { readonly path: VaultPath; readonly kind: DocKind; readonly size: number }[];
	readonly id: string;
	readonly createdAtMs: number;
	readonly reason: SnapReason;
	readonly partBytes: number;
	readonly deviceLabel: string;
	/** Blob-store address of a part (CryptoPort.blobAddress), recorded for the index and a future GC. */
	readonly address: (sha256: ContentHash) => Promise<string>;
}

export type ExportResult =
	| { readonly t: "ok"; readonly record: SnapRecord }
	| { readonly t: "too-large"; readonly detail: string };

export async function exportSnapshot(o: ExportInput): Promise<ExportResult> {
	const eligible = o.files.filter((f) => f.kind !== "blob" || f.size <= SNAP_MAX_BLOB_BYTES);
	const planned = eligible.reduce((n, f) => n + f.size, 0);
	if (planned > SNAP_MAX_TOTAL_BYTES) return { t: "too-large", detail: `${planned} bytes` };
	if (eligible.length > SNAP_MAX_FILES) return { t: "too-large", detail: `${eligible.length} files` };
	let written = 0;
	const builder = new BundleBuilder(o.hash, o.id, o.createdAtMs, o.reason, o.partBytes, async (p) => {
		await o.side.write(partName(o.id, p.index), p.bytes);
		written = p.index + 1;
	});
	try {
		for (const batch of batches(eligible)) {
			const res = await o.disk.read(batch.map((f) => ({ area: "vault" as const, path: f.path, maxBytes: maxEntryBytes(f.kind) })), LANE.bulk);
			for (let j = 0; j < batch.length; j++) {
				const f = batch[j]!;
				const r = res[j];
				if (!r || !r.ok) {
					if (r?.ok === false && r.reason === "missing") continue;
					builder.skip(f.path, r?.ok === false && r.reason === "too-large" ? "too-large" : "unreadable");
					continue;
				}
				if (pathInvalidReason(f.path) || contentProblem(f.kind, r.bytes)) {
					builder.skip(f.path, "invalid");
					continue;
				}
				await builder.addFile(f.path, f.kind, r.bytes);
			}
			if (builder.fileBytes > SNAP_MAX_TOTAL_BYTES) {
				await removeParts(o, written);
				return { t: "too-large", detail: `${builder.fileBytes} bytes` };
			}
		}
		const built = await builder.finish();
		const addresses: string[] = [];
		for (const p of built.parts) addresses.push(await o.address(p.sha256));
		const record = bundleRecord(built, o.deviceLabel, addresses);
		const problem = snapRecordProblem(record);
		if (problem) throw new Error(`snapshot record out of bounds: ${problem}`);
		await writeDescriptor(o.side, record);
		return { t: "ok", record };
	} catch (e) {
		await removeParts(o, written).catch(() => undefined);
		throw e;
	}
}

function* batches<T extends { readonly size: number }>(files: readonly T[]): Generator<T[]> {
	let cur: T[] = [];
	let bytes = 0;
	for (const f of files) {
		if (cur.length > 0 && (bytes + f.size > READ_BATCH_BYTES || cur.length >= READ_BATCH_FILES)) {
			yield cur;
			cur = [];
			bytes = 0;
		}
		cur.push(f);
		bytes += f.size;
	}
	if (cur.length > 0) yield cur;
}

async function removeParts(o: ExportInput, n: number): Promise<void> {
	for (let i = 0; i < n; i++) await o.side.remove(partName(o.id, i));
}
