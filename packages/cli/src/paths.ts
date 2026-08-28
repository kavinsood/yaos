/**
 * Vault-relative path handling for the Node host.
 *
 * Two rules live here and nowhere else in `packages/cli`:
 *
 *   1. SPELLING. A vault path is POSIX-separated, NFC-normalized, relative, and
 *      free of `.`/`..` segments and NUL bytes. Identity is NOT reinvented —
 *      `canonicalizeVaultPath` (src/paths/canonicalPath.ts) owns it, and this
 *      module delegates to it so the daemon and the sync engine agree on what
 *      "the same file" means.
 *   2. CONTAINMENT. A vault path may only ever name something inside the vault
 *      root, and "inside" is decided after resolving symlinks, not by string
 *      prefix. A note called `../../.ssh/authorized_keys` arriving over the
 *      CRDT must not be writable, and neither must `notes` when `notes` is a
 *      symlink to `/etc`.
 *
 * The containment checks are the ones PR #16 hardened over two review rounds;
 * the ordering requirement they carry (assert before mkdir AND again
 * immediately before the write) is a caller obligation, restated at each call
 * site in `nodeApp.ts`.
 */

import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { canonicalizeVaultPath } from "../../../src/paths/canonicalPath";

/** A path that cannot be used, with a message naming the offending input. */
export class VaultPathError extends Error {
	readonly vaultPath: string;

	constructor(message: string, vaultPath: string) {
		super(message);
		this.name = "VaultPathError";
		this.vaultPath = vaultPath;
	}
}

/**
 * The canonical spelling of a vault path: separators cleaned, leading `./` and
 * `/` stripped, NFC-folded.
 *
 * Delegates to `canonicalizeVaultPath` rather than repeating its regexes — a
 * second normalizer is exactly the dual-normalization bug the audit already
 * found between `vaultSync.normPath` and `canonicalKey`.
 */
export function normalizeVaultPath(input: string): string {
	return canonicalizeVaultPath(input).canonicalKey;
}

/**
 * The path's segments, or a throw.
 *
 * Rejects NUL (which Node turns into an opaque `ERR_INVALID_ARG_VALUE` far from
 * the cause), absolute paths, Windows drive letters and UNC roots, and `.`/`..`
 * segments. Empty segments are dropped by the normalizer already; a path that
 * is empty after normalization has no segments and is rejected by the callers
 * that need one.
 *
 * THE ABSOLUTE CHECK LOOKS AT THE RAW INPUT, on purpose. `canonicalizeVaultPath`
 * strips a leading `/`, so `/etc/passwd.md` normalizes to the vault-relative
 * `etc/passwd.md` — which is what Obsidian does too, and is harmless because
 * the result still lands inside the vault. A caller that reaches this function
 * with a leading slash still attached, however, has bypassed `normalize`, and
 * that is a bug worth a loud failure rather than a silent reinterpretation.
 */
export function vaultPathParts(vaultPath: string): string[] {
	if (vaultPath.includes("\0")) {
		throw new VaultPathError(
			`Path rejected: "${vaultPath}" contains a NUL byte`,
			vaultPath,
		);
	}
	if (
		vaultPath.startsWith("/") ||
		vaultPath.startsWith("\\") ||
		/^[a-zA-Z]:/.test(vaultPath)
	) {
		throw new VaultPathError(
			`Path rejected: "${vaultPath}" is absolute`,
			vaultPath,
		);
	}
	const normalized = normalizeVaultPath(vaultPath);
	const parts = normalized.split("/").filter((part) => part.length > 0);
	for (const part of parts) {
		if (part === "." || part === "..") {
			throw new VaultPathError(
				`Path traversal rejected: "${vaultPath}" contains dot segments`,
				vaultPath,
			);
		}
	}
	return parts;
}

/**
 * The absolute filesystem path for a vault path.
 *
 * Purely lexical: it proves the joined path stays under `vaultRoot` as a
 * string. That is necessary but not sufficient — see `assertInsideRoot`, which
 * is what catches a symlinked ancestor.
 */
export function toAbsolutePath(vaultRoot: string, vaultPath: string): string {
	const parts = vaultPathParts(vaultPath);
	const absolute = nodePath.join(vaultRoot, ...parts);
	const relative = nodePath.relative(vaultRoot, absolute);
	if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
		throw new VaultPathError(
			`Path traversal rejected: "${vaultPath}" resolves outside vault root`,
			vaultPath,
		);
	}
	return absolute;
}

/**
 * The vault path for something inside the vault, or `null` when it is outside.
 *
 * `null` rather than a throw: every caller is a directory walk or a watcher
 * event, and both legitimately see paths they should simply skip.
 */
export function toVaultRelativePath(
	vaultRoot: string,
	absolutePath: string,
): string | null {
	const relative = nodePath.relative(vaultRoot, absolutePath);
	if (relative === "" || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
		return null;
	}
	const normalized = normalizeVaultPath(relative.split(nodePath.sep).join("/"));
	return normalized.length > 0 ? normalized : null;
}

/**
 * The realpath of the nearest ancestor of `directory` that exists.
 *
 * Walks up on ENOENT, because the parent of a file the daemon is about to
 * create usually does not exist yet and the question "would creating it escape
 * the vault" still has to be answerable. Throws if it reaches the filesystem
 * root without finding anything, which cannot happen for a path under a vault
 * root that exists.
 */
export async function nearestExistingAncestorRealPath(
	directory: string,
): Promise<string> {
	let current = nodePath.resolve(directory);
	for (;;) {
		try {
			return await fs.realpath(current);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				const parent = nodePath.dirname(current);
				if (parent === current) {
					throw new VaultPathError(
						`Cannot resolve any existing ancestor of "${directory}"`,
						directory,
					);
				}
				current = parent;
				continue;
			}
			throw error;
		}
	}
}

/**
 * Throw unless `absolutePath`'s parent really lives under `rootRealPath`.
 *
 * Resolves symlinks, so `notes -> /etc` is caught where a string comparison
 * would wave it through. Callers must run this BEFORE creating directories (so
 * `mkdir -p` cannot build a chain through a symlink) and AGAIN immediately
 * before the write, because the two are separated by an await during which the
 * filesystem can change underneath.
 */
export async function assertInsideRoot(
	rootRealPath: string,
	absolutePath: string,
	vaultPath: string,
): Promise<void> {
	const parentRealPath = await nearestExistingAncestorRealPath(
		nodePath.dirname(absolutePath),
	);
	const relative = nodePath.relative(rootRealPath, parentRealPath);
	if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
		throw new VaultPathError(
			`Symlink traversal rejected: "${vaultPath}" resolves outside vault root`,
			vaultPath,
		);
	}
}
