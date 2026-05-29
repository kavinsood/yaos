import * as Y from "yjs";
const snapshotModule = await import("../src/sync/snapshotClient.ts");
const { diffSnapshot, restoreFromSnapshot } = snapshotModule.default ?? snapshotModule;
const fileMetaModule = await import("../src/sync/fileMeta.ts");
const getMetaPath = fileMetaModule.getMetaPath ?? fileMetaModule.default?.getMetaPath;
const getMetaDeletedAt = fileMetaModule.getMetaDeletedAt ?? fileMetaModule.default?.getMetaDeletedAt;

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

function cloneDoc(doc) {
	const clone = new Y.Doc();
	Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
	return clone;
}

function syncBoth(docA, docB) {
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
	Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
}

function activeMetaPaths(doc) {
	const paths = new Map();
	const meta = doc.getMap("meta");
	meta.forEach((entry, fileId) => {
		if (!entry || typeof entry.path !== "string") return;
		if (typeof entry.deletedAt === "number" || entry.deleted === true) return;
		paths.set(entry.path, fileId);
	});
	return paths;
}

console.log("\n--- Test 1: v2 concurrent offline rename converges to one active path ---");
{
	const base = new Y.Doc();
	const sys = base.getMap("sys");
	const idToText = base.getMap("idToText");
	const meta = base.getMap("meta");
	const pathToId = base.getMap("pathToId");
	const fileId = "file-1";
	const initialPath = "Projects/Alpha/note.md";

	base.transact(() => {
		sys.set("schemaVersion", 2);
		const text = new Y.Text();
		text.insert(0, "Hello from YAOS");
		idToText.set(fileId, text);
		meta.set(fileId, { path: initialPath, mtime: 1, device: "seed" });
		// Keep legacy map populated to ensure v2 behavior does not depend on it.
		pathToId.set(initialPath, fileId);
	});

	const desktop = cloneDoc(base);
	const mobile = cloneDoc(base);

	const desktopMeta = desktop.getMap("meta");
	const mobileMeta = mobile.getMap("meta");

	desktop.transact(() => {
		desktopMeta.set(fileId, { path: "Projects/Beta/note.md", mtime: 2, device: "desktop" });
		desktop.getMap("pathToId").set("Projects/Beta/note.md", fileId);
	});

	mobile.transact(() => {
		mobileMeta.set(fileId, { path: "Projects/Gamma/note.md", mtime: 3, device: "mobile" });
		mobile.getMap("pathToId").set("Projects/Gamma/note.md", fileId);
	});

	syncBoth(desktop, mobile);

	const desktopPath = desktop.getMap("meta").get(fileId)?.path;
	const mobilePath = mobile.getMap("meta").get(fileId)?.path;
	assert(typeof desktopPath === "string", "desktop kept an active path");
	assert(typeof mobilePath === "string", "mobile kept an active path");
	assert(desktopPath === mobilePath, "both replicas converge to one winner path");
	assert(desktop.getMap("idToText").size === 1, "desktop did not clone file IDs");
	assert(mobile.getMap("idToText").size === 1, "mobile did not clone file IDs");
	assert(activeMetaPaths(desktop).size === 1, "desktop has exactly one active markdown path");
	assert(activeMetaPaths(mobile).size === 1, "mobile has exactly one active markdown path");

	desktop.destroy();
	mobile.destroy();
	base.destroy();
}

console.log("\n--- Test 2: snapshot diff ignores legacy pathToId noise for schema v2 ---");
{
	const seed = new Y.Doc();
	const sys = seed.getMap("sys");
	const idToText = seed.getMap("idToText");
	const meta = seed.getMap("meta");
	const fileId = "file-2";
	seed.transact(() => {
		sys.set("schemaVersion", 2);
		const text = new Y.Text();
		text.insert(0, "Stable content");
		idToText.set(fileId, text);
		meta.set(fileId, { path: "notes/stable.md", mtime: 1, device: "seed" });
	});

	const snapshotDoc = cloneDoc(seed);
	const liveDoc = cloneDoc(seed);
	liveDoc.transact(() => {
		// Deliberately inject stale/extra legacy aliases.
		const livePathToId = liveDoc.getMap("pathToId");
		livePathToId.set("notes/stable.md", fileId);
		livePathToId.set("notes/ghost.md", fileId);
	});

	const diff = diffSnapshot(snapshotDoc, liveDoc);
	assert(diff.createdSinceSnapshot.length === 0, "no fake creates from pathToId aliases");
	assert(diff.deletedSinceSnapshot.length === 0, "no fake deletes from pathToId aliases");
	assert(diff.contentChanged.length === 0, "no fake content changes from pathToId aliases");
	assert(diff.unchanged.includes("notes/stable.md"), "active v2 path remains unchanged");

	seed.destroy();
	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 3: v2 restore undeletes without writing legacy pathToId ---");
{
	const snapshotDoc = new Y.Doc();
	const snapSys = snapshotDoc.getMap("sys");
	const snapIdToText = snapshotDoc.getMap("idToText");
	const snapMeta = snapshotDoc.getMap("meta");
	const fileId = "file-3";
	snapshotDoc.transact(() => {
		snapSys.set("schemaVersion", 2);
		const text = new Y.Text();
		text.insert(0, "Recovered");
		snapIdToText.set(fileId, text);
		snapMeta.set(fileId, { path: "notes/recover.md", mtime: 1, device: "snapshot" });
	});

	const liveDoc = new Y.Doc();
	const liveSys = liveDoc.getMap("sys");
	const liveIdToText = liveDoc.getMap("idToText");
	const liveMeta = liveDoc.getMap("meta");
	const livePathToId = liveDoc.getMap("pathToId");
	liveDoc.transact(() => {
		liveSys.set("schemaVersion", 2);
		const stale = new Y.Text();
		stale.insert(0, "Stale value");
		liveIdToText.set(fileId, stale);
		liveMeta.set(fileId, { path: "notes/recover.md", deletedAt: Date.now() - 1000 });
	});

	const restored = restoreFromSnapshot(snapshotDoc, liveDoc, {
		markdownPaths: ["notes/recover.md"],
		device: "test-device",
	});
	const restoredMeta = liveMeta.get(fileId);
	const restoredText = liveIdToText.get(fileId)?.toString();
	assert(restored.markdownUndeleted === 1, "restore undeleted one markdown file");
	assert(restoredText === "Recovered", "restore replaced stale content");
	// Use helper to read both flat (v2) and nested (v3) metadata shapes.
	assert(getMetaPath(restoredMeta) === "notes/recover.md", "restore kept expected path");
	assert(getMetaDeletedAt(restoredMeta) === null, "restore cleared tombstone state");
	assert(livePathToId.size === 0, "restore did not write legacy pathToId in schema v2");

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
