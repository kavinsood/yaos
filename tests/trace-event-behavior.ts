import * as Y from "yjs";
import { TFile } from "obsidian";
import { DiskMirror } from "../src/sync/diskMirror";
import { ServerAckTracker } from "../src/sync/serverAckTracker";
import { InMemoryCandidateStore, type ScopeKey, type ScopeMetadata } from "../src/sync/candidateStore";
import type { TraceEventDetails } from "../src/debug/trace";

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

interface CapturedTrace {
	source: string;
	msg: string;
	details?: TraceEventDetails;
}

function captureTrace(events: CapturedTrace[]) {
	return (source: string, msg: string, details?: TraceEventDetails) => {
		events.push({ source, msg, details });
	};
}

function findEvent(events: CapturedTrace[], source: string, msg: string): CapturedTrace | undefined {
	return events.find((event) => event.source === source && event.msg === msg);
}

const BASE_SCOPE: ScopeKey & ScopeMetadata = {
	vaultIdHash: "vault-hash",
	serverHostHash: "host-hash",
	localDeviceId: "local-device",
	roomName: "raw-room-name-should-not-leak",
	docSchemaVersion: 2,
	pluginVersion: "0.5.0",
	ackStoreVersion: 1,
};

console.log("\n--- Test 1: receipt trace events fire from tracker behavior ---");
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
	assert(!!captured, "local update emits receipt-candidate-captured");
	assert(captured?.details?.candidateBytes !== undefined, "candidate trace includes byte count");
	assert(!!echo, "server echo emits receipt-server-echo");
	assert(echo?.details?.serverDominatesCandidate === true, "echo trace reports domination result");
	assert(echo?.details?.serverAppliedLocalState === true, "echo trace reports tracker state");
}

console.log("\n--- Test 2: receipt startup failure trace does not leak room name ---");
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
	assert(!!failedLoad, "startup load failure emits receipt-startup-load-failed");
	assert(!serialized.includes(BASE_SCOPE.roomName), "startup load failure trace does not include raw room name");
}

function makeSuppressionMirror(
	readContent: () => string,
	events: CapturedTrace[],
): DiskMirror {
	const app = {
		vault: {
			read: async () => readContent(),
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => null,
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
	} as any;
	return new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));
}

console.log("\n--- Test 3: suppression acknowledgement trace fires from observed file state ---");
{
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(() => "expected", events);
	await (mirror as any).suppressWrite("Notes/suppressed.md", "expected");
	const file = new TFile() as TFile & { path: string; stat: { size: number } };
	file.path = "Notes/suppressed.md";
	file.stat = { size: new TextEncoder().encode("expected").length };

	const suppressed = await mirror.shouldSuppressModify(file);
	const acknowledged = findEvent(events, "disk", "suppression-acknowledged");
	assert(suppressed, "matching observed state suppresses self modify event");
	assert(!!acknowledged, "matching observed state emits suppression-acknowledged");
	assert(acknowledged?.details?.path === "Notes/suppressed.md", "suppression trace includes path field for redaction");
}

console.log("\n--- Test 4: suppression mismatch trace fires from changed file state ---");
{
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(() => "changed", events);
	await (mirror as any).suppressWrite("Notes/suppressed.md", "expected");
	const file = new TFile() as TFile & { path: string; stat: { size: number } };
	file.path = "Notes/suppressed.md";
	file.stat = { size: new TextEncoder().encode("changed").length };

	const suppressed = await mirror.shouldSuppressModify(file);
	const mismatch = findEvent(events, "disk", "suppression-mismatch");
	assert(!suppressed, "changed observed state does not suppress modify event");
	assert(!!mismatch, "changed observed state emits suppression-mismatch");
	assert(mismatch?.details?.reason === "size-mismatch", "suppression mismatch includes reason");
}

console.log("\n--- Test 5: diskMirror remote delete emits trace with deleteMode ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];
	const deletedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/remote-deleted.md";
	file.stat = { mtime: 1, size: 10 };

	const fileContent = "content";
	const app = {
		vault: {
			read: async () => fileContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/remote-deleted.md" ? file : null),
			delete: async (f: TFile) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async (f: TFile & { path: string }) => { trashedPaths.push(f.path); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT matches disk content — file is clean, delete should proceed
		getTextForPath: () => ({ toString: () => fileContent }),
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete("Notes/remote-deleted.md");

	const deleteApplied = findEvent(events, "disk", "remote-delete-applied");
	assert(!!deleteApplied, "diskMirror remote delete emits remote-delete-applied trace");
	assert(deleteApplied?.details?.deleteMode === "trash", "diskMirror remote delete reports deleteMode 'trash'");
	assert(trashedPaths.includes("Notes/remote-deleted.md"), "diskMirror remote delete uses trashFile");
	assert(deletedPaths.length === 0, "diskMirror does not hard-delete when trash available");
}

console.log("\n--- Test 6: diskMirror remote delete falls back to hard delete ---");
{
	const events: CapturedTrace[] = [];
	const deletedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/fallback-deleted.md";
	file.stat = { mtime: 1, size: 10 };

	const fileContent = "content";
	const app = {
		vault: {
			read: async () => fileContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/fallback-deleted.md" ? file : null),
			delete: async (f: TFile & { path: string }) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		// No fileManager — trash unavailable
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT matches disk content — file is clean, delete should proceed
		getTextForPath: () => ({ toString: () => fileContent }),
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete("Notes/fallback-deleted.md");

	const deleteApplied = findEvent(events, "disk", "remote-delete-applied");
	assert(!!deleteApplied, "diskMirror fallback delete emits remote-delete-applied trace");
	assert(deleteApplied?.details?.deleteMode === "delete", "diskMirror fallback reports deleteMode 'delete'");
	assert(deletedPaths.includes("Notes/fallback-deleted.md"), "diskMirror falls back to hard delete");
}

console.log("\n--- Test 7: diskMirror remote delete preserves locally modified markdown ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/locally-modified.md";
	file.stat = { mtime: 1, size: 20 };

	const app = {
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
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// Return CRDT content that DIFFERS from disk content
		getTextForPath: () => ({ toString: () => "old CRDT version" }),
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete("Notes/locally-modified.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!preserved, "diskMirror preserves locally modified file");
	assert(preserved?.details?.reason === "local-file-modified-since-last-sync", "trace includes correct reason");
	assert(!deleted, "diskMirror does NOT delete locally modified file");
}

console.log("\n--- Test 8: diskMirror remote delete proceeds when content matches CRDT ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/unchanged.md";
	file.stat = { mtime: 1, size: 10 };

	const matchingContent = "content matches CRDT";
	const app = {
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
			trashFile: async (f: TFile & { path: string }) => { trashedPaths.push(f.path); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// Return CRDT content that MATCHES disk content
		getTextForPath: () => ({ toString: () => matchingContent }),
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete("Notes/unchanged.md");

	const deleted = findEvent(events, "disk", "remote-delete-applied");
	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	assert(!!deleted, "diskMirror deletes file when disk content matches CRDT");
	assert(!preserved, "diskMirror does NOT preserve file when content matches");
	assert(trashedPaths.includes("Notes/unchanged.md"), "diskMirror trashes unmodified file");
}

console.log("\n--- Test 9: diskMirror remote delete preserves when CRDT unavailable ---");
{
	const events: CapturedTrace[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/no-crdt-baseline.md";
	file.stat = { mtime: 1, size: 10 };

	const app = {
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
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// Return null — no CRDT text available
		getTextForPath: () => null,
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete("Notes/no-crdt-baseline.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!preserved, "diskMirror preserves file when CRDT text is unavailable");
	assert(preserved?.details?.reason === "no-crdt-baseline-available", "trace includes no-crdt-baseline reason");
	assert(!deleted, "diskMirror does NOT delete when no CRDT baseline");
}

console.log("\n--- Test 10: diskMirror remote delete suppression fires before delete ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];
	const suppressedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/suppression-test.md";
	file.stat = { mtime: 1, size: 10 };

	const matchingContent = "same content";
	const app = {
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
			trashFile: async (f: TFile & { path: string }) => { trashedPaths.push(f.path); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => ({ toString: () => matchingContent }),
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	// Intercept suppressDelete to verify it fires before delete
	const originalSuppressDelete = (mirror as any).suppressDelete.bind(mirror);
	(mirror as any).suppressDelete = (p: string) => {
		suppressedPaths.push(p);
		return originalSuppressDelete(p);
	};

	await (mirror as any).handleRemoteDelete("Notes/suppression-test.md");

	assert(suppressedPaths.length === 1, "suppressDelete called once");
	assert(suppressedPaths[0] === "Notes/suppression-test.md", "suppressDelete called with correct path");
	assert(trashedPaths.length === 1, "file was trashed");
}

console.log("\n--- Test 11: diskMirror remote delete falls back when trash throws ---");
{
	const events: CapturedTrace[] = [];
	const deletedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/trash-throws.md";
	file.stat = { mtime: 1, size: 10 };

	const matchingContent = "same content";
	const app = {
		vault: {
			read: async () => matchingContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/trash-throws.md" ? file : null),
			delete: async (f: TFile & { path: string }) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			// Trash throws — simulating adapter that doesn't support system trash
			trashFile: async () => { throw new Error("trash not supported"); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => ({ toString: () => matchingContent }),
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete("Notes/trash-throws.md");

	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!deleted, "delete still applied after trash failure");
	assert(deleted?.details?.deleteMode === "delete", "falls back to hard delete");
	assert(deletedPaths.includes("Notes/trash-throws.md"), "vault.delete called");
}

console.log("\n--- Test 12: known-dirty remote delete revives tombstone (no loop) ---");
{
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;
	let ensureFileArgs: { path: string; content: string; reviveTombstone: boolean } | null = null;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/dirty-revive.md";
	file.stat = { mtime: 1, size: 20 };

	const diskContent = "locally edited version";
	const crdtContent = "old CRDT baseline";
	const app = {
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
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT differs from disk — known dirty
		getTextForPath: () => ({ toString: () => crdtContent }),
		isFileMetaDeleted: () => false,
		ensureFile: (path: string, content: string, _device: string, opts: any) => {
			ensureFileCalled = true;
			ensureFileArgs = { path, content, reviveTombstone: opts?.reviveTombstone ?? false };
			return {}; // mock Y.Text
		},
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await (mirror as any).handleRemoteDelete("Notes/dirty-revive.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const revived = findEvent(events, "disk", "remote-delete-preserved-revived");
	assert(!!preserved, "known-dirty file is preserved");
	assert(preserved?.details?.reason === "local-file-modified-since-last-sync", "reason is known-dirty");
	assert(!!revived, "tombstone is revived for known-dirty file");
	assert(ensureFileCalled, "ensureFile was called to revive");
	assert(ensureFileArgs?.reviveTombstone === true, "reviveTombstone: true passed");
	assert(ensureFileArgs?.content === diskContent, "disk content used for revive");
}

console.log("\n--- Test 13: unknown-baseline remote delete does NOT revive tombstone ---");
{
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/unknown-baseline.md";
	file.stat = { mtime: 1, size: 10 };

	const app = {
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
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT unavailable — unknown baseline
		getTextForPath: () => null,
		isFileMetaDeleted: () => false,
		ensureFile: () => {
			ensureFileCalled = true;
			return {};
		},
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await (mirror as any).handleRemoteDelete("Notes/unknown-baseline.md");

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const revived = findEvent(events, "disk", "remote-delete-preserved-revived");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!preserved, "unknown-baseline file is preserved");
	assert(preserved?.details?.reason === "no-crdt-baseline-available", "reason is no-baseline");
	assert(!revived, "tombstone is NOT revived for unknown-baseline");
	assert(!deleted, "file is NOT deleted");
	assert(!ensureFileCalled, "ensureFile is NOT called — no auto-resurrection");
}

console.log("\n--- Test 5: Multi-pass: unknown-baseline preserved file is NOT revived by importUntrackedFiles ---");
{
	// This is the critical system-level test demanded by all three reviewers.
	// Scenario:
	// 1. Local file exists.
	// 2. Remote tombstone arrives with no CRDT baseline.
	// 3. Handler preserves file as unresolved (does NOT revive).
	// 4. importUntrackedFiles() runs on next reconciliation pass.
	// 5. Assert: file is NOT revived, tombstone remains, ensureFile NOT called.

	const { ReconciliationController } = await import("../src/runtime/reconciliationController");
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/unknown-baseline.md";
	(file as any).stat = { mtime: 1, size: 10 };

	// --- Step 1: Set up DiskMirror and trigger preserve-unresolved ---
	const app = {
		vault: {
			read: async () => "some content on disk",
			getAbstractFileByPath: (path: string) => (path === "Notes/unknown-baseline.md" ? file : null),
			delete: async () => { throw new Error("should not delete"); },
			adapter: { stat: async () => ({ mtime: 1, size: 10 }) },
		},
		workspace: {
			getActiveViewOfType: () => null,
			iterateAllLeaves: () => {},
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash"); },
		},
	} as any;

	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT unavailable — unknown baseline
		getTextForPath: () => null,
		isFileMetaDeleted: () => false,
		isInitialized: true,
		markInitialized: () => {},
		ensureFile: () => {
			ensureFileCalled = true;
			return {};
		},
		getActiveMarkdownPaths: () => [],
	} as any;

	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;

	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	// Step 2: Remote tombstone arrives — no CRDT baseline
	await (mirror as any).handleRemoteDelete("Notes/unknown-baseline.md");

	// Verify: path is now in preserved-unresolved set
	assert(
		mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path recorded in preservedUnresolvedPaths after remote-delete with unknown baseline",
	);
	assert(!ensureFileCalled, "ensureFile NOT called during initial remote-delete");

	// --- Step 3: Set up ReconciliationController and run importUntrackedFiles ---
	const controller = new ReconciliationController({
		app,
		getSettings: () => ({ deviceName: "TestDevice" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
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
	(controller as any).untrackedFiles = ["Notes/unknown-baseline.md"];

	// Step 4: Run importUntrackedFiles — the next reconciliation pass
	await (controller as any).importUntrackedFiles();

	// Step 5: Assert no resurrection
	assert(!ensureFileCalled, "ensureFile NOT called by importUntrackedFiles (preserved-unresolved guard)");
	assert(
		mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path remains in preservedUnresolvedPaths (not auto-cleared)",
	);
	const skipTrace = events.find(
		(e) => e.source === "reconcile" && e.msg === "import-untracked-skipped-preserved-unresolved",
	);
	assert(!!skipTrace, "trace emitted for skipped preserved-unresolved import");

	// Step 6: Simulate user explicitly modifying the file → clears the guard
	mirror.clearPreservedUnresolved("Notes/unknown-baseline.md");
	assert(
		!mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path cleared from preservedUnresolvedPaths after user action",
	);

	// Now importUntrackedFiles WOULD call ensureFile (proving the guard was the only blocker)
	(controller as any).untrackedFiles = ["Notes/unknown-baseline.md"];
	await (controller as any).importUntrackedFiles();
	assert(ensureFileCalled, "ensureFile IS called after preserved-unresolved guard is cleared");
}

console.log("\n--- Test 6: Multi-pass: read-failure during remote-delete becomes preserve-unresolved (not apply-delete) ---");
{
	const events: CapturedTrace[] = [];
	let fileTrashed = false;
	let fileDeleted = false;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/read-fails.md";
	file.stat = { mtime: 1, size: 10 };

	const app = {
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
	} as any;

	const ytext = { toString: () => "known baseline content" };
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT HAS a baseline — but read will fail
		getTextForPath: () => ytext,
		isFileMetaDeleted: () => false,
		ensureFile: () => null,
	} as any;
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await (mirror as any).handleRemoteDelete("Notes/read-fails.md");

	// File should NOT be deleted or trashed
	assert(!fileDeleted, "file NOT deleted when read fails");
	assert(!fileTrashed, "file NOT trashed when read fails");

	// Should be preserved-unresolved
	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	assert(!!preserved, "preserve trace emitted");
	assert(preserved?.details?.reason === "read-failed-cannot-verify", "reason is read-failed");

	// Path should be in preserved-unresolved set
	assert(
		mirror.preservedUnresolvedPaths.has("Notes/read-fails.md"),
		"path recorded as preserved-unresolved after read failure",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
