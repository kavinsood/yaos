/**
 * VaultPort over Obsidian's Vault (DESIGN §f, §h).
 *  - write: CAS. Text over an existing file goes through vault.process with an
 *    exact-content guard (the callback throws to abort, so a changed file is
 *    never written); "absent" goes through vault.create (throws if it exists).
 *    Binary over an existing file is check-then-modifyBinary (not atomic;
 *    narrowed by a stat recheck). Gap recorded in wp-d-notes.
 *  - rename: vault.rename only (never fileManager.renameFile: no link rewrites).
 *  - trash: vault.trash only. No permanent file delete exists in this adapter.
 *  - removeEmptyFolder: vault.delete(folder, false) only when it has zero
 *    children in the index (no file content can be lost).
 */

import type { DiskFingerprint, VaultPath } from "../core/types";
import type { Unsubscribe } from "../ports/common";
import type { RenameOutcome, TrashMode, VaultEvent, VaultPort, VaultStat, WriteOutcome, WritePrecondition } from "../ports/vault";
import type { Hasher } from "./hashing";
import { utf8 } from "./hashing";
import {
	decodeKeepBom, invalidVaultPath, isFile, isFolder, parentsOf, tightBuffer,
	type AbstractFileLike, type FileLike, type VaultApi,
} from "./obsidianApi";

class CasAbort extends Error {}

export function statOf(f: FileLike): VaultStat {
	return { path: f.path, size: f.stat.size, mtimeMs: f.stat.mtime, ctimeMs: f.stat.ctime };
}

export class ObsidianVault implements VaultPort {
	readonly configDir: string;
	readonly caseInsensitive: boolean;
	private tmpSeq = 0;

	constructor(
		private readonly vault: VaultApi,
		private readonly hasher: Hasher,
		caseInsensitive: boolean,
	) {
		this.configDir = vault.configDir;
		this.caseInsensitive = caseInsensitive;
	}

	private key(path: string): string {
		return this.caseInsensitive ? path.toLowerCase() : path;
	}

	private file(path: string): FileLike | null {
		const f = this.vault.getAbstractFileByPath(path);
		return isFile(f) ? f : null;
	}

	async list(): Promise<readonly VaultStat[]> {
		return this.vault.getFiles().map(statOf);
	}

	async stat(path: string): Promise<VaultStat | null> {
		const f = this.file(path);
		return f ? statOf(f) : null;
	}

	async readText(path: string): Promise<string> {
		const f = this.file(path);
		if (!f) throw new Error(`ENOENT: ${path}`);
		return this.vault.read(f);
	}

	async readBytes(path: string): Promise<Uint8Array> {
		const f = this.file(path);
		if (!f) throw new Error(`ENOENT: ${path}`);
		return new Uint8Array(await this.vault.readBinary(f));
	}

	/** null = passes. Reads exact bytes so fingerprint preconditions see what is on disk. */
	private async check(path: string, f: FileLike | null, pre: WritePrecondition): Promise<{ pass: boolean; bytes: Uint8Array | null }> {
		switch (pre.t) {
			case "any":
				return { pass: true, bytes: null };
			case "absent":
				return { pass: f === null && !(await this.vault.adapter.exists(path)), bytes: null };
			case "fingerprint":
			case "hash": {
				if (!f) return { pass: false, bytes: null };
				const bytes = new Uint8Array(await this.vault.readBinary(f));
				const pass = pre.t === "fingerprint"
					? (await this.hasher.fingerprint(bytes)) === pre.fingerprint
					: (await this.hasher.contentHash(path, bytes)) === pre.hash;
				return { pass, bytes };
			}
		}
	}

	private async ensureParents(path: string): Promise<string | null> {
		for (const p of parentsOf(path)) {
			const a = this.vault.getAbstractFileByPath(p);
			if (isFile(a)) return p;
			if (a === null) {
				try {
					await this.vault.createFolder(p);
				} catch {
					// created concurrently (or exists unindexed): fine
				}
			}
		}
		return null;
	}

	async write(path: VaultPath, data: string | Uint8Array, precondition: WritePrecondition): Promise<WriteOutcome> {
		const bad = invalidVaultPath(path);
		if (bad) return { ok: false, reason: "invalid-path", current: null, message: bad };
		const existing = this.vault.getAbstractFileByPath(path);
		if (isFolder(existing)) return { ok: false, reason: "io", current: null, message: "target is a folder" };
		const parentFile = await this.ensureParents(path);
		if (parentFile !== null) {
			const pf = this.file(parentFile);
			return { ok: false, reason: "parent-is-file", current: pf ? statOf(pf) : null, message: `parent ${parentFile} is a file` };
		}
		const bytes = typeof data === "string" ? utf8(data) : data;
		const f = this.file(path);
		const failPre = (cur: FileLike | null): WriteOutcome => ({ ok: false, reason: "precondition", current: cur ? statOf(cur) : null, message: `precondition ${precondition.t} failed` });
		const before = f ? statOf(f) : null; // snapshot: Obsidian mutates file.stat in place
		try {
			const { pass, bytes: seen } = await this.check(path, f, precondition);
			if (!pass) return failPre(this.file(path));
			if (!f) {
				// absent (or "any" on a missing file): create throws if it appeared meanwhile.
				try {
					if (typeof data === "string") await this.vault.create(path, data);
					else await this.vault.createBinary(path, tightBuffer(data));
				} catch (e) {
					if (this.file(path) || (await this.vault.adapter.exists(path))) return failPre(this.file(path));
					throw e;
				}
			} else if (typeof data === "string") {
				const expect = seen ? decodeKeepBom(seen) : null;
				await this.vault.process(f, (cur) => {
					if (expect !== null && cur !== expect) throw new CasAbort("changed since check");
					return data;
				});
			} else {
				const now = this.file(path);
				if (!now || !before || now.stat.mtime !== before.mtimeMs || now.stat.size !== before.size) return failPre(now);
				await this.vault.modifyBinary(now, tightBuffer(data));
			}
		} catch (e) {
			if (e instanceof CasAbort) return failPre(this.file(path));
			return { ok: false, reason: "io", current: null, message: e instanceof Error ? e.message : String(e) };
		}
		const after = this.file(path);
		if (!after) return { ok: false, reason: "io", current: null, message: "written file vanished" };
		return { ok: true, stat: statOf(after), fingerprint: (await this.hasher.fingerprint(bytes)) as DiskFingerprint };
	}

	async rename(from: string, to: VaultPath, precondition: WritePrecondition): Promise<RenameOutcome> {
		const bad = invalidVaultPath(to);
		if (bad) return { ok: false, reason: "io", message: `invalid target: ${bad}` };
		const src = this.file(from);
		if (!src) return { ok: false, reason: "source-missing", message: "source missing" };
		const caseOnly = this.key(from) === this.key(to) && from !== to;
		if (!caseOnly && (this.vault.getAbstractFileByPath(to) !== null || (await this.vault.adapter.exists(to)))) {
			return { ok: false, reason: "target-exists", message: "target exists" };
		}
		const { pass } = await this.check(from, src, precondition);
		if (!pass) return { ok: false, reason: "precondition", message: `precondition ${precondition.t} failed` };
		const parentFile = await this.ensureParents(to);
		if (parentFile !== null) return { ok: false, reason: "io", message: `parent ${parentFile} is a file` };
		try {
			if (caseOnly) {
				const tmp = `${from}.yaos-case-${++this.tmpSeq}`;
				await this.vault.rename(src, tmp);
				const mid = this.file(tmp);
				if (!mid) return { ok: false, reason: "io", message: "case rename lost the file" };
				await this.vault.rename(mid, to);
			} else {
				await this.vault.rename(src, to);
			}
		} catch (e) {
			return { ok: false, reason: "io", message: e instanceof Error ? e.message : String(e) };
		}
		const moved = this.file(to);
		return moved ? { ok: true, stat: statOf(moved) } : { ok: false, reason: "io", message: "renamed file not indexed" };
	}

	async trash(path: string, mode: TrashMode, precondition: WritePrecondition): Promise<RenameOutcome> {
		const f = this.file(path);
		if (!f) return { ok: false, reason: "source-missing", message: "source missing" };
		const before = statOf(f);
		const { pass } = await this.check(path, f, precondition);
		if (!pass) return { ok: false, reason: "precondition", message: `precondition ${precondition.t} failed` };
		const now = this.file(path);
		if (!now || now.stat.mtime !== before.mtimeMs || now.stat.size !== before.size) return { ok: false, reason: "precondition", message: "changed during check" };
		const stat = statOf(now);
		try {
			await this.vault.trash(now, mode === "system-trash");
		} catch (e) {
			return { ok: false, reason: "io", message: e instanceof Error ? e.message : String(e) };
		}
		return { ok: true, stat };
	}

	async removeEmptyFolder(path: VaultPath): Promise<void> {
		const f = this.vault.getAbstractFileByPath(path);
		if (!isFolder(f) || f.children.length > 0) return;
		const listed = await this.vault.adapter.list(path).catch(() => null);
		if (!listed || listed.files.length > 0 || listed.folders.length > 0) return; // hidden children: keep
		await this.vault.delete(f, false);
	}

	onEvent(listener: (event: VaultEvent) => void): Unsubscribe {
		const v = this.vault;
		const refs = [
			v.on("create", (f: AbstractFileLike) => {
				if (isFile(f)) listener({ t: "create", path: f.path, stat: statOf(f) });
			}),
			v.on("modify", (f: AbstractFileLike) => {
				if (isFile(f)) listener({ t: "modify", path: f.path, stat: statOf(f) });
			}),
			v.on("delete", (f: AbstractFileLike) => {
				if (isFile(f)) listener({ t: "delete", path: f.path });
			}),
			v.on("rename", (f: AbstractFileLike, oldPath: string) => {
				if (isFile(f)) listener({ t: "rename", from: oldPath, to: f.path, stat: statOf(f) });
			}),
		];
		return () => {
			for (const r of refs) v.offref(r);
		};
	}
}
