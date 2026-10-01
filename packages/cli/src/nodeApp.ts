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
import { canonicalizeMarkdown } from "@shared/markdownCodec";
import { MAX_CLIENT_MARKDOWN_BYTES } from "@shared/durableLimits";
import { CANVAS_LIMITS } from "@shared/canvasLimits";
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
	writeFileAtomic,
	processFileCheckedReplacement,
} from "./fs";
import { NodeFsExecutor, type NodeFsExecutorOptions } from "./nodeFsExecutor";
import type { FileIdentity, FilePublication } from "./nodeFsHelper";
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
 * This early raw-byte guard is derived from the protocol's absolute canonical
 * Markdown ceiling. CRLF can make a valid on-disk file twice as large as its
 * canonical LF form, and a leading UTF-8 BOM contributes three more bytes.
 * Reconciliation applies the exact configured (possibly lower) canonical-byte
 * limit after reading.
 */
export const MAX_MARKDOWN_FILE_BYTES = MAX_CLIENT_MARKDOWN_BYTES * 2 + 3;
export const DEFAULT_PROCESS_RETAINED_BYTES = 4 * MAX_MARKDOWN_FILE_BYTES;

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

export interface NodeAppOptions extends NodeFsExecutorOptions {
	readonly maximumPendingMutations?: number;
	readonly maximumPendingMutationBytes?: number;
}

export class NodeApp {
	readonly criticalIo: NodeFsExecutor;
	readonly failure: Promise<never>;
	readonly vault: NodeVault;
	readonly fileManager: NodeFileManager;
	readonly workspace: NodeWorkspace;
	readonly index = new VaultIndex();
	/** Directories proven to resolve inside the root. See `isContainedDirectory`. */
	private readonly containedDirectories = new Set<string>();
	private readonly fileHandles = new Map<string, { file: TFile; dev: number; ino: number }>();
	private mutationTail: Promise<unknown> = Promise.resolve();
	private pendingMutations = 0;
	private activeMutations = 0;
	private pendingMutationBytes = 0;
	private rejectedMutations = 0;
	private readonly maximumPendingMutations: number;
	private readonly maximumPendingMutationBytes: number;

	get mutationDiagnostics() {
		return {
			pending: this.pendingMutations, active: this.activeMutations,
			payloadBytes: this.pendingMutationBytes, rejected: this.rejectedMutations,
			maximumPending: this.maximumPendingMutations, maximumPayloadBytes: this.maximumPendingMutationBytes,
			failed: this.criticalIo.failureError !== undefined,
		};
	}

	mutate<Result>(operation: () => Result | Promise<Result>, payloadBytes = 0): Promise<Result> {
		if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) return Promise.reject(new Error("Invalid mutation payload size"));
		if (this.criticalIo.failureError) return Promise.reject(this.criticalIo.failureError);
		if (this.pendingMutations >= this.maximumPendingMutations || payloadBytes > this.maximumPendingMutationBytes - this.pendingMutationBytes) {
			this.rejectedMutations += 1;
			return Promise.reject(new Error(`Node host mutation admission full: ${payloadBytes} retained bytes requested; ${this.maximumPendingMutationBytes - this.pendingMutationBytes} available of ${this.maximumPendingMutationBytes}; ${this.pendingMutations}/${this.maximumPendingMutations} operations admitted`));
		}
		this.pendingMutations += 1;
		this.pendingMutationBytes += payloadBytes;
		let started = false;
		const pending = this.mutationTail.then(() => {
			if (this.criticalIo.failureError) throw this.criticalIo.failureError;
			started = true;
			this.activeMutations += 1;
			return operation();
		}).finally(() => {
			if (started) this.activeMutations -= 1;
			this.pendingMutations -= 1;
			this.pendingMutationBytes -= payloadBytes;
		});
		this.mutationTail = pending.catch(() => undefined);
		return pending;
	}

	assertCurrentFile(file: TFile): void {
		this.assertWritableSync(file.path, this.absolutePathFor(file.path));
		if (this.abstractFileFor(file.path) !== file) throw new Error(`File identity changed: ${file.path}`);
	}

	assertCachedFile(file: TFile, path: string, identity?: FileIdentity): FileIdentity {
		const cached = this.fileHandles.get(path);
		if (file.path !== path || cached?.file !== file ||
			(identity && (cached.dev !== identity.dev || cached.ino !== identity.ino))) {
			throw new Error(`File identity changed: ${path}`);
		}
		return { dev: cached.dev, ino: cached.ino };
	}

	adoptProcessedFile(path: string, file: TFile, published: FilePublication): void {
		this.assertCachedFile(file, path);
		this.fileHandles.set(path, { file, dev: published.dev, ino: published.ino });
		const stat: VaultFsStat = { kind: "file", size: published.size, mtime: Math.floor(published.mtimeMs) };
		this.index.set(path, stat, toVaultRelativePath(this.vaultRoot, this.absolutePathFor(path)));
		file.stat = { ctime: stat.mtime, mtime: stat.mtime, size: stat.size };
	}

	assertWritableSync(vaultPath: string, absolutePath: string): void {
		this.assertWritableParentSync(vaultPath, absolutePath);
		const stats = lstatSync(absolutePath);
		if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Not a regular file: ${vaultPath}`);
	}

	assertWritableParentSync(vaultPath: string, absolutePath: string): void {
		const parent = realpathSync(nodePath.dirname(absolutePath));
		const relative = nodePath.relative(this.rootRealPath, parent);
		if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
			throw new VaultPathError(`Symlink traversal rejected: "${vaultPath}"`, vaultPath);
		}
	}

	adoptWrittenFile(vaultPath: string, file?: TFile, published?: Pick<Stats, "dev" | "ino">): TFile {
		const stats = lstatSync(this.absolutePathFor(vaultPath));
		if (!stats.isFile() || (published && (stats.dev !== published.dev || stats.ino !== published.ino))) {
			throw new Error(`Published file replaced externally: ${vaultPath}`);
		}
		const existing = file ?? this.fileHandles.get(vaultPath)?.file;
		if (existing) this.fileHandles.set(vaultPath, { file: existing, dev: stats.dev, ino: stats.ino });
		const stat = toVaultFsStat(stats, "file");
		this.index.set(vaultPath, stat, toVaultRelativePath(this.vaultRoot, this.absolutePathFor(vaultPath)));
		return this.makeTFile(vaultPath, stat);
	}

	forgetFileHandles(path: string): void {
		for (const key of this.fileHandles.keys()) {
			if (key === path || key.startsWith(`${path}/`)) this.fileHandles.delete(key);
		}
	}

	moveFileHandles(source: string, target: string): void {
		const moved = [...this.fileHandles.entries()].filter(([key]) => key === source || key.startsWith(`${source}/`));
		this.forgetFileHandles(source);
		for (const [key, entry] of moved) {
			const destination = `${target}${key.slice(source.length)}`;
			this.fileHandles.set(destination, entry);
			const stat = this.statSyncEntry(destination);
			if (stat?.kind === "file") this.makeTFile(destination, stat);
		}
	}

	private constructor(
		readonly vaultRoot: string,
		readonly rootRealPath: string,
		options: NodeAppOptions,
	) {
		this.maximumPendingMutations = options.maximumPendingMutations ?? 64;
		this.maximumPendingMutationBytes = options.maximumPendingMutationBytes ?? 32 * 1024 * 1024;
		if (!Number.isSafeInteger(this.maximumPendingMutations) || this.maximumPendingMutations < 1) throw new Error("Invalid mutation admission bound");
		if (!Number.isSafeInteger(this.maximumPendingMutationBytes) || this.maximumPendingMutationBytes < 1) throw new Error("Invalid mutation payload bound");
		this.criticalIo = new NodeFsExecutor(options);
		this.failure = this.criticalIo.failure;
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
	static async create(vaultRoot: string, options: NodeAppOptions = {}): Promise<NodeApp> {
		const resolved = nodePath.resolve(vaultRoot);
		await ensureDirectoryDurable(resolved);
		return new NodeApp(resolved, await fs.realpath(resolved), options);
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
			this.forgetFileHandles(vaultPath);
			return null;
		}
		if (stats.isSymbolicLink()) {
			this.index.forget(vaultPath);
			this.forgetFileHandles(vaultPath);
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
		this.walkInto(this.vaultRoot, "", files, unreadable, ".md", MAX_MARKDOWN_FILE_BYTES);
		return { files, unreadable };
	}

	walkCanvases(): MarkdownWalk {
		const files: WalkedFile[] = [];
		const unreadable: string[] = [];
		this.walkInto(this.vaultRoot, "", files, unreadable, ".canvas", CANVAS_LIMITS.canonicalBytes * 2);
		return { files, unreadable };
	}

	private walkInto(
		absoluteDir: string,
		relativeDir: string,
		out: WalkedFile[],
		unreadable: string[],
		extension: string,
		maximumBytes: number,
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
				this.walkInto(absolute, diskRelPath, out, unreadable, extension, maximumBytes);
				continue;
			}
			if (!stats.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(extension)) continue;
			if (stats.size > maximumBytes) continue;
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
		const stats = lstatSync(this.absolutePathFor(vaultPath));
		const cached = this.fileHandles.get(vaultPath);
		const file = cached?.dev === stats.dev && cached.ino === stats.ino ? cached.file : new TFile();
		this.fileHandles.set(vaultPath, { file, dev: stats.dev, ino: stats.ino });
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

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const bytes = await fs.readFile(this.host.absolutePathFor(file.path));
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	}

	async modify(file: TFile, content: string): Promise<void> {
		return this.host.mutate(async () => {
			content = canonicalizeMarkdown(content);
			const absolute = this.host.absolutePathFor(file.path);
			await this.host.assertWritable(file.path, absolute);
			this.host.assertCurrentFile(file);
			await writeFileAtomic(absolute, content, {
				onPublished: (stats) => { this.host.adoptWrittenFile(file.path, file, stats); },
			});
		}, 2 * content.length);
	}

	async process(file: TFile, transform: (content: string) => string, options: { retainedBytes?: number } = {}): Promise<string> {
		return this.host.mutate(async () => {
			const path = file.path;
			const identity = this.host.assertCachedFile(file, path);
			const absolute = this.host.absolutePathFor(path);
			const content = await processFileCheckedReplacement(absolute, transform, {
				maximumBytes: MAX_MARKDOWN_FILE_BYTES,
				root: this.host.rootRealPath,
				identity,
				executor: this.host.criticalIo,
				assertCurrent: () => { this.host.assertCachedFile(file, path, identity); },
				onPublished: (stats) => { this.host.adoptProcessedFile(path, file, stats); },
			});
			return content;
		}, options.retainedBytes ?? DEFAULT_PROCESS_RETAINED_BYTES);
	}

	async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
		return this.host.mutate(async () => {
			const absolute = this.host.absolutePathFor(file.path);
			await this.host.assertWritable(file.path, absolute);
			this.host.assertCurrentFile(file);
			await writeFileAtomic(absolute, new Uint8Array(content), {
				onPublished: (stats) => { this.host.adoptWrittenFile(file.path, file, stats); },
			});
		}, content.byteLength);
	}

	/**
	 * Create a file. Throws when anything is already there, which is Obsidian's
	 * behaviour and the reason `BlobSync`'s already-exists recovery exists.
	 */
	async create(path: string, content: string): Promise<TFile> {
		return this.host.mutate(async () => {
			content = canonicalizeMarkdown(content);
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
		}, 2 * content.length);
	}

	async createBinary(path: string, content: ArrayBuffer): Promise<TFile> {
		return this.host.mutate(async () => {
			const normalized = normalizeVaultPath(path);
			const absolute = this.host.absolutePathFor(normalized);
			if (this.host.statSyncEntry(normalized) !== null) throw new Error(`File already exists: ${normalized}`);
			await this.host.assertWritable(normalized, absolute);
			await ensureDirectoryDurable(nodePath.dirname(absolute));
			await this.host.assertWritable(normalized, absolute);
			await writeFileAtomic(absolute, new Uint8Array(content));
			return this.host.makeTFile(normalized, this.refreshAfterWrite(normalized, absolute));
		}, content.byteLength);
	}

	async createFolder(path: string): Promise<TFolder> {
		return this.host.mutate(async () => {
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
		});
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

	async exists(path: string): Promise<boolean> { return (await this.stat(path)) !== null; }

	async mkdir(path: string): Promise<void> {
		return this.host.mutate(async () => {
			const normalized = normalizeVaultPath(path);
			const absolute = this.host.absolutePathFor(normalized);
			await this.host.assertWritable(normalized, absolute);
			await ensureDirectoryDurable(absolute);
		});
	}

	async write(path: string, content: string): Promise<void> {
		return this.host.mutate(async () => {
			const normalized = normalizeVaultPath(path);
			const existing = this.host.abstractFileFor(normalized);
			const absolute = this.host.absolutePathFor(normalized);
			await this.host.assertWritable(normalized, absolute);
			await ensureDirectoryDurable(nodePath.dirname(absolute));
			await this.host.assertWritable(normalized, absolute);
			if (existing instanceof TFile) this.host.assertCurrentFile(existing);
			await writeFileAtomic(absolute, content, {
				onPublished: (stats) => { this.host.adoptWrittenFile(normalized, existing instanceof TFile ? existing : undefined, stats); },
			});
		}, 2 * content.length);
	}

	async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
		return this.host.mutate(async () => {
			const normalized = normalizeVaultPath(path);
			const existing = this.host.abstractFileFor(normalized);
			const absolute = this.host.absolutePathFor(normalized);
			await this.host.assertWritable(normalized, absolute);
			await ensureDirectoryDurable(nodePath.dirname(absolute));
			await this.host.assertWritable(normalized, absolute);
			if (existing instanceof TFile) this.host.assertCurrentFile(existing);
			await writeFileAtomic(absolute, new Uint8Array(content), {
				onPublished: (stats) => { this.host.adoptWrittenFile(normalized, existing instanceof TFile ? existing : undefined, stats); },
			});
		}, content.byteLength);
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
		return this.host.mutate(async () => {
			const absolute = this.host.absolutePathFor(file.path);
			await this.host.assertWritable(file.path, absolute);
			if (file instanceof TFile) this.host.assertCurrentFile(file);
			await removeFileDurable(absolute);
			this.host.index.forget(file.path);
			this.host.forgetFileHandles(file.path);
		});
	}

	/**
	 * Move a file. Throws when the destination is occupied, as Obsidian does.
	 *
	 * The hook runs before helper dispatch; the helper repeats the identity,
	 * containment and vacancy checks before rename. Publication is asynchronous.
	 */
	async renameFile(
		file: TAbstractFile,
		newPath: string,
		beforeMutation?: () => void,
	): Promise<void> {
		return this.host.mutate(async () => {
			const target = normalizeVaultPath(newPath);
			const source = file.path;
			const from = this.host.absolutePathFor(file.path);
			const original = lstatSync(from);
			if (original.isSymbolicLink() || (!original.isFile() && !original.isDirectory())) {
				throw new Error(`Not a vault entry: ${source}`);
			}
			if (this.host.statSyncEntry(target) !== null) {
				throw new Error(`File already exists: ${target}`);
			}
			const to = nodePath.join(this.host.vaultRoot, ...vaultPathParts(target));
			await this.host.assertWritable(file.path, from);
			await this.host.assertWritable(target, to);
			await ensureDirectoryDurable(nodePath.dirname(to));
			await this.host.assertWritable(target, to);
			const assertPublicationCurrent = (): void => {
				this.host.assertWritableParentSync(source, from);
				this.host.assertWritableParentSync(target, to);
				const current = lstatSync(from);
				if (file.path !== source || current.dev !== original.dev || current.ino !== original.ino) {
					throw new Error(`File identity changed: ${source}`);
				}
				if (file instanceof TFile) this.host.assertCurrentFile(file);
				let vacant = false;
				try {
					lstatSync(to);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					vacant = true;
				}
				if (!vacant) throw new Error(`File already exists: ${target}`);
			};
			assertPublicationCurrent();
			beforeMutation?.();
			assertPublicationCurrent();
			await this.host.criticalIo.execute({
				kind: "rename", root: this.host.rootRealPath, path: from, target: to,
				identity: { dev: original.dev, ino: original.ino },
			});
			this.host.index.forgetSubtree(file.path);
			this.host.statSyncEntry(target);
			this.host.moveFileHandles(source, target);
			file.path = target;
			file.name = target.slice(target.lastIndexOf("/") + 1);
		});
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
