/**
 * SideFilePort: plugin-private state next to the vault,
 * <configDir>/plugins/yaos/state/ (DESIGN §e.4, §i.5). Survives an IndexedDB
 * wipe. Writes are plain (readers use A/B generations + checksums).
 */

import type { SideFileName, SideFilePort } from "../ports/vault";
import { mkdirs } from "./configDir";
import { tightBuffer, type AdapterApi } from "./obsidianApi";

export class ObsidianSideFiles implements SideFilePort {
	private readonly dir: string;

	/** pluginDir = manifest.dir, e.g. ".obsidian/plugins/yaos". */
	constructor(
		private readonly adapter: AdapterApi,
		pluginDir: string,
	) {
		this.dir = `${pluginDir.replace(/\/$/, "")}/state`;
	}

	private path(name: SideFileName): string {
		return `${this.dir}/${name}`;
	}

	async read(name: SideFileName): Promise<Uint8Array | null> {
		const p = this.path(name);
		if (!(await this.adapter.exists(p))) return null;
		return new Uint8Array(await this.adapter.readBinary(p));
	}

	async write(name: SideFileName, bytes: Uint8Array): Promise<void> {
		const p = this.path(name);
		await mkdirs(this.adapter, p.slice(0, p.lastIndexOf("/")));
		await this.adapter.writeBinary(p, tightBuffer(bytes));
	}

	async remove(name: SideFileName): Promise<void> {
		const p = this.path(name);
		if (await this.adapter.exists(p)) await this.adapter.remove(p);
	}

	async list(prefix: "snapshots/"): Promise<readonly SideFileName[]> {
		const dir = `${this.dir}/${prefix.replace(/\/$/, "")}`;
		if (!(await this.adapter.exists(dir))) return [];
		const listed = await this.adapter.list(dir);
		return listed.files.map((f) => `${prefix}${f.slice(f.lastIndexOf("/") + 1)}` as SideFileName);
	}
}
