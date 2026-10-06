/**
 * Fake Obsidian Vault/DataAdapter (structural VaultApi) for host adapter tests.
 * In-memory, case-sensitive or -insensitive, records every mutating call so
 * tests can assert "vault.rename only", "trash only".
 */

import type { AdapterApi, AdapterStatLike, EventRefLike, FileLike, FolderLike, AbstractFileLike, VaultApi } from "../host/obsidianApi";

interface FakeFile extends FileLike {
	path: string;
	extension: string;
	stat: { size: number; mtime: number; ctime: number };
	bytes: Uint8Array;
}

interface FakeFolder extends FolderLike {
	path: string;
	children: unknown[];
}

type Ev = "create" | "modify" | "delete" | "rename";
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { ignoreBOM: true });

export class FakeObsidianVault implements VaultApi {
	readonly configDir = ".obsidian";
	readonly files = new Map<string, FakeFile>();
	readonly folders = new Map<string, FakeFolder>();
	readonly calls: string[] = [];
	readonly trashed: { path: string; system: boolean }[] = [];
	readonly raw = new Map<string, Uint8Array>(); // adapter-only files (config dir, dot-folders)
	private readonly listeners = new Map<Ev, Set<(f: AbstractFileLike, old?: string) => unknown>>();
	private clock = 1_000;
	/** Runs inside readBinary after the bytes were taken (simulates a concurrent edit during a CAS check). */
	afterReadBinary: ((path: string) => void) | null = null;
	/** Runs inside process before it reads the file (a write landing after the host's last stat recheck). */
	beforeProcess: ((path: string) => void) | null = null;
	readonly adapter: AdapterApi;

	constructor(readonly insensitive = false) {
		const self = this;
		const rawKey = (p: string) => this.k(p);
		const adapter: AdapterApi & { insensitive: boolean } = {
			insensitive,
			async exists(p) {
				return self.files.has(rawKey(p)) || self.folders.has(rawKey(p)) || self.raw.has(rawKey(p)) || [...self.raw.keys()].some((r) => r.startsWith(rawKey(p) + "/"));
			},
			async stat(p): Promise<AdapterStatLike | null> {
				const b = self.raw.get(rawKey(p));
				if (b) return { type: "file", size: b.length, mtime: 1, ctime: 1 };
				return [...self.raw.keys()].some((r) => r.startsWith(rawKey(p) + "/")) ? { type: "folder", size: 0, mtime: 0, ctime: 0 } : null;
			},
			async read(p) {
				const b = self.raw.get(rawKey(p));
				if (!b) throw new Error(`ENOENT ${p}`);
				return dec.decode(b);
			},
			async readBinary(p) {
				const b = self.raw.get(rawKey(p));
				if (b) return b.slice().buffer;
				const f = self.files.get(rawKey(p));
				if (!f) throw new Error(`ENOENT ${p}`);
				const out = f.bytes.slice().buffer;
				self.afterReadBinary?.(f.path);
				return out;
			},
			async write(p, data) {
				self.calls.push(`adapter.write ${p}`);
				self.raw.set(rawKey(p), enc.encode(data));
			},
			async writeBinary(p, data) {
				self.calls.push(`adapter.writeBinary ${p}`);
				self.raw.set(rawKey(p), new Uint8Array(data.slice(0)));
			},
			async list(p) {
				const prefix = rawKey(p) + "/";
				const files: string[] = [];
				const folders = new Set<string>();
				for (const r of self.raw.keys()) {
					if (!r.startsWith(prefix)) continue;
					const rest = r.slice(prefix.length);
					const i = rest.indexOf("/");
					if (i < 0) files.push(r);
					else folders.add(prefix + rest.slice(0, i));
				}
				for (const f of self.files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) files.push(f);
				return { files, folders: [...folders] };
			},
			async mkdir() {},
			async remove(p) {
				self.calls.push(`adapter.remove ${p}`);
				self.raw.delete(rawKey(p));
			},
			async rename(a, b) {
				self.calls.push(`adapter.rename ${a} ${b}`);
				const v = self.raw.get(rawKey(a));
				if (!v) throw new Error("ENOENT");
				self.raw.delete(rawKey(a));
				self.raw.set(rawKey(b), v);
			},
		};
		this.adapter = adapter;
	}

	private k(p: string): string {
		return this.insensitive ? p.toLowerCase() : p;
	}

	private emit(ev: Ev, f: AbstractFileLike, old?: string): void {
		for (const l of this.listeners.get(ev) ?? []) l(f, old);
	}

	/** Seed or externally change a file (fires create/modify like Obsidian's watcher). */
	put(path: string, text: string | Uint8Array): FakeFile {
		const bytes = typeof text === "string" ? enc.encode(text) : text;
		const cur = this.files.get(this.k(path));
		this.clock += 10;
		if (cur) {
			cur.bytes = bytes;
			cur.stat.size = bytes.length;
			cur.stat.mtime = this.clock;
			this.emit("modify", cur);
			return cur;
		}
		const name = path.split("/").pop() ?? path;
		const dot = name.lastIndexOf(".");
		const f: FakeFile = { path, extension: dot > 0 ? name.slice(dot + 1) : "", stat: { size: bytes.length, mtime: this.clock, ctime: this.clock }, bytes };
		this.files.set(this.k(path), f);
		this.emit("create", f);
		return f;
	}

	text(path: string): string | null {
		const f = this.files.get(this.k(path));
		return f ? dec.decode(f.bytes) : null;
	}

	getFiles(): FileLike[] {
		return [...this.files.values()];
	}

	getAbstractFileByPath(path: string): AbstractFileLike | null {
		const f = this.files.get(this.k(path));
		if (f) return f;
		const d = this.folders.get(this.k(path));
		if (d) {
			d.children = [...this.files.keys(), ...this.folders.keys()].filter((c) => c.startsWith(this.k(path) + "/") && !c.slice(path.length + 1).includes("/"));
			return d;
		}
		return null;
	}

	async read(file: FileLike): Promise<string> {
		return dec.decode((file as FakeFile).bytes);
	}

	async readBinary(file: FileLike): Promise<ArrayBuffer> {
		const out = (file as FakeFile).bytes.slice().buffer;
		this.afterReadBinary?.(file.path);
		return out;
	}

	async create(path: string, data: string): Promise<FileLike> {
		this.calls.push(`create ${path}`);
		if (this.files.has(this.k(path))) throw new Error("File already exists.");
		return this.put(path, data);
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<FileLike> {
		this.calls.push(`createBinary ${path}`);
		if (this.files.has(this.k(path))) throw new Error("File already exists.");
		return this.put(path, new Uint8Array(data.slice(0)));
	}

	async modifyBinary(file: FileLike, data: ArrayBuffer): Promise<void> {
		this.calls.push(`modifyBinary ${file.path}`);
		this.put(file.path, new Uint8Array(data.slice(0)));
	}

	async process(file: FileLike, fn: (data: string) => string): Promise<string> {
		this.calls.push(`process ${file.path}`);
		this.beforeProcess?.(file.path);
		const next = fn(dec.decode((file as FakeFile).bytes));
		this.put(file.path, next);
		return next;
	}

	async createFolder(path: string): Promise<unknown> {
		this.calls.push(`createFolder ${path}`);
		if (this.folders.has(this.k(path))) throw new Error("Folder already exists.");
		const d: FakeFolder = { path, children: [] };
		this.folders.set(this.k(path), d);
		return d;
	}

	async rename(file: AbstractFileLike, newPath: string): Promise<void> {
		this.calls.push(`rename ${file.path} ${newPath}`);
		const f = this.files.get(this.k(file.path));
		if (!f) throw new Error("ENOENT");
		const old = f.path;
		this.files.delete(this.k(old));
		f.path = newPath;
		this.files.set(this.k(newPath), f);
		this.emit("rename", f, old);
	}

	async trash(file: AbstractFileLike, system: boolean): Promise<void> {
		this.calls.push(`trash ${file.path}`);
		this.trashed.push({ path: file.path, system });
		this.files.delete(this.k(file.path));
		this.emit("delete", file);
	}

	async delete(file: AbstractFileLike, force?: boolean): Promise<void> {
		this.calls.push(`delete ${file.path} force=${String(force ?? false)}`);
		if (this.files.has(this.k(file.path))) throw new Error("fake: refusing to delete a file in tests");
		this.folders.delete(this.k(file.path));
	}

	on(name: Ev, callback: (file: AbstractFileLike, oldPath: string) => unknown): EventRefLike {
		const set = this.listeners.get(name) ?? new Set();
		const cb = callback as (f: AbstractFileLike, old?: string) => unknown;
		set.add(cb);
		this.listeners.set(name, set);
		return { name, cb } as unknown as EventRefLike;
	}

	offref(ref: EventRefLike): void {
		const r = ref as unknown as { name: Ev; cb: (f: AbstractFileLike, old?: string) => unknown };
		this.listeners.get(r.name)?.delete(r.cb);
	}
}
