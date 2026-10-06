/**
 * In-memory VaultPort for WP-B tests (stand-in for WP-D's SimVault).
 * Obsidian-like semantics:
 *  - list() returns files only, never dot-folders (".trash", the config dir);
 *  - write() with a precondition is a CAS; a failed precondition never writes;
 *    parent folders are created; a file in the parent chain fails "parent-is-file";
 *  - rename() is a plain rename: it never rewrites links. `fileManagerRenameFile`
 *    is the link-rewriting variant the engine must never reach (counted);
 *  - trash() moves to ".trash/" (obsidian-trash) or a system-trash list (system-trash, and
 *    follow-obsidian as Obsidian's default); nothing is ever permanently deleted;
 *  - case-insensitive profile: "a.md" and "A.md" are one file, the stored name
 *    keeps the casing of its creation (or of the last rename);
 *  - events: create / modify / delete / rename, emitted synchronously after the change.
 */

import type { Unsubscribe } from "../../../ports/common";
import type {
	RenameOutcome, TrashMode, VaultEvent, VaultPort, VaultStat, WriteOutcome, WritePrecondition,
} from "../../../ports/vault";
import type { ContentHash, VaultPath } from "../../../core/types";
import { kindOfPath } from "../../../core/types";
import { sha256Hex } from "../../../core/hash/sha256";
import { utf8Decode, utf8Encode } from "../../../core/hash/utf8";
import { exactFingerprint, markdownContentHash } from "../../../core/hash/markdownLf";
import { canvasContentHash } from "../../../core/hash/canvasCanonical";

export interface FakeFile {
	/** Display path (exact casing / normalization as stored). */
	path: string;
	bytes: Uint8Array;
	mtimeMs: number;
	ctimeMs: number;
}

export function logicalHash(path: string, bytes: Uint8Array): ContentHash {
	const kind = kindOfPath(path);
	if (kind === "markdown") return markdownContentHash(utf8Decode(bytes));
	if (kind === "canvas") return canvasContentHash(bytes);
	return sha256Hex(bytes) as ContentHash;
}

export class FakeVault implements VaultPort {
	readonly configDir = ".obsidian";
	private readonly files = new Map<string, FakeFile>();
	private readonly folders = new Map<string, string>();
	private readonly listeners = new Set<(e: VaultEvent) => void>();
	/** Trashed items, newest last (recoverable). */
	readonly trashed: { path: string; bytes: Uint8Array; mode: TrashMode }[] = [];
	/** Calls of the link-rewriting rename (must stay 0 for engine-driven moves). */
	fileManagerRenames = 0;
	/** Every mutating call, for assertions. */
	readonly calls: string[] = [];
	private tick = 0;

	constructor(readonly caseInsensitive = false, private readonly now: () => number = () => 1_700_000_000_000) {}

	private key(path: string): string {
		const n = path.normalize("NFC");
		return this.caseInsensitive ? n.toLowerCase() : n;
	}

	private stamp(): number {
		// Distinct, increasing mtimes even when the clock does not move.
		this.tick++;
		return this.now() + this.tick;
	}

	private statOf(f: FakeFile): VaultStat {
		return { path: f.path, size: f.bytes.length, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs };
	}

	private emit(e: VaultEvent): void {
		for (const l of [...this.listeners]) l(e);
	}

	private hidden(path: string): boolean {
		return path.split("/").some((seg) => seg.startsWith("."));
	}

	private checkPre(f: FakeFile | undefined, pre: WritePrecondition): boolean {
		switch (pre.t) {
			case "any": return true;
			case "absent": return f === undefined;
			case "fingerprint": return f !== undefined && exactFingerprint(f.bytes) === pre.fingerprint;
			case "hash": return f !== undefined && logicalHash(f.path, f.bytes) === pre.hash;
		}
	}

	private ensureFolders(path: string): string | null {
		const parts = path.split("/");
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc === "" ? parts[i]! : `${acc}/${parts[i]}`;
			if (this.files.has(this.key(acc))) return acc;
		}
		acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc === "" ? parts[i]! : `${acc}/${parts[i]}`;
			if (!this.folders.has(this.key(acc))) this.folders.set(this.key(acc), acc);
		}
		return null;
	}

	// ---- test helpers (user / external writer actions) ----------------------

	/** User or external app writes a file (emits create/modify). */
	userWrite(path: string, data: string | Uint8Array): VaultStat {
		const bytes = typeof data === "string" ? utf8Encode(data) : data;
		const r = this.writeNow(path, bytes, { t: "any" });
		if (!r.ok) throw new Error(`userWrite failed: ${r.reason}`);
		return r.stat;
	}

	userDelete(path: string): void {
		const k = this.key(path);
		const f = this.files.get(k);
		if (!f) throw new Error(`userDelete: missing ${path}`);
		this.files.delete(k);
		this.emit({ t: "delete", path: f.path });
	}

	userRename(from: string, to: string): void {
		const r = this.renameNow(from, to, { t: "any" });
		if (!r.ok) throw new Error(`userRename failed: ${r.reason}`);
	}

	/** The link-rewriting rename (Obsidian fileManager.renameFile). Never used by the engine path. */
	fileManagerRenameFile(from: string, to: string): void {
		this.fileManagerRenames++;
		this.userRename(from, to);
	}

	text(path: string): string | null {
		const f = this.files.get(this.key(path));
		return f ? utf8Decode(f.bytes) : null;
	}

	bytesOf(path: string): Uint8Array | null {
		return this.files.get(this.key(path))?.bytes ?? null;
	}

	has(path: string): boolean {
		return this.files.has(this.key(path));
	}

	hasFolder(path: string): boolean {
		return this.folders.has(this.key(path));
	}

	/** Exact stored paths, sorted (includes hidden files). */
	paths(): string[] {
		return [...this.files.values()].map((f) => f.path).sort();
	}

	/** Visible files with text content (path -> text), sorted. */
	snapshot(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const p of this.paths()) if (!this.hidden(p)) out[p] = utf8Decode(this.files.get(this.key(p))!.bytes);
		return out;
	}

	// ---- VaultPort -----------------------------------------------------------

	async list(): Promise<readonly VaultStat[]> {
		return [...this.files.values()].filter((f) => !this.hidden(f.path)).map((f) => this.statOf(f)).sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	async stat(path: string): Promise<VaultStat | null> {
		const f = this.files.get(this.key(path));
		return f ? this.statOf(f) : null;
	}

	async readBytes(path: string): Promise<Uint8Array> {
		const f = this.files.get(this.key(path));
		if (!f) throw new Error(`ENOENT ${path}`);
		return f.bytes.slice();
	}

	async write(path: VaultPath, data: string | Uint8Array, precondition: WritePrecondition): Promise<WriteOutcome> {
		this.calls.push(`write ${path}`);
		const bytes = typeof data === "string" ? utf8Encode(data) : data.slice();
		return this.writeNow(path, bytes, precondition);
	}

	private writeNow(path: string, bytes: Uint8Array, precondition: WritePrecondition): WriteOutcome {
		const k = this.key(path);
		const f = this.files.get(k);
		if (this.folders.has(k)) return { ok: false, reason: "io", current: null, message: "is a folder" };
		if (!this.checkPre(f, precondition)) return { ok: false, reason: "precondition", current: f ? this.statOf(f) : null, message: "precondition failed" };
		const blocked = this.ensureFolders(path);
		if (blocked !== null) return { ok: false, reason: "parent-is-file", current: null, message: `parent ${blocked} is a file` };
		const mtimeMs = this.stamp();
		if (f) {
			f.bytes = bytes;
			f.mtimeMs = mtimeMs;
			this.emit({ t: "modify", path: f.path, stat: this.statOf(f) });
			return { ok: true, stat: this.statOf(f) };
		}
		const nf: FakeFile = { path, bytes, mtimeMs, ctimeMs: mtimeMs };
		this.files.set(k, nf);
		this.emit({ t: "create", path, stat: this.statOf(nf) });
		return { ok: true, stat: this.statOf(nf) };
	}

	async rename(from: string, to: VaultPath, precondition: WritePrecondition): Promise<RenameOutcome> {
		this.calls.push(`rename ${from} -> ${to}`);
		return this.renameNow(from, to, precondition);
	}

	private renameNow(from: string, to: string, precondition: WritePrecondition): RenameOutcome {
		const fk = this.key(from);
		const tk = this.key(to);
		const f = this.files.get(fk);
		if (!f) return { ok: false, reason: "source-missing", message: from };
		if (!this.checkPre(f, precondition)) return { ok: false, reason: "precondition", message: "precondition failed" };
		if (tk !== fk && (this.files.has(tk) || this.folders.has(tk))) return { ok: false, reason: "target-exists", message: to };
		const blocked = this.ensureFolders(to);
		if (blocked !== null) return { ok: false, reason: "io", message: `parent ${blocked} is a file` };
		const oldPath = f.path;
		this.files.delete(fk);
		f.path = to;
		this.files.set(tk, f);
		this.emit({ t: "rename", from: oldPath, to, stat: this.statOf(f) });
		return { ok: true, stat: this.statOf(f) };
	}

	async trash(path: string, mode: TrashMode, precondition: WritePrecondition): Promise<RenameOutcome> {
		this.calls.push(`trash ${path}`);
		const k = this.key(path);
		const f = this.files.get(k);
		if (!f) return { ok: false, reason: "source-missing", message: path };
		if (!this.checkPre(f, precondition)) return { ok: false, reason: "precondition", message: "precondition failed" };
		this.files.delete(k);
		this.trashed.push({ path: f.path, bytes: f.bytes, mode });
		if (mode === "obsidian-trash") {
			const leaf = f.path.slice(f.path.lastIndexOf("/") + 1);
			let name = `.trash/${leaf}`;
			for (let n = 2; this.files.has(this.key(name)); n++) name = `.trash/${n} ${leaf}`;
			this.files.set(this.key(name), { ...f, path: name });
		}
		this.emit({ t: "delete", path: f.path });
		return { ok: true, stat: this.statOf(f) };
	}

	async removeEmptyFolder(path: VaultPath): Promise<void> {
		this.calls.push(`rmdir ${path}`);
		const k = this.key(path);
		if (!this.folders.has(k)) return;
		const prefix = `${k}/`;
		for (const fk of this.files.keys()) if (fk.startsWith(prefix)) return;
		for (const dk of this.folders.keys()) if (dk.startsWith(prefix)) return;
		this.folders.delete(k);
	}

	onEvent(listener: (event: VaultEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
