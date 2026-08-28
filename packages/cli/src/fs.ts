/**
 * Durable filesystem primitives for the Node daemon.
 *
 * Adopted from PR #16's `packages/cli/src/fs.ts`. Every write the daemon makes
 * into a user's vault goes through `writeFileAtomic`: a reader must never
 * observe a half-written note, and a crash must never leave one behind.
 *
 * The `syncDirectoryBestEffort` swallow list is deliberately narrow — EINVAL,
 * ENOTSUP, EPERM and EISDIR are the "this filesystem does not do directory
 * fsync" family (tmpfs, some FUSE mounts, macOS quirks). Everything else is a
 * real failure and is rethrown.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import nodePath from "node:path";

const DIRECTORY_SYNC_TOLERATED_CODES: Record<string, true> = {
	EINVAL: true,
	ENOTSUP: true,
	EPERM: true,
	EISDIR: true,
};

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = error.code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

/**
 * fsync a directory so a rename/unlink inside it survives power loss.
 *
 * Best effort by necessity: not every filesystem supports it. Only the four
 * "unsupported" codes are swallowed; anything else propagates.
 */
async function syncDirectoryBestEffort(directory: string): Promise<void> {
	let handle;
	try {
		handle = await fs.open(directory, "r");
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || (code !== undefined && DIRECTORY_SYNC_TOLERATED_CODES[code] === true)) {
			return;
		}
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		const code = errorCode(error);
		if (code === undefined || DIRECTORY_SYNC_TOLERATED_CODES[code] !== true) throw error;
	} finally {
		await handle.close();
	}
}

/** The file's current permission bits, or undefined when it does not exist. */
async function readExistingMode(absolutePath: string): Promise<number | undefined> {
	try {
		const stats = await fs.stat(absolutePath);
		return stats.mode & 0o7777;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Write `content` to `absolutePath` atomically.
 *
 * temp `wx` open -> explicit chmod (umask cannot tighten it) -> datasync ->
 * rename -> parent directory fsync. The temp file is removed in `finally`
 * whenever the rename did not happen.
 *
 * The temp name is vault-visible; the watcher's ignore predicate must exclude
 * `.yaos-write-*.tmp`.
 */
export async function writeFileAtomic(
	absolutePath: string,
	content: string | Uint8Array,
	options: { mode?: number } = {},
): Promise<void> {
	const dir = nodePath.dirname(absolutePath);
	const mode = options.mode ?? (await readExistingMode(absolutePath));
	const tmpPath = nodePath.join(
		dir,
		`.yaos-write-${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let renamed = false;
	try {
		const handle = await fs.open(tmpPath, "wx", mode);
		try {
			if (mode !== undefined) {
				await handle.chmod(mode);
			}
			await handle.writeFile(content);
			await handle.datasync();
		} finally {
			await handle.close();
		}
		await fs.rename(tmpPath, absolutePath);
		renamed = true;
		await syncDirectoryBestEffort(dir);
	} finally {
		if (!renamed) {
			await fs.rm(tmpPath, { force: true });
		}
	}
}

/**
 * Create `directory` and every missing parent, fsyncing each newly created
 * level's parent so the directory itself survives power loss.
 */
export async function ensureDirectoryDurable(directory: string): Promise<void> {
	const firstCreated = await fs.mkdir(directory, { recursive: true });
	if (firstCreated === undefined) return;
	await syncCreatedDirectoryParents(firstCreated, directory);
}

/**
 * fsync the parent of every directory created by one recursive mkdir, walking
 * from the shallowest newly created directory down to the target.
 */
async function syncCreatedDirectoryParents(
	firstCreated: string,
	target: string,
): Promise<void> {
	const resolvedTarget = nodePath.resolve(target);
	let current = nodePath.resolve(firstCreated);
	await syncDirectoryBestEffort(nodePath.dirname(current));
	while (current !== resolvedTarget) {
		const relative = nodePath.relative(current, resolvedTarget);
		if (relative === "" || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
			return;
		}
		const [next] = relative.split(nodePath.sep);
		if (!next) return;
		current = nodePath.join(current, next);
		await syncDirectoryBestEffort(nodePath.dirname(current));
	}
}

/** Remove a file and fsync its parent. A missing file is not an error. */
export async function removeFileDurable(absolutePath: string): Promise<void> {
	await fs.rm(absolutePath, { force: true });
	await syncDirectoryBestEffort(nodePath.dirname(absolutePath));
}

/** Rename a file and fsync both parents (once when they are the same). */
export async function renameFileDurable(
	fromPath: string,
	toPath: string,
): Promise<void> {
	await fs.rename(fromPath, toPath);
	const fromDir = nodePath.dirname(fromPath);
	const toDir = nodePath.dirname(toPath);
	await syncDirectoryBestEffort(fromDir);
	if (fromDir !== toDir) {
		await syncDirectoryBestEffort(toDir);
	}
}
