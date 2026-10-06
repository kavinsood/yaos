/**
 * VaultPort over Obsidian's Vault (DESIGN §f, §h).
 *  - write: CAS without hashing on main (DESIGN §d.4). "absent" goes through vault.create (throws if
 *    it exists: atomic). fingerprint/hash: read the raw bytes, the engine hashes them (HashOracle),
 *    compare, then write behind O(1) guards; see "Precondition window" below.
 *  - rename: vault.rename only (never fileManager.renameFile: no link rewrites).
 *  - trash: vault.trash only. No permanent file delete exists in this adapter. "follow-obsidian"
 *    reads trashOption from <configDir>/app.json through the adapter at each delete (see
 *    followObsidianSystemTrash).
 *  - removeEmptyFolder: vault.delete(folder, false) only when it has zero
 *    children in the index (no file content can be lost).
 *
 * Precondition window (fingerprint/hash over an existing file). Obsidian has no compare-and-swap; the
 * check reads at t0 (adapter.readBinary), the engine answers at t1, the write happens at t2.
 *  - Caught: any change visible in TFile.stat (size or mtime differs from the snapshot taken before
 *    the t0 read) up to the recheck right before the write; for text, any change of the UTF-16 length
 *    at t2: vault.process reads the file inside Obsidian's adapter queue and our callback throws (no
 *    write) unless `cur.length` equals the engine's textLength of the t0 bytes (desktop adapter.process
 *    reads, calls the callback, writes only if it returned, obsidian.asar 1.14.4 app.js@552301;
 *    Vault.process@1426847 delegates to it; Capacitor@1350128 is the same shape).
 *  - Missed (accepted gap): a same-length text change, or any binary change, that is not yet in
 *    TFile.stat when we recheck: Obsidian's watcher has not delivered it yet, it kept size and mtime
 *    (same-millisecond, coarse-mtime filesystems), or it lands between the recheck and the process
 *    read (text) / the modifyBinary (binary). The old main-thread guard compared the full text inside
 *    process and closed the text part of this gap at O(N) main-thread cost; DESIGN §d.4 forbids that.
 *    The engine fingerprints what it wrote and re-reads the disk on the next modify event, so a lost
 *    external edit of this kind is still the narrow race of any non-atomic writer, not a silent loop.
 *  - Spurious failures (safe direction): if Obsidian's decode ever disagreed with the engine's
 *    WHATWG UTF-8 decode on invalid bytes, the length guard fails and the op is retried/replanned.
 */

import type { VaultPath } from "../core/types";
import type { Unsubscribe } from "../ports/common";
import type { RenameOutcome, TrashMode, VaultEvent, VaultPort, VaultStat, WriteOutcome, WritePrecondition } from "../ports/vault";
import type { HashOracle } from "./hashOracle";
import {
	invalidVaultPath, isFile, isFolder, parentsOf, tightBuffer,
	type AbstractFileLike, type FileLike, type VaultApi,
} from "./obsidianApi";

class CasAbort extends Error {}

export function statOf(f: FileLike): VaultStat {
	return { path: f.path, size: f.stat.size, mtimeMs: f.stat.mtime, ctimeMs: f.stat.ctime };
}

/**
 * Obsidian's Deleted files preference (Settings → Files and links), stored as `trashOption` in
 * `<configDir>/app.json`, mapped to vault.trash's `system` flag. Obsidian 1.12.7 (obsidian.asar):
 * the default is trashOption "system", and FileManager.trashFile does "system" → vault.trash(f, true),
 * "local" → vault.trash(f, false), "none" → vault.delete(f, true); the config is saved with
 * writeConfigJson("app"). "none" maps to the .trash folder here because YAOS never deletes
 * permanently (invariant 2). Absent, unreadable or malformed → Obsidian's default, system.
 */
export function followObsidianSystemTrash(appJson: string | null): boolean {
	if (appJson === null) return true;
	let parsed: unknown;
	try {
		parsed = JSON.parse(appJson);
	} catch {
		return true;
	}
	const option = parsed !== null && typeof parsed === "object" ? (parsed as { trashOption?: unknown }).trashOption : undefined;
	return option !== "local" && option !== "none";
}

export class ObsidianVault implements VaultPort {
	readonly configDir: string;
	readonly caseInsensitive: boolean;
	private tmpSeq = 0;

	constructor(
		private readonly vault: VaultApi,
		private readonly hashes: HashOracle,
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
		// adapter.readBinary, not vault.readBinary: the latter also decodes .md files into Obsidian's
		// cache on main (obsidian.asar 1.14.4 app.js@1423772). Desktop returns a fresh ArrayBuffer
		// (@550001, Xl @545899: buffer.slice), so the view owns it and transfers without a copy.
		return new Uint8Array(await this.vault.adapter.readBinary(f.path));
	}

	/**
	 * Evaluates a precondition without hashing on main: the exact bytes go (transferred) to the engine,
	 * which answers the hash and the UTF-16 length of their text (BOM kept) for the write guard.
	 * Throws when the engine is not running (callers report io, never guess).
	 */
	private async check(path: string, f: FileLike | null, pre: WritePrecondition): Promise<{ pass: boolean; textLength: number | null }> {
		switch (pre.t) {
			case "any":
				return { pass: true, textLength: null };
			case "absent":
				return { pass: f === null && !(await this.vault.adapter.exists(path)), textLength: null };
			case "fingerprint":
			case "hash": {
				if (!f) return { pass: false, textLength: null };
				const bytes = await this.readBytes(f.path);
				const [v] = await this.hashes.hash([{ path: f.path, want: pre.t === "fingerprint" ? "fingerprint" : "contentHash", bytes }]);
				if (!v) throw new Error("hash oracle returned no value");
				return { pass: v.hash === (pre.t === "fingerprint" ? pre.fingerprint : pre.hash), textLength: v.textLength };
			}
		}
	}

	/** check() for rename/trash: an unavailable engine is an io failure, not a throw. */
	private async checkOrIo(path: string, f: FileLike, pre: WritePrecondition): Promise<RenameOutcome | null> {
		try {
			const { pass } = await this.check(path, f, pre);
			return pass ? null : { ok: false, reason: "precondition", message: `precondition ${pre.t} failed` };
		} catch (e) {
			return { ok: false, reason: "io", message: e instanceof Error ? e.message : String(e) };
		}
	}

	/** True when `f` is still the file the check read: present, same size and mtime as `before`. */
	private unchanged(path: string, before: VaultStat | null): FileLike | null {
		const now = this.file(path);
		return now && before && now.stat.mtime === before.mtimeMs && now.stat.size === before.size ? now : null;
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
		const f = this.file(path);
		const failPre = (cur: FileLike | null): WriteOutcome => ({ ok: false, reason: "precondition", current: cur ? statOf(cur) : null, message: `precondition ${precondition.t} failed` });
		const before = f ? statOf(f) : null; // snapshot: Obsidian mutates file.stat in place
		try {
			const { pass, textLength } = await this.check(path, f, precondition);
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
			} else {
				// Checked preconditions: the file must still be the one the check read (stat-visible
				// changes since the snapshot). "any" skips it, as before. No await between this recheck
				// and the write call below.
				const now = precondition.t === "any" ? f : this.unchanged(path, before);
				if (!now) return failPre(this.file(path));
				if (typeof data === "string") {
					// O(1) guard at the read inside Obsidian's adapter queue: a changed length aborts
					// before anything is written (the callback throws). Same-length changes not visible
					// in stat are the accepted gap (header).
					await this.vault.process(now, (cur) => {
						if (textLength !== null && cur.length !== textLength) throw new CasAbort("changed since check");
						return data;
					});
				} else {
					await this.vault.modifyBinary(now, tightBuffer(data));
				}
			}
		} catch (e) {
			if (e instanceof CasAbort) return failPre(this.file(path));
			return { ok: false, reason: "io", current: null, message: e instanceof Error ? e.message : String(e) };
		}
		const after = this.file(path);
		if (!after) return { ok: false, reason: "io", current: null, message: "written file vanished" };
		return { ok: true, stat: statOf(after) };
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
		const before = statOf(src);
		const failed = await this.checkOrIo(from, src, precondition);
		if (failed) return failed;
		const parentFile = await this.ensureParents(to);
		if (parentFile !== null) return { ok: false, reason: "io", message: `parent ${parentFile} is a file` };
		const cur = precondition.t === "any" || precondition.t === "absent" ? this.file(from) : this.unchanged(from, before);
		if (!cur) return { ok: false, reason: "precondition", message: "changed during check" };
		try {
			if (caseOnly) {
				const tmp = `${from}.yaos-case-${++this.tmpSeq}`;
				await this.vault.rename(cur, tmp);
				const mid = this.file(tmp);
				if (!mid) return { ok: false, reason: "io", message: "case rename lost the file" };
				await this.vault.rename(mid, to);
			} else {
				await this.vault.rename(cur, to);
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
		const system = await this.systemTrash(mode); // before the check: no await between recheck and trash
		const failed = await this.checkOrIo(path, f, precondition);
		if (failed) return failed;
		const now = this.unchanged(path, before);
		if (!now) return { ok: false, reason: "precondition", message: "changed during check" };
		const stat = statOf(now);
		try {
			await this.vault.trash(now, system);
		} catch (e) {
			return { ok: false, reason: "io", message: e instanceof Error ? e.message : String(e) };
		}
		return { ok: true, stat };
	}

	private async systemTrash(mode: TrashMode): Promise<boolean> {
		if (mode !== "follow-obsidian") return mode === "system-trash";
		const appJson = await this.vault.adapter.read(`${this.configDir}/app.json`).catch(() => null);
		return followObsidianSystemTrash(appJson);
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
