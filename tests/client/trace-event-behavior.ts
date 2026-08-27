import * as Y from "yjs";
import {
	TFile,
	type App,
	type DataAdapter,
	type FileManager,
	type FileStats,
	type Stat,
	type TAbstractFile,
	type Vault,
	type Workspace,
} from "obsidian";
import { DiskMirror } from "../../src/sync/diskMirror";
import { ServerAckTracker } from "../../src/sync/serverAckTracker";
import type { ScopeKey, ScopeMetadata } from "../../src/sync/candidateStore";
import { InMemoryCandidateStore } from "./helpers/inMemoryCandidateStore";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSyncSettings } from "../../src/settings/settingsStore";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import type { TraceEventDetails, TraceRecord } from "../../src/observability/traceContext";
import { suite } from "../harness.ts";

const s = suite("trace-event-behavior");

interface CapturedTrace {
	source: string;
	msg: string;
	details?: TraceEventDetails;
}

// Declared as the product's own TraceRecord: if the trace callback signature
// changes, this fixture stops compiling instead of quietly diverging.
function captureTrace(events: CapturedTrace[]): TraceRecord {
	return (source, msg, details) => {
		events.push({ source, msg, details });
	};
}

function findEvent(events: CapturedTrace[], source: string, msg: string): CapturedTrace | undefined {
	return events.find((event) => event.source === source && event.msg === msg);
}

function makeFile(path: string, stat: FileStats): TFile {
	const file = new TFile();
	file.path = path;
	file.stat = stat;
	return file;
}

/**
 * Fixture doubles are typed against the REAL product types instead of `any`.
 * Every `parts` argument is a `Partial<…>` of the genuine interface, so each
 * mocked member is checked against the product's declared signature and this
 * suite fails to compile — rather than silently passing — if that signature
 * changes. The single widening cast inside each helper is the one place where
 * "the members this test exercises" becomes "the whole interface".
 */
type VaultParts = Partial<Omit<Vault, "adapter">> & { adapter?: Partial<DataAdapter> };

/**
 * Obsidian declares `trashFile(file)` with one parameter; DiskMirror calls it
 * as `trashFile(file, true)`. The fixture mirrors the product's call shape.
 */
type FileManagerParts = Partial<Omit<FileManager, "trashFile">> & {
	trashFile?: (file: TAbstractFile, system?: boolean) => Promise<void>;
};

function makeApp(parts: {
	vault: VaultParts;
	workspace?: Partial<Workspace>;
	/** Omitted entirely by tests that need the no-trash-channel fallback. */
	fileManager?: FileManagerParts;
}): App {
	return {
		vault: parts.vault as Vault,
		workspace: (parts.workspace ?? {}) as Workspace,
		fileManager: parts.fileManager as FileManager | undefined,
	} as App;
}

/**
 * The CRDT surface these paths read is `getTextForPath` / `ensureFile`. The
 * structural fields DiskMirror only touches from `attach()` are backed by a
 * real Y.Doc, so they carry the product's declared Y types.
 */
function makeVaultSync(parts: Partial<VaultSync>): VaultSync {
	const doc = new Y.Doc();
	return {
		ydoc: doc,
		meta: doc.getMap<unknown>("meta"),
		idToText: doc.getMap<Y.Text>("idToText"),
		getFileIdForText: () => undefined,
		isFileMetaDeleted: () => false,
		...parts,
	} as VaultSync;
}

function makeEditorBindings(parts: Partial<EditorBindingManager>): EditorBindingManager {
	return parts as EditorBindingManager;
}

/**
 * A real Y.Text carrying `content`. handleRemoteDelete compares
 * `getTextForPath(path)?.toString()` against disk, so the CRDT baseline has to
 * be a genuine Y.Text and not a `{ toString }` shim the compiler cannot check.
 */
function makeCrdtText(content: string): Y.Text {
	const text = new Y.Doc().getText("content");
	if (content) text.insert(0, content);
	return text;
}

const BASE_SCOPE: ScopeKey & ScopeMetadata = {
	vaultIdHash: "vault-hash",
	serverHostHash: "host-hash",
	localDeviceId: "local-device",
	roomName: "raw-room-name-should-not-leak",
	roomGeneration: 1,
	docSchemaVersion: 2,
	pluginVersion: "0.5.0",
	ackStoreVersion: 2,
};

s.section("Test 1: receipt trace events fire from tracker behavior");
{
	const events: CapturedTrace[] = [];
	const doc = new Y.Doc({ gc: false });
	const provider = { kind: "provider" };
	const tracker = new ServerAckTracker(captureTrace(events));
	tracker.attach(doc, () => Y.encodeStateVector(doc), provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	doc.getText("note").insert(0, "hello");
	tracker.recordServerSvEcho(Y.encodeStateVector(doc));

	const captured = findEvent(events, "receipt", "receipt-candidate-captured");
	const echo = findEvent(events, "receipt", "receipt-server-echo");
	s.check(!!captured, "local update emits receipt-candidate-captured");
	s.check(captured?.details?.candidateBytes !== undefined, "candidate trace includes byte count");
	s.check(!!echo, "server echo emits receipt-server-echo");
	s.check(echo?.details?.serverDominatesCandidate === true, "echo trace reports domination result");
	s.check(echo?.details?.serverAppliedLocalState === true, "echo trace reports tracker state");
}

s.section("Test 2: receipt startup failure trace does not leak room name");
{
	const events: CapturedTrace[] = [];
	const tracker = new ServerAckTracker(captureTrace(events));
	await tracker.onStartup({
		async load() {
			throw new Error("load failed");
		},
		async save() {},
		async clear() {},
	}, BASE_SCOPE);

	const failedLoad = findEvent(events, "receipt", "receipt-startup-load-failed");
	const serialized = JSON.stringify(failedLoad);
	s.check(!!failedLoad, "startup load failure emits receipt-startup-load-failed");
	s.check(!serialized.includes(BASE_SCOPE.roomName), "startup load failure trace does not include raw room name");
}

function makeSuppressionMirror(
	readContent: () => string,
	events: CapturedTrace[],
): DiskMirror {
	const app = makeApp({
		vault: {
			read: async () => readContent(),
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {},
	});
	const vaultSync = makeVaultSync({
		getTextForPath: () => null,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
	});
	return new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));
}

s.section("Test 3: suppression acknowledgement trace fires from observed file state");
{
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(() => "expected", events);
	await mirror["suppressWrite"]("Notes/suppressed.md", "expected");
	const file = makeFile("Notes/suppressed.md", {
		ctime: 1,
		mtime: 1,
		size: new TextEncoder().encode("expected").length,
	});

	const suppressed = await mirror.shouldSuppressModify(file);
	const acknowledged = findEvent(events, "disk", "suppression-acknowledged");
	s.check(suppressed, "matching observed state suppresses self modify event");
	s.check(!!acknowledged, "matching observed state emits suppression-acknowledged");
	s.check(acknowledged?.details?.path === "Notes/suppressed.md", "suppression trace includes path field for redaction");
}

s.section("Test 4: suppression mismatch trace fires from changed file state");
{
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(() => "changed", events);
	await mirror["suppressWrite"]("Notes/suppressed.md", "expected");
	const file = makeFile("Notes/suppressed.md", {
		ctime: 1,
		mtime: 1,
		size: new TextEncoder().encode("changed").length,
	});

	const suppressed = await mirror.shouldSuppressModify(file);
	const mismatch = findEvent(events, "disk", "suppression-mismatch");
	s.check(!suppressed, "changed observed state does not suppress modify event");
	s.check(!!mismatch, "changed observed state emits suppression-mismatch");
	s.check(mismatch?.details?.reason === "size-mismatch", "suppression mismatch includes reason");
}

s.section("Test 5: diskMirror remote delete emits trace with deleteMode");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];
	const deletedPaths: string[] = [];

	const file = makeFile("Notes/remote-deleted.md", { ctime: 1, mtime: 1, size: 10 });

	const fileContent = "content";
	const crdtText = makeCrdtText(fileContent);
	const app = makeApp({
		vault: {
			read: async () => fileContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/remote-deleted.md" ? file : null),
			delete: async (f: TAbstractFile) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async (f: TAbstractFile) => { trashedPaths.push(f.path); },
		},
	});
	const vaultSync = makeVaultSync({
		// CRDT matches disk content — file is clean, delete should proceed
		getTextForPath: () => crdtText,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await mirror["handleRemoteDelete"]("Notes/remote-deleted.md");

	const deleteApplied = findEvent(events, "disk", "remote-delete-applied");
	s.check(!!deleteApplied, "diskMirror remote delete emits remote-delete-applied trace");
	s.check(deleteApplied?.details?.deleteMode === "trash", "diskMirror remote delete reports deleteMode 'trash'");
	s.check(trashedPaths.includes("Notes/remote-deleted.md"), "diskMirror remote delete uses trashFile");
	s.check(deletedPaths.length === 0, "diskMirror does not hard-delete when trash available");
}

s.section("Test 6: diskMirror never hard-deletes when trash is unavailable");
{
	const events: CapturedTrace[] = [];
	const deletedPaths: string[] = [];

	const file = makeFile("Notes/fallback-deleted.md", { ctime: 1, mtime: 1, size: 10 });
	const fileContent = "content";
	const crdtText = makeCrdtText(fileContent);
	const app = makeApp({
		vault: {
			read: async () => fileContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/fallback-deleted.md" ? file : null),
			delete: async (f: TAbstractFile) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
	});
	const vaultSync = makeVaultSync({
		getTextForPath: () => crdtText,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await mirror["handleRemoteDelete"]("Notes/fallback-deleted.md");

	const deleteApplied = findEvent(events, "disk", "remote-delete-applied");
	s.check(!deleteApplied, "failed trash does not emit remote-delete-applied");
	s.check(deletedPaths.length === 0, "diskMirror never falls back to hard delete");
}

s.section("Test 7: diskMirror remote delete preserves locally modified markdown");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];

	const file = makeFile("Notes/locally-modified.md", { ctime: 1, mtime: 1, size: 20 });
	const crdtText = makeCrdtText("old CRDT version");

	const app = makeApp({
		vault: {
			read: async () => "locally edited version",
			getAbstractFileByPath: (path: string) => (path === "Notes/locally-modified.md" ? file : null),
			delete: async () => { throw new Error("should not delete locally modified file"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash locally modified file"); },
		},
	});
	const vaultSync = makeVaultSync({
		// Return CRDT content that DIFFERS from disk content
		getTextForPath: () => crdtText,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await mirror["handleRemoteDelete"]("Notes/locally-modified.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	s.check(!!preserved, "diskMirror preserves locally modified file");
	s.check(preserved?.details?.reason === "local-file-modified-since-last-sync", "trace includes correct reason");
	s.check(!deleted, "diskMirror does NOT delete locally modified file");
}

s.section("Test 8: diskMirror remote delete proceeds when content matches CRDT");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];

	const file = makeFile("Notes/unchanged.md", { ctime: 1, mtime: 1, size: 10 });

	const matchingContent = "content matches CRDT";
	const crdtText = makeCrdtText(matchingContent);
	const app = makeApp({
		vault: {
			read: async () => matchingContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/unchanged.md" ? file : null),
			delete: async () => {},
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async (f: TAbstractFile) => { trashedPaths.push(f.path); },
		},
	});
	const vaultSync = makeVaultSync({
		// Return CRDT content that MATCHES disk content
		getTextForPath: () => crdtText,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await mirror["handleRemoteDelete"]("Notes/unchanged.md");

	const deleted = findEvent(events, "disk", "remote-delete-applied");
	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	s.check(!!deleted, "diskMirror deletes file when disk content matches CRDT");
	s.check(!preserved, "diskMirror does NOT preserve file when content matches");
	s.check(trashedPaths.includes("Notes/unchanged.md"), "diskMirror trashes unmodified file");
}

s.section("Test 9: diskMirror remote delete preserves when CRDT unavailable");
{
	const events: CapturedTrace[] = [];

	const file = makeFile("Notes/no-crdt-baseline.md", { ctime: 1, mtime: 1, size: 10 });

	const app = makeApp({
		vault: {
			read: async () => "some local content",
			getAbstractFileByPath: (path: string) => (path === "Notes/no-crdt-baseline.md" ? file : null),
			delete: async () => { throw new Error("should not delete when CRDT unavailable"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash when CRDT unavailable"); },
		},
	});
	const vaultSync = makeVaultSync({
		// Return null — no CRDT text available
		getTextForPath: () => null,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await mirror["handleRemoteDelete"]("Notes/no-crdt-baseline.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	s.check(!!preserved, "diskMirror preserves file when CRDT text is unavailable");
	s.check(preserved?.details?.reason === "no-crdt-baseline-available", "trace includes no-crdt-baseline reason");
	s.check(!deleted, "diskMirror does NOT delete when no CRDT baseline");
}

s.section("Test 10: diskMirror remote delete suppression fires before delete");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];
	const suppressedPaths: string[] = [];

	const file = makeFile("Notes/suppression-test.md", { ctime: 1, mtime: 1, size: 10 });

	const matchingContent = "same content";
	const crdtText = makeCrdtText(matchingContent);
	const app = makeApp({
		vault: {
			read: async () => matchingContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/suppression-test.md" ? file : null),
			delete: async () => {},
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async (f: TAbstractFile) => { trashedPaths.push(f.path); },
		},
	});
	const vaultSync = makeVaultSync({
		getTextForPath: () => crdtText,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	// Intercept suppressDelete to verify it fires before delete
	const originalSuppressDelete = mirror["suppressDelete"].bind(mirror);
	mirror["suppressDelete"] = (p: string) => {
		suppressedPaths.push(p);
		return originalSuppressDelete(p);
	};

	await mirror["handleRemoteDelete"]("Notes/suppression-test.md");

	s.check(suppressedPaths.length === 1, "suppressDelete called once");
	s.check(suppressedPaths[0] === "Notes/suppression-test.md", "suppressDelete called with correct path");
	s.check(trashedPaths.length === 1, "file was trashed");
}

s.section("Test 11: diskMirror preserves the file when trash throws");
{
	const events: CapturedTrace[] = [];
	const deletedPaths: string[] = [];

	const file = makeFile("Notes/trash-throws.md", { ctime: 1, mtime: 1, size: 10 });
	const matchingContent = "same content";
	const crdtText = makeCrdtText(matchingContent);
	const app = makeApp({
		vault: {
			read: async () => matchingContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/trash-throws.md" ? file : null),
			delete: async (f: TAbstractFile) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("trash not supported"); },
		},
	});
	const vaultSync = makeVaultSync({
		getTextForPath: () => crdtText,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await mirror["handleRemoteDelete"]("Notes/trash-throws.md");

	const deleted = findEvent(events, "disk", "remote-delete-applied");
	s.check(!deleted, "trash failure does not emit remote-delete-applied");
	s.check(deletedPaths.length === 0, "trash failure never falls back to vault.delete");
}

s.section("Test 12: known-dirty remote delete revives tombstone (no loop)");
{
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;
	// ensureFile's declared return type is Y.Text | null. A real, truthy Y.Text
	// keeps every caller branch identical to the previous `{}` stub.
	const revivedText = makeCrdtText("revived");
	const ensureFileCalls: Array<{ path: string; content: string; reviveTombstone: boolean }> = [];

	const file = makeFile("Notes/dirty-revive.md", { ctime: 1, mtime: 1, size: 20 });

	const diskContent = "locally edited version";
	const crdtContent = "old CRDT baseline";
	const crdtText = makeCrdtText(crdtContent);
	const app = makeApp({
		vault: {
			read: async () => diskContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/dirty-revive.md" ? file : null),
			delete: async () => { throw new Error("should not delete"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash"); },
		},
	});
	const vaultSync = makeVaultSync({
		// CRDT differs from disk — known dirty
		getTextForPath: () => crdtText,
		ensureFile: (path: string, content: string, _device?: string, opts?: { reviveTombstone?: boolean }) => {
			ensureFileCalled = true;
			ensureFileCalls.push({ path, content, reviveTombstone: opts?.reviveTombstone ?? false });
			return revivedText;
		},
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await mirror["handleRemoteDelete"]("Notes/dirty-revive.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const revived = findEvent(events, "disk", "remote-delete-preserved-revived");
	s.check(!!preserved, "known-dirty file is preserved");
	s.check(preserved?.details?.reason === "local-file-modified-since-last-sync", "reason is known-dirty");
	s.check(!!revived, "tombstone is revived for known-dirty file");
	s.check(ensureFileCalled, "ensureFile was called to revive");
	s.check(ensureFileCalls.at(-1)?.reviveTombstone === true, "reviveTombstone: true passed");
	s.check(ensureFileCalls.at(-1)?.content === diskContent, "disk content used for revive");
}

s.section("Test 13: unknown-baseline remote delete does NOT revive tombstone");
{
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;
	// ensureFile's declared return type is Y.Text | null. A real, truthy Y.Text
	// keeps every caller branch identical to the previous `{}` stub.
	const revivedText = makeCrdtText("revived");

	const file = makeFile("Notes/unknown-baseline.md", { ctime: 1, mtime: 1, size: 10 });

	const app = makeApp({
		vault: {
			read: async () => "some content on disk",
			getAbstractFileByPath: (path: string) => (path === "Notes/unknown-baseline.md" ? file : null),
			delete: async () => { throw new Error("should not delete"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash"); },
		},
	});
	const vaultSync = makeVaultSync({
		// CRDT unavailable — unknown baseline
		getTextForPath: () => null,
		ensureFile: () => {
			ensureFileCalled = true;
			return revivedText;
		},
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await mirror["handleRemoteDelete"]("Notes/unknown-baseline.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const revived = findEvent(events, "disk", "remote-delete-preserved-revived");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	s.check(!!preserved, "unknown-baseline file is preserved");
	s.check(preserved?.details?.reason === "no-crdt-baseline-available", "reason is no-baseline");
	s.check(!revived, "tombstone is NOT revived for unknown-baseline");
	s.check(!deleted, "file is NOT deleted");
	s.check(!ensureFileCalled, "ensureFile is NOT called — no auto-resurrection");
}

s.section("Test 5: Multi-pass: unknown-baseline preserved file is NOT revived by importUntrackedFiles");
{
	// This is the critical system-level test demanded by all three reviewers.
	// Scenario:
	// 1. Local file exists.
	// 2. Remote tombstone arrives with no CRDT baseline.
	// 3. Handler preserves file as unresolved (does NOT revive).
	// 4. importUntrackedFiles() runs on next reconciliation pass.
	// 5. Assert: file is NOT revived, tombstone remains, ensureFile NOT called.

	const { ReconciliationController } = await import("../../src/runtime/reconciliationController");
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;
	// ensureFile's declared return type is Y.Text | null. A real, truthy Y.Text
	// keeps every caller branch identical to the previous `{}` stub.
	const revivedText = makeCrdtText("revived");

	const file = makeFile("Notes/unknown-baseline.md", { ctime: 1, mtime: 1, size: 10 });

	// --- Step 1: Set up DiskMirror and trigger preserve-unresolved ---
	const app = makeApp({
		vault: {
			read: async () => "some content on disk",
			getAbstractFileByPath: (path: string) => (path === "Notes/unknown-baseline.md" ? file : null),
			delete: async () => { throw new Error("should not delete"); },
			adapter: { stat: async (): Promise<Stat> => ({ type: "file", ctime: 1, mtime: 1, size: 10 }) },
		},
		workspace: {
			getActiveViewOfType: () => null,
			iterateAllLeaves: () => {},
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash"); },
		},
	});

	const vaultSync = makeVaultSync({
		// CRDT unavailable — unknown baseline
		getTextForPath: () => null,
		isInitialized: true,
		markInitialized: () => {},
		ensureFile: () => {
			ensureFileCalled = true;
			return revivedText;
		},
		getActiveMarkdownPaths: () => [],
	});

	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});

	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	// Step 2: Remote tombstone arrives — no CRDT baseline
	await mirror["handleRemoteDelete"]("Notes/unknown-baseline.md");

	// Verify: path is now in preserved-unresolved set
	s.check(
		mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path recorded in preservedUnresolvedPaths after remote-delete with unknown baseline",
	);
	s.check(!ensureFileCalled, "ensureFile NOT called during initial remote-delete");

	// --- Step 3: Set up ReconciliationController and run importUntrackedFiles ---
	const controller = new ReconciliationController({
		app,
		getSettings: () => ({ deviceName: "TestDevice" }) as VaultSyncSettings,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [] as string[],
			externalEditPolicy: "always",
		}) as RuntimeConfig,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => mirror,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: captureTrace(events),
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// Inject the preserved file as "untracked" — simulates reconciliation
	// discovering the file on disk with no CRDT entry
	controller["untrackedFiles"] = ["Notes/unknown-baseline.md"];

	// Step 4: Run importUntrackedFiles — the next reconciliation pass
	await controller.importUntrackedFiles();

	// Step 5: Assert no resurrection
	s.check(!ensureFileCalled, "ensureFile NOT called by importUntrackedFiles (preserved-unresolved guard)");
	s.check(
		mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path remains in preservedUnresolvedPaths (not auto-cleared)",
	);
	const skipTrace = events.find(
		(e) => e.source === "reconcile" && e.msg === "import-untracked-skipped-preserved-unresolved",
	);
	s.check(!!skipTrace, "trace emitted for skipped preserved-unresolved import");

	// Step 6: Simulate user explicitly modifying the file → clears the guard
	mirror.clearPreservedUnresolved("Notes/unknown-baseline.md");
	s.check(
		!mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path cleared from preservedUnresolvedPaths after user action",
	);

	// Now importUntrackedFiles WOULD call ensureFile (proving the guard was the only blocker)
	controller["untrackedFiles"] = ["Notes/unknown-baseline.md"];
	await controller.importUntrackedFiles();
	s.check(ensureFileCalled, "ensureFile IS called after preserved-unresolved guard is cleared");
}

s.section("Test 6: Multi-pass: read-failure during remote-delete becomes preserve-unresolved (not apply-delete)");
{
	const events: CapturedTrace[] = [];
	let fileTrashed = false;
	let fileDeleted = false;

	const file = makeFile("Notes/read-fails.md", { ctime: 1, mtime: 1, size: 10 });

	const app = makeApp({
		vault: {
			// Read throws — simulates locked/busy file
			read: async () => { throw new Error("EBUSY: file is locked"); },
			getAbstractFileByPath: (path: string) => (path === "Notes/read-fails.md" ? file : null),
			delete: async () => { fileDeleted = true; },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { fileTrashed = true; },
		},
	});

	const ytext = makeCrdtText("known baseline content");
	const vaultSync = makeVaultSync({
		// CRDT HAS a baseline — but read will fail
		getTextForPath: () => ytext,
		ensureFile: () => null,
	});
	const editorBindings = makeEditorBindings({
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	});
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await mirror["handleRemoteDelete"]("Notes/read-fails.md");

	// File should NOT be deleted or trashed
	s.check(!fileDeleted, "file NOT deleted when read fails");
	s.check(!fileTrashed, "file NOT trashed when read fails");

	// Should be preserved-unresolved
	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	s.check(!!preserved, "preserve trace emitted");
	s.check(preserved?.details?.reason === "read-failed-cannot-verify", "reason is read-failed");

	// Path should be in preserved-unresolved set
	s.check(
		mirror.preservedUnresolvedPaths.has("Notes/read-fails.md"),
		"path recorded as preserved-unresolved after read failure",
	);
}
await s.done();
