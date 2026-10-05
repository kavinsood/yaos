/**
 * ConfigDirPort over Obsidian's DataAdapter (DESIGN §j.3). Paths are
 * config-relative ("plugins/x/data.json"); list() returns config-relative paths.
 * writeBytes is write-tmp-then-rename (remove target first where rename does
 * not overwrite).
 */

import type { ConfigDirPort } from "../ports/vault";
import { tightBuffer, type AdapterApi } from "./obsidianApi";

function join(a: string, b: string): string {
	return b === "" ? a : `${a}/${b}`.replace(/\/+/g, "/").replace(/\/$/, "");
}

export async function mkdirs(adapter: AdapterApi, dir: string): Promise<void> {
	const parts = dir.split("/").filter(Boolean);
	for (let i = 1; i <= parts.length; i++) {
		const p = parts.slice(0, i).join("/");
		if (!(await adapter.exists(p))) await adapter.mkdir(p);
	}
}

export class ObsidianConfigDir implements ConfigDirPort {
	constructor(
		private readonly adapter: AdapterApi,
		private readonly configDir: string,
	) {}

	private abs(rel: string): string {
		return join(this.configDir, rel.replace(/^\/+/, ""));
	}

	private rel(abs: string): string {
		return abs.startsWith(this.configDir + "/") ? abs.slice(this.configDir.length + 1) : abs;
	}

	async list(dir: string) {
		const base = this.abs(dir.replace(/\/$/, ""));
		if (!(await this.adapter.exists(base))) return [];
		const listed = await this.adapter.list(base);
		const out: { path: string; size: number; mtimeMs: number; isFolder: boolean }[] = [];
		for (const f of listed.files) {
			const st = await this.adapter.stat(f);
			out.push({ path: this.rel(f), size: st?.size ?? 0, mtimeMs: st?.mtime ?? 0, isFolder: false });
		}
		for (const d of listed.folders) out.push({ path: this.rel(d), size: 0, mtimeMs: 0, isFolder: true });
		return out;
	}

	async readBytes(path: string): Promise<Uint8Array | null> {
		const p = this.abs(path);
		if (!(await this.adapter.exists(p))) return null;
		return new Uint8Array(await this.adapter.readBinary(p));
	}

	async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
		const p = this.abs(path);
		const slash = p.lastIndexOf("/");
		if (slash > 0) await mkdirs(this.adapter, p.slice(0, slash));
		const tmp = `${p}.yaos-tmp`;
		await this.adapter.writeBinary(tmp, tightBuffer(bytes));
		try {
			await this.adapter.rename(tmp, p);
		} catch {
			if (await this.adapter.exists(p)) await this.adapter.remove(p);
			await this.adapter.rename(tmp, p);
		}
	}

	async remove(path: string): Promise<void> {
		const p = this.abs(path);
		if (await this.adapter.exists(p)) await this.adapter.remove(p);
	}
}
