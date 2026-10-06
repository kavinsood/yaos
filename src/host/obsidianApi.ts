/**
 * Structural subset of the Obsidian Vault / DataAdapter / Workspace API the
 * host adapters use. Kept structural (no runtime `obsidian` import) so the
 * adapters run in node tests against fakes; plugin.ts passes the real objects.
 */

export interface FileStatLike {
	readonly size: number;
	readonly mtime: number;
	readonly ctime: number;
}

export interface FileLike {
	readonly path: string;
	readonly extension: string;
	readonly stat: FileStatLike;
}

export interface FolderLike {
	readonly path: string;
	readonly children: readonly unknown[];
}

export type AbstractFileLike = FileLike | FolderLike;

export function isFile(f: unknown): f is FileLike {
	return !!f && typeof f === "object" && "stat" in f && "extension" in f && !("children" in f);
}

export function isFolder(f: unknown): f is FolderLike {
	return !!f && typeof f === "object" && "children" in f;
}

export interface EventRefLike {
	readonly __eventRef?: never;
}

export interface AdapterStatLike {
	readonly type: "file" | "folder";
	readonly size: number;
	readonly mtime: number;
	readonly ctime: number;
}

export interface AdapterApi {
	exists(path: string, sensitive?: boolean): Promise<boolean>;
	stat(path: string): Promise<AdapterStatLike | null>;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
	write(path: string, data: string): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	mkdir(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export interface VaultApi {
	readonly configDir: string;
	readonly adapter: AdapterApi;
	getFiles(): FileLike[];
	getAbstractFileByPath(path: string): AbstractFileLike | null;
	read(file: FileLike): Promise<string>;
	readBinary(file: FileLike): Promise<ArrayBuffer>;
	create(path: string, data: string): Promise<FileLike>;
	createBinary(path: string, data: ArrayBuffer): Promise<FileLike>;
	modifyBinary(file: FileLike, data: ArrayBuffer): Promise<void>;
	process(file: FileLike, fn: (data: string) => string): Promise<string>;
	createFolder(path: string): Promise<unknown>;
	rename(file: AbstractFileLike, newPath: string): Promise<void>;
	trash(file: AbstractFileLike, system: boolean): Promise<void>;
	delete(file: AbstractFileLike, force?: boolean): Promise<void>;
	on(name: "create" | "modify" | "delete", callback: (file: AbstractFileLike) => unknown): EventRefLike;
	on(name: "rename", callback: (file: AbstractFileLike, oldPath: string) => unknown): EventRefLike;
	offref(ref: EventRefLike): void;
}

export function tightBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
	return bytes.slice().buffer as ArrayBuffer;
}

export function parentsOf(path: string): string[] {
	const parts = path.split("/");
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
	return out;
}

export function invalidVaultPath(path: string): string | null {
	if (path.length === 0) return "empty path";
	if (path.startsWith("/") || path.endsWith("/")) return "leading or trailing slash";
	for (const seg of path.split("/")) {
		if (seg === "" || seg === "." || seg === "..") return `bad segment ${JSON.stringify(seg)}`;
	}
	return null;
}
