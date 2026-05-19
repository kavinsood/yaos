/**
 * INV-SAFETY-02 — Local Repairs Round-Tripping integration test.
 */

import * as Y from "yjs";
import { DiskMirror } from "../src/sync/diskMirror";
import { ORIGIN_DISK_SYNC_RECOVER_BOUND } from "../src/sync/origins";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

// ── Harness ───────────────────────────────────────────────────────────────────

const FILE_PATH = "notes/test.md";
const FILE_ID = "file-001";

function makeHarness() {
	const doc = new Y.Doc();
	const meta = doc.getMap<{ path: string; deleted?: boolean }>("meta");
	const ytext = doc.getText("content");
	const fakeProvider = { __kind: "fake-provider" };

	// Seed meta
	doc.transact(() => {
		meta.set(FILE_ID, { path: FILE_PATH, deleted: false });
	});

	const fakeVaultSync = {
		provider: fakeProvider,
		ydoc: doc,
		meta,
		getTextForPath: (path: string) => (path === FILE_PATH ? ytext : null),
		getFileIdForText: (text: Y.Text) => (text === ytext ? FILE_ID : null),
		idToText: { entries: () => new Map([[FILE_ID, ytext]]).entries() },
		isFileMetaDeleted: (m: { deleted?: boolean } | undefined) =>
			Boolean(m?.deleted),
	};

	const fakeEditorBindings = {
		getLastEditorActivityForPath: () => null,
	};

	let diskContent = "v1";
	let lastVaultWrite: { path: string; content: string } | null = null;
	const fakeApp = {
		vault: {
			adapter: {
				write: async (path: string, content: string) => {
					lastVaultWrite = { path, content };
					diskContent = content;
				},
				read: async (path: string) => {
					if (path === FILE_PATH) return diskContent;
					return "";
				},
				stat: async () => ({
					mtime: Date.now(),
					size: diskContent.length,
				}),
			},
			getAbstractFileByPath: (path: string) => {
				if (path === FILE_PATH) return { path: FILE_PATH };
				return null;
			},
			createFolder: async () => {},
			create: async (path: string, content: string) => {
				lastVaultWrite = { path, content };
				diskContent = content;
				return { path };
			},
			process: async (
				file: { path: string },
				fn: (content: string) => string,
			) => {
				const old = diskContent;
				const next = fn(old);
				lastVaultWrite = { path: file.path, content: next };
				diskContent = next;
			},
			workspace: { getActiveViewOfType: () => null },
		},
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mirror = new DiskMirror(
		fakeApp as any,
		fakeVaultSync as any,
		fakeEditorBindings as any,
		false,
	);

	return {
		doc,
		ytext,
		fakeProvider,
		meta,
		mirror,
		getLastVaultWrite: () => lastVaultWrite,
		setDiskContent: (c: string) => {
			diskContent = c;
		},
	};
}

function debounceTimerCount(m: DiskMirror): number {
	return (m as unknown as { debounceTimers: Map<unknown, unknown> })
		.debounceTimers.size;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Test 1: Provider echo race (S-A) — Fixed ──────────────────────────────────

console.log("\n--- Test 1: provider echo race (S-A) — FIXED ---");
(async () => {
	const {
		doc,
		ytext,
		fakeProvider,
		mirror,
		setDiskContent,
		getLastVaultWrite,
	} = makeHarness();
	mirror.startMapObservers();

	// T+0ms: Local repair writes CRDT = "v2"
	doc.transact(() => {
		ytext.delete(0, ytext.length);
		ytext.insert(0, "v2");
	}, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	// In reality, ReconciliationController would call this:
	await mirror.recordRepairEcho(FILE_PATH, "v2");

	assert(
		debounceTimerCount(mirror) === 0,
		"local repair does not schedule write",
	);

	// T+10ms: Provider echoes "v2"
	doc.transact(() => {
		ytext.insert(0, " ");
		ytext.delete(0, 1);
	}, fakeProvider);

	// Wait a bit for the async handler to run
	await sleep(50);

	// With the fix, this should be 0
	assert(
		debounceTimerCount(mirror) === 0,
		"provider echo DOES NOT schedule write (fixed)",
	);

	// T+50ms: External tool writes disk = "v3"
	setDiskContent("v3");

	// T+310ms: Debounce would fire if it were scheduled
	await sleep(500);

	const lastWrite = getLastVaultWrite();
	// With the fix, no write should have happened
	assert(
		lastWrite === null,
		`SUCCESS: echo did NOT overwrite external edit (last write was ${lastWrite ? `"${lastWrite.content}"` : "null"})`,
	);

	doc.destroy();
	process.exit(failed > 0 ? 1 : 0);
})();
