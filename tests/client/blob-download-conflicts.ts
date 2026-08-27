import { App, TFile, type FileStats } from "obsidian";
import {
	BlobSyncManager,
	type AttachmentCatalogPort,
} from "../../src/sync/blobSync";
import type { BlobRef } from "../../src/types";
import { suite } from "../harness.ts";

const s = suite("blob-download-conflicts");

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
	file: TFile;
	data: ArrayBuffer;
}

/**
 * `TFile`'s fields are declared but never initialised by the declaration file
 * (the real class is constructed by Obsidian), so a fixture just fills them in.
 * Kept as a real `TFile` because blobSync gates on `instanceof TFile`.
 */
function makeFile(path: string, stat: FileStats): TFile {
	const file = new TFile();
	file.path = path;
	file.stat = stat;
	return file;
}

/**
 * Exactly the `app.vault` surface BlobSyncManager consumes. `delete` and
 * `getFiles` are optional because the default fixture omits them and the tests
 * that exercise deletion/reconcile install their own — installing them here
 * would change which code paths the untouched tests reach.
 */
interface FakeVault {
	getAbstractFileByPath(path: string): TFile | null;
	readBinary(file: TFile): Promise<ArrayBuffer>;
	modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
	createBinary(path: string, data: ArrayBuffer): Promise<void>;
	createFolder(path: string): Promise<void>;
	adapter: { stat(path: string): Promise<FileStats | null> };
	configDir: string;
	delete?(file: TFile): Promise<void>;
	getFiles?(): TFile[];
}

/** Exactly the `app.fileManager` surface `deleteLocalReplica` probes. */
interface FakeFileManager {
	trashFile?(file: TFile, system?: boolean): Promise<void>;
}

interface VaultFixture {
	vault: FakeVault;
	files: Map<string, StoredFile>;
	put(path: string, data: ArrayBuffer): StoredFile;
}

/** In-memory vault: a path → bytes map with monotonic mtimes. */
function makeVaultFixture(): VaultFixture {
	let clock = 1;
	const files = new Map<string, StoredFile>();

	function put(path: string, data: ArrayBuffer): StoredFile {
		const existing = files.get(path);
		const writtenAt = clock++;
		const stat: FileStats = {
			ctime: existing?.file.stat.ctime ?? writtenAt,
			mtime: writtenAt,
			size: data.byteLength,
		};
		const file = existing?.file ?? makeFile(path, stat);
		file.path = path;
		file.stat = stat;
		const stored = { file, data };
		files.set(path, stored);
		return stored;
	}

	const vault: FakeVault = {
		getAbstractFileByPath: (path) => files.get(path)?.file ?? null,
		readBinary: async (file) => {
			const stored = files.get(file.path);
			if (!stored) throw new Error("missing file");
			return stored.data;
		},
		modifyBinary: async (file, data) => {
			put(file.path, data);
		},
		createBinary: async (path, data) => {
			if (files.has(path)) {
				const error = new Error("exists") as Error & { code?: string };
				error.code = "EEXIST";
				throw error;
			}
			put(path, data);
		},
		createFolder: async () => {},
		adapter: {
			stat: async (path) => files.get(path)?.file.stat ?? null,
		},
		configDir: ".obsidian",
	};

	return { vault, files, put };
}

/**
 * `App` cannot be constructed outside Obsidian, and satisfying it member by
 * member would mean faking Workspace, MetadataCache, Keymap and Scope — none of
 * which blobSync touches. The prototype gives a real `App` to hand to the
 * constructor; the two members blobSync actually reads are supplied by
 * reference, so tests mutate `vault`/`fileManager` directly and the manager sees
 * it (it re-reads `app.fileManager` on every delete).
 */
function makeApp(vault: FakeVault, fileManager: FakeFileManager): App {
	return Object.assign(Object.create(App.prototype) as App, {
		vault,
		fileManager,
	});
}

function makeAttachmentCatalogFixture(): AttachmentCatalogPort {
	const refs = new Map<string, BlobRef>();
	const tombstones = new Set<string>();
	return {
		listAttachmentRefs: () => refs,
		getAttachmentRef: (path) => refs.get(path),
		isAttachmentTombstoned: (path) => tombstones.has(path),
		setAttachmentRef: (path, hash, size) => {
			refs.set(path, { hash, size });
			tombstones.delete(path);
		},
		deleteAttachmentRef: (path) => {
			refs.delete(path);
			tombstones.add(path);
		},
		renameAttachmentRef: (oldPath, newPath) => {
			const ref = refs.get(oldPath);
			if (!ref) return;
			refs.delete(oldPath);
			refs.set(newPath, ref);
		},
		observeAttachmentChanges: () => () => {},
	};
}

/**
 * Stub the download leg of the manager's blob HTTP client. `BlobHttpClient` is
 * not exported (and has private fields, so no stand-in is assignable to it), so
 * the instance the constructor built is mutated in place — `download` is the
 * only member these tests exercise.
 */
function stubDownload(
	manager: BlobSyncManager,
	download: () => Promise<ArrayBuffer>,
): void {
	manager["blobClient"].download = download;
}

function makeHarness() {
	const { vault, files, put } = makeVaultFixture();
	const fileManager: FakeFileManager = {};
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const manager = new BlobSyncManager(
		makeApp(vault, fileManager),
		makeAttachmentCatalogFixture(),
		{
			host: "https://worker.example",
			deviceToken: "device-token",
			vaultId: "vault",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		},
		{},
		(source, msg, details) => traces.push({ source, msg, details }),
	);

	return { vault, fileManager, manager, files, put, traces };
}

async function runDownload(
	manager: BlobSyncManager,
	path: string,
	data: ArrayBuffer,
	onDownload?: () => void,
): Promise<string> {
	const hash = await sha256Hex(data);
	manager["attachmentCatalog"].setAttachmentRef(path, hash, data.byteLength, "application/octet-stream");
	stubDownload(manager, async () => {
		onDownload?.();
		return data;
	});
	await manager["processDownload"]({
		path,
		hash,
		sizeBytes: data.byteLength,
		retries: 0,
		status: "processing",
		readyAt: 0,
		rerunResets: 0,
	});
	return hash;
}

s.section("Test 1: existing attachment changed during download is quarantined");
{
	const { manager, files, put, traces } = makeHarness();
	put("img.png", bytes("local-old"));
	await runDownload(manager, "img.png", bytes("remote"), () => {
		put("img.png", bytes("local-new"));
	});

	const conflict = Array.from(files.keys()).find((path) =>
		path.startsWith("img (YAOS remote conflict") && path.endsWith(".png")
	);
	s.check(text(files.get("img.png")!.data) === "local-new", "local changed attachment is preserved");
	s.check(!!conflict, "remote bytes are written to a conflict artifact");
	s.check(conflict ? text(files.get(conflict)!.data) === "remote" : false, "conflict artifact contains remote bytes");
	s.check(
		traces.some((event) =>
			event.msg === "download-conflict-quarantined" &&
			event.details?.reason === "existing-changed-during-download"
		),
		"download conflict quarantine is traced",
	);
}

s.section("Test 2: unchanged existing attachment can be overwritten");
{
	const { manager, files, put, traces } = makeHarness();
	put("img.png", bytes("local-old"));
	await runDownload(manager, "img.png", bytes("remote"));

	const conflict = Array.from(files.keys()).find((path) => path.includes("YAOS remote conflict"));
	s.check(text(files.get("img.png")!.data) === "remote", "unchanged attachment is overwritten by remote bytes");
	s.check(!conflict, "no conflict artifact is created for unchanged overwrite");
	s.check(
		traces.some((event) =>
			event.msg === "download-overwrite-decision" &&
			event.details?.action === "overwrite-existing"
		),
		"normal overwrite decision is traced",
	);
}

s.section("Test 3: create race mismatch is quarantined instead of overwritten");
{
	const { vault, manager, files, put, traces } = makeHarness();
	const originalCreateBinary = vault.createBinary;
	let raced = false;
	vault.createBinary = async (path: string, data: ArrayBuffer) => {
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
	s.check(text(files.get("img.png")!.data) === "local-race", "create-race local attachment is preserved");
	s.check(!!conflict, "remote bytes are written to a conflict artifact after create race");
	s.check(conflict ? text(files.get(conflict)!.data) === "remote" : false, "create-race conflict contains remote bytes");
	s.check(
		traces.some((event) =>
			event.msg === "download-conflict-quarantined" &&
			event.details?.reason === "create-race-mismatch"
		),
		"create-race mismatch quarantine is traced",
	);
}

s.section("Test 4: create race same hash is skipped");
{
	const { vault, manager, files, put, traces } = makeHarness();
	const remote = bytes("remote");
	const originalCreateBinary = vault.createBinary;
	let raced = false;
	vault.createBinary = async (path: string, data: ArrayBuffer) => {
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
	s.check(text(files.get("img.png")!.data) === "remote", "matching create-race attachment remains in place");
	s.check(!conflict, "matching create-race does not create conflict artifact");
	s.check(
		traces.some((event) =>
			event.msg === "download-overwrite-decision" &&
			event.details?.action === "skip-create-race-match"
		),
		"matching create-race skip is traced",
	);
}

// ── Test 5: blob remote delete prefers trashFile ────────────────────────────

s.section("Test 5: blob remote delete prefers trashFile");
{
	const { vault, fileManager, manager, files, put, traces } = makeHarness();
	const existing = put("attachment.png", bytes("local data"));
	const trashedPaths: string[] = [];
	const deletedPaths: string[] = [];

	// Seed hash cache so knownHash matches — file is clean, delete should proceed
	const knownHash = "1".repeat(64);
	manager["hashCache"]["attachment.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	// Add trashFile to the app mock
	fileManager.trashFile = async (file) => {
		trashedPaths.push(file.path);
		files.delete(file.path);
	};
	vault.delete = async (file) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await manager["handleRemoteDelete"]("attachment.png", knownHash);

	s.check(trashedPaths.includes("attachment.png"), "blob remote delete uses trashFile");
	s.check(deletedPaths.length === 0, "blob remote delete does not use hard delete when trash is available");
	s.check(!files.has("attachment.png"), "blob remote delete removes file from vault");
	s.check(
		traces.some((event) =>
			event.msg === "remote-delete-applied" &&
			event.details?.deleteMode === "trash"
		),
		"blob remote delete traces deleteMode as 'trash'",
	);
}

// ── Test 6: blob remote delete preserves file when trash is unavailable ─────

s.section("Test 6: blob remote delete never hard-deletes when trash is unavailable");
{
	const { vault, fileManager, manager, files, put, traces } = makeHarness();
	const existing = put("attachment2.png", bytes("local data 2"));
	const deletedPaths: string[] = [];

	const knownHash = "2".repeat(64);
	manager["hashCache"]["attachment2.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	fileManager.trashFile = undefined;
	vault.delete = async (file) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await manager["handleRemoteDelete"]("attachment2.png", knownHash);

	s.check(deletedPaths.length === 0, "blob remote delete never falls back to hard delete");
	s.check(files.has("attachment2.png"), "file remains when the user-respecting trash path is unavailable");
	s.check(
		!traces.some((event) => event.msg === "remote-delete-applied"),
		"failed trash does not emit remote-delete-applied",
	);
}

// ── Test 7: blob remote delete preserves file when trash fails ──────────────

s.section("Test 7: blob remote delete never hard-deletes when trashFile throws");
{
	const { vault, fileManager, manager, files, put, traces } = makeHarness();
	const existing = put("attachment3.png", bytes("local data 3"));
	const deletedPaths: string[] = [];

	const knownHash = "3".repeat(64);
	manager["hashCache"]["attachment3.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	fileManager.trashFile = async () => {
		throw new Error("trash not supported");
	};
	vault.delete = async (file) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await manager["handleRemoteDelete"]("attachment3.png", knownHash);

	s.check(deletedPaths.length === 0, "trash failure never falls back to hard delete");
	s.check(files.has("attachment3.png"), "file remains when trashFile fails");
	s.check(
		!traces.some((event) => event.msg === "remote-delete-applied"),
		"trash failure does not emit remote-delete-applied",
	);
}

// ── Test 8: blob remote delete suppresses path before deletion ──────────────

s.section("Test 8: blob remote delete suppresses path before deletion");
{
	const { fileManager, manager, files, put, traces } = makeHarness();
	const existing = put("suppressed.png", bytes("suppress me"));

	// Seed hash cache so knownHash matches — file is clean, delete should proceed
	const knownHash = "4".repeat(64);
	manager["hashCache"]["suppressed.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: knownHash,
	};

	fileManager.trashFile = async (file) => {
		// Check suppression is active before deletion completes.
		s.check(
			manager.isSuppressed("suppressed.png"),
			"path is suppressed before trash executes",
		);
		files.delete(file.path);
	};

	await manager["handleRemoteDelete"]("suppressed.png", knownHash);
	s.check(!files.has("suppressed.png"), "file is deleted after suppression");
}

// ── Test 9: blob remote delete preserves locally modified file ──────────────

s.section("Test 9: blob remote delete preserves locally modified file");
{
	const { vault, manager, files, put, traces } = makeHarness();
	const existing = put("locally-modified.png", bytes("local version"));

	// Seed the hash cache with the KNOWN hash (the hash at last sync)
	const knownHash = "aabbccdd00112233445566778899aabbccddeeff0011223344556677889900aa";
	// The file was modified locally — stat doesn't match any cache entry (cache is empty),
	// so getCachedHash will return null → localDirty = true
	vault.delete = async () => {
		throw new Error("should not delete locally modified file");
	};

	await manager["handleRemoteDelete"]("locally-modified.png", knownHash);

	s.check(files.has("locally-modified.png"), "locally modified file is preserved");
	s.check(
		traces.some((event) =>
			event.msg === "remote-delete-conflict-preserved" &&
			event.details?.reason === "local-file-modified-since-last-sync"
		),
		"blob remote delete traces conflict preservation",
	);
}

// ── Test 10: blob remote delete proceeds when hash matches ──────────────────

s.section("Test 10: blob remote delete proceeds when hash matches known");
{
	const { fileManager, manager, files, put, traces } = makeHarness();
	const existing = put("unchanged.png", bytes("same content"));

	// Seed the hash cache so getCachedHash returns the known hash
	const knownHash = "5".repeat(64);
	const stat = existing.file.stat;
	manager["hashCache"]["unchanged.png"] = {
		mtime: stat.mtime,
		size: stat.size,
		hash: knownHash,
	};

	const trashedPaths: string[] = [];
	fileManager.trashFile = async (file) => {
		trashedPaths.push(file.path);
		files.delete(file.path);
	};

	await manager["handleRemoteDelete"]("unchanged.png", knownHash);

	s.check(!files.has("unchanged.png"), "unmodified file is deleted");
	s.check(trashedPaths.includes("unchanged.png"), "trashFile was called for unmodified file");
	s.check(
		traces.some((event) => event.msg === "remote-delete-applied"),
		"blob remote delete traces remote-delete-applied for unmodified file",
	);
}

// ── Test 11: blob remote delete preserves when knownHash is null ────────────

s.section("Test 11: blob remote delete preserves when no known hash baseline");
{
	const { vault, fileManager, manager, files, put, traces } = makeHarness();
	const existing = put("no-baseline.png", bytes("mystery content"));

	// Track whether tombstone was cleared (it should NOT be for unknown baseline)
	let tombstoneCleared = false;
	Reflect.set(manager, "attachmentCatalog", {
		isAttachmentTombstoned: () => true,
		setAttachmentRef: () => { tombstoneCleared = true; },
	});

	vault.delete = async () => { throw new Error("should not delete when knownHash is null"); };
	fileManager.trashFile = async () => { throw new Error("should not trash when knownHash is null"); };

	await manager["handleRemoteDelete"]("no-baseline.png", null);

	s.check(files.has("no-baseline.png"), "file preserved when no known hash baseline");
	s.check(
		traces.some((event) =>
			event.msg === "remote-delete-conflict-preserved" &&
			event.details?.reason === "no-known-hash-baseline"
		),
		"blob remote delete traces no-known-hash-baseline preservation",
	);
	s.check(!tombstoneCleared, "blob tombstone NOT cleared for unknown-baseline (no auto-resurrection)");
}

// ── Test 12: rerunResets cap prevents infinite retry loops ───────────────────

s.section("Test 12: rerunResets cap triggers permanent failure");
{
	const { manager, traces } = makeHarness();

	// Craft a download item that has exhausted retries AND rerunResets
	const item = {
		path: "capped.png",
		hash: "a".repeat(64),
		sizeBytes: 100,
		status: "processing" as const,
		retries: 4, // > MAX_RETRIES (3)
		readyAt: 0,
		needsRerun: true,
		rerunResets: 5, // = MAX_RERUN_RESETS (5)
	};
	manager["attachmentCatalog"].setAttachmentRef(
		item.path,
		item.hash,
		item.sizeBytes,
		"image/png",
	);

	// Mock blobClient to throw
	stubDownload(manager, async () => { throw new Error("always fails"); });

	await manager["processDownload"](item);

	// Item should be permanently failed — not restarted
	s.check(
		!manager["downloadQueue"].has("capped.png"),
		"capped item removed from queue (permanent failure)",
	);
	s.check(
		traces.some((event) =>
			event.msg === "download-permanently-failed" &&
			event.details?.path === "capped.png"
		),
		"permanent failure trace emitted for capped item",
	);
	s.check(
		manager["_permanentDownloadFailures"] === 1,
		"permanent download failure counter incremented",
	);
}

// ── Test 13: rerunResets < cap allows fresh restart ─────────────────────────

s.section("Test 13: rerunResets below cap allows fresh restart");
{
	const { manager, traces } = makeHarness();

	const item = {
		path: "restartable.png",
		hash: "b".repeat(64),
		sizeBytes: 200,
		status: "processing" as "pending" | "processing",
		retries: 4, // > MAX_RETRIES
		readyAt: 0,
		needsRerun: true,
		rerunResets: 3, // < MAX_RERUN_RESETS (5)
	};
	manager["attachmentCatalog"].setAttachmentRef(
		item.path,
		item.hash,
		item.sizeBytes,
		"image/png",
	);

	stubDownload(manager, async () => { throw new Error("temporary"); });

	// Put item in queue so processDownload can find it
	manager["downloadQueue"].set("restartable.png", item);

	await manager["processDownload"](item);

	// Item should be restarted, not permanently failed
	s.check(
		manager["downloadQueue"].has("restartable.png"),
		"restartable item still in queue after rerun reset",
	);
	s.check(item.retries === 0, "retries reset to 0 after rerun");
	s.check(item.rerunResets === 4, "rerunResets incremented");
	s.check(item.status === "pending", "status reset to pending");
	s.check(
		manager["_permanentDownloadFailures"] === 0,
		"no permanent failure for restartable item",
	);
}

// ── Test 14: debug snapshot exposes permanent failure counters ───────────────

s.section("Test 14: debug snapshot includes permanent failure counters");
{
	const { manager } = makeHarness();

	const snapshot = manager.getDebugSnapshot();
	s.check(
		"permanentUploadFailures" in snapshot,
		"debug snapshot has permanentUploadFailures",
	);
	s.check(
		"permanentDownloadFailures" in snapshot,
		"debug snapshot has permanentDownloadFailures",
	);
	s.check(
		"blobConflictArtifacts" in snapshot,
		"debug snapshot has blobConflictArtifacts",
	);
	s.check(
		snapshot.permanentUploadFailures === 0,
		"initial permanent upload failures is 0",
	);
	s.check(
		snapshot.permanentDownloadFailures === 0,
		"initial permanent download failures is 0",
	);
}

// ── Test 15: destroy() during in-flight transfer does not resurrect queue state ──

s.section("Test 15: destroy during in-flight does not resurrect");
{
	const { manager, files, put, traces } = makeHarness();
	put("inflight.png", bytes("data"));
	const remoteData = bytes("remote");
	const remoteHash = await sha256Hex(remoteData);

	let resolveDownload: (() => void) | null = null;
	const downloadPromise = new Promise<void>((resolve) => {
		resolveDownload = resolve;
	});

	stubDownload(manager, async () => {
		// download started — destroy while in flight
		manager.destroy();
		await downloadPromise; // wait until test signals
		return remoteData;
	});

	const item = {
		path: "inflight.png",
		hash: remoteHash,
		sizeBytes: 6,
		status: "processing" as const,
		retries: 0,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	manager["downloadQueue"].set("inflight.png", item);

	// Start processing — it will call blobClient.download which destroys mid-flight
	const processPromise = manager["processDownload"](item);

	// Let the download resolve after destroy
	resolveDownload!();
	await processPromise;

	// After destroy + download resolving, queue should remain empty
	s.check(
		manager["downloadQueue"].size === 0,
		"download queue empty after destroy (not resurrected)",
	);
	s.check(
		manager["uploadQueue"].size === 0,
		"upload queue empty after destroy",
	);
	s.check(
		manager["inflightDownloads"].size === 0,
		"inflight tracking cleared by destroy",
	);

	// Clear any deferred queue work that may have been scheduled after the
	// in-flight operation resolved.
	manager.destroy();
}

// ── Test 16: kickUploadDrain does not start duplicate drain loops ────────────

s.section("Test 16: concurrent kickUploadDrain does not duplicate drain");
{
	const { manager, put, traces } = makeHarness();

	// Force uploadDraining = true to simulate active drain
	manager["uploadDraining"] = true;

	let drainCalled = false;
	const originalDrain = manager["drainUploads"].bind(manager);
	manager["drainUploads"] = async () => {
		drainCalled = true;
		return originalDrain();
	};

	// Kick should be a no-op when already draining
	manager["kickUploadDrain"]();

	s.check(!drainCalled, "drainUploads NOT called when uploadDraining is true");

	// Reset and verify it would call if not draining
	manager["uploadDraining"] = false;
	manager["kickUploadDrain"]();

	// drainUploads should have been called (though it exits immediately with empty queue)
	s.check(drainCalled, "drainUploads called when uploadDraining is false");
}

// ── Test 17: importQueue with rerunResets near cap ──────────────────────────

s.section("Test 17: importQueue preserves rerunResets near cap");
{
	const { manager } = makeHarness();

	// Prevent drain from starting during import (we just want to check state)
	manager["uploadDraining"] = true;
	manager["downloadDraining"] = true;

	const snapshot = {
		uploads: [
			{ path: "near-cap.png", sizeBytes: 100, retries: 2, status: "pending" as const, readyAt: 0, needsRerun: true, rerunResets: 4 },
		],
		downloads: [
			{ path: "at-cap.png", hash: "c".repeat(64), sizeBytes: 200, retries: 3, status: "processing" as const, readyAt: 999, needsRerun: true, rerunResets: 5 },
		],
	};
	manager["attachmentCatalog"].setAttachmentRef(
		"at-cap.png",
		"c".repeat(64),
		200,
		"image/png",
	);

	manager.importQueue(snapshot);

	const uploadItem = manager["uploadQueue"].get("near-cap.png");
	s.check(uploadItem !== undefined, "near-cap upload item imported");
	// The check above proves the entry is present; `!` keeps the field reads terse.
	s.check(uploadItem!.rerunResets === 4, "rerunResets preserved at 4 (near cap)");
	s.check(uploadItem!.needsRerun === true, "needsRerun preserved");
	s.check(uploadItem!.status === "pending", "status normalized to pending on import");
	s.check(uploadItem!.readyAt === 0, "readyAt reset to 0 on import");

	const downloadItem = manager["downloadQueue"].get("at-cap.png");
	s.check(downloadItem !== undefined, "at-cap download item imported");
	// Same reasoning as the upload item above.
	s.check(downloadItem!.rerunResets === 5, "rerunResets preserved at 5 (at cap)");
	s.check(downloadItem!.needsRerun === true, "needsRerun preserved for download");
	s.check(downloadItem!.status === "pending", "download status normalized to pending");
}

// ── Test 18: download conflict artifact does not update target hash cache ────

s.section("Test 18: conflict artifact does not pollute target hash cache");
{
	const { manager, files, put, traces } = makeHarness();
	const existing = put("target.png", bytes("local version"));

	// Seed hash cache for target with known value
	const originalHash = "original-target-hash";
	manager["hashCache"]["target.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: originalHash,
	};

	// Simulate download that creates a conflict artifact
	const remoteData = bytes("remote version");
	const remoteHash = await sha256Hex(remoteData);
	stubDownload(manager, async () => {
		put("target.png", bytes("local changed during download"));
		return remoteData;
	});

	const item = {
		path: "target.png",
		hash: remoteHash,
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
	manager["hashCache"]["target.png"] = {
		mtime: stat.mtime,
		size: stat.size,
		hash: "different-from-remote",
	};

	await manager["processDownload"](item);

	// Verify target hash cache was NOT updated to remote hash
	const targetEntry = manager["hashCache"]["target.png"];
	s.check(
		targetEntry?.hash !== remoteHash,
		"target hash cache NOT updated to remote hash after conflict",
	);
	s.check(
		typeof targetEntry?.hash === "string" && targetEntry.hash.length > 0,
		"target hash cache keeps a local-file hash after conflict",
	);

	manager.destroy();
}

s.section("Test 19: Multi-pass: unknown-baseline preserved blob is NOT re-uploaded by reconcile scan");
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
	const attachmentRefs = new Map<string, BlobRef>([
		["attachments/preserved.png", { hash: "d".repeat(64), size: 100 }],
	]);
	const blobTombstones = new Set(["attachments/preserved.png"]);
	Reflect.set(manager, "attachmentCatalog", {
		listAttachmentRefs: () => attachmentRefs,
		getAttachmentRef: (path: string) => attachmentRefs.get(path),
		isAttachmentTombstoned: (path: string) => blobTombstones.has(path),
		setAttachmentRef: () => { throw new Error("setAttachmentRef should not be called"); },
		deleteAttachmentRef: (path: string) => { blobTombstones.delete(path); },
		renameAttachmentRef: () => {},
		observeAttachmentChanges: () => () => {},
	});

	// Step 2–3: Remote tombstone with unknown baseline
	// Call handleRemoteDelete with knownHash = null
	await manager["handleRemoteDelete"]("attachments/preserved.png", null);

	// Verify: path is in preservedUnresolvedPaths
	s.check(
		manager.preservedUnresolvedPaths.has("attachments/preserved.png"),
		"blob path recorded as preserved-unresolved after unknown-baseline remote-delete",
	);

	// Verify: tombstone was NOT cleared
	s.check(
		blobTombstones.has("attachments/preserved.png"),
		"blob tombstone remains after preserve-unresolved",
	);

	// Step 4: Run reconcile scan
	// Add vault.getFiles() to return the local file
	const localFile = makeFile("attachments/preserved.png", { ctime: 5, mtime: 5, size: 16 });
	const scanFixture = makeVaultFixture();
	scanFixture.vault.getFiles = () => [localFile];
	scanFixture.vault.getAbstractFileByPath = () => localFile;
	manager["app"] = makeApp(scanFixture.vault, {});

	const result = manager.reconcile("authoritative", []);

	// Step 5: Assert file was NOT queued for upload
	s.check(
		result.uploadQueued === 0,
		"preserved-unresolved blob NOT queued for upload by reconcile",
	);
	s.check(
		result.skipped >= 1,
		"preserved-unresolved blob counted as skipped",
	);
	s.check(
		!manager["uploadQueue"].has("attachments/preserved.png"),
		"upload queue does NOT contain preserved-unresolved path",
	);

	// Verify tombstone still present
	s.check(
		blobTombstones.has("attachments/preserved.png"),
		"blob tombstone still present after reconcile",
	);

	// Step 6: Now simulate user explicitly modifying the file (handleFileChange)
	// This should clear the guard and allow future uploads
	manager["preservedUnresolved"].paths.add("attachments/preserved.png"); // re-add for clarity
	const fakeFile = makeFile("attachments/preserved.png", { ctime: 10, mtime: 10, size: 20 });

	// Suppress the debounce timer to avoid async issues
	manager.handleFileChange(fakeFile);
	s.check(
		!manager.preservedUnresolvedPaths.has("attachments/preserved.png"),
		"preserved-unresolved cleared after user modify event (handleFileChange)",
	);

	manager.destroy();
}

s.section("Test 20: Multi-pass: stat-failure during blob remote-delete becomes preserve-unresolved");
{
	const { vault, manager, put, traces } = makeHarness();

	put("attachments/stat-fails.png", bytes("file data"));

	// Override stat to throw
	vault.adapter.stat = async () => { throw new Error("EBUSY"); };

	// Call handleRemoteDelete with a known hash (so it enters the stat path)
	await manager["handleRemoteDelete"]("attachments/stat-fails.png", "6".repeat(64));

	// File should NOT be deleted (check that delete was not called)
	const deleteTrace = traces.find((t) => t.msg === "remote-delete-applied");
	s.check(!deleteTrace, "file NOT deleted when stat fails");

	// Should be preserved-unresolved
	const preserveTrace = traces.find(
		(t) => t.source === "blob" && t.msg === "remote-delete-conflict-preserved" && t.details?.reason === "stat-failed-cannot-verify",
	);
	s.check(!!preserveTrace, "preserve trace emitted with stat-failed reason");
	s.check(
		manager.preservedUnresolvedPaths.has("attachments/stat-fails.png"),
		"blob path recorded as preserved-unresolved after stat failure",
	);
}

s.section("Test 21: processUpload skips preserved-unresolved paths (queue snapshot resurrection guard)");
{
	const { manager, put, traces } = makeHarness();

	put("attachments/zombie.png", bytes("zombie data"));

	// Mark path as preserved-unresolved (simulates prior remote-delete with unknown baseline)
	manager["preservedUnresolved"].paths.add("attachments/zombie.png");

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
	manager["uploadQueue"].set("attachments/zombie.png", item);

	// Process the upload — should be blocked by the guard
	await manager["processUpload"](item);

	// Upload should have been removed from queue without uploading
	s.check(
		!manager["uploadQueue"].has("attachments/zombie.png"),
		"stale upload removed from queue",
	);
	const skipTrace = traces.find(
		(t) => t.source === "blob" && t.msg === "upload-skipped-preserved-unresolved",
	);
	s.check(!!skipTrace, "trace emitted for skipped preserved-unresolved upload");
}

s.section("Test 22: attachment publication failure remains in the upload queue for retry");
{
	const { manager, put } = makeHarness();
	const data = bytes("publication retry");
	const path = "attachments/publication-retry.bin";
	put(path, data);
	const hash = await sha256Hex(data);
	manager["blobClient"].exists = async () => [hash];
	let publicationAttempts = 0;
	manager["attachmentCatalog"].setAttachmentRef = async () => {
		publicationAttempts++;
		if (publicationAttempts === 1) throw new Error("publication unavailable");
	};
	const item = {
		path,
		sizeBytes: data.byteLength,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	manager["uploadQueue"].set(path, item);

	await manager["processUpload"](item);
	s.check(manager["uploadQueue"].has(path), "publication failure leaves the upload queued");
	s.check(item.retries === 1, "publication failure consumes one retry attempt");

	item.readyAt = 0;
	await manager["processUpload"](item);
	s.check(publicationAttempts === 2, "queued upload retries attachment publication");
	s.check(!manager["uploadQueue"].has(path), "successful publication clears the upload queue");
	manager.destroy();
}
await s.done();
