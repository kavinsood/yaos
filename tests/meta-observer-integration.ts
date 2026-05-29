/**
 * Integration tests proving that nested Y.Map field mutations (v3 metadata)
 * correctly drive the semantic observer, which in turn is what DiskMirror
 * and the witness tracker consume.
 *
 * Covers:
 * - Nested field mutations fire the correct semantic change kinds
 * - Cross-doc remote mutations fire on the receiving doc
 * - Transaction origin (local vs remote) is correctly propagated
 * - Local metadata changes do NOT trigger remote-only consumers
 * - mtime-only changes do NOT trigger structural side effects
 * - Incremental diff is correct for all change kinds
 */

import * as Y from "yjs";
import {
	createNestedActiveMeta,
	createNestedDeletedMeta,
	ensureNestedMetaEntry,
	buildMetaSnapshot,
	extractAffectedFileIds,
	computeIncrementalMetaChanges,
	type MetaSemanticChange,
	type MetaChangeBatch,
} from "../src/sync/fileMeta";
import { isLocalOrigin, ORIGIN_SEED } from "../src/sync/origins";

// ── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) { passed++; } else { failed++; console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

function section(name: string): void {
	console.log(`\n── ${name} ──`);
}

// ── Helper: simulate what VaultSync._metaDeepObserver does ──────────────────

/**
 * Attaches a semantic observer to a meta map using incremental diffing,
 * identical to what VaultSync does internally. Returns batches (with origin)
 * collected across all subsequent mutations, plus an unsubscribe function.
 *
 * The `provider` argument simulates the y-partyserver provider instance.
 * Remote updates are applied without an origin (null) or with the provider
 * as origin — both must be detected as remote by isLocalOrigin().
 */
function attachSemanticObserver(
	metaMap: Y.Map<unknown>,
	provider: unknown = null,
): {
	batches: MetaChangeBatch[];
	changes: MetaSemanticChange[];   // flat view for backwards compat
	unsubscribe: () => void;
} {
	const batches: MetaChangeBatch[] = [];
	const changes: MetaSemanticChange[] = [];
	let snapshot = buildMetaSnapshot(metaMap);

	const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		const origin = events[0]?.transaction.origin;
		const isLocal = isLocalOrigin(origin, provider);

		let batchChanges: MetaSemanticChange[];
		const affected = extractAffectedFileIds(events, metaMap);
		if (affected !== null) {
			batchChanges = computeIncrementalMetaChanges(snapshot, metaMap, affected);
		} else {
			// Fallback: should not happen in tests, but handle gracefully
			const next = buildMetaSnapshot(metaMap);
			batchChanges = [];
			snapshot = next;
		}

		if (batchChanges.length === 0) return;
		const batch: MetaChangeBatch = { origin, isLocal, changes: batchChanges };
		batches.push(batch);
		changes.push(...batchChanges);
	};

	metaMap.observeDeep(handler);
	return {
		batches,
		changes,
		unsubscribe: () => metaMap.unobserveDeep(handler),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Core observer firing tests
// ═══════════════════════════════════════════════════════════════════════════

section("Observer: flat object replacement fires on shallow observe");

{
	// Baseline: flat entry replacement — old shallow observer worked for this.
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");
	const { changes, unsubscribe } = attachSemanticObserver(meta);

	// Write flat active entry
	doc.transact(() => {
		meta.set("id1", { path: "notes/a.md", mtime: 1000, device: "dev" } as unknown);
	});

	assertEqual(changes.length, 1, "flat add fires one change");
	assertEqual(changes[0]!.kind, "added", "flat add kind is 'added'");
	assertEqual((changes[0] as any).next.path, "notes/a.md", "flat add path correct");

	// Replace with tombstone
	doc.transact(() => {
		meta.set("id1", { path: "notes/a.md", deletedAt: 9999 } as unknown);
	});

	const deleted = changes.find(c => c.kind === "deleted");
	assert(deleted !== undefined, "flat tombstone replacement fires 'deleted'");

	unsubscribe();
}

section("Observer: nested deletedAt fires 'deleted' (THE critical path)");

{
	// This is the specific case that a shallow observer missed.
	// If a file was already a nested Y.Map and someone sets deletedAt
	// inside it, the top-level meta key did NOT change — only a nested
	// field did. observeDeep must fire.
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	// Create a nested active entry
	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/b.md", 2000, "dev");
		meta.set("id2", entry);
	});

	const { changes, unsubscribe } = attachSemanticObserver(meta);

	// Now delete it by mutating the nested map's field — NOT replacing the top-level entry
	doc.transact(() => {
		const entry = meta.get("id2") as Y.Map<unknown>;
		entry.set("deletedAt", Date.now());
		entry.delete("mtime");
		entry.delete("device");
	});

	assert(changes.length > 0, "nested deletedAt mutation fires at least one change");
	const deleted = changes.find(c => c.kind === "deleted");
	assert(deleted !== undefined, "nested deletedAt fires 'deleted' semantic change");
	assertEqual((deleted as any).path, "notes/b.md", "deleted path correct");

	unsubscribe();
}

section("Observer: nested deletedAt removal fires 'revived'");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	// Start with a nested tombstone
	doc.transact(() => {
		const entry = createNestedDeletedMeta("notes/c.md", 5000);
		meta.set("id3", entry);
	});

	const { changes, unsubscribe } = attachSemanticObserver(meta);

	// Revive by removing deletedAt from the nested map
	doc.transact(() => {
		const entry = meta.get("id3") as Y.Map<unknown>;
		entry.delete("deletedAt");
		entry.set("mtime", Date.now());
		entry.set("device", "dev");
	});

	const revived = changes.find(c => c.kind === "revived");
	assert(revived !== undefined, "nested deletedAt deletion fires 'revived'");
	assertEqual((revived as any).path, "notes/c.md", "revived path correct");

	unsubscribe();
}

section("Observer: nested path change fires 'path-changed'");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/original.md", 1000, "dev");
		meta.set("id4", entry);
	});

	const { changes, unsubscribe } = attachSemanticObserver(meta);

	// Rename by mutating nested path field
	doc.transact(() => {
		const entry = meta.get("id4") as Y.Map<unknown>;
		entry.set("path", "notes/renamed.md");
	});

	const pathChanged = changes.find(c => c.kind === "path-changed");
	assert(pathChanged !== undefined, "nested path mutation fires 'path-changed'");
	assertEqual((pathChanged as any).previousPath, "notes/original.md", "previous path correct");
	assertEqual((pathChanged as any).nextPath, "notes/renamed.md", "next path correct");

	unsubscribe();
}

section("Observer: nested mtime change fires 'mtime-changed' (not delete or rename)");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/d.md", 1000, "dev");
		meta.set("id5", entry);
	});

	const { changes, unsubscribe } = attachSemanticObserver(meta);

	// Touch mtime only — this must NOT fire delete, rename, or revive
	doc.transact(() => {
		const entry = meta.get("id5") as Y.Map<unknown>;
		entry.set("mtime", Date.now());
	});

	const structuralChanges = changes.filter(c =>
		c.kind === "deleted" || c.kind === "revived" || c.kind === "path-changed"
	);
	assertEqual(structuralChanges.length, 0, "mtime-only change has no structural side effects");

	const mtime = changes.find(c => c.kind === "mtime-changed");
	assert(mtime !== undefined, "mtime-only change fires 'mtime-changed'");

	unsubscribe();
}

section("Observer: nested device change fires 'device-changed' (not structural)");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/e.md", 1000, "device-a");
		meta.set("id6", entry);
	});

	const { changes, unsubscribe } = attachSemanticObserver(meta);

	doc.transact(() => {
		const entry = meta.get("id6") as Y.Map<unknown>;
		entry.set("device", "device-b");
	});

	const structural = changes.filter(c =>
		c.kind === "deleted" || c.kind === "revived" || c.kind === "path-changed"
	);
	assertEqual(structural.length, 0, "device-only change has no structural side effects");
	assert(changes.some(c => c.kind === "device-changed"), "device-only change fires 'device-changed'");

	unsubscribe();
}

// ═══════════════════════════════════════════════════════════════════════════
// Lazy conversion observer interaction
// ═══════════════════════════════════════════════════════════════════════════

section("Observer: flat→nested lazy conversion fires correctly");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	// Start with a flat entry
	doc.transact(() => {
		meta.set("id7", { path: "notes/f.md", mtime: 1000, device: "dev" } as unknown);
	});

	const { changes, unsubscribe } = attachSemanticObserver(meta);

	// ensureNestedMetaEntry converts it and mutates mtime
	doc.transact(() => {
		const entry = ensureNestedMetaEntry(meta, "id7");
		entry!.set("mtime", 2000);
	});

	// Should fire mtime-changed (path stays the same, entry is now nested)
	assert(changes.length > 0, "lazy conversion fires at least one change");
	// No spurious delete/rename during conversion
	const structural = changes.filter(c =>
		c.kind === "deleted" || c.kind === "revived" || c.kind === "path-changed"
	);
	assertEqual(structural.length, 0, "lazy conversion does not fire structural changes");

	unsubscribe();
}

// ═══════════════════════════════════════════════════════════════════════════
// Cross-doc sync: semantic changes fire after remote update applied
// ═══════════════════════════════════════════════════════════════════════════

section("Cross-doc: remote nested delete fires 'deleted' on receiving doc");

{
	const docA = new Y.Doc({ gc: false });
	const docB = new Y.Doc({ gc: false });

	// Initial state: active nested entry on both
	const entryA = createNestedActiveMeta("sync/file.md", 1000, "deviceA");
	docA.getMap("meta").set("fileX", entryA);
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	// Observe on B
	const { changes, unsubscribe } = attachSemanticObserver(docB.getMap("meta"));

	// Device A deletes the file (mutates nested field)
	docA.transact(() => {
		const entry = docA.getMap("meta").get("fileX") as Y.Map<unknown>;
		entry.set("deletedAt", 9999);
		entry.delete("mtime");
		entry.delete("device");
	});

	// Sync to B
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const deleted = changes.find(c => c.kind === "deleted");
	assert(deleted !== undefined, "remote nested delete fires 'deleted' on receiving doc");
	assertEqual((deleted as any).path, "sync/file.md", "correct path in deleted event");

	unsubscribe();
}

section("Cross-doc: remote nested rename fires 'path-changed' on receiving doc");

{
	const docA = new Y.Doc({ gc: false });
	const docB = new Y.Doc({ gc: false });

	const entryA = createNestedActiveMeta("sync/before.md", 1000, "deviceA");
	docA.getMap("meta").set("fileY", entryA);
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const { changes, unsubscribe } = attachSemanticObserver(docB.getMap("meta"));

	// Device A renames the file (mutates nested path field)
	docA.transact(() => {
		const entry = docA.getMap("meta").get("fileY") as Y.Map<unknown>;
		entry.set("path", "sync/after.md");
	});

	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const pathChanged = changes.find(c => c.kind === "path-changed");
	assert(pathChanged !== undefined, "remote nested rename fires 'path-changed' on receiving doc");
	assertEqual((pathChanged as any).previousPath, "sync/before.md", "previous path correct");
	assertEqual((pathChanged as any).nextPath, "sync/after.md", "next path correct");

	unsubscribe();
}

section("Cross-doc: remote nested revive fires 'revived' on receiving doc");

{
	const docA = new Y.Doc({ gc: false });
	const docB = new Y.Doc({ gc: false });

	// Start with tombstone on both docs
	const tombstone = createNestedDeletedMeta("sync/revived.md", 5000);
	docA.getMap("meta").set("fileZ", tombstone);
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const { changes, unsubscribe } = attachSemanticObserver(docB.getMap("meta"));

	// Device A revives the file
	docA.transact(() => {
		const entry = docA.getMap("meta").get("fileZ") as Y.Map<unknown>;
		entry.delete("deletedAt");
		entry.set("mtime", Date.now());
		entry.set("device", "deviceA");
	});

	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const revived = changes.find(c => c.kind === "revived");
	assert(revived !== undefined, "remote nested revive fires 'revived' on receiving doc");
	assertEqual((revived as any).path, "sync/revived.md", "revived path correct");

	unsubscribe();
}

section("Cross-doc: remote mtime change does NOT fire structural event on receiving doc");

{
	const docA = new Y.Doc({ gc: false });
	const docB = new Y.Doc({ gc: false });

	const entry = createNestedActiveMeta("sync/stable.md", 1000, "deviceA");
	docA.getMap("meta").set("fileW", entry);
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const { changes, unsubscribe } = attachSemanticObserver(docB.getMap("meta"));

	// Device A just saves the file (mtime bump only)
	docA.transact(() => {
		const e = docA.getMap("meta").get("fileW") as Y.Map<unknown>;
		e.set("mtime", Date.now());
	});

	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const structural = changes.filter(c =>
		c.kind === "deleted" || c.kind === "revived" || c.kind === "path-changed"
	);
	assertEqual(structural.length, 0, "remote mtime change has no structural side effects on receiver");

	unsubscribe();
}

// ═══════════════════════════════════════════════════════════════════════════
// Origin filtering: local vs remote
// ═══════════════════════════════════════════════════════════════════════════

section("Origin: local ORIGIN_SEED write is flagged isLocal=true");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");
	const { batches, unsubscribe } = attachSemanticObserver(meta);

	// Write with ORIGIN_SEED (local)
	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/local.md", 1000, "dev");
		meta.set("local-id", entry);
	}, ORIGIN_SEED);

	assertEqual(batches.length, 1, "local seed write fires one batch");
	assertEqual(batches[0]!.isLocal, true, "ORIGIN_SEED batch is isLocal=true");

	unsubscribe();
}

section("Origin: remote update (null origin) is flagged isLocal=false");

{
	// Simulate a remote update applied via Y.applyUpdate (which uses null origin)
	const docA = new Y.Doc({ gc: false });
	const docB = new Y.Doc({ gc: false });

	// Seed docA
	docA.transact(() => {
		const entry = createNestedActiveMeta("notes/remote.md", 1000, "deviceA");
		docA.getMap("meta").set("remote-id", entry);
	});

	// docB observes with no provider — null origin is remote
	const { batches, unsubscribe } = attachSemanticObserver(docB.getMap("meta"), null);

	// Apply remote update to docB
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	assert(batches.length > 0, "remote update fires at least one batch");
	assert(batches.every(b => b.isLocal === false), "all remote batches are isLocal=false");

	unsubscribe();
}

section("Origin: local delete does NOT get treated as remote by DiskMirror logic");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	// Create an active entry
	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/will-delete.md", 1000, "dev");
		meta.set("del-id", entry);
	});

	// Track what a DiskMirror-like consumer would do (skip isLocal)
	const remoteDeletions: string[] = [];
	const { unsubscribe } = attachSemanticObserver(meta);

	// Simulate DiskMirror behavior: only act on remote batches
	const unsubMeta = ((): (() => void) => {
		let snapshot = buildMetaSnapshot(meta);
		const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
			const origin = events[0]?.transaction.origin;
			const isLocal = isLocalOrigin(origin, null);
			if (isLocal) return; // DiskMirror ignores local changes

			const affected = extractAffectedFileIds(events, meta);
			if (!affected) return;
			const changes = computeIncrementalMetaChanges(snapshot, meta, affected);
			for (const c of changes) {
				if (c.kind === "deleted") remoteDeletions.push(c.path);
			}
		};
		meta.observeDeep(handler);
		return () => meta.unobserveDeep(handler);
	})();

	// Local delete (ORIGIN_SEED) — DiskMirror must NOT react
	doc.transact(() => {
		const entry = meta.get("del-id") as Y.Map<unknown>;
		entry.set("deletedAt", Date.now());
		entry.delete("mtime");
		entry.delete("device");
	}, ORIGIN_SEED);

	assertEqual(remoteDeletions.length, 0, "local nested delete is NOT treated as remote by DiskMirror");

	unsubMeta();
	unsubscribe();
}

section("Origin: remote delete IS treated as remote by DiskMirror logic");

{
	const docA = new Y.Doc({ gc: false });
	const docB = new Y.Doc({ gc: false });

	// Active entry on both docs
	const active = createNestedActiveMeta("notes/remote-del.md", 1000, "deviceA");
	docA.getMap("meta").set("rdel-id", active);
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	const remoteDeletions: string[] = [];
	const metaB = docB.getMap("meta");
	let snapshotB = buildMetaSnapshot(metaB);
	const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		const origin = events[0]?.transaction.origin;
		const isLocal = isLocalOrigin(origin, null); // null = no provider on docB
		if (isLocal) return;
		const affected = extractAffectedFileIds(events, metaB);
		if (!affected) return;
		const changes = computeIncrementalMetaChanges(snapshotB, metaB, affected);
		for (const c of changes) {
			if (c.kind === "deleted") remoteDeletions.push(c.path);
		}
	};
	metaB.observeDeep(handler);

	// Device A deletes remotely
	docA.transact(() => {
		const e = docA.getMap("meta").get("rdel-id") as Y.Map<unknown>;
		e.set("deletedAt", Date.now());
		e.delete("mtime");
		e.delete("device");
	});

	// Sync to B
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

	assertEqual(remoteDeletions.length, 1, "remote nested delete IS treated as remote");
	assertEqual(remoteDeletions[0], "notes/remote-del.md", "correct path for remote delete");

	metaB.unobserveDeep(handler);
}

section("Origin: local rename does NOT trigger remote rename handler");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/before.md", 1000, "dev");
		meta.set("ren-id", entry);
	});

	const remoteRenames: { from: string; to: string }[] = [];
	let snap = buildMetaSnapshot(meta);
	const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		const origin = events[0]?.transaction.origin;
		if (isLocalOrigin(origin, null)) return;
		const affected = extractAffectedFileIds(events, meta);
		if (!affected) return;
		const changes = computeIncrementalMetaChanges(snap, meta, affected);
		for (const c of changes) {
			if (c.kind === "path-changed") remoteRenames.push({ from: c.previousPath, to: c.nextPath });
		}
	};
	meta.observeDeep(handler);

	// Local rename via ORIGIN_SEED
	doc.transact(() => {
		const entry = meta.get("ren-id") as Y.Map<unknown>;
		entry.set("path", "notes/after.md");
	}, ORIGIN_SEED);

	assertEqual(remoteRenames.length, 0, "local nested rename does NOT trigger remote rename handler");

	meta.unobserveDeep(handler);
}

// ═══════════════════════════════════════════════════════════════════════════
// Incremental diff: extractAffectedFileIds correctness
// ═══════════════════════════════════════════════════════════════════════════

section("Incremental: top-level key change identifies correct fileId");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	let capturedAffected: Set<string> | null = null;
	const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		capturedAffected = extractAffectedFileIds(events, meta);
	};
	meta.observeDeep(handler);

	doc.transact(() => {
		meta.set("my-file-id", { path: "x.md", mtime: 1 } as unknown);
	});

	assert(capturedAffected !== null, "affected set extracted");
	assert(capturedAffected!.has("my-file-id"), "correct fileId from top-level change");
	assertEqual(capturedAffected!.size, 1, "exactly one fileId affected");

	meta.unobserveDeep(handler);
}

section("Incremental: nested field change identifies correct fileId via event.path");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	// Pre-populate with a nested entry
	doc.transact(() => {
		const entry = createNestedActiveMeta("notes/y.md", 1000, "dev");
		meta.set("nested-file-id", entry);
	});

	let capturedAffected: Set<string> | null = null;
	const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		capturedAffected = extractAffectedFileIds(events, meta);
	};
	meta.observeDeep(handler);

	// Mutate nested field — top-level key does NOT change
	doc.transact(() => {
		const entry = meta.get("nested-file-id") as Y.Map<unknown>;
		entry.set("mtime", 2000);
	});

	assert(capturedAffected !== null, "affected set extracted for nested change");
	assert(capturedAffected!.has("nested-file-id"), "nested-file-id correctly identified from event.path");
	assertEqual(capturedAffected!.size, 1, "exactly one fileId for nested mutation");

	meta.unobserveDeep(handler);
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
	process.exit(1);
}
