import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ObsidianClient } from "./obsidian-client.mjs";

export interface ExternalVaultFile {
	relPath: string;
	content: string;
}

export async function writeNodeFile(
	vaultAbsPath: string,
	relPath: string,
	content: string,
): Promise<void> {
	const fullPath = join(vaultAbsPath, relPath);
	await mkdir(dirname(fullPath), { recursive: true });
	await writeFile(fullPath, content, "utf8");
}

export async function writeNodeFileAndWait(
	client: ObsidianClient,
	vaultAbsPath: string,
	relPath: string,
	content: string,
	timeoutMs = 15_000,
): Promise<void> {
	await writeNodeFile(vaultAbsPath, relPath, content);
	await waitForFileState(client, relPath, content.length, timeoutMs);
}

export async function writeNodeFilesAndWait(
	client: ObsidianClient,
	vaultAbsPath: string,
	files: readonly ExternalVaultFile[],
	timeoutMs = 30_000,
): Promise<void> {
	await Promise.all(files.map(({ relPath, content }) =>
		writeNodeFile(vaultAbsPath, relPath, content)));
	await Promise.all(files.map(({ relPath, content }) =>
		waitForFileState(client, relPath, content.length, timeoutMs)));
}

export async function deleteNodeFileAndWait(
	client: ObsidianClient,
	vaultAbsPath: string,
	relPath: string,
	timeoutMs = 15_000,
): Promise<void> {
	await rm(join(vaultAbsPath, relPath), { force: true });
	await waitForFileState(client, relPath, null, timeoutMs);
}

async function waitForFileState(
	client: ObsidianClient,
	relPath: string,
	expectedLength: number | null,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const observed = await client.evalRaw<boolean>(`
				(async () => {
					const file = window.app?.vault.getFileByPath(${JSON.stringify(relPath)});
					if (${expectedLength === null}) return !file;
					if (!file) return false;
					try {
						const content = await window.app.vault.read(file);
						return content.length === ${expectedLength ?? 0};
					} catch { return false; }
				})()
			`);
			if (observed) return;
		} catch {
			// The renderer can be transiently unavailable while Obsidian processes the event.
		}
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	throw new Error(
		expectedLength === null
			? `deleteNodeFileAndWait: "${relPath}" still visible after ${timeoutMs}ms`
			: `writeNodeFileAndWait: Obsidian did not observe "${relPath}" within ${timeoutMs}ms`,
	);
}
