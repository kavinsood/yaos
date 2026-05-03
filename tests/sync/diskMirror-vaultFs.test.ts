import test from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import * as Y from "yjs";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { FakeVaultFs, ObsidianVaultFs, VaultFsError } from "../../src/sync/vaultFs";
import type { FileMeta } from "../../src/types";

const encoder = new TextEncoder();

class FakeVaultSync {
	readonly ydoc = new Y.Doc();
	readonly pathToId = this.ydoc.getMap<string>("pathToId");
	readonly idToText = this.ydoc.getMap<Y.Text>("idToText");
	readonly meta = this.ydoc.getMap<FileMeta>("meta");
	readonly provider = { name: "fake-provider" };

	private readonly textToFileId = new WeakMap<Y.Text, string>();
	private nextId = 1;

	setText(path: string, content: string): Y.Text {
		let fileId = this.pathToId.get(path);
		if (!fileId) {
			fileId = `file-${this.nextId++}`;
			this.pathToId.set(path, fileId);
		}
		const ytext = new Y.Text();
		ytext.insert(0, content);
		this.idToText.set(fileId, ytext);
		this.meta.set(fileId, { path, mtime: Date.now() });
		this.textToFileId.set(ytext, fileId);
		return ytext;
	}

	getTextForPath(path: string): Y.Text | null {
		const fileId = this.pathToId.get(path);
		if (!fileId) return null;
		const text = this.idToText.get(fileId) ?? null;
		if (text) this.textToFileId.set(text, fileId);
		return text;
	}

	getFileIdForText(ytext: Y.Text): string | undefined {
		return this.textToFileId.get(ytext);
	}

	isFileMetaDeleted(meta: FileMeta | undefined): boolean {
		return !!meta && (meta.deleted === true || typeof meta.deletedAt === "number");
	}
}

interface Harness {
	vaultFs: FakeVaultFs;
	vaultSync: FakeVaultSync;
	mirror: DiskMirror;
	editorRenames: Array<Map<string, string>>;
}

function createHarness(
	diskFiles: Record<string, string> = {},
	crdtFiles: Record<string, string> = {},
	frontmatterGuardEnabled = true,
): Harness {
	const vaultFs = new FakeVaultFs(diskFiles);
	const vaultSync = new FakeVaultSync();
	for (const [path, content] of Object.entries(crdtFiles)) {
		vaultSync.setText(vaultFs.normalize(path), content);
	}
	const app = {
		workspace: {
			getActiveViewOfType: () => null,
		},
	} as unknown as App;
	const editorRenames: Array<Map<string, string>> = [];
	const editorBindings = {
		getLastEditorActivityForPath: () => null,
		unbindByPath: () => undefined,
		updatePathsAfterRename: (renames: Map<string, string>) => {
			editorRenames.push(renames);
		},
	} as unknown as EditorBindingManager;
	const mirror = new DiskMirror(
		app,
		vaultFs,
		vaultSync as unknown as VaultSync,
		editorBindings,
		false,
		undefined,
		() => frontmatterGuardEnabled,
	);
	return { vaultFs, vaultSync, mirror, editorRenames };
}

function tFile(path: string, content: string): TFile {
	const size = encoder.encode(content).byteLength;
	return {
		path,
		stat: { size, mtime: Date.now(), ctime: Date.now() },
	} as TFile;
}

async function handleRemoteDelete(mirror: DiskMirror, path: string): Promise<void> {
	await (mirror as unknown as { handleRemoteDelete(path: string): Promise<void> })
		.handleRemoteDelete(path);
}

async function handleRemoteRename(mirror: DiskMirror, oldPath: string, newPath: string): Promise<void> {
	await (mirror as unknown as { handleRemoteRename(oldPath: string, newPath: string): Promise<void> })
		.handleRemoteRename(oldPath, newPath);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertVaultFsError(err: unknown, code: string): boolean {
	return err instanceof VaultFsError && err.code === code;
}

test("VaultFs adapters share path normalization and reject dot segments", async () => {
	const adapters = [
		new FakeVaultFs(),
		new ObsidianVaultFs({} as App),
	];
	const cases: Array<[string, string]> = [
		["Cafe\u0301.md", "Café.md"],
		["./folder//note.md", "folder/note.md"],
		["/folder/note.md/", "folder/note.md"],
		["folder\\sub\\note.md", "folder/sub/note.md"],
		["", ""],
		["folder/.hidden.md", "folder/.hidden.md"],
	];

	for (const adapter of adapters) {
		for (const [input, expected] of cases) {
			assert.equal(adapter.normalize(input), expected);
		}
	}

	for (const adapter of adapters) {
		await assert.rejects(
			() => adapter.readText("folder/./note.md"),
			(err) => assertVaultFsError(err, "traversal"),
		);
		await assert.rejects(
			() => adapter.writeText("folder/../note.md", "unsafe"),
			(err) => assertVaultFsError(err, "traversal"),
		);
	}

	const fakeVaultFs = new FakeVaultFs({ dir: "not a folder" });
	await assert.rejects(
		() => fakeVaultFs.writeText("dir/note.md", "content"),
		(err) => assertVaultFsError(err, "target_exists"),
	);
});

test("DiskMirror creates a missing markdown file through VaultFs", async (t) => {
	const h = createHarness({}, { "note.md": "new content" });
	t.after(() => h.mirror.destroy());

	await h.mirror.flushWrite("note.md");

	assert.deepEqual(h.vaultFs.snapshot(), { "note.md": "new content" });
	assert.deepEqual(h.vaultFs.writes, [{ path: "note.md", content: "new content" }]);
});

test("DiskMirror updates an existing markdown file through VaultFs", async (t) => {
	const h = createHarness({ "note.md": "old content" }, { "note.md": "new content" });
	t.after(() => h.mirror.destroy());

	await h.mirror.flushWrite("note.md");

	assert.deepEqual(h.vaultFs.snapshot(), { "note.md": "new content" });
	assert.deepEqual(h.vaultFs.writes, [{ path: "note.md", content: "new content" }]);
});

test("DiskMirror deletes remote tombstones through VaultFs", async (t) => {
	const h = createHarness({ "note.md": "old content" });
	t.after(() => h.mirror.destroy());

	await handleRemoteDelete(h.mirror, "note.md");

	assert.deepEqual(h.vaultFs.snapshot(), {});
	assert.deepEqual(h.vaultFs.deletes, ["note.md"]);
});

test("DiskMirror renames remote moves through VaultFs", async (t) => {
	const h = createHarness({ "old.md": "old content" }, { "new.md": "old content" });
	t.after(() => h.mirror.destroy());

	await handleRemoteRename(h.mirror, "old.md", "new.md");

	assert.deepEqual(h.vaultFs.snapshot(), { "new.md": "old content" });
	assert.deepEqual(h.vaultFs.renames, [{ oldPath: "old.md", newPath: "new.md", overwrite: false }]);
	assert.equal(h.editorRenames.length, 1);
	assert.equal(h.editorRenames[0]?.get("old.md"), "new.md");
});

test("DiskMirror suppression validates the VaultFs readback fingerprint", async (t) => {
	const h = createHarness({ "note.md": "old content" }, { "note.md": "new content" });
	t.after(() => h.mirror.destroy());

	await h.mirror.flushWrite("note.md");
	const suppressed = await h.mirror.shouldSuppressModify(tFile("note.md", "new content"));

	assert.equal(suppressed, true);
	assert.equal(h.mirror.isSuppressed("note.md"), false);
});

test("DiskMirror frontmatter guard blocks unsafe VaultFs writes", async (t) => {
	const h = createHarness({}, { "note.md": "---\ntitle: Broken\n# Missing closing fence" });
	t.after(() => h.mirror.destroy());

	await h.mirror.flushWrite("note.md");

	assert.deepEqual(h.vaultFs.snapshot(), {});
	assert.deepEqual(h.vaultFs.writes, []);
});

test("DiskMirror target-file rename collision rewrites target from CRDT", async (t) => {
	const h = createHarness(
		{ "old.md": "old content", "new.md": "target content" },
		{ "new.md": "remote renamed content" },
	);
	t.after(() => h.mirror.destroy());

	await handleRemoteRename(h.mirror, "old.md", "new.md");
	assert.equal(h.mirror.pendingWriteCount, 1);

	await sleep(350);

	assert.deepEqual(h.vaultFs.snapshot(), { "new.md": "remote renamed content" });
	assert.deepEqual(h.vaultFs.renames, []);
	assert.deepEqual(h.vaultFs.deletes, ["old.md"]);
});

test("DiskMirror target directory rename collision leaves the source intact", async (t) => {
	const h = createHarness({ "old.md": "old content", "new.md/child.md": "local child" });
	t.after(() => h.mirror.destroy());

	await handleRemoteRename(h.mirror, "old.md", "new.md");

	assert.deepEqual(h.vaultFs.snapshot(), {
		"new.md/child.md": "local child",
		"old.md": "old content",
	});
	assert.deepEqual(h.vaultFs.renames, []);
	assert.deepEqual(h.vaultFs.deletes, []);
	assert.equal(h.mirror.pendingWriteCount, 0);
});

test("DiskMirror open-file target directory collision restores old open observer", async (t) => {
	const h = createHarness(
		{ "old.md": "old content", "new.md/child.md": "local child" },
		{ "old.md": "old content" },
	);
	t.after(() => h.mirror.destroy());
	h.mirror.notifyFileOpened("old.md");
	const fileId = h.vaultSync.pathToId.get("old.md");
	assert.ok(fileId);
	h.vaultSync.pathToId.delete("old.md");
	h.vaultSync.pathToId.set("new.md", fileId);
	h.vaultSync.meta.set(fileId, { path: "new.md", mtime: Date.now() });

	await handleRemoteRename(h.mirror, "old.md", "new.md");

	const snapshot = h.mirror.getDebugSnapshot();
	assert.deepEqual(snapshot.openPaths, ["old.md"]);
	assert.deepEqual(snapshot.observedPaths, ["old.md"]);
	assert.equal(h.mirror.pendingWriteCount, 0);
	const ytext = h.vaultSync.idToText.get(fileId);
	assert.ok(ytext);
	h.mirror.startMapObservers();
	const replacement = new Y.Text();
	replacement.insert(0, "replacement content");
	h.vaultSync.pathToId.set("old.md", "replacement-file");
	h.vaultSync.idToText.set("replacement-file", replacement);
	h.vaultSync.meta.set("replacement-file", { path: "old.md", mtime: Date.now() });
	h.vaultSync.ydoc.transact(() => {
		ytext.insert(ytext.length, " updated");
	}, h.vaultSync.provider);
	const internals = h.mirror as unknown as { debounceTimers: Map<string, unknown> };
	assert.equal(internals.debounceTimers.has("new.md"), false);
	await h.mirror.flushOpenPath("old.md", "test-collision-restore");
	assert.equal(h.vaultFs.getFile("old.md"), "old content updated");
});

test("DiskMirror blocked rename flushes an already pending open write", async (t) => {
	const h = createHarness(
		{ "old.md": "old content", "new.md/child.md": "local child" },
		{ "old.md": "old content" },
	);
	t.after(() => h.mirror.destroy());
	h.mirror.notifyFileOpened("old.md");
	const fileId = h.vaultSync.pathToId.get("old.md");
	assert.ok(fileId);
	const ytext = h.vaultSync.idToText.get(fileId);
	assert.ok(ytext);
	h.vaultSync.ydoc.transact(() => {
		ytext.insert(ytext.length, " pending");
	}, h.vaultSync.provider);
	assert.equal(h.mirror.pendingWriteCount, 1);

	h.vaultSync.pathToId.delete("old.md");
	h.vaultSync.pathToId.set("new.md", fileId);
	h.vaultSync.meta.set(fileId, { path: "new.md", mtime: Date.now() });

	await handleRemoteRename(h.mirror, "old.md", "new.md");

	assert.equal(h.mirror.pendingWriteCount, 1);
	await h.mirror.flushOpenPath("old.md", "test-pending-rollback");
	assert.equal(h.vaultFs.getFile("old.md"), "old content pending");
	assert.equal(h.mirror.pendingWriteCount, 0);
});

test("DiskMirror parent-file rename collision leaves the source intact", async (t) => {
	const h = createHarness({ "old.md": "old content", dir: "not a folder" }, { "dir/new.md": "remote content" });
	t.after(() => h.mirror.destroy());

	await handleRemoteRename(h.mirror, "old.md", "dir/new.md");

	assert.deepEqual(h.vaultFs.snapshot(), {
		dir: "not a folder",
		"old.md": "old content",
	});
	assert.deepEqual(h.vaultFs.renames, []);
	assert.deepEqual(h.vaultFs.deletes, []);
	assert.equal(h.mirror.pendingWriteCount, 0);
});

test("DiskMirror missing-source target directory collision does not schedule a doomed write", async (t) => {
	const h = createHarness({ "new.md/child.md": "local child" }, { "new.md": "remote content" });
	t.after(() => h.mirror.destroy());

	await handleRemoteRename(h.mirror, "missing.md", "new.md");

	assert.deepEqual(h.vaultFs.snapshot(), { "new.md/child.md": "local child" });
	assert.equal(h.mirror.pendingWriteCount, 0);
});

test("DiskMirror missing-source parent-file collision does not schedule a doomed write", async (t) => {
	const h = createHarness({ dir: "not a folder" }, { "dir/new.md": "remote content" });
	t.after(() => h.mirror.destroy());

	await handleRemoteRename(h.mirror, "missing.md", "dir/new.md");

	assert.deepEqual(h.vaultFs.snapshot(), { dir: "not a folder" });
	assert.equal(h.mirror.pendingWriteCount, 0);
});

test("DiskMirror missing-source rename schedules a write for the remote target", async (t) => {
	const h = createHarness({}, { "new.md": "remote content" });
	t.after(() => h.mirror.destroy());

	await handleRemoteRename(h.mirror, "missing.md", "new.md");
	assert.equal(h.mirror.pendingWriteCount, 1);

	await sleep(350);

	assert.deepEqual(h.vaultFs.snapshot(), { "new.md": "remote content" });
});
