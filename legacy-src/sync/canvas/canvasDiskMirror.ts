import { type App, normalizePath, TFile } from "obsidian";
import type { CanvasMergeConflict } from "@shared/canvasTypes";
import type { CanvasProjectionPort } from "./canvasManager";

export class ObsidianCanvasDiskMirror implements CanvasProjectionPort {
	constructor(private readonly app: App) {}

	async read(path: string): Promise<Uint8Array | null> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return file instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(file)) : null;
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		const normalized = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		if (file instanceof TFile) await this.app.vault.modifyBinary(file, buffer);
		else await this.app.vault.createBinary(normalized, buffer);
	}

	fingerprint(path: string): Promise<Uint8Array | null> { return this.read(path); }

	async preserveConflict(input: { path: string; documentId: string; bytes: Uint8Array;
		conflicts: readonly CanvasMergeConflict[] }): Promise<boolean> {
		try {
			const parent = normalizePath(".yaos-conflicts");
			if (!await this.app.vault.adapter.exists(parent)) await this.app.vault.adapter.mkdir(parent);
			const directory = normalizePath(".yaos-conflicts/canvas");
			if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory);
			const safeName = input.path.replace(/[^A-Za-z0-9._-]+/g, "_");
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const artifact = normalizePath(`${directory}/${safeName}.${stamp}.${input.documentId.slice(0, 8)}.canvas`);
			const buffer = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer;
			await this.app.vault.adapter.writeBinary(artifact, buffer);
			await this.app.vault.adapter.write(`${artifact}.json`, JSON.stringify({ path: input.path,
				documentId: input.documentId, conflicts: input.conflicts }, null, 2));
			return true;
		} catch { return false; }
	}
}
