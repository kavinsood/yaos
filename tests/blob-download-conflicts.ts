import { TFile } from "obsidian";
import { BlobSyncManager } from "../src/sync/blobSync";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function text(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(buffer);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

interface StoredFile {
	file: TFile & { path: string; stat: { mtime: number; size: number } };
	data: ArrayBuffer;
}

function makeHarness() {
	let clock = 1;
	const files = new Map<string, StoredFile>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	function put(path: string, data: ArrayBuffer): StoredFile {
		const existing = files.get(path);
		const file = existing?.file ?? (new TFile() as TFile & {
			path: string;
			stat: { mtime: number; size: number };
		});
		file.path = path;
		file.stat = { mtime: clock++, size: data.byteLength };
		const stored = { file, data };
		files.set(path, stored);
		return stored;
	}

	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
			readBinary: async (file: TFile & { path: string }) => {
				const stored = files.get(file.path);
				if (!stored) throw new Error("missing file");
				return stored.data;
			},
			modifyBinary: async (file: TFile & { path: string }, data: ArrayBuffer) => {
				put(file.path, data);
			},
			createBinary: async (path: string, data: ArrayBuffer) => {
				if (files.has(path)) {
					const error = new Error("exists") as Error & { code?: string };
					error.code = "EEXIST";
					throw error;
				}
				put(path, data);
			},
			createFolder: async () => {},
			adapter: {
				stat: async (path: string) => files.get(path)?.file.stat ?? null,
			},
			configDir: ".obsidian",
		},
	} as any;

	const manager = new BlobSyncManager(
		app,
		{} as any,
		{
			host: "https://worker.example",
			token: "token",
			vaultId: "vault",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		},
		{},
		(source, msg, details) => traces.push({ source, msg, details }),
	);

	return { app, manager, files, put, traces };
}

async function runDownload(
	manager: BlobSyncManager,
	path: string,
	data: ArrayBuffer,
	onDownload?: () => void,
): Promise<string> {
	const hash = await sha256Hex(data);
	(manager as any).blobClient = {
		download: async () => {
			onDownload?.();
			return data;
		},
	};
	await (manager as any).processDownload({
		path,
		hash,
		sizeBytes: data.byteLength,
		retries: 0,
		status: "processing",
		readyAt: 0,
	});
	return hash;
}

console.log("\n--- Test 1: existing attachment changed during download is quarantined ---");
{
	const { manager, files, put, traces } = makeHarness();
	put("img.png", bytes("local-old"));
	await runDownload(manager, "img.png", bytes("remote"), () => {
		put("img.png", bytes("local-new"));
	});

	const conflict = Array.from(files.keys()).find((path) =>
		path.startsWith("img (YAOS remote conflict") && path.endsWith(".png")
	);
	assert(text(files.get("img.png")!.data) === "local-new", "local changed attachment is preserved");
	assert(!!conflict, "remote bytes are written to a conflict artifact");
	assert(conflict ? text(files.get(conflict)!.data) === "remote" : false, "conflict artifact contains remote bytes");
	assert(
		traces.some((event) =>
			event.msg === "download-conflict-quarantined" &&
			event.details?.reason === "existing-changed-during-download"
		),
		"download conflict quarantine is traced",
	);
}

console.log("\n--- Test 2: unchanged existing attachment can be overwritten ---");
{
	const { manager, files, put, traces } = makeHarness();
	put("img.png", bytes("local-old"));
	await runDownload(manager, "img.png", bytes("remote"));

	const conflict = Array.from(files.keys()).find((path) => path.includes("YAOS remote conflict"));
	assert(text(files.get("img.png")!.data) === "remote", "unchanged attachment is overwritten by remote bytes");
	assert(!conflict, "no conflict artifact is created for unchanged overwrite");
	assert(
		traces.some((event) =>
			event.msg === "download-overwrite-decision" &&
			event.details?.action === "overwrite-existing"
		),
		"normal overwrite decision is traced",
	);
}

console.log("\n--- Test 3: create race mismatch is quarantined instead of overwritten ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const originalCreateBinary = app.vault.createBinary;
	let raced = false;
	app.vault.createBinary = async (path: string, data: ArrayBuffer) => {
		if (path === "img.png" && !raced) {
			raced = true;
			put(path, bytes("local-race"));
			const error = new Error("exists") as Error & { code?: string };
			error.code = "EEXIST";
			throw error;
		}
		return originalCreateBinary(path, data);
	};

	await runDownload(manager, "img.png", bytes("remote"));

	const conflict = Array.from(files.keys()).find((path) =>
		path.startsWith("img (YAOS remote conflict") && path.endsWith(".png")
	);
	assert(text(files.get("img.png")!.data) === "local-race", "create-race local attachment is preserved");
	assert(!!conflict, "remote bytes are written to a conflict artifact after create race");
	assert(conflict ? text(files.get(conflict)!.data) === "remote" : false, "create-race conflict contains remote bytes");
	assert(
		traces.some((event) =>
			event.msg === "download-conflict-quarantined" &&
			event.details?.reason === "create-race-mismatch"
		),
		"create-race mismatch quarantine is traced",
	);
}

console.log("\n--- Test 4: create race same hash is skipped ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const remote = bytes("remote");
	const originalCreateBinary = app.vault.createBinary;
	let raced = false;
	app.vault.createBinary = async (path: string, data: ArrayBuffer) => {
		if (path === "img.png" && !raced) {
			raced = true;
			put(path, remote);
			const error = new Error("exists") as Error & { code?: string };
			error.code = "EEXIST";
			throw error;
		}
		return originalCreateBinary(path, data);
	};

	await runDownload(manager, "img.png", remote);

	const conflict = Array.from(files.keys()).find((path) => path.includes("YAOS remote conflict"));
	assert(text(files.get("img.png")!.data) === "remote", "matching create-race attachment remains in place");
	assert(!conflict, "matching create-race does not create conflict artifact");
	assert(
		traces.some((event) =>
			event.msg === "download-overwrite-decision" &&
			event.details?.action === "skip-create-race-match"
		),
		"matching create-race skip is traced",
	);
}

// ── Test 5: blob remote delete prefers trashFile ────────────────────────────

console.log("\n--- Test 5: blob remote delete prefers trashFile ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const existing = put("attachment.png", bytes("local data"));
	const trashedPaths: string[] = [];
	const deletedPaths: string[] = [];

	// Seed hash cache so knownHash matches — file is clean, delete should proceed
	const knownHash = "deadbeef1234";
	(manager as any).hashCache["attachment.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	// Add trashFile to the app mock
	(app as any).fileManager = {
		trashFile: async (file: TFile & { path: string }, system?: boolean) => {
			trashedPaths.push(file.path);
			files.delete(file.path);
		},
	};
	(app as any).vault.delete = async (file: TFile & { path: string }) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await (manager as any).handleRemoteDelete("attachment.png", knownHash);

	assert(trashedPaths.includes("attachment.png"), "blob remote delete uses trashFile");
	assert(deletedPaths.length === 0, "blob remote delete does not use hard delete when trash is available");
	assert(!files.has("attachment.png"), "blob remote delete removes file from vault");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-applied" &&
			event.details?.deleteMode === "trash"
		),
		"blob remote delete traces deleteMode as 'trash'",
	);
}

// ── Test 6: blob remote delete falls back to hard delete ────────────────────

console.log("\n--- Test 6: blob remote delete falls back when trash unavailable ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const existing = put("attachment2.png", bytes("local data 2"));
	const deletedPaths: string[] = [];

	// Seed hash cache so knownHash matches — file is clean, delete should proceed
	const knownHash = "deadbeef5678";
	(manager as any).hashCache["attachment2.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	// No fileManager.trashFile — simulate unavailable trash
	(app as any).fileManager = undefined;
	(app as any).vault.delete = async (file: TFile & { path: string }) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await (manager as any).handleRemoteDelete("attachment2.png", knownHash);

	assert(deletedPaths.includes("attachment2.png"), "blob remote delete falls back to hard delete");
	assert(!files.has("attachment2.png"), "file is removed from vault");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-applied" &&
			event.details?.deleteMode === "delete"
		),
		"blob remote delete traces deleteMode as 'delete'",
	);
}

// ── Test 7: blob remote delete with trash failure falls back ────────────────

console.log("\n--- Test 7: blob remote delete falls back when trashFile throws ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const existing = put("attachment3.png", bytes("local data 3"));
	const deletedPaths: string[] = [];

	// Seed hash cache so knownHash matches — file is clean, delete should proceed
	const knownHash = "deadbeef9abc";
	(manager as any).hashCache["attachment3.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	(app as any).fileManager = {
		trashFile: async () => {
			throw new Error("trash not supported");
		},
	};
	(app as any).vault.delete = async (file: TFile & { path: string }) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await (manager as any).handleRemoteDelete("attachment3.png", knownHash);

	assert(deletedPaths.includes("attachment3.png"), "falls back to hard delete when trash throws");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-applied" &&
			event.details?.deleteMode === "delete"
		),
		"traces fallback deleteMode as 'delete'",
	);
}

// ── Test 8: blob remote delete suppresses path before deletion ──────────────

console.log("\n--- Test 8: blob remote delete suppresses path before deletion ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const existing = put("suppressed.png", bytes("suppress me"));

	// Seed hash cache so knownHash matches — file is clean, delete should proceed
	const knownHash = "deadbeefdef0";
	(manager as any).hashCache["suppressed.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	(app as any).vault.delete = async (file: TFile & { path: string }) => {
		// Check suppression is active before deletion completes
		assert(
			(manager as any).isSuppressed("suppressed.png"),
			"path is suppressed before delete executes",
		);
		files.delete(file.path);
	};

	await (manager as any).handleRemoteDelete("suppressed.png", knownHash);
	assert(!files.has("suppressed.png"), "file is deleted after suppression");
}

// ── Test 9: blob remote delete preserves locally modified file ──────────────

console.log("\n--- Test 9: blob remote delete preserves locally modified file ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const existing = put("locally-modified.png", bytes("local version"));

	// Seed the hash cache with the KNOWN hash (the hash at last sync)
	const knownHash = "aabbccdd00112233445566778899aabbccddeeff0011223344556677889900aa";
	// The file was modified locally — stat doesn't match any cache entry (cache is empty),
	// so getCachedHash will return null → localDirty = true
	(app as any).vault.delete = async () => {
		throw new Error("should not delete locally modified file");
	};

	await (manager as any).handleRemoteDelete("locally-modified.png", knownHash);

	assert(files.has("locally-modified.png"), "locally modified file is preserved");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-conflict-preserved" &&
			event.details?.reason === "local-file-modified-since-last-sync"
		),
		"blob remote delete traces conflict preservation",
	);
}

// ── Test 10: blob remote delete proceeds when hash matches ──────────────────

console.log("\n--- Test 10: blob remote delete proceeds when hash matches known ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const existing = put("unchanged.png", bytes("same content"));

	// Seed the hash cache so getCachedHash returns the known hash
	const knownHash = "known-hash-matching";
	const stat = existing.file.stat;
	(manager as any).hashCache["unchanged.png"] = {
		mtime: stat.mtime,
		size: stat.size,
		hash: knownHash,
	};

	const deletedPaths: string[] = [];
	(app as any).vault.delete = async (file: TFile & { path: string }) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await (manager as any).handleRemoteDelete("unchanged.png", knownHash);

	assert(!files.has("unchanged.png"), "unmodified file is deleted");
	assert(deletedPaths.includes("unchanged.png"), "delete was called for unmodified file");
	assert(
		traces.some((event) => event.msg === "remote-delete-applied"),
		"blob remote delete traces remote-delete-applied for unmodified file",
	);
}

// ── Test 11: blob remote delete preserves when knownHash is null ────────────

console.log("\n--- Test 11: blob remote delete preserves when no known hash baseline ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const existing = put("no-baseline.png", bytes("mystery content"));

	// Track whether tombstone was cleared (it should NOT be for unknown baseline)
	let tombstoneCleared = false;
	(manager as any).vaultSync = {
		isBlobTombstoned: () => true,
		blobTombstones: {
			delete: () => { tombstoneCleared = true; },
		},
	};

	(app as any).vault.delete = async () => { throw new Error("should not delete when knownHash is null"); };
	(app as any).fileManager = {
		trashFile: async () => { throw new Error("should not trash when knownHash is null"); },
	};

	await (manager as any).handleRemoteDelete("no-baseline.png", null);

	assert(files.has("no-baseline.png"), "file preserved when no known hash baseline");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-conflict-preserved" &&
			event.details?.reason === "no-known-hash-baseline"
		),
		"blob remote delete traces no-known-hash-baseline preservation",
	);
	assert(!tombstoneCleared, "blob tombstone NOT cleared for unknown-baseline (no auto-resurrection)");
}

// ── Test 12: rerunResets cap prevents infinite retry loops ───────────────────

console.log("\n--- Test 12: rerunResets cap triggers permanent failure ---");
{
	const { manager, traces } = makeHarness();

	// Craft a download item that has exhausted retries AND rerunResets
	const item = {
		path: "capped.png",
		hash: "abc123",
		sizeBytes: 100,
		status: "processing" as const,
		retries: 4, // > MAX_RETRIES (3)
		readyAt: 0,
		needsRerun: true,
		rerunResets: 5, // = MAX_RERUN_RESETS (5)
	};

	// Mock blobClient to throw
	(manager as any).blobClient = {
		download: async () => { throw new Error("always fails"); },
	};

	await (manager as any).processDownload(item);

	// Item should be permanently failed — not restarted
	assert(
		!((manager as any).downloadQueue as Map<string, unknown>).has("capped.png"),
		"capped item removed from queue (permanent failure)",
	);
	assert(
		traces.some((event) =>
			event.msg === "download-permanently-failed" &&
			event.details?.path === "capped.png"
		),
		"permanent failure trace emitted for capped item",
	);
	assert(
		(manager as any)._permanentDownloadFailures === 1,
		"permanent download failure counter incremented",
	);
}

// ── Test 13: rerunResets < cap allows fresh restart ─────────────────────────

console.log("\n--- Test 13: rerunResets below cap allows fresh restart ---");
{
	const { manager, traces } = makeHarness();

	const item = {
		path: "restartable.png",
		hash: "def456",
		sizeBytes: 200,
		status: "processing" as const,
		retries: 4, // > MAX_RETRIES
		readyAt: 0,
		needsRerun: true,
		rerunResets: 3, // < MAX_RERUN_RESETS (5)
	};

	(manager as any).blobClient = {
		download: async () => { throw new Error("temporary"); },
	};

	// Put item in queue so processDownload can find it
	(manager as any).downloadQueue.set("restartable.png", item);

	await (manager as any).processDownload(item);

	// Item should be restarted, not permanently failed
	assert(
		((manager as any).downloadQueue as Map<string, any>).has("restartable.png"),
		"restartable item still in queue after rerun reset",
	);
	assert(item.retries === 0, "retries reset to 0 after rerun");
	assert(item.rerunResets === 4, "rerunResets incremented");
	assert(item.status === "pending", "status reset to pending");
	assert(
		(manager as any)._permanentDownloadFailures === 0,
		"no permanent failure for restartable item",
	);
}

// ── Test 14: debug snapshot exposes permanent failure counters ───────────────

console.log("\n--- Test 14: debug snapshot includes permanent failure counters ---");
{
	const { manager } = makeHarness();

	const snapshot = (manager as any).getDebugSnapshot();
	assert(
		"permanentUploadFailures" in snapshot,
		"debug snapshot has permanentUploadFailures",
	);
	assert(
		"permanentDownloadFailures" in snapshot,
		"debug snapshot has permanentDownloadFailures",
	);
	assert(
		"blobConflictArtifacts" in snapshot,
		"debug snapshot has blobConflictArtifacts",
	);
	assert(
		snapshot.permanentUploadFailures === 0,
		"initial permanent upload failures is 0",
	);
	assert(
		snapshot.permanentDownloadFailures === 0,
		"initial permanent download failures is 0",
	);
}

// ── Test 15: destroy() during in-flight transfer does not resurrect queue state ──

console.log("\n--- Test 15: destroy during in-flight does not resurrect ---");
{
	const { manager, files, put, traces } = makeHarness();
	put("inflight.png", bytes("data"));

	let resolveDownload: (() => void) | null = null;
	const downloadPromise = new Promise<void>((resolve) => {
		resolveDownload = resolve;
	});

	(manager as any).blobClient = {
		download: async () => {
			// download started — destroy while in flight
			(manager as any).destroy();
			await downloadPromise; // wait until test signals
			return bytes("remote");
		},
	};

	const item = {
		path: "inflight.png",
		hash: "abc123",
		sizeBytes: 6,
		status: "processing" as const,
		retries: 0,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	(manager as any).downloadQueue.set("inflight.png", item);

	// Start processing — it will call blobClient.download which destroys mid-flight
	const processPromise = (manager as any).processDownload(item);

	// Let the download resolve after destroy
	resolveDownload!();
	await processPromise;

	// After destroy + download resolving, queue should remain empty
	assert(
		(manager as any).downloadQueue.size === 0,
		"download queue empty after destroy (not resurrected)",
	);
	assert(
		(manager as any).uploadQueue.size === 0,
		"upload queue empty after destroy",
	);
	assert(
		(manager as any).inflightDownloads.size === 0,
		"inflight tracking cleared by destroy",
	);
}

// ── Test 16: kickUploadDrain does not start duplicate drain loops ────────────

console.log("\n--- Test 16: concurrent kickUploadDrain does not duplicate drain ---");
{
	const { manager, put, traces } = makeHarness();

	// Force uploadDraining = true to simulate active drain
	(manager as any).uploadDraining = true;

	let drainCalled = false;
	const originalDrain = (manager as any).drainUploads.bind(manager);
	(manager as any).drainUploads = async () => {
		drainCalled = true;
		return originalDrain();
	};

	// Kick should be a no-op when already draining
	(manager as any).kickUploadDrain();

	assert(!drainCalled, "drainUploads NOT called when uploadDraining is true");

	// Reset and verify it would call if not draining
	(manager as any).uploadDraining = false;
	(manager as any).kickUploadDrain();

	// drainUploads should have been called (though it exits immediately with empty queue)
	assert(drainCalled, "drainUploads called when uploadDraining is false");
}

// ── Test 17: importQueue with rerunResets near cap ──────────────────────────

console.log("\n--- Test 17: importQueue preserves rerunResets near cap ---");
{
	const { manager } = makeHarness();

	// Prevent drain from starting during import (we just want to check state)
	(manager as any).uploadDraining = true;
	(manager as any).downloadDraining = true;

	const snapshot = {
		uploads: [
			{ path: "near-cap.png", sizeBytes: 100, retries: 2, status: "pending" as const, readyAt: 0, needsRerun: true, rerunResets: 4 },
		],
		downloads: [
			{ path: "at-cap.png", hash: "xyz", sizeBytes: 200, retries: 3, status: "processing" as const, readyAt: 999, needsRerun: true, rerunResets: 5 },
		],
	};

	(manager as any).importQueue(snapshot);

	const uploadItem = (manager as any).uploadQueue.get("near-cap.png");
	assert(uploadItem !== undefined, "near-cap upload item imported");
	assert(uploadItem.rerunResets === 4, "rerunResets preserved at 4 (near cap)");
	assert(uploadItem.needsRerun === true, "needsRerun preserved");
	assert(uploadItem.status === "pending", "status normalized to pending on import");
	assert(uploadItem.readyAt === 0, "readyAt reset to 0 on import");

	const downloadItem = (manager as any).downloadQueue.get("at-cap.png");
	assert(downloadItem !== undefined, "at-cap download item imported");
	assert(downloadItem.rerunResets === 5, "rerunResets preserved at 5 (at cap)");
	assert(downloadItem.needsRerun === true, "needsRerun preserved for download");
	assert(downloadItem.status === "pending", "download status normalized to pending");
}

// ── Test 18: download conflict artifact does not update target hash cache ────

console.log("\n--- Test 18: conflict artifact does not pollute target hash cache ---");
{
	const { manager, files, put, traces } = makeHarness();
	const existing = put("target.png", bytes("local version"));

	// Seed hash cache for target with known value
	const originalHash = "original-target-hash";
	(manager as any).hashCache["target.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: originalHash,
	};

	// Simulate download that creates a conflict artifact
	const remoteData = bytes("remote version");
	(manager as any).blobClient = {
		download: async () => remoteData,
	};

	// Modify the file mid-download to trigger conflict path
	const item = {
		path: "target.png",
		hash: "remote-hash-abc",
		sizeBytes: remoteData.byteLength,
		status: "processing" as const,
		retries: 0,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};

	// Put a different stat so getCachedHash returns the original hash but it differs
	// from item.hash — this makes it take the conflict path
	const stat = existing.file.stat;
	(manager as any).hashCache["target.png"] = {
		mtime: stat.mtime,
		size: stat.size,
		hash: "different-from-remote",
	};

	await (manager as any).processDownload(item);

	// Verify target hash cache was NOT updated to remote hash
	const targetEntry = (manager as any).hashCache["target.png"];
	assert(
		targetEntry?.hash !== "remote-hash-abc",
		"target hash cache NOT updated to remote hash after conflict",
	);
	assert(
		targetEntry?.hash === "different-from-remote",
		"target hash cache retains its original value",
	);
}

console.log("\n--- Test 19: Multi-pass: unknown-baseline preserved blob is NOT re-uploaded by reconcile scan ---");
{
	// This is the critical system-level test for blob paths.
	// Scenario:
	// 1. Local blob file exists (image.png).
	// 2. Remote tombstone arrives with knownHash === null (unknown baseline).
	// 3. Handler preserves file as unresolved, does NOT clear tombstone.
	// 4. reconcile() runs (next pass) — sees local file + tombstoned path.
	// 5. Assert: file is NOT queued for upload, tombstone is NOT cleared.
	// 6. handleFileChange() fires for the same path without user modification.
	//    (e.g., filesystem watcher spurious event)
	//    Wait — actually handleFileChange clears the guard intentionally, because
	//    a vault modify event means the USER edited the file. So this scenario
	//    specifically tests reconcile()'s own scan, not handleFileChange.

	const { manager, put, traces } = makeHarness();

	// Set up: local file exists
	put("attachments/preserved.png", bytes("local image data"));

	// Simulate: the vaultSync has this path tombstoned
	const vaultSync = {
		pathToBlob: new Map([["attachments/preserved.png", { hash: "remote-hash-old", size: 100 }]]),
		isBlobTombstoned: (path: string) => path === "attachments/preserved.png",
		blobTombstones: new Map([["attachments/preserved.png", true]]),
		getBlobRef: () => null,
		setBlobRef: () => { throw new Error("setBlobRef should not be called"); },
		deleteBlobRef: () => {},
	};
	(manager as any).vaultSync = vaultSync;

	// Step 2–3: Remote tombstone with unknown baseline
	// Call handleRemoteDelete with knownHash = null
	await (manager as any).handleRemoteDelete("attachments/preserved.png", null);

	// Verify: path is in preservedUnresolvedPaths
	assert(
		(manager as any).preservedUnresolvedPaths.has("attachments/preserved.png"),
		"blob path recorded as preserved-unresolved after unknown-baseline remote-delete",
	);

	// Verify: tombstone was NOT cleared
	assert(
		vaultSync.blobTombstones.has("attachments/preserved.png"),
		"blob tombstone remains after preserve-unresolved",
	);

	// Step 4: Run reconcile scan
	// Add vault.getFiles() to return the local file
	const localFile = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	localFile.path = "attachments/preserved.png";
	(localFile as any).stat = { mtime: 5, size: 16 };
	(manager as any).app = {
		vault: {
			getFiles: () => [localFile],
			getAbstractFileByPath: () => localFile,
			configDir: ".obsidian",
		},
	};

	const result = manager.reconcile("authoritative", []);

	// Step 5: Assert file was NOT queued for upload
	assert(
		result.uploadQueued === 0,
		"preserved-unresolved blob NOT queued for upload by reconcile",
	);
	assert(
		result.skipped >= 1,
		"preserved-unresolved blob counted as skipped",
	);
	assert(
		!(manager as any).uploadQueue.has("attachments/preserved.png"),
		"upload queue does NOT contain preserved-unresolved path",
	);

	// Verify tombstone still present
	assert(
		vaultSync.blobTombstones.has("attachments/preserved.png"),
		"blob tombstone still present after reconcile",
	);

	// Step 6: Now simulate user explicitly modifying the file (handleFileChange)
	// This should clear the guard and allow future uploads
	(manager as any).preservedUnresolvedPaths.add("attachments/preserved.png"); // re-add for clarity
	const fakeFile = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	fakeFile.path = "attachments/preserved.png";
	(fakeFile as any).stat = { mtime: 10, size: 20 };

	// Suppress the debounce timer to avoid async issues
	manager.handleFileChange(fakeFile);
	assert(
		!(manager as any).preservedUnresolvedPaths.has("attachments/preserved.png"),
		"preserved-unresolved cleared after user modify event (handleFileChange)",
	);
}

console.log("\n--- Test 20: Multi-pass: stat-failure during blob remote-delete becomes preserve-unresolved ---");
{
	const { manager, put, traces } = makeHarness();

	put("attachments/stat-fails.png", bytes("file data"));

	// Override stat to throw
	(manager as any).app.vault.adapter.stat = async () => { throw new Error("EBUSY"); };

	// Call handleRemoteDelete with a known hash (so it enters the stat path)
	await (manager as any).handleRemoteDelete("attachments/stat-fails.png", "known-hash-abc123");

	// File should NOT be deleted (check that delete was not called)
	const deleteTrace = traces.find((t) => t.msg === "remote-delete-applied");
	assert(!deleteTrace, "file NOT deleted when stat fails");

	// Should be preserved-unresolved
	const preserveTrace = traces.find(
		(t) => t.source === "blob" && t.msg === "remote-delete-conflict-preserved" && t.details?.reason === "stat-failed-cannot-verify",
	);
	assert(!!preserveTrace, "preserve trace emitted with stat-failed reason");
	assert(
		(manager as any).preservedUnresolvedPaths.has("attachments/stat-fails.png"),
		"blob path recorded as preserved-unresolved after stat failure",
	);
}

console.log("\n--- Test 21: processUpload skips preserved-unresolved paths (queue snapshot resurrection guard) ---");
{
	const { manager, put, traces } = makeHarness();

	put("attachments/zombie.png", bytes("zombie data"));

	// Mark path as preserved-unresolved (simulates prior remote-delete with unknown baseline)
	(manager as any).preservedUnresolvedPaths.add("attachments/zombie.png");

	// Simulate a stale queue entry that slipped through (e.g., from importQueue)
	const item = {
		path: "attachments/zombie.png",
		sizeBytes: 11,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	(manager as any).uploadQueue.set("attachments/zombie.png", item);

	// Process the upload — should be blocked by the guard
	await (manager as any).processUpload(item);

	// Upload should have been removed from queue without uploading
	assert(
		!(manager as any).uploadQueue.has("attachments/zombie.png"),
		"stale upload removed from queue",
	);
	const skipTrace = traces.find(
		(t) => t.source === "blob" && t.msg === "upload-skipped-preserved-unresolved",
	);
	assert(!!skipTrace, "trace emitted for skipped preserved-unresolved upload");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
