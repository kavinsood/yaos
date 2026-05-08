import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

/**
 * Write a file atomically: write to a unique temp file, fsync, then rename.
 * A crash mid-write leaves at most an orphan temp file rather than a corrupt
 * final file. Rename is atomic on POSIX when source and destination share a
 * filesystem, which they do because the temp file is created next to the target.
 */
export async function writeFileAtomic(
	absolutePath: string,
	content: string | Uint8Array,
	options: { mode?: number } = {},
): Promise<void> {
	const dir = nodePath.dirname(absolutePath);
	const mode = options.mode ?? await readExistingMode(absolutePath);
	const tmpPath = nodePath.join(
		dir,
		`.yaos-write-${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
	);

	let renamed = false;
	try {
		const fh = await fs.open(tmpPath, "wx", mode);
		try {
			if (mode !== undefined) {
				await fh.chmod(mode);
			}
			await fh.writeFile(content);
			await fh.datasync();
		} finally {
			await fh.close();
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

export async function ensureDirectoryDurable(dir: string): Promise<void> {
	const created = await fs.mkdir(dir, { recursive: true });
	if (!created) return;
	await syncCreatedDirectoryParents(created, dir);
}

export async function removeFileDurable(absolutePath: string): Promise<void> {
	await fs.rm(absolutePath, { force: true });
	await syncDirectoryIfPresent(nodePath.dirname(absolutePath));
}

export async function renameFileDurable(oldAbsolutePath: string, newAbsolutePath: string): Promise<void> {
	await fs.rename(oldAbsolutePath, newAbsolutePath);
	const oldDir = nodePath.dirname(oldAbsolutePath);
	const newDir = nodePath.dirname(newAbsolutePath);
	await syncDirectoryBestEffort(oldDir);
	if (newDir !== oldDir) {
		await syncDirectoryBestEffort(newDir);
	}
}

async function readExistingMode(absolutePath: string): Promise<number | undefined> {
	try {
		const stats = await fs.stat(absolutePath);
		return stats.mode & 0o7777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function syncCreatedDirectoryParents(firstCreated: string, targetDir: string): Promise<void> {
	const target = nodePath.resolve(targetDir);
	let current = nodePath.resolve(firstCreated);
	while (true) {
		await syncDirectoryBestEffort(nodePath.dirname(current));
		if (current === target) return;
		if (!target.startsWith(current + nodePath.sep)) return;
		const nextSegment = target.slice(current.length + 1).split(nodePath.sep)[0];
		if (!nextSegment) return;
		current = nodePath.join(current, nextSegment);
	}
}

async function syncDirectoryIfPresent(dir: string): Promise<void> {
	try {
		await syncDirectoryBestEffort(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

async function syncDirectoryBestEffort(dir: string): Promise<void> {
	let dh: fs.FileHandle | null = null;
	try {
		dh = await fs.open(dir, "r");
		await dh.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EISDIR") {
			throw error;
		}
	} finally {
		await dh?.close();
	}
}
