/**
 * Incremental bundle export (DESIGN §j.4): files go into a ZipWriter one at a time, the zip bytes go through a
 * PartCutter, and each finished part is handed to `onPart` (the engine writes it to a side file). Nothing holds
 * the whole zip; the builder keeps one part buffer, the central directory entries and the manifest list.
 * Paths and contents are not checked here: the caller filters what it adds (restore checks everything again).
 */

import type { HashPort } from "../../ports/crypto";
import type { ContentHash, DocKind, VaultPath } from "../types";
import { digestHex } from "../hash/digest";
import { exactFingerprint } from "../hash/markdownLf";
import { SNAP_FORMAT_ZIP1, SNAP_RECORD_VERSION, clampSnapLabel, type SnapReason, type SnapRecord } from "./record";
import {
	PartCutter, SNAP_ENTRY_PREFIX, SNAP_MANIFEST, bundleDigest, encodeManifest,
	type CutPart, type SnapManifest, type SnapManifestFile, type SnapSkipReason,
} from "./bundle";
import { ZipWriter } from "./zip";

export interface BuiltBundle {
	readonly manifest: SnapManifest;
	readonly parts: readonly { readonly size: number; readonly sha256: ContentHash }[];
	readonly bundleDigest: ContentHash;
	readonly zipBytes: number;
	readonly totalBytes: number;
}

export class BundleBuilder {
	private readonly cutter: PartCutter;
	private readonly zip: ZipWriter;
	private readonly files: SnapManifestFile[] = [];
	private readonly skipped: { path: string; reason: SnapSkipReason }[] = [];
	private total = 0;

	constructor(
		private readonly hash: HashPort,
		readonly id: string,
		readonly createdAtMs: number,
		readonly reason: SnapReason,
		partSize: number,
		onPart: (p: CutPart) => Promise<void>,
	) {
		this.cutter = new PartCutter(hash, partSize, onPart);
		this.zip = new ZipWriter((chunk) => this.cutter.push(chunk));
	}

	get fileBytes(): number { return this.total; }
	get zipBytes(): number { return this.zip.bytesWritten; }

	async addFile(path: VaultPath, kind: DocKind, data: Uint8Array): Promise<void> {
		await this.zip.add(SNAP_ENTRY_PREFIX + path, data, kind !== "blob");
		const hash = (await exactFingerprint(this.hash, data)) as string as ContentHash;
		this.files.push({ path, kind, hash, size: data.length });
		this.total += data.length;
	}

	skip(path: string, reason: SnapSkipReason): void {
		this.skipped.push({ path, reason });
	}

	async finish(): Promise<BuiltBundle> {
		const manifest: SnapManifest = { formatVersion: 1, id: this.id, createdAtMs: this.createdAtMs, reason: this.reason, files: this.files, skipped: this.skipped };
		const mbytes = encodeManifest(manifest);
		await this.zip.add(SNAP_MANIFEST, mbytes, true);
		await this.zip.finish();
		await this.cutter.end();
		const parts = this.cutter.parts;
		const digest = await bundleDigest(this.hash, this.id, parts, await digestHex(this.hash, mbytes));
		return { manifest, parts, bundleDigest: digest, zipBytes: this.zip.bytesWritten, totalBytes: this.total };
	}
}

/** The index record of a built bundle; `addresses[i]` = blobAddress(parts[i].sha256). */
export function bundleRecord(b: BuiltBundle, deviceLabel: string, addresses: readonly string[]): SnapRecord {
	return {
		version: SNAP_RECORD_VERSION, snapshotId: b.manifest.id, createdAtMs: b.manifest.createdAtMs, deviceLabel: clampSnapLabel(deviceLabel), reason: b.manifest.reason,
		format: SNAP_FORMAT_ZIP1, fileCount: b.manifest.files.length, totalBytes: b.totalBytes, bundleDigest: b.bundleDigest,
		parts: b.parts.map((p, i) => ({ address: addresses[i]!, size: p.size, sha256: p.sha256 })),
	};
}
