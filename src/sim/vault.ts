/**
 * SimVault: in-memory VaultPort with Obsidian-like semantics. DESIGN §l.1.
 *
 * Profiles:
 *  - "case-insensitive" (macOS/Windows/iOS): "a.md" and "A.md" are the same
 *    file; a case-only rename is a legal rename; writing "A.md" when "a.md"
 *    exists modifies "a.md" (display case kept).
 *  - "case-sensitive" (Linux/Android internal storage): distinct files.
 *
 * Events (hints, like Obsidian's vault events):
 *  - port operations (the sync engine's own writes) fire after `apiEventDelayMs`;
 *  - user operations through Obsidian fire after `apiEventDelayMs`;
 *  - external writers (another app) fire after a seeded watcher delay;
 *  - a folder rename fires one `rename` per contained file (plus nothing for
 *    the folder itself: VaultEvent carries files only).
 * Events are delivered FIFO (due times never decrease).
 *
 * Reloads of open views (spike OR-2, Android, Obsidian 1.13.8): after a
 * modify/create event Obsidian calls setData on every open view of the file
 * whose data differs. Through the vault API (vault.modify / vault.process:
 * the engine's writes, user ops, editor saves) that happens right after the
 * event (spike A: event 8.5 ms, setData 8.8 ms, before modify() resolved), so
 * the reload lag is 0. For a raw disk write by another app it comes
 * `reloadLagMs` after the watcher event (spike B: event 12.7 ms, setData
 * 25.5 ms after the write; the default 25 ms is conservative). SimWorkspace
 * reloads its views from `onReload`, which fires at exactly that moment.
 *
 * A write by anyone but the editor (another app, or another Obsidian UI op /
 * plugin through vault.modify) counts as "unseen" (ClobberRecord on an editor
 * save over it) until that reload. In the window Obsidian's autosave writes
 * the editor over it without looking at the disk; nothing YAOS does runs in
 * between.
 *
 * Dot-folders and the config dir are invisible to list() and events.
 * Every version that ever existed is kept in `history` and every trashed file
 * in `trashed`, for the "nothing destroyed without a copy" invariant (§l.3.3).
 */

import type { Unsubscribe } from "../ports/common";
import type { ClockPort } from "../ports/clock";
import type {
	ConfigDirPort, RenameOutcome, SideFileName, SideFilePort, TrashMode, VaultEvent, VaultPort, VaultStat, WriteOutcome, WritePrecondition,
} from "../ports/vault";
import type { VaultPath } from "../core/types";
import type { HashOracle } from "../host/hashOracle";

// The simulated filesystem's own text encoding (Obsidian's job in the real host, not hashing).
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);
const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

/**
 * A version's text, decoded the first time it is read (the invariants read history after a run): decoding a 100 MB
 * attachment takes about 0.9 s on the thread that wrote it, a cost of the sim alone (Obsidian keeps no history).
 * `bytes` is the version's own array: commit() replaces a file's bytes and never writes into them.
 */
function versionRecord(path: string, bytes: Uint8Array, by: WriterKind, atMs: number): VersionRecord {
	let text: string | null = null;
	return { path, by, atMs, get text() { return (text ??= fromUtf8(bytes)); } };
}

export type CaseProfile = "case-insensitive" | "case-sensitive";

/** External (watcher) modify event -> setViewData lag (spike OR-2 B: 12.8 ms after the event, 25.5 ms after the write; conservative). */
export const OBSIDIAN_RELOAD_DELAY_MS = 25;

/** sync = the engine through VaultPort; save = Obsidian saving an open editor; user = other Obsidian UI ops; external = another app. */
export type WriterKind = "sync" | "save" | "user" | "external";

interface SimFile {
	path: string;
	bytes: Uint8Array;
	mtimeMs: number;
	ctimeMs: number;
	version: number;
	/** Version written by a non-editor writer (external/user) that open views have not reloaded yet. */
	unseenExternal: number | null;
}

export interface VersionRecord {
	readonly path: string;
	readonly text: string;
	readonly by: WriterKind;
	readonly atMs: number;
}

/**
 * Obsidian's own race: an editor save (vault.modify, no precondition) replaced
 * an external or user write before Obsidian reloaded the view with it (watcher
 * delay + reload lag). YAOS never saw that version; its tokens absent from
 * the saved text are exempt in §l.3.
 */
export interface ClobberRecord {
	readonly path: string;
	readonly text: string;
	readonly savedText: string;
	readonly atMs: number;
}

export interface TrashRecord {
	readonly path: string;
	readonly text: string;
	readonly mode: TrashMode | "user";
	readonly atMs: number;
}

export interface SimVaultOptions {
	readonly clock: ClockPort;
	/** Precondition hashes: the engine's (main never hashes, host/hashOracle.ts); sim/hash.ts simHashOracle. */
	readonly hashes: HashOracle;
	readonly profile: CaseProfile;
	readonly configDir?: string;
	/** Delay of events for API (Obsidian-internal) operations. */
	readonly apiEventDelayMs?: number;
	/** Delay of external-writer events (file watcher), drawn per event. */
	readonly watcherDelayMs?: () => number;
	/** External writes: event delivery -> view reload lag (default OBSIDIAN_RELOAD_DELAY_MS). API writes reload at delivery. */
	readonly reloadLagMs?: number;
	/** Called on every completed mutation (for invariants/tracing). */
	readonly onMutation?: (m: { readonly kind: "write" | "rename" | "trash"; readonly by: WriterKind; readonly path: string; readonly to?: string }) => void;
}

function parentOf(path: string): string | null {
	const i = path.lastIndexOf("/");
	return i < 0 ? null : path.slice(0, i);
}

function ancestors(path: string): string[] {
	const out: string[] = [];
	let p = parentOf(path);
	while (p !== null) {
		out.push(p);
		p = parentOf(p);
	}
	return out;
}

function invalidPath(path: string): string | null {
	if (path.length === 0) return "empty path";
	if (path.startsWith("/") || path.endsWith("/")) return "leading or trailing slash";
	for (const seg of path.split("/")) {
		if (seg === "" || seg === "." || seg === "..") return `bad segment "${seg}"`;
	}
	if (/[\u0000-\u001f\u007f]/.test(path)) return "control character";
	return null;
}

export class SimVault implements VaultPort {
	readonly configDir: string;
	readonly caseInsensitive: boolean;
	private readonly files = new Map<string, SimFile>();
	private readonly folders = new Map<string, string>();
	private readonly listeners = new Set<(event: VaultEvent) => void>();
	private readonly reloadListeners = new Set<(path: string) => void>();
	private lastEventDue = 0;
	private eventsInFlight = 0;
	readonly history: VersionRecord[] = [];
	readonly trashed: TrashRecord[] = [];
	readonly clobbered: ClobberRecord[] = [];
	/** Counts of port calls (acceptance: rename via rename(), deletes via trash()). */
	readonly calls = { write: 0, rename: 0, trash: 0, removeEmptyFolder: 0, list: 0, readBytes: 0 };
	/** Fault hook: make the next N port operations throw (I/O error). */
	failNextOps = 0;

	constructor(private readonly opts: SimVaultOptions) {
		this.configDir = opts.configDir ?? ".obsidian";
		this.caseInsensitive = opts.profile === "case-insensitive";
	}

	key(path: string): string {
		const n = path.normalize("NFC");
		return this.caseInsensitive ? n.toLowerCase() : n;
	}

	private hidden(path: string): boolean {
		return path.split("/").some((seg) => seg.startsWith(".")) || path === this.configDir || path.startsWith(this.configDir + "/");
	}

	private stamp(f: SimFile): VaultStat {
		return { path: f.path, size: f.bytes.byteLength, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs };
	}

	// --- VaultPort ------------------------------------------------------------

	async list(): Promise<readonly VaultStat[]> {
		this.calls.list++;
		const out: VaultStat[] = [];
		for (const f of this.files.values()) if (!this.hidden(f.path)) out.push(this.stamp(f));
		return out;
	}

	async stat(path: string): Promise<VaultStat | null> {
		const f = this.files.get(this.key(path));
		return f ? this.stamp(f) : null;
	}

	async readBytes(path: string): Promise<Uint8Array> {
		this.calls.readBytes++;
		this.maybeFail("readBytes");
		const f = this.files.get(this.key(path));
		if (!f) throw new Error(`ENOENT: ${path}`);
		return f.bytes.slice();
	}

	async write(path: VaultPath, data: string | Uint8Array, precondition: WritePrecondition): Promise<WriteOutcome> {
		this.calls.write++;
		this.maybeFail("write");
		const bad = invalidPath(path);
		if (bad) return { ok: false, reason: "invalid-path", current: null, message: bad };
		for (const a of ancestors(path)) {
			const f = this.files.get(this.key(a));
			if (f) return { ok: false, reason: "parent-is-file", current: this.stamp(f), message: `parent ${a} is a file` };
		}
		if (this.folders.has(this.key(path))) return { ok: false, reason: "io", current: null, message: "target is a folder" };
		const bytes = typeof data === "string" ? utf8(data) : data.slice();
		// CAS: hash the current bytes, then commit only if the file did not change meanwhile.
		for (let attempt = 0; attempt < 8; attempt++) {
			const cur = this.files.get(this.key(path)) ?? null;
			const version = cur ? cur.version : -1;
			const pass = await this.check(path, cur, precondition);
			const now = this.files.get(this.key(path)) ?? null;
			if ((now ? now.version : -1) !== version) continue;
			if (!pass) return { ok: false, reason: "precondition", current: cur ? this.stamp(cur) : null, message: `precondition ${precondition.t} failed` };
			const f = this.commit(path, bytes, "sync");
			return { ok: true, stat: this.stamp(f) };
		}
		return { ok: false, reason: "io", current: null, message: "file kept changing during CAS" };
	}

	async rename(from: string, to: VaultPath, precondition: WritePrecondition): Promise<RenameOutcome> {
		this.calls.rename++;
		this.maybeFail("rename");
		const bad = invalidPath(to);
		if (bad) return { ok: false, reason: "io", message: `invalid target: ${bad}` };
		const src = this.files.get(this.key(from));
		if (!src) return { ok: false, reason: "source-missing", message: "source missing" };
		const version = src.version;
		const tk = this.key(to);
		if (tk !== this.key(from) && (this.files.has(tk) || this.folders.has(tk))) return { ok: false, reason: "target-exists", message: "target exists" };
		for (const a of ancestors(to)) if (this.files.has(this.key(a))) return { ok: false, reason: "io", message: `parent ${a} is a file` };
		const pass = await this.check(from, src, precondition);
		if (this.files.get(this.key(from))?.version !== version) return { ok: false, reason: "precondition", message: "source changed during check" };
		if (!pass) return { ok: false, reason: "precondition", message: `precondition ${precondition.t} failed` };
		if (tk !== this.key(from) && this.files.has(tk)) return { ok: false, reason: "target-exists", message: "target exists" };
		const moved = this.move(src.path, to);
		this.opts.onMutation?.({ kind: "rename", by: "sync", path: from, to });
		return { ok: true, stat: this.stamp(moved) };
	}

	async trash(path: string, mode: TrashMode, precondition: WritePrecondition): Promise<RenameOutcome> {
		this.calls.trash++;
		this.maybeFail("trash");
		const f = this.files.get(this.key(path));
		if (!f) return { ok: false, reason: "source-missing", message: "source missing" };
		const version = f.version;
		const pass = await this.check(path, f, precondition);
		if (this.files.get(this.key(path))?.version !== version) return { ok: false, reason: "precondition", message: "changed during check" };
		if (!pass) return { ok: false, reason: "precondition", message: `precondition ${precondition.t} failed` };
		const stat = this.stamp(f);
		this.removeFile(f, mode);
		this.opts.onMutation?.({ kind: "trash", by: "sync", path });
		return { ok: true, stat };
	}

	async removeEmptyFolder(path: VaultPath): Promise<void> {
		this.calls.removeEmptyFolder++;
		const k = this.key(path);
		if (!this.folders.has(k)) return;
		const prefix = k + "/";
		for (const fk of this.files.keys()) if (fk.startsWith(prefix)) return;
		for (const dk of this.folders.keys()) if (dk.startsWith(prefix)) return;
		this.folders.delete(k);
	}

	onEvent(listener: (event: VaultEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Sim-only: the moment Obsidian reloads open views of a modified/created file (see header). */
	onReload(listener: (path: string) => void): Unsubscribe {
		this.reloadListeners.add(listener);
		return () => this.reloadListeners.delete(listener);
	}

	// --- actors (user through Obsidian, external app) -------------------------

	/** User edit/create through Obsidian (not through an open editor). */
	userWrite(path: string, text: string): void {
		this.actorWrite(path, utf8(text), "user");
	}

	/** Obsidian saves an open editor view (vault.modify on an existing file). */
	editorSave(path: string, text: string): boolean {
		const cur = this.files.get(this.key(path));
		if (!cur) return false;
		if (cur.unseenExternal === cur.version) this.clobbered.push({ path: cur.path, text: fromUtf8(cur.bytes), savedText: text, atMs: this.opts.clock.now() });
		this.commit(path, utf8(text), "save");
		return true;
	}

	/** Another app writes the file on disk; Obsidian notices via its watcher. */
	externalWrite(path: string, data: string | Uint8Array): void {
		this.actorWrite(path, typeof data === "string" ? utf8(data) : data, "external");
	}

	/** User deletes in Obsidian (goes to .trash). */
	userDelete(path: string): boolean {
		const f = this.files.get(this.key(path));
		if (!f) return false;
		this.removeFile(f, "user");
		this.opts.onMutation?.({ kind: "trash", by: "user", path });
		return true;
	}

	/** User renames a file in Obsidian (vault.rename semantics: fails on collision). */
	userRename(from: string, to: string): boolean {
		const f = this.files.get(this.key(from));
		if (!f || invalidPath(to)) return false;
		const tk = this.key(to);
		if (tk !== this.key(from) && (this.files.has(tk) || this.folders.has(tk))) return false;
		if (ancestors(to).some((a) => this.files.has(this.key(a)))) return false;
		this.move(f.path, to);
		this.opts.onMutation?.({ kind: "rename", by: "user", path: from, to });
		return true;
	}

	/** Folder rename: one rename event per contained file. */
	userRenameFolder(from: string, to: string): boolean {
		const fk = this.key(from);
		if (!this.folders.has(fk) || invalidPath(to)) return false;
		const tk = this.key(to);
		if (tk !== fk && (this.files.has(tk) || this.folders.has(tk))) return false;
		if (tk.startsWith(fk + "/")) return false;
		const prefix = fk + "/";
		const moving = [...this.files.values()].filter((f) => this.key(f.path).startsWith(prefix));
		const subfolders = [...this.folders.entries()].filter(([k]) => k === fk || k.startsWith(prefix));
		for (const [k] of subfolders) this.folders.delete(k);
		for (const [, display] of subfolders) {
			const nd = to + display.slice(from.length);
			this.folders.set(this.key(nd), nd);
		}
		for (const f of moving) this.move(f.path, to + f.path.slice(from.length));
		this.opts.onMutation?.({ kind: "rename", by: "user", path: from, to });
		return true;
	}

	userCreateFolder(path: string): void {
		this.ensureFolders(path + "/x");
	}

	// --- inspection -----------------------------------------------------------

	/** Visible files: display path -> text. */
	snapshot(): Map<string, string> {
		const out = new Map<string, string>();
		for (const f of this.files.values()) if (!this.hidden(f.path)) out.set(f.path, fromUtf8(f.bytes));
		return out;
	}

	hasFile(path: string): boolean {
		return this.files.has(this.key(path));
	}

	textOf(path: string): string | null {
		const f = this.files.get(this.key(path));
		return f ? fromUtf8(f.bytes) : null;
	}

	/** Exact bytes (inspection: no call counting, no injected faults). */
	bytesOf(path: string): Uint8Array | null {
		const f = this.files.get(this.key(path));
		return f ? f.bytes.slice() : null;
	}

	folderPaths(): string[] {
		return [...this.folders.values()];
	}

	/** Events scheduled but not yet delivered. */
	pendingEvents(): number {
		return this.eventsInFlight;
	}

	// --- internals ------------------------------------------------------------

	private maybeFail(op: string): void {
		if (this.failNextOps > 0) {
			this.failNextOps--;
			throw new Error(`EIO (injected) during ${op}`);
		}
	}

	private async check(path: string, cur: SimFile | null, pre: WritePrecondition): Promise<boolean> {
		switch (pre.t) {
			case "any":
				return true;
			case "absent":
				return cur === null;
			case "fingerprint":
			case "hash": {
				if (cur === null) return false;
				// A copy: the oracle takes (transfers) its bytes. The sim keeps an exact version CAS around
				// this (write() retries when the file changed), so it does not model ObsidianVault's
				// accepted same-length gap.
				const [v] = await this.opts.hashes.hash([{ path, want: pre.t === "fingerprint" ? "fingerprint" : "contentHash", bytes: cur.bytes.slice() }]);
				return v !== undefined && v.hash === (pre.t === "fingerprint" ? pre.fingerprint : pre.hash);
			}
		}
	}

	private ensureFolders(path: string): void {
		const chain = ancestors(path).reverse();
		for (const a of chain) {
			const k = this.key(a);
			if (!this.folders.has(k)) this.folders.set(k, a);
		}
	}

	private commit(path: string, bytes: Uint8Array, by: WriterKind): SimFile {
		const k = this.key(path);
		const now = this.opts.clock.now();
		const cur = this.files.get(k);
		this.ensureFolders(path);
		let f: SimFile;
		if (cur) {
			cur.bytes = bytes;
			cur.mtimeMs = Math.max(now, cur.mtimeMs + 1);
			cur.version++;
			f = cur;
			f.unseenExternal = by === "external" || by === "user" ? f.version : null;
			this.emit({ t: "modify", path: f.path, stat: this.stamp(f) }, by, this.reload(f));
		} else {
			f = { path, bytes, mtimeMs: now, ctimeMs: now, version: 0, unseenExternal: by === "external" || by === "user" ? 0 : null };
			this.files.set(k, f);
			this.emit({ t: "create", path: f.path, stat: this.stamp(f) }, by, this.reload(f));
		}
		this.history.push(versionRecord(f.path, bytes, by, now));
		this.opts.onMutation?.({ kind: "write", by, path: f.path });
		return f;
	}

	private actorWrite(path: string, bytes: Uint8Array, by: WriterKind): boolean {
		if (invalidPath(path)) return false;
		if (ancestors(path).some((a) => this.files.has(this.key(a)))) return false;
		if (this.folders.has(this.key(path))) return false;
		this.commit(path, bytes, by);
		return true;
	}

	private move(fromDisplay: string, to: string): SimFile {
		const f = this.files.get(this.key(fromDisplay));
		if (!f) throw new Error(`move: missing ${fromDisplay}`);
		this.files.delete(this.key(fromDisplay));
		this.ensureFolders(to);
		const old = f.path;
		f.path = to;
		f.version++;
		this.files.set(this.key(to), f);
		this.emit({ t: "rename", from: old, to, stat: this.stamp(f) }, "user");
		return f;
	}

	private removeFile(f: SimFile, mode: TrashMode | "user"): void {
		this.files.delete(this.key(f.path));
		this.trashed.push({ path: f.path, text: fromUtf8(f.bytes), mode, atMs: this.opts.clock.now() });
		this.emit({ t: "delete", path: f.path }, mode === "user" ? "user" : "sync");
	}

	/** Obsidian reloads open views of `f` (wherever it lives now); from then on this version is seen. */
	private reload(f: SimFile): () => void {
		const v = f.version;
		return () => {
			if (this.files.get(this.key(f.path)) === f) for (const l of [...this.reloadListeners]) l(f.path);
			if (f.unseenExternal === v) f.unseenExternal = null;
		};
	}

	private emit(event: VaultEvent, by: WriterKind, reload?: () => void): void {
		const path = event.t === "rename" ? event.to : event.path;
		if (this.hidden(path) && (event.t !== "rename" || this.hidden(event.from))) return;
		const delay = by === "external" ? (this.opts.watcherDelayMs?.() ?? 100) : (this.opts.apiEventDelayMs ?? 0);
		const now = this.opts.clock.monotonic();
		const due = Math.max(now + delay, this.lastEventDue);
		this.lastEventDue = due;
		this.eventsInFlight++;
		this.opts.clock.setTimer(due - now, () => {
			this.eventsInFlight--;
			for (const l of [...this.listeners]) l(event);
			if (!reload) return;
			const lag = by === "external" ? (this.opts.reloadLagMs ?? OBSIDIAN_RELOAD_DELAY_MS) : 0;
			if (lag > 0) this.opts.clock.setTimer(lag, reload);
			else reload();
		});
	}
}

/** Config-dir files (config-relative paths). writeBytes is atomic in memory. */
export class SimConfigDir implements ConfigDirPort {
	readonly files = new Map<string, Uint8Array>();
	constructor(private readonly clock: ClockPort) {}

	async list(dir: string) {
		const prefix = dir === "" ? "" : dir.replace(/\/$/, "") + "/";
		const seen = new Map<string, { path: string; size: number; mtimeMs: number; isFolder: boolean }>();
		for (const [p, b] of this.files) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash < 0) seen.set(p, { path: p, size: b.byteLength, mtimeMs: this.clock.now(), isFolder: false });
			else {
				const folder = prefix + rest.slice(0, slash);
				seen.set(folder, { path: folder, size: 0, mtimeMs: 0, isFolder: true });
			}
		}
		return [...seen.values()];
	}

	async readBytes(path: string): Promise<Uint8Array | null> {
		const b = this.files.get(path);
		return b ? b.slice() : null;
	}

	async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
		this.files.set(path, bytes.slice());
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
}

/** Plugin state side files; survive an IDB wipe (they live next to the vault). */
export class SimSideFiles implements SideFilePort {
	readonly files = new Map<string, Uint8Array>();
	writes = 0;

	async read(name: SideFileName): Promise<Uint8Array | null> {
		const b = this.files.get(name);
		return b ? b.slice() : null;
	}

	async write(name: SideFileName, bytes: Uint8Array): Promise<void> {
		this.writes++;
		this.files.set(name, bytes.slice());
	}

	async remove(name: SideFileName): Promise<void> {
		this.files.delete(name);
	}

	async list(prefix: "snapshots/"): Promise<readonly SideFileName[]> {
		return [...this.files.keys()].filter((k) => k.startsWith(prefix)) as SideFileName[];
	}
}
