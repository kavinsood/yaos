import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import test from "node:test";
import { writeFileAtomic } from "../src/fs";

test("writeFileAtomic writes content and leaves no temp files after success", async () => {
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-atomic-"));
	try {
		const target = nodePath.join(tempRoot, "note.md");
		await writeFileAtomic(target, "hello\n");
		await writeFileAtomic(target, "goodbye\n");

		assert.equal(await readFile(target, "utf8"), "goodbye\n");
		assert.deepEqual(await listTempFiles(tempRoot), []);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("writeFileAtomic preserves the existing file when the target directory rejects temp creation", async () => {
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-atomic-"));
	try {
		const target = nodePath.join(tempRoot, "note.md");
		await writeFile(target, "original\n", "utf8");
		await chmod(tempRoot, 0o500);
		try {
			await assert.rejects(
				() => writeFileAtomic(target, "new\n"),
				/EACCES|EPERM/,
			);
		} finally {
			await chmod(tempRoot, 0o700);
		}
		assert.equal(await readFile(target, "utf8"), "original\n");
		assert.deepEqual(await listTempFiles(tempRoot), []);
	} finally {
		await chmod(tempRoot, 0o700).catch(() => undefined);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("writeFileAtomic preserves an existing file mode", async () => {
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-atomic-"));
	try {
		const target = nodePath.join(tempRoot, "secret.md");
		await writeFile(target, "secret\n", { encoding: "utf8", mode: 0o600 });
		await chmod(target, 0o600);

		await writeFileAtomic(target, "updated\n");

		assert.equal(await readFile(target, "utf8"), "updated\n");
		assert.equal((await stat(target)).mode & 0o777, 0o600);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

async function listTempFiles(dir: string): Promise<string[]> {
	return (await readdir(dir)).filter((entry) => entry.includes(".tmp"));
}
