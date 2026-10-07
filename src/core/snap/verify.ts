/**
 * Snapshot bundle verification (DESIGN §j.4). Fail closed: the first failed check throws SnapCorrupt and the
 * whole snapshot is refused. Order of checks while streaming the parts in sequence:
 *
 *   1. each part: present (part-missing), record size (part-size), record sha256 (part-hash)
 *   2. zip structure, sizes, crc32 (zip-decode / truncated)
 *   3. each `files/<path>` entry: ns path rules (path-invalid), content parses for its kind (content-invalid)
 *   4. manifest.json last, strict schema (manifest-invalid); its id / fileCount / totalBytes equal the record's and
 *      the entry list equals its file list in order: path, kind, size, sha256 (manifest-mismatch)
 *   5. bundle digest over the record's parts and sha256(manifest.json) equals the record's (bundle-digest)
 *
 * `onEntry` sees each entry only after every part holding it passed step 1. It runs before the manifest is seen,
 * so callers that write files call `verifyBundle` twice: once to verify, once to restore with `expect` set to the
 * verified manifest (each entry is then also checked against it before `onEntry` runs).
 */

import type { HashPort } from "../../ports/crypto";
import type { ContentHash, DocKind, VaultPath } from "../types";
import { kindOfPath } from "../types";
import { digestHex } from "../hash/digest";
import { exactFingerprint } from "../hash/markdownLf";
import type { SnapRecord } from "./record";
import {
	SNAP_MANIFEST, SnapCorrupt, bundleDigest, contentProblem, entryPath, maxZipEntryBytes, parseManifest,
	type SnapManifest,
} from "./bundle";
import { ZipError, readZip } from "./zip";

export interface VerifiedEntry { readonly path: VaultPath; readonly kind: DocKind; readonly data: Uint8Array; readonly hash: ContentHash }

export interface VerifyOptions {
	readonly hash: HashPort;
	readonly record: SnapRecord;
	/** Bytes of part `index`, or null when it is missing. Called once per part, in order. */
	readonly part: (index: number) => Promise<Uint8Array | null>;
	/** Called with each part once it passed its size and hash checks (e.g. to keep a verified copy). */
	readonly onPart?: (index: number, bytes: Uint8Array) => Promise<void>;
	readonly onEntry?: (e: VerifiedEntry) => Promise<void>;
	/** A manifest verified by an earlier pass: entries must match it before onEntry runs. */
	readonly expect?: SnapManifest;
}

export async function verifyBundle(o: VerifyOptions): Promise<SnapManifest> {
	const { record, hash } = o;
	let next = 0;
	const source = async (): Promise<Uint8Array | null> => {
		if (next >= record.parts.length) return null;
		const i = next++;
		const want = record.parts[i]!;
		const bytes = await o.part(i);
		if (!bytes) throw new SnapCorrupt("part-missing", `part ${i + 1}/${record.parts.length}`);
		if (bytes.length !== want.size) throw new SnapCorrupt("part-size", `part ${i + 1}: ${bytes.length} bytes, record says ${want.size}`);
		if ((await digestHex(hash, bytes)) !== want.sha256) throw new SnapCorrupt("part-hash", `part ${i + 1}`);
		if (o.onPart) await o.onPart(i, bytes);
		return bytes;
	};
	const seen: { path: VaultPath; kind: DocKind; size: number; hash: ContentHash }[] = [];
	let manifestBytes: Uint8Array | null = null;
	try {
		for await (const entry of readZip(source, { maxEntryBytes: maxZipEntryBytes })) {
			if (manifestBytes) throw new SnapCorrupt("manifest-mismatch", "entries after manifest.json");
			if (entry.name === SNAP_MANIFEST) { manifestBytes = entry.data; continue; }
			const path = entryPath(entry.name);
			const kind = kindOfPath(path);
			const problem = contentProblem(kind, entry.data);
			if (problem) throw new SnapCorrupt("content-invalid", `${problem}: ${path}`);
			const fp = (await exactFingerprint(hash, entry.data)) as string as ContentHash;
			const i = seen.length;
			seen.push({ path, kind, size: entry.data.length, hash: fp });
			if (o.expect) {
				const f = o.expect.files[i];
				if (!f || f.path !== path || f.kind !== kind || f.size !== entry.data.length || f.hash !== fp) throw new SnapCorrupt("file-hash", path);
			}
			if (o.onEntry) await o.onEntry({ path, kind, data: entry.data, hash: fp });
		}
	} catch (e) {
		if (e instanceof ZipError) throw new SnapCorrupt(e.check, e.message);
		throw e;
	}
	if (!manifestBytes) throw new SnapCorrupt("manifest-mismatch", "no manifest.json");
	const m = parseManifest(manifestBytes);
	const total = m.files.reduce((n, f) => n + f.size, 0);
	if (m.id !== record.snapshotId || m.files.length !== record.fileCount || total !== record.totalBytes) {
		throw new SnapCorrupt("manifest-mismatch", "manifest does not match the index record");
	}
	if (m.files.length !== seen.length) throw new SnapCorrupt("manifest-mismatch", `${seen.length} entries, manifest lists ${m.files.length}`);
	const paths = new Set<string>();
	m.files.forEach((f, i) => {
		const s = seen[i]!;
		if (f.path !== s.path || f.kind !== s.kind || f.size !== s.size || f.hash !== s.hash) throw new SnapCorrupt("manifest-mismatch", f.path);
		if (paths.has(f.path)) throw new SnapCorrupt("manifest-invalid", `duplicate ${f.path}`);
		paths.add(f.path);
	});
	if ((await bundleDigest(hash, record.snapshotId, record.parts, await digestHex(hash, manifestBytes))) !== record.bundleDigest) {
		throw new SnapCorrupt("bundle-digest", record.snapshotId);
	}
	return m;
}
