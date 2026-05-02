export interface VaultFsStats {
	size: number;
	/** Milliseconds since epoch. */
	mtime: number;
	isFile: boolean;
	isDirectory: boolean;
}

export interface VaultFsListOptions {
	excludePatterns: string[];
	configDir: string;
}

export interface VaultFsListing {
	path: string;
	stats: VaultFsStats;
}

export interface VaultFsRenameOptions {
	/** When true, overwrite an existing target. Default false. */
	overwrite?: boolean;
}

export interface VaultFsReadOptions {
	/** Reject reads larger than `maxBytes` with a `VaultFsError` carrying code `too_large`. */
	maxBytes?: number;
}

export type VaultFsErrorCode =
	| "missing"
	| "target_exists"
	| "too_large"
	| "traversal"
	| "symlink_escape"
	| "non_nfc"
	| "io";

export class VaultFsError extends Error {
	constructor(
		message: string,
		readonly code: VaultFsErrorCode,
		options?: { cause?: unknown },
	) {
		super(message);
		this.name = "VaultFsError";
		if (options && "cause" in options) {
			(this as Error & { cause?: unknown }).cause = options.cause;
		}
	}
}

export interface VaultFs {
	/** Canonical vault-relative form. NFC, slash-normalized, no leading/trailing slash. */
	normalize(path: string): string;

	/** Read UTF-8 text. Returns null when the file is missing. Throws `too_large` if `maxBytes` exceeded. */
	readText(path: string, options?: VaultFsReadOptions): Promise<string | null>;

	/** Write UTF-8 text. Atomic where the runtime supports it. Creates parent directories. */
	writeText(path: string, content: string): Promise<void>;

	/** Delete a file. No-op when the file is missing. */
	delete(path: string): Promise<void>;

	/**
	 * Rename `oldPath` to `newPath`. Creates parent directories of the target.
	 * Plugin adapter MUST preserve link rewrites (Obsidian `app.fileManager.renameFile`).
	 * Throws `missing` when source is missing.
	 * Throws `target_exists` when the target exists and `options.overwrite` is not true.
	 */
	rename(oldPath: string, newPath: string, options?: VaultFsRenameOptions): Promise<void>;

	/** Stat a path. Returns null when missing. */
	stat(path: string): Promise<VaultFsStats | null>;

	/** Yield every vault-relative markdown path that survives `excludePatterns` and is a file. */
	listMarkdown(options: VaultFsListOptions): AsyncIterable<VaultFsListing>;
}
