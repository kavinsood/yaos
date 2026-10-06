/**
 * Snapshot side files (DESIGN §j.4), under <plugin>/state/snapshots/:
 *
 *   <id>-p<NNN>.part   zip part NNN (000-based) of a local snapshot
 *   <id>.snap          its descriptor: the encoded index record (SnapRecord), written after every part
 *   dl-p<NNN>.part     the one remote snapshot being restored (download cache, removed when done)
 *
 * A snapshot exists locally iff its descriptor decodes and names it; parts without a descriptor are leftovers of
 * an interrupted export and are removed by `sweep`.
 */
import { decodeSnapRecord, encodeSnapRecord, parseSnapshotId, type SnapRecord } from "../../core/snap/record";
import type { SideFileName, SideFilePort } from "../../ports/vault";

const DIR = "snapshots/";
const pad = (i: number) => String(i).padStart(3, "0");

export const partName = (id: string, i: number): SideFileName => `${DIR}${id}-p${pad(i)}.part`;
export const descName = (id: string): SideFileName => `${DIR}${id}.snap`;
export const dlName = (i: number): SideFileName => `${DIR}dl-p${pad(i)}.part`;

const DESC = /^snapshots\/([0-9a-z]{9}-[a-z]+)\.snap$/;
const PART = /^snapshots\/([0-9a-z]{9}-[a-z]+)-p(\d{3})\.part$/;
const DL = /^snapshots\/dl-p\d{3}\.part$/;

export interface LocalSnapshot { readonly id: string; readonly record: SnapRecord }

/** Local snapshots, oldest first. Undecodable or misnamed descriptors are skipped (`onBad`). */
export async function listLocal(side: SideFilePort, onBad?: (name: string) => void): Promise<LocalSnapshot[]> {
	const out: LocalSnapshot[] = [];
	for (const name of await side.list(DIR)) {
		const m = DESC.exec(name);
		if (!m || !parseSnapshotId(m[1]!)) continue;
		const bytes = await side.read(name);
		const record = bytes ? decodeSnapRecord(bytes) : null;
		if (!record || record.snapshotId !== m[1]) {
			onBad?.(name);
			continue;
		}
		out.push({ id: m[1]!, record });
	}
	return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function readLocal(side: SideFilePort, id: string): Promise<SnapRecord | null> {
	const bytes = await side.read(descName(id));
	const record = bytes ? decodeSnapRecord(bytes) : null;
	return record && record.snapshotId === id ? record : null;
}

export async function writeDescriptor(side: SideFilePort, record: SnapRecord): Promise<void> {
	await side.write(descName(record.snapshotId), encodeSnapRecord(record));
}

/** Descriptor first (the snapshot is gone from then on), then its parts. */
export async function removeLocal(side: SideFilePort, id: string, partCount: number): Promise<void> {
	await side.remove(descName(id));
	for (let i = 0; i < partCount; i++) await side.remove(partName(id, i));
}

export async function removeDownload(side: SideFilePort, partCount: number): Promise<void> {
	for (let i = 0; i < partCount; i++) await side.remove(dlName(i));
}

/**
 * Removes parts with no descriptor (an export cut short) except those of `busy`, and every download part unless
 * `keepDownload`. Returns the number of files removed.
 */
export async function sweep(side: SideFilePort, busy: string | null, keepDownload: boolean): Promise<number> {
	const names = await side.list(DIR);
	const have = new Set(names.flatMap((n) => { const m = DESC.exec(n); return m ? [m[1]!] : []; }));
	let n = 0;
	for (const name of names) {
		const p = PART.exec(name);
		const orphan = p !== null && !have.has(p[1]!) && p[1] !== busy;
		if (orphan || (!keepDownload && DL.test(name))) {
			await side.remove(name);
			n++;
		}
	}
	return n;
}
