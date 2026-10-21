/**
 * HostSideFilePort: plugin-private state next to the vault, <configDir>/plugins/yaos/state/<deviceId>/ (DESIGN
 * §e.4, §i.5; identity-per-store §5.2). Survives an IndexedDB wipe. Writes are plain (readers use A/B generations +
 * checksums). Every path names its store dir, and the engine only ever names its own; this adapter refuses any
 * other shape. It never lists or deletes a dir as a whole: a copied or synced folder carries other installs' dirs.
 */

import { sideFileDir, type HostSideFilePort, type SideFilePath, type SideFilePrefix } from "../ports/vault";
import { mkdirs } from "./configDir";
import { tightBuffer, type AdapterApi } from "./obsidianApi";

/** The flat files of the identity-less layout (identity-per-store §13), deleted on start. */
export const LEGACY_SIDE_FILES: readonly string[] = ["outbox-a.bin", "outbox-b.bin", "synced-a.bin", "synced-b.bin"];

export class ObsidianSideFiles implements HostSideFilePort {
	private readonly dir: string;

	/** pluginDir = manifest.dir, e.g. ".obsidian/plugins/yaos". */
	constructor(
		private readonly adapter: AdapterApi,
		pluginDir: string,
	) {
		this.dir = `${pluginDir.replace(/\/$/, "")}/state`;
	}

	private path(name: string): string {
		if (sideFileDir(name) === null || name.includes("..")) throw new Error("side file outside a store dir");
		return `${this.dir}/${name}`;
	}

	async read(name: SideFilePath): Promise<Uint8Array | null> {
		const p = this.path(name);
		if (!(await this.adapter.exists(p))) return null;
		return new Uint8Array(await this.adapter.readBinary(p));
	}

	async write(name: SideFilePath, bytes: Uint8Array): Promise<void> {
		const p = this.path(name);
		await mkdirs(this.adapter, p.slice(0, p.lastIndexOf("/")));
		await this.adapter.writeBinary(p, tightBuffer(bytes));
	}

	async remove(name: SideFilePath): Promise<void> {
		const p = this.path(name);
		if (await this.adapter.exists(p)) await this.adapter.remove(p);
	}

	async list(prefix: SideFilePrefix): Promise<readonly SideFilePath[]> {
		const dir = this.path(prefix).replace(/\/$/, "");
		if (!(await this.adapter.exists(dir))) return [];
		const listed = await this.adapter.list(dir);
		return listed.files.map((f) => `${prefix}${f.slice(f.lastIndexOf("/") + 1)}` as SideFilePath);
	}

	/** identity-per-store §13: drop the old layout's flat mirrors (`state/outbox-*.bin`, `state/synced-*.bin`). */
	async removeLegacy(): Promise<number> {
		let n = 0;
		for (const name of LEGACY_SIDE_FILES) {
			const p = `${this.dir}/${name}`;
			if (!(await this.adapter.exists(p))) continue;
			await this.adapter.remove(p);
			n++;
		}
		return n;
	}
}
