/**
 * The Node stand-in for Obsidian's `App`.
 *
 * `DiskMirror` and `ReconciliationController` still reach through `app.vault`
 * and `app.fileManager` at a handful of call sites that the `VaultFs` port
 * deliberately does not cover (the `flushWrite` write group, and three
 * index-backed existence probes whose three-way answer `stat`/`cachedStat`
 * cannot express). This class is what those call sites talk to.
 *
 * It is also the daemon's whole filesystem mechanism: guards, durable writes,
 * and the in-memory index. Every disk call the engine makes lands here, the
 * same way the plugin's land on Obsidian's own `App`.
 *
 * WHAT THIS IS NOT. It implements the members production calls on the paths the
 * daemon exercises, and nothing else. It is exposed as an `App` through one
 * documented cast in `nodeHost.ts`; Obsidian's `App` has a hundred members that
 * a daemon has no answer for, and pretending otherwise would just move the lie
 * into the type.
 *
 * SYMLINKS ARE NOT VAULT ENTRIES. Every stat in this file is an `lstat`, and a
 * symlink is reported as absent. That is stricter than Obsidian, and it is the
 * only answer that keeps a remote CRDT entry from writing through a link the
 * daemon did not create.
 */

import {
	promises as fs,
	lstatSync,
	readdirSync,
	realpathSync,
	statSync,
	type Stats,
} from "node:fs";
import nodePath from "node:path";
import { TFile, TFolder, type TAbstractFile } from "obsidian";
/**
 * Stat shape this host tracks. Declared locally: the daemon no longer depends
 * on the client `VaultFs` port, which is unfinished and stays out of this
 * milestone. `kind` is a discriminant because a folder and a missing entry are
 * different answers and `diskMirror` distinguishes them.
 */
export interface VaultFsStat {
	readonly kind: "file" | "folder";
	readonly size: number;
	readonly mtime: number;
}
import {
	ensureDirectoryDurable,
	removeFileDurable,
	renameFileDurable,
	writeFileAtomic,
} from "./fs";
import {
	VaultPathError,
	assertInsideRoot,
	normalizeVaultPath,
	toVaultRelativePath,
	vaultPathParts,
} from "./paths";

/**
 * A Markdown file bigger than this is not a note, it is an accident. The daemon
 * refuses to index it at all rather than reading it into memory to find out.
 *
 * This is a MECHANISM guard and not the user's size limit: the configured
 * `maxFileSizeBytes` is applied by `ReconciliationController` to `content.length`
 * after a successful read, and stays there.
 */
export const MAX_MARKDOWN_FILE_BYTES = 64 * 1024 * 1024;

/** What the index knows about one path. */
interface IndexEntry {
	readonly stat: VaultFsStat;
	/**
	 * The path's spelling ON DISK, relative to the root, when it differs from
	 * the NFC key.
	 *
	 * Vault paths are NFC by contract, but a Linux filesystem stores whatever
	 * bytes the file was created with; a note created on macOS and copied to
	 * ext4 keeps its decomposed name, and opening it by the composed name is
	 * ENOENT. Remembering the real spelling is what lets the daemon read a file
	 * it can see.
	 */
	readonly diskRelPath: string | null;
}

/**
 * The daemon's in-memory vault index.
 *
 * Obsidian keeps one for free; a Node host has to maintain it. It is warmed by
 * every walk and every stat this class performs, refreshed after every mutation
 * the daemon makes, and invalidated by the watcher when the outside world
 * changes something. `cachedStat` reads it and nothing else.
 */
export class VaultIndex {
	private readonly entries = new Map<string, IndexEntry>();

	get(path: string): IndexEntry | null {
		return this.entries.get(normalizeVaultPath(path)) ?? null;
	}

	set(path: string, stat: VaultFsStat, diskRelPath: string | null): void {
		const key = normalizeVaultPath(path);
		this.entries.set(key, {
			stat,
			diskRelPath: diskRelPath === key ? null : diskRelPath,
		});
	}

	forget(path: string): void {
		this.entries.delete(normalizeVaultPath(path));
	}

	/** Drop `path` and everything beneath it — a deleted or renamed folder. */
	forgetSubtree(path: string): void {
		const key = normalizeVaultPath(path);
		const prefix = `${key}/`;
		this.entries.delete(key);
		for (const existing of this.entries.keys()) {
			if (existing.startsWith(prefix)) this.entries.delete(existing);
		}
	}

	clear(): void {
		this.entries.clear();
	}
}

/** One entry of a walk: the NFC vault path plus its on-disk spelling. */
export interface WalkedFile {
	readonly vaultPath: string;
	readonly diskRelPath: string;
	readonly stat: VaultFsStat;
}

/**
 * What one walk saw, and — just as load-bearing — what it could not see.
 *
 * `unreadable` names every path whose contents the walk failed to establish:
 * a directory whose `readdir` failed, and any entry whose `lstat` failed
 * (which may itself be a directory, so its whole subtree is equally unknown).
 * Absence from `files` therefore means "not seen", which is only the same
 * thing as "not on disk" for paths that are not under one of these.
 *
 * This shape exists because a caller now acts on absence. Returning the file
 * list alone made an unreadable subtree indistinguishable from an empty one,
 * which is the difference between one delete and a vault-wide one.
 */
export interface MarkdownWalk {
	readonly files: readonly WalkedFile[];
	readonly unreadable: readonly string[];
}

/**
 * The three-way answer to "is this path gone?", from one `lstat`.
 *
 * `"absent"` is a POSITIVE finding — the kernel said nothing is there — and
 * is the only value that may be read as evidence of a deletion. Every failure
 * mode that is not ENOENT/ENOTDIR (EACCES, EIO, ELOOP, an unmounted volume,
 * an errno nobody has thought of yet) answers `"unknown"`, which means the
 * caller learned nothing and must do nothing.
 */
export type PathProbe = "present" | "absent" | "unknown";

/**
 * The entry in `unreadable` that shadows `vaultPath`, or null when none does.
 * A path is shadowed by an exact match or by any ancestor: an unreadable
 * directory makes its whole subtree unknown.
 */
export function shadowedBy(vaultPath: string, unreadable: readonly string[]): string | null {
	for (const blind of unreadable) {
		if (blind === "") return "";
		if (vaultPath === blind || vaultPath.startsWith(`${blind}/`)) return blind;
	}
	return null;
}

/**
 * `Stats` -> `VaultFsStat`. Times are floored to whole milliseconds because
 * that is what Obsidian's adapter reports, and both the disk index and the
 * suppression gate compare them for equality.
 */
function toVaultFsStat(stats: Stats, kind: "file" | "folder"): VaultFsStat {
	return { kind, size: stats.size, mtime: Math.floor(stats.mtimeMs) };
}

export class NodeApp {
	readonly vault: NodeVault;
	readonly fileManager: NodeFileManager;
	readonly workspace: NodeWorkspace;
	readonly index = new VaultIndex();
	/** Directories proven to resolve inside the root. See `isContainedDirectory`. */
	private readonly containedDirectories = new Set<string>();

	private constructor(
		readonly vaultRoot: string,
		readonly rootRealPath: string,
	) {
		this.vault = new NodeVault(this);
		this.fileManager = new NodeFileManager(this);
		this.workspace = new NodeWorkspace();
	}

	/**
	 * Resolve the root's realpath once, up front.
	 *
	 * Every containment check compares against it, and resolving it per call
	 * would both cost a syscall and open a window where the root itself is
	 * swapped for a link between two checks.
	 */
	static async create(vaultRoot: string): Promise<NodeApp> {
		const resolved = nodePath.resolve(vaultRoot);
		await ensureDirectoryDurable(resolved);
		return new NodeApp(resolved, await fs.realpath(resolved));
	}

	/**
	 * The absolute path for a vault path, honouring a remembered on-disk
	 * spelling when the index has one.
	 *
	 * @throws {VaultPathError} on traversal, absolute paths and NUL bytes.
	 */
	absolutePathFor(vaultPath: string): string {
		const parts = vaultPathParts(vaultPath);
		const remembered = this.index.get(vaultPath)?.diskRelPath;
		const relative = remembered ?? parts.join("/");
		const absolute = nodePath.join(this.vaultRoot, ...relative.split("/"));
		const back = nodePath.relative(this.vaultRoot, absolute);
		if (back.startsWith("..") || nodePath.isAbsolute(back)) {
			throw new VaultPathError(
				`Path traversal rejected: "${vaultPath}" resolves outside vault root`,
				vaultPath,
			);
		}
		return absolute;
	}

	/**
	 * `lstat` a vault path and refresh the index from the answer.
	 *
	 * Synchronous on purpose: `getAbstractFileByPath` and `getMarkdownFiles` are
	 * synchronous in Obsidian's API and production calls them inside branches
	 * that cannot await. A daemon can afford the syscall; answering from a map
	 * that might be a step behind would make the rename destination probe — the
	 * one whose `"file"` branch TRASHES THE SOURCE — decide on stale data.
	 */
	statSyncEntry(vaultPath: string): VaultFsStat | null {
		let absolute: string;
		try {
			absolute = this.absolutePathFor(vaultPath);
		} catch {
			return null;
		}
		let stats: Stats;
		try {
			stats = lstatSync(absolute);
		} catch {
			this.index.forget(vaultPath);
			return null;
		}
		if (stats.isSymbolicLink()) {
			this.index.forget(vaultPath);
			return null;
		}
		if (!stats.isFile() && !stats.isDirectory()) {
			this.index.forget(vaultPath);
			return null;
		}
		if (!this.isContainedDirectory(nodePath.dirname(absolute))) {
			this.index.forget(vaultPath);
			return null;
		}
		const stat = toVaultFsStat(stats, stats.isDirectory() ? "folder" : "file");
		const remembered = this.index.get(vaultPath)?.diskRelPath ?? null;
		this.index.set(vaultPath, stat, remembered);
		return stat;
	}

	/**
	 * Does `absoluteDirectory` really live under the vault root?
	 *
	 * A symlink is not a vault entry, and neither is anything reached through
	 * one. The final component is covered by the `lstat` in `statSyncEntry`;
	 * this covers the ANCESTORS, which is the case that matters — a directory
	 * named `escape` pointing at `/etc` would otherwise let a remote CRDT entry
	 * called `escape/passwd.md` be read, and read content is content the daemon
	 * uploads.
	 *
	 * Cached per directory, because a `realpath` on every existence probe would
	 * be paid a hundred times over by the conflict-artifact naming loop alone.
	 * The cache is dropped whenever the watcher sees a directory appear or
	 * disappear. MUTATIONS DO NOT USE IT: `assertWritable` resolves fresh every
	 * time, because the destructive paths must not trust a memo.
	 */
	isContainedDirectory(absoluteDirectory: string): boolean {
		if (absoluteDirectory === this.vaultRoot) return true;
		if (this.containedDirectories.has(absoluteDirectory)) return true;
		let real: string;
		try {
			real = realpathSync(absoluteDirectory);
		} catch {
			return false;
		}
		const relative = nodePath.relative(this.rootRealPath, real);
		if (relative !== "" && (relative.startsWith("..") || nodePath.isAbsolute(relative))) {
			return false;
		}
		this.containedDirectories.add(absoluteDirectory);
		return true;
	}

	/** Drop the containment memo — the directory tree changed shape. */
	forgetContainedDirectories(): void {
		this.containedDirectories.clear();
	}

	/**
	 * Assert that writing to `vaultPath` stays inside the vault after symlink
	 * resolution. Callers run this twice — see `assertInsideRoot`.
	 */
	async assertWritable(vaultPath: string, absolutePath: string): Promise<void> {
		await assertInsideRoot(this.rootRealPath, absolutePath, vaultPath);
	}

	/**
	 * Every Markdown file under the root, plus every path the walk could not
	 * establish the contents of.
	 *
	 * Synchronous because `getMarkdownFiles` is; `scanMarkdown` reuses it so the
	 * two can never report different sets. Skips dot-entries (Obsidian's own
	 * rule, which also disposes of `.obsidian`, `.git` and the atomic-write
	 * temp files), symlinks, and files past `MAX_MARKDOWN_FILE_BYTES`.
	 */
	walkMarkdown(): MarkdownWalk {
		const files: WalkedFile[] = [];
		const unreadable: string[] = [];
		this.walkInto(this.vaultRoot, "", files, unreadable);
		return { files, unreadable };
	}

	private walkInto(
		absoluteDir: string,
		relativeDir: string,
		out: WalkedFile[],
		unreadable: string[],
	): void {
		let entries;
		try {
			entries = readdirSync(absoluteDir, { withFileTypes: true });
		} catch {
			// A directory we cannot read contributes no files AND no evidence.
			// It is reported rather than swallowed: the caller infers deletions
			// from absence, and an unreadable directory that looked like an
			// empty one would turn one bad syscall into a vault-wide delete.
			unreadable.push(normalizeVaultPath(relativeDir));
			return;
		}
		for (const entry of entries) {
			// Obsidian's vault index ignores dot-entries, and so does this one.
			// That also disposes of `.obsidian`, `.git` and the atomic-write
			// temp files without a second rule.
			if (entry.name.startsWith(".")) continue;
			const absolute = nodePath.join(absoluteDir, entry.name);
			const diskRelPath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
			let stats: Stats;
			try {
				stats = lstatSync(absolute);
			} catch {
				// Listed but not stattable. It may be a directory, so the
				// subtree under it is unknown too — same reasoning as above,
				// one level down.
				unreadable.push(normalizeVaultPath(diskRelPath));
				continue;
			}
			if (stats.isSymbolicLink()) continue;
			if (stats.isDirectory()) {
				const folderPath = normalizeVaultPath(diskRelPath);
				this.index.set(folderPath, toVaultFsStat(stats, "folder"), diskRelPath);
				this.walkInto(absolute, diskRelPath, out, unreadable);
				continue;
			}
			if (!stats.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(".md")) continue;
			if (stats.size > MAX_MARKDOWN_FILE_BYTES) continue;
			const vaultPath = normalizeVaultPath(diskRelPath);
			const stat = toVaultFsStat(stats, "file");
			this.index.set(vaultPath, stat, diskRelPath);
			out.push({ vaultPath, diskRelPath, stat });
		}
	}

	/**
	 * Ask the kernel, for this one path, whether anything is there.
	 *
	 * The walk answers "did I see it"; this answers "is it gone", and only
	 * ENOENT (nothing at that name) and ENOTDIR (a parent component is not a
	 * directory, so nothing can be at that name either) are allowed to mean
	 * gone. Every other outcome — a permission failure, an I/O error, a
	 * symlink loop, a path this host will not resolve, an errno that does not
	 * exist yet — falls through to `"unknown"`, because the caller deletes
	 * user data on this answer and "I could not tell" must never round up to
	 * "it is gone".
	 */
	probePath(vaultPath: string): PathProbe {
		let absolute: string;
		try {
			absolute = this.absolutePathFor(vaultPath);
		} catch {
			return "unknown";
		}
		try {
			lstatSync(absolute);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
		}
		// Something occupies the name. Whether it is a file, a folder or a
		// symlink this host refuses to treat as a vault entry is a question
		// for the walk; none of them is a deletion.
		return "present";
	}

	/** Build the `TFile` production reads `.path`, `.stat` and `.basename` off. */
	makeTFile(vaultPath: string, stat: VaultFsStat): TFile {
		const file = new TFile();
		file.path = vaultPath;
		file.name = vaultPath.slice(vaultPath.lastIndexOf("/") + 1);
		const dot = file.name.lastIndexOf(".");
		file.basename = dot > 0 ? file.name.slice(0, dot) : file.name;
		file.extension = dot > 0 ? file.name.slice(dot + 1) : "";
		file.stat = { ctime: stat.mtime, mtime: stat.mtime, size: stat.size };
		file.parent = null;
		return file;
	}

	private makeTFolder(vaultPath: string): TFolder {
		const folder = new TFolder();
		folder.path = vaultPath;
		folder.name = vaultPath.slice(vaultPath.lastIndexOf("/") + 1);
		folder.children = [];
		folder.parent = null;
		return folder;
	}

	/** `TFile`, `TFolder` or null — the three-way answer, from a live stat. */
	abstractFileFor(vaultPath: string): TAbstractFile | null {
		const normalized = normalizeVaultPath(vaultPath);
		if (normalized === "" || normalized === "/") return null;
		const stat = this.statSyncEntry(normalized);
		if (stat === null) return null;
		return stat.kind === "folder"
			? this.makeTFolder(normalized)
			: this.makeTFile(normalized, stat);
	}
}

/**
 * `app.vault`.
 *
 * Members here are exactly the ones production calls on the daemon's paths:
 * `getAbstractFileByPath`, `read`, `modify`, `create`, `createFolder`,
 * `getMarkdownFiles`, `adapter.stat` and `configDir`.
 */
export class NodeVault {
	/**
	 * `.obsidian`, the same default Obsidian uses.
	 *
	 * It is not vestigial headless: `isExcluded` takes it, and the daemon must
	 * keep the plugin's config directory out of sync exactly as the plugin does.
	 */
	readonly configDir = ".obsidian";

	readonly adapter: NodeVaultAdapter;

	constructor(private readonly host: NodeApp) {
		this.adapter = new NodeVaultAdapter(host);
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.host.abstractFileFor(path);
	}

	getMarkdownFiles(): TFile[] {
		return this.host
			.walkMarkdown()
			.files.map((entry) => this.host.makeTFile(entry.vaultPath, entry.stat));
	}

	async read(file: TFile): Promise<string> {
		return await fs.readFile(this.host.absolutePathFor(file.path), "utf8");
	}

	async modify(file: TFile, content: string): Promise<void> {
		const absolute = this.host.absolutePathFor(file.path);
		await this.host.assertWritable(file.path, absolute);
		await writeFileAtomic(absolute, content);
		this.refreshAfterWrite(file.path, absolute);
	}

	/**
	 * Create a file. Throws when anything is already there, which is Obsidian's
	 * behaviour and the reason `BlobSync`'s already-exists recovery exists.
	 */
	async create(path: string, content: string): Promise<TFile> {
		const normalized = normalizeVaultPath(path);
		const absolute = this.host.absolutePathFor(normalized);
		if (this.host.statSyncEntry(normalized) !== null) {
			throw new Error(`File already exists: ${normalized}`);
		}
		await this.host.assertWritable(normalized, absolute);
		await ensureDirectoryDurable(nodePath.dirname(absolute));
		// Again after mkdir: the two are separated by an await, and a directory
		// created through a symlink planted in between is exactly the escape
		// this guard exists for.
		await this.host.assertWritable(normalized, absolute);
		await writeFileAtomic(absolute, content);
		const stat = this.refreshAfterWrite(normalized, absolute);
		return this.host.makeTFile(normalized, stat);
	}

	async createFolder(path: string): Promise<TFolder> {
		const normalized = normalizeVaultPath(path);
		const absolute = this.host.absolutePathFor(normalized);
		if (this.host.statSyncEntry(normalized) !== null) {
			throw new Error(`Folder already exists: ${normalized}`);
		}
		await this.host.assertWritable(normalized, absolute);
		await ensureDirectoryDurable(absolute);
		this.host.statSyncEntry(normalized);
		const folder = new TFolder();
		folder.path = normalized;
		folder.name = normalized.slice(normalized.lastIndexOf("/") + 1);
		return folder;
	}

	/** Re-stat after a write so `cachedStat` reflects what just landed. */
	private refreshAfterWrite(vaultPath: string, absolutePath: string): VaultFsStat {
		const stats = statSync(absolutePath);
		const stat = toVaultFsStat(stats, "file");
		const relative = toVaultRelativePath(this.host.vaultRoot, absolutePath);
		this.host.index.set(vaultPath, stat, relative);
		return stat;
	}
}

/**
 * `app.vault.adapter`.
 *
 * `stat` is the DISK truth, which is what `diskIndex.statFile` and the
 * reconcile baseline require — same split as the Obsidian adapter, where
 * `adapter.stat` sees things the index does not.
 */
export class NodeVaultAdapter {
	constructor(private readonly host: NodeApp) {}

	async stat(
		path: string,
	): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
		let absolute: string;
		try {
			absolute = this.host.absolutePathFor(path);
		} catch {
			return null;
		}
		let stats: Stats;
		try {
			stats = await fs.lstat(absolute);
		} catch {
			return null;
		}
		if (stats.isSymbolicLink()) return null;
		if (!stats.isFile() && !stats.isDirectory()) return null;
		return {
			type: stats.isDirectory() ? "folder" : "file",
			ctime: Math.floor(stats.birthtimeMs),
			mtime: Math.floor(stats.mtimeMs),
			size: stats.size,
		};
	}
}

/**
 * `app.fileManager`.
 *
 * Core deletion and renaming go through here in production, and the two members
 * below are the ones `DiskMirror` calls.
 */
export class NodeFileManager {
	constructor(private readonly host: NodeApp) {}

	/**
	 * Remove a file.
	 *
	 * There is no system trash on a headless Linux host, so this unlinks. The
	 * caller reports the mode it actually got (`VaultFsDeleteResult.mode`), and
	 * the daemon reports `"unlink"` — claiming `"trash"` would put a recovery
	 * option in the trace that does not exist.
	 */
	async trashFile(file: TAbstractFile): Promise<void> {
		const absolute = this.host.absolutePathFor(file.path);
		await this.host.assertWritable(file.path, absolute);
		await removeFileDurable(absolute);
		this.host.index.forget(file.path);
	}

	/**
	 * Move a file. Throws when the destination is occupied, as Obsidian does.
	 *
	 * `beforeMutation` is the `VaultFsRenameOptions` hook, threaded down to here
	 * rather than run by the caller because the contract requires NO await
	 * between the hook and the mutation: the marker it sets exists to be
	 * consumed by the rename event, and an await in between is exactly the race
	 * it is defending against. Every rejection above it happens before the hook
	 * runs, so a caller is never left holding a marker for an event that will
	 * not arrive.
	 */
	async renameFile(
		file: TAbstractFile,
		newPath: string,
		beforeMutation?: () => void,
	): Promise<void> {
		const target = normalizeVaultPath(newPath);
		const from = this.host.absolutePathFor(file.path);
		if (this.host.statSyncEntry(target) !== null) {
			throw new Error(`File already exists: ${target}`);
		}
		const to = nodePath.join(this.host.vaultRoot, ...vaultPathParts(target));
		await this.host.assertWritable(file.path, from);
		await this.host.assertWritable(target, to);
		await ensureDirectoryDurable(nodePath.dirname(to));
		await this.host.assertWritable(target, to);
		beforeMutation?.();
		await renameFileDurable(from, to);
		this.host.index.forgetSubtree(file.path);
		this.host.statSyncEntry(target);
		file.path = target;
		file.name = target.slice(target.lastIndexOf("/") + 1);
	}
}

/**
 * `app.workspace`.
 *
 * A daemon has no editors. `null` and "no leaves" are the CORRECT answers, not
 * placeholders: `getActiveViewOfType` returning null means "nothing is open",
 * which is true, and it is what makes the external-edit and open-bound
 * deferral policies take their headless branch instead of guessing.
 */
export class NodeWorkspace {
	getActiveViewOfType<T>(_type: unknown): T | null {
		return null;
	}

	iterateAllLeaves(_callback: (leaf: unknown) => void): void {
		// No leaves. Nothing to iterate.
	}
}
