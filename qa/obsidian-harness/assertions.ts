/**
 * Assertion helpers for the QA harness.
 * All failures throw an Error with a descriptive message.
 */

import { type App } from "obsidian";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";

export class AssertionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssertionError";
	}
}

function fail(message: string): never {
	throw new AssertionError(message);
}

export async function assertFileExists(app: App, path: string): Promise<void> {
	if (!app.vault.getAbstractFileByPath(path)) {
		fail(`assertFileExists: "${path}" not found in vault`);
	}
}

export async function assertFileNotExists(app: App, path: string): Promise<void> {
	if (app.vault.getAbstractFileByPath(path)) {
		fail(`assertFileNotExists: "${path}" still exists in vault`);
	}
}

export async function assertFileContent(app: App, path: string, expected: string): Promise<void> {
	const file = app.vault.getFileByPath(path);
	if (!file) fail(`assertFileContent: "${path}" not found`);
	const actual = await app.vault.read(file!);
	if (actual !== expected) {
		fail(
			`assertFileContent: "${path}" content mismatch\n` +
				`  expected (${expected.length} chars): ${expected.slice(0, 120)}…\n` +
				`  actual   (${actual.length} chars): ${actual.slice(0, 120)}…`,
		);
	}
}

export async function assertFileHash(
	app: App,
	yaos: YaosQaDebugApi,
	path: string,
	expectedHash: string,
): Promise<void> {
	const actual = await yaos.getDiskHash(path);
	if (!actual) fail(`assertFileHash: "${path}" not found or unreadable`);
	if (actual !== expectedHash) {
		fail(`assertFileHash: "${path}" hash mismatch\n  expected: ${expectedHash}\n  actual:   ${actual}`);
	}
}

export async function assertDiskEqualsCrdt(
	yaos: YaosQaDebugApi,
	path: string,
): Promise<void> {
	const diskHash = await yaos.getDiskHash(path);
	const crdtHash = await yaos.getCrdtHash(path);
	if (diskHash === null && crdtHash === null) return; // both absent — OK for deleted files
	if (diskHash !== crdtHash) {
		fail(
			`assertDiskEqualsCrdt: "${path}" mismatch\n` +
				`  disk: ${diskHash ?? "null"}\n` +
				`  crdt: ${crdtHash ?? "null"}`,
		);
	}
}

export async function assertNoConflictCopies(app: App, dir = ""): Promise<void> {
	const allFiles = app.vault.getFiles().map((f) => f.path);
	const conflicts = allFiles.filter((p) => {
		if (dir && !p.startsWith(dir)) return false;
		// Obsidian conflict pattern: "file (device's conflicted copy YYYY-MM-DD).ext"
		// or YAOS pattern: "file.conflict.md", "file (conflict).md"
		return (
			p.includes(" (conflict") ||
			p.includes(".conflict.") ||
			/\s\([^)]+conflicted copy[^)]*\)/.test(p)
		);
	});
	if (conflicts.length > 0) {
		fail(`assertNoConflictCopies: found ${conflicts.length} conflict copies:\n  ${conflicts.join("\n  ")}`);
	}
}
