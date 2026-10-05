/**
 * VaultPort, ConfigDirPort, SideFilePort: main-thread file I/O. DESIGN §f, §h.
 *
 * Rules every implementation must follow:
 *  - rename() is a plain vault rename (Obsidian vault.rename), NEVER
 *    fileManager.renameFile: remote moves must not rewrite links.
 *  - write() with a precondition is a CAS (Obsidian: vault.process for
 *    existing files, create for "absent"); a failed precondition never writes.
 *  - Events are hints. The engine never deletes or overwrites based on an
 *    event alone; it re-stats/re-hashes and plans from the three trees.
 *  - Dot-folders and the config dir are invisible to list() (Obsidian does not
 *    index them); config files go through ConfigDirPort.
 */

import type { Unsubscribe } from "./common";
import type { ContentHash, DiskFingerprint, VaultPath } from "../core/types";

export interface VaultStat {
	/** Exact path as reported by the vault (may be NFD on some filesystems). */
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

export type VaultEvent =
	| { readonly t: "create"; readonly path: string; readonly stat: VaultStat | null }
	| { readonly t: "modify"; readonly path: string; readonly stat: VaultStat | null }
	| { readonly t: "delete"; readonly path: string }
	/** Obsidian fires one per child for folder renames. */
	| { readonly t: "rename"; readonly from: string; readonly to: string; readonly stat: VaultStat | null };

/** Precondition for destructive writes. Checked atomically with the write where the platform allows. */
export type WritePrecondition =
	| { readonly t: "absent" }
	/** Current exact bytes hash to this fingerprint. */
	| { readonly t: "fingerprint"; readonly fingerprint: DiskFingerprint }
	/** Current logical (canonical) content hashes to this. */
	| { readonly t: "hash"; readonly hash: ContentHash }
	| { readonly t: "any" };

export type WriteOutcome =
	| { readonly ok: true; readonly stat: VaultStat; readonly fingerprint: DiskFingerprint }
	| { readonly ok: false; readonly reason: "precondition" | "parent-is-file" | "invalid-path" | "io"; readonly current: VaultStat | null; readonly message: string };

export type RenameOutcome =
	| { readonly ok: true; readonly stat: VaultStat }
	| { readonly ok: false; readonly reason: "source-missing" | "target-exists" | "precondition" | "io"; readonly message: string };

export type TrashMode = "obsidian-trash" | "system-trash";

export interface VaultPort {
	readonly configDir: string;
	/** Probed once: does "a.md" collide with "A.md" on this filesystem. */
	readonly caseInsensitive: boolean;
	/** Full listing of files (not folders). Cheap on Obsidian (in-memory index). */
	list(): Promise<readonly VaultStat[]>;
	stat(path: string): Promise<VaultStat | null>;
	readText(path: string): Promise<string>;
	readBytes(path: string): Promise<Uint8Array>;
	/** Create or replace, creating parent folders. */
	write(path: VaultPath, data: string | Uint8Array, precondition: WritePrecondition): Promise<WriteOutcome>;
	rename(from: string, to: VaultPath, precondition: WritePrecondition): Promise<RenameOutcome>;
	/** Recoverable delete only (invariant 2). Permanent delete is not exposed. */
	trash(path: string, mode: TrashMode, precondition: WritePrecondition): Promise<RenameOutcome>;
	/** Remove now-empty folders left behind by remote moves/deletes (never non-empty ones). */
	removeEmptyFolder(path: VaultPath): Promise<void>;
	onEvent(listener: (event: VaultEvent) => void): Unsubscribe;
}

/** Adapter-level access to <configDir>/ for settings sync (DESIGN §j.3). Paths are config-relative. */
export interface ConfigDirPort {
	list(dir: string): Promise<readonly { readonly path: string; readonly size: number; readonly mtimeMs: number; readonly isFolder: boolean }[]>;
	readBytes(path: string): Promise<Uint8Array | null>;
	/** Atomic replace (write tmp + rename). */
	writeBytes(path: string, bytes: Uint8Array): Promise<void>;
	remove(path: string): Promise<void>;
}

/**
 * Plugin-private state files next to the vault (<configDir>/plugins/yaos/state/).
 * Holds the outbox mirror, the synced-tree mirror and local recovery snapshots.
 * Survives IndexedDB eviction (DESIGN §e.4, §i.5).
 */
export type SideFileName =
	| "outbox-a.bin"
	| "outbox-b.bin"
	| "synced-a.bin"
	| "synced-b.bin"
	| `snapshots/${string}.zip`;

export interface SideFilePort {
	read(name: SideFileName): Promise<Uint8Array | null>;
	/** Not required to be atomic: readers use A/B generations + checksums. */
	write(name: SideFileName, bytes: Uint8Array): Promise<void>;
	remove(name: SideFileName): Promise<void>;
	list(prefix: "snapshots/"): Promise<readonly SideFileName[]>;
}
