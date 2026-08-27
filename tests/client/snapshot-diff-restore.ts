import * as Y from "yjs";
import { canonicalizeVaultPath } from "../../src/paths/canonicalPath";
import { diffSnapshot, restoreFromSnapshot } from "../../src/sync/snapshotClient";
import type { BlobRef } from "../../src/types";
import { suite } from "../harness.ts";

const s = suite("snapshot-diff-restore");

interface TestDocs {
	readonly snapshot: Y.Doc;
	readonly live: Y.Doc;
}

function makeSnapshotAndModifiedLiveDoc(): TestDocs {
	const snapshot = new Y.Doc();
	const pathToId = snapshot.getMap<string>("pathToId");
	const idToText = snapshot.getMap<Y.Text>("idToText");
	const meta = snapshot.getMap("meta");
	const pathToBlob = snapshot.getMap<BlobRef>("pathToBlob");

	snapshot.transact(() => {
		for (const [path, fileId, content] of [
			["notes/hello.md", "hello-id", "# Hello\nSnapshot content."],
			["notes/world.md", "world-id", "# World\nRestore me."],
			["notes/unchanged.md", "unchanged-id", "Still the same."],
		] as const) {
			const text = new Y.Text();
			text.insert(0, content);
			pathToId.set(path, fileId);
			idToText.set(fileId, text);
			meta.set(fileId, { path, mtime: 1 });
		}
		pathToBlob.set("images/changed.png", { hash: "a".repeat(64), size: 10 });
		pathToBlob.set("images/deleted.png", { hash: "b".repeat(64), size: 20 });
	});

	const live = new Y.Doc();
	Y.applyUpdate(live, Y.encodeStateAsUpdate(snapshot));
	const livePathToId = live.getMap<string>("pathToId");
	const liveIdToText = live.getMap<Y.Text>("idToText");
	const liveMeta = live.getMap("meta");
	const livePathToBlob = live.getMap<BlobRef>("pathToBlob");
	live.transact(() => {
		const hello = liveIdToText.get("hello-id")!;
		hello.delete(0, hello.length);
		hello.insert(0, "Modified after snapshot");

		livePathToId.delete("notes/world.md");
		liveMeta.set("world-id", { path: "notes/world.md", deleted: true, mtime: 2 });

		const created = new Y.Text();
		created.insert(0, "Created later");
		livePathToId.set("notes/new.md", "new-id");
		liveIdToText.set("new-id", created);
		liveMeta.set("new-id", { path: "notes/new.md", mtime: 2 });

		livePathToBlob.set("images/changed.png", { hash: "c".repeat(64), size: 30 });
		livePathToBlob.delete("images/deleted.png");
		livePathToBlob.set("images/new.png", { hash: "d".repeat(64), size: 40 });
	});

	return { snapshot, live };
}

s.section("Test 1: exported diffSnapshot reports markdown and blob changes");
{
	const { snapshot, live } = makeSnapshotAndModifiedLiveDoc();
	const diff = diffSnapshot(snapshot, live);

	s.check(diff.deletedSinceSnapshot.map(({ path }) => path).includes("notes/world.md"), "deleted markdown is reported");
	s.check(diff.createdSinceSnapshot.includes("notes/new.md"), "created markdown is reported");
	s.check(diff.contentChanged.map(({ path }) => path).includes("notes/hello.md"), "changed markdown content is reported");
	s.check(diff.unchanged.includes("notes/unchanged.md"), "unchanged markdown is reported");
	s.check(diff.blobsDeletedSinceSnapshot.map(({ path }) => path).includes("images/deleted.png"), "deleted blob is reported");
	s.check(diff.blobsChanged.map(({ path }) => path).includes("images/changed.png"), "changed blob is reported");
	s.check(diff.blobsCreatedSinceSnapshot.includes("images/new.png"), "created blob is reported");

	snapshot.destroy();
	live.destroy();
}

s.section("Test 2: exported restoreFromSnapshot restores selected content, tombstones, and blobs");
{
	const { snapshot, live } = makeSnapshotAndModifiedLiveDoc();
	const result = restoreFromSnapshot(snapshot, live, {
		markdownPaths: ["././notes\\hello.md", "/notes//world.md"],
		blobPaths: ["./images//changed.png"],
		device: "snapshot-test",
	});

	s.check(result.markdownRestored === 1, `one existing markdown file restored (got ${result.markdownRestored})`);
	s.check(result.markdownUndeleted === 1, `one markdown file undeleted (got ${result.markdownUndeleted})`);
	s.check(result.blobsRestored === 1, `one blob reference restored (got ${result.blobsRestored})`);

	const restoredDiff = diffSnapshot(snapshot, live);
	s.check(!restoredDiff.contentChanged.some(({ path }) => path === "notes/hello.md"), "selected markdown content matches the snapshot");
	s.check(!restoredDiff.deletedSinceSnapshot.some(({ path }) => path === "notes/world.md"), "selected tombstoned markdown is active again");
	s.check(!restoredDiff.blobsChanged.some(({ path }) => path === "images/changed.png"), "selected blob reference matches the snapshot");
	s.check(restoredDiff.createdSinceSnapshot.includes("notes/new.md"), "unselected created markdown remains untouched");
	s.check(restoredDiff.blobsCreatedSinceSnapshot.includes("images/new.png"), "unselected created blob remains untouched");

	snapshot.destroy();
	live.destroy();
}

s.section("Test 3: snapshot matching uses canonical path identity");
{
	const snapshot = new Y.Doc();
	const live = new Y.Doc();
	snapshot.getMap("sys").set("schemaVersion", 2);
	live.getMap("sys").set("schemaVersion", 2);

	const snapshotText = new Y.Text();
	snapshotText.insert(0, "snapshot");
	snapshot.getMap<Y.Text>("idToText").set("snapshot-id", snapshotText);
	snapshot.getMap("meta").set("snapshot-id", { path: "cafe\u0301\\note.md", mtime: 1 });

	const liveText = new Y.Text();
	liveText.insert(0, "live");
	live.getMap<Y.Text>("idToText").set("live-id", liveText);
	live.getMap("meta").set("live-id", { path: "caf\u00E9/note.md", mtime: 1 });

	const before = diffSnapshot(snapshot, live);
	s.check(before.deletedSinceSnapshot.length === 0, "NFD/backslash snapshot path matches NFC live path");
	s.check(before.createdSinceSnapshot.length === 0, "canonical match does not report a spurious creation");
	s.check(before.contentChanged.length === 1, "canonical match compares the two file bodies");

	const result = restoreFromSnapshot(snapshot, live, {
		markdownPaths: ["/./caf\u00E9//note.md"],
	});
	s.check(result.markdownRestored === 1, "canonical requested path restores the matched snapshot file");
	s.check(liveText.toString() === "snapshot", "matched live body receives snapshot content");

	snapshot.destroy();
	live.destroy();
}

s.section("Test 4: blob restore removes canonical aliases and matching tombstones");
{
	const snapshot = new Y.Doc();
	const live = new Y.Doc();
	const canonicalPath = "assets/caf\u00E9/photo.png";
	const snapshotRef: BlobRef = { hash: "e".repeat(64), size: 50 };
	const unrelatedRef: BlobRef = { hash: "f".repeat(64), size: 60 };
	const livePathToBlob = live.getMap<BlobRef>("pathToBlob");
	const liveBlobTombstones = live.getMap<{ deletedAt: number }>("blobTombstones");

	snapshot.getMap<BlobRef>("pathToBlob").set(canonicalPath, snapshotRef);
	live.transact(() => {
		livePathToBlob.set("assets/cafe\u0301/photo.png", { hash: "1".repeat(64), size: 10 });
		livePathToBlob.set("./assets//caf\u00E9/photo.png", { hash: "2".repeat(64), size: 20 });
		livePathToBlob.set(canonicalPath, { hash: "3".repeat(64), size: 30 });
		livePathToBlob.set("assets/unrelated.png", unrelatedRef);
		liveBlobTombstones.set("/./assets//cafe\u0301/photo.png", { deletedAt: 1 });
		liveBlobTombstones.set(canonicalPath, { deletedAt: 2 });
		liveBlobTombstones.set("assets/unrelated-deleted.png", { deletedAt: 3 });
	});

	const result = restoreFromSnapshot(snapshot, live, {
		blobPaths: ["/./assets//cafe\u0301/photo.png", canonicalPath],
	});

	const matchingLiveKeys = Array.from(livePathToBlob.keys()).filter(
		(path) => canonicalizeVaultPath(path).canonicalKey === canonicalPath,
	);
	const matchingTombstoneKeys = Array.from(liveBlobTombstones.keys()).filter(
		(path) => canonicalizeVaultPath(path).canonicalKey === canonicalPath,
	);
	s.check(result.blobsRestored === 1, `canonical blob identity is counted once (got ${result.blobsRestored})`);
	s.check(matchingLiveKeys.length === 1 && matchingLiveKeys[0] === canonicalPath, "exactly one canonical blob key remains");
	s.check(
		livePathToBlob.get(canonicalPath)?.hash === snapshotRef.hash
			&& livePathToBlob.get(canonicalPath)?.size === snapshotRef.size,
		"snapshot value wins over conflicting live aliases",
	);
	s.check(matchingTombstoneKeys.length === 0, "all canonical-equivalent blob tombstones are cleared");
	s.check(livePathToBlob.get("assets/unrelated.png")?.hash === unrelatedRef.hash, "unrelated live blob survives");
	s.check(liveBlobTombstones.has("assets/unrelated-deleted.png"), "unrelated tombstone survives");

	snapshot.destroy();
	live.destroy();
}

await s.done();
