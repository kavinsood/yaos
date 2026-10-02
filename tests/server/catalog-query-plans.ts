// P3 (PHASE4-BATCH-ON-RELAY3 §1): the catalog queries on mutation, bootstrap
// and alarm paths must not read O(catalog history). They were GROUP BY
// body_id/document_id/path over every event; they are now index skip-scans and
// an in-memory path index, with no new SQLite index. This suite proves:
//   1. every statement they issue plans without SCAN or TEMP B-TREE;
//   2. results equal the legacy GROUP BY queries at several boundaries;
//   3. the path index survives rollbacks (store-guarded and foreign).
// Rows read on a 10k-event catalog under workerd: scripts/relay2/catalog-rows-read.ts.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import type { CatalogMutation } from "../../server/src/vaultCatalogStore";
import { suite } from "../harness.ts";

const s = suite("catalog-query-plans");

interface Recorded { query: string; bindings: unknown[] }

interface Recording { on: boolean; log: Recorded[] }

async function withStore(check: (store: VaultStore, sqlite: NodeSqliteStorage, recording: Recording) => void | Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "yaos-catalog-plans-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const recording: Recording = { on: false, log: [] };
	const storage = {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				if (recording.on) recording.log.push({ query, bindings });
				return sqlite.sql.exec(query, ...bindings);
			},
		},
		transactionSync<T>(closure: () => T): T {
			return sqlite.transactionSync(closure);
		},
	} as unknown as VaultStoragePort;
	const store = new VaultStore(storage);
	try {
		await check(store, sqlite, recording);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

/** Runs `action` and returns every statement the store issued meanwhile. */
function record(state: Recording, action: () => void): Recorded[] {
	state.log = [];
	state.on = true;
	try { action(); } finally { state.on = false; }
	return state.log;
}

function assertIndexedPlans(sqlite: NodeSqliteStorage, statements: Recorded[], label: string): string[] {
	assert.ok(statements.length > 0, `${label}: issued no statements`);
	const plans: string[] = [];
	for (const { query, bindings } of statements) {
		const detail = sqlite.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
			.toArray().map((row) => row.detail).join(" | ");
		plans.push(detail);
		assert.doesNotMatch(detail, /\bSCAN\b/, `${label}: full scan in plan "${detail}" for ${query.replace(/\s+/g, " ")}`);
		assert.doesNotMatch(detail, /TEMP B-TREE/, `${label}: temp b-tree in plan "${detail}" for ${query.replace(/\s+/g, " ")}`);
		assert.doesNotMatch(detail, /AUTOMATIC/, `${label}: automatic index in plan "${detail}"`);
	}
	return plans;
}

let docCounter = 0;
function bodyUpdate(bodyId: string, text: string): Uint8Array {
	const doc = new Y.Doc({ guid: `${bodyId}-${docCounter++}` });
	doc.getText("body").insert(0, text);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}

function mutate(store: VaultStore, mutation: CatalogMutation): void {
	store.commitUpdate({ documentId: mutation.bodyId, update: bodyUpdate(mutation.bodyId, mutation.path), kind: "body", catalog: [mutation] });
}

/** ~bodies*4 catalog events: create, renames, deletes, revivals, plus canvas and attachment history. */
function seed(store: VaultStore, sqlite: NodeSqliteStorage, bodies: number): number[] {
	const boundaries: number[] = [];
	const paths = new Map<string, string>();
	for (let i = 0; i < bodies; i++) {
		const bodyId = `body-${String(i).padStart(5, "0")}`;
		const path = `notes/n${i}.md`;
		mutate(store, { bodyId, fileId: `file-${i}`, path, previousPath: null, lifecycle: "active", bodyGeneration: 1 });
		paths.set(bodyId, path);
	}
	boundaries.push(store.currentSequence());
	for (let i = 0; i < bodies; i += 2) {
		const bodyId = `body-${String(i).padStart(5, "0")}`;
		const from = paths.get(bodyId)!;
		const to = `renamed/r${i}.md`;
		mutate(store, { bodyId, fileId: `file-${i}`, path: to, previousPath: from, lifecycle: "active", bodyGeneration: 1 });
		paths.set(bodyId, to);
	}
	boundaries.push(store.currentSequence());
	for (let i = 0; i < bodies; i += 3) {
		const bodyId = `body-${String(i).padStart(5, "0")}`;
		mutate(store, { bodyId, fileId: `file-${i}`, path: paths.get(bodyId)!, previousPath: null, lifecycle: "tombstoned", bodyGeneration: 1 });
	}
	boundaries.push(store.currentSequence());
	for (let i = 0; i < bodies; i += 9) {
		const bodyId = `body-${String(i).padStart(5, "0")}`;
		mutate(store, { bodyId, fileId: `file-${i}`, path: paths.get(bodyId)!, previousPath: null, lifecycle: "active", bodyGeneration: 1 });
	}
	// Canvas and attachment history written directly: only the read paths are under test.
	let sequence = store.currentSequence();
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < Math.max(4, bodies / 10); i++) {
			sequence++;
			sqlite.sql.exec(`INSERT INTO vault_semantic_catalog_events(sequence, document_id, file_id, kind, format, format_version,
			 path, previous_path, lifecycle, generation, document_epoch, content_hash, size, mutation_index)
			 VALUES (?, ?, ?, 'canvas', 'json-canvas', 1, ?, NULL, ?, ?, 1, NULL, NULL, 0)`, sequence, `canvas-${i}`, `cfile-${i}`,
			`c/${i}-${round}.canvas`, round === 1 && i % 2 === 0 ? "tombstoned" : "active", round + 1).toArray();
			sqlite.sql.exec(`INSERT INTO vault_attachment_catalog_events(sequence, path, content_hash, size, mime, lifecycle, operation_id)
			 VALUES (?, ?, ?, 10, 'image/png', ?, ?)`, sequence, `a/${i}.png`,
			round === 2 && i % 3 === 0 ? null : `${String((i + round) % 7).repeat(64)}`,
			round === 2 && i % 3 === 0 ? "tombstoned" : "active", `op-${round}-${i}`).toArray();
		}
		boundaries.push(sequence);
	}
	sqlite.sql.exec("UPDATE vault_clock SET sequence = ?", sequence).toArray();
	boundaries.push(sequence);
	return [0, ...boundaries];
}

// ---- legacy (3908abe) GROUP BY queries, kept only as the correctness oracle ----
const legacyActiveAtPath = `SELECT e.body_id FROM vault_catalog_events e
	JOIN (SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events WHERE sequence <= ? GROUP BY body_id) latest
	  ON latest.body_id = e.body_id AND latest.sequence = e.sequence
	WHERE e.path = ? AND e.lifecycle = 'active'`;
const legacyCountActive = `SELECT COUNT(*) AS count FROM vault_catalog_events e
	JOIN (SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events WHERE sequence <= ? GROUP BY body_id) latest
	  ON latest.body_id = e.body_id AND latest.sequence = e.sequence WHERE e.lifecycle = 'active'`;
const legacyMarkdownHeads = `SELECT e.sequence, e.body_id, e.path, e.lifecycle FROM vault_catalog_events e
	JOIN (SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events WHERE sequence <= ? GROUP BY body_id) latest
	  ON latest.body_id = e.body_id AND latest.sequence = e.sequence ORDER BY e.body_id`;
const legacySemanticHeads = `SELECT e.sequence, e.document_id, e.lifecycle FROM vault_semantic_catalog_events e
	JOIN (SELECT document_id, MAX(sequence) AS sequence FROM vault_semantic_catalog_events WHERE sequence <= ? GROUP BY document_id) latest
	  ON latest.document_id = e.document_id AND latest.sequence = e.sequence ORDER BY e.document_id`;
const legacyAttachmentHeads = `SELECT e.sequence, e.path, e.lifecycle, e.content_hash FROM vault_attachment_catalog_events e
	JOIN (SELECT path, MAX(sequence) AS sequence FROM vault_attachment_catalog_events WHERE sequence <= ? GROUP BY path) latest
	  ON latest.path = e.path AND latest.sequence = e.sequence ORDER BY e.path`;
const legacyBlobs = `WITH current_paths AS (
	  SELECT e.content_hash FROM vault_attachment_catalog_events e JOIN (
	    SELECT path, MAX(sequence) AS sequence FROM vault_attachment_catalog_events WHERE sequence <= ? GROUP BY path
	  ) latest ON latest.path = e.path AND latest.sequence = e.sequence WHERE e.content_hash IS NOT NULL
	), first_blob AS (
	  SELECT e.content_hash, MIN(e.sequence) AS sequence FROM vault_attachment_catalog_events e
	  JOIN current_paths c ON c.content_hash = e.content_hash
	  WHERE e.sequence <= ? AND e.lifecycle = 'active' GROUP BY e.content_hash
	), first_blob_row AS (
	  SELECT e.content_hash, e.sequence, MIN(e.path) AS path FROM vault_attachment_catalog_events e
	  JOIN first_blob f ON f.content_hash = e.content_hash AND f.sequence = e.sequence
	  WHERE e.lifecycle = 'active' GROUP BY e.content_hash, e.sequence
	)
	SELECT e.content_hash, e.size, e.mime FROM vault_attachment_catalog_events e JOIN first_blob_row f
	  ON f.content_hash = e.content_hash AND f.sequence = e.sequence AND f.path = e.path ORDER BY e.content_hash`;

type Internal = VaultStore & {
	activeBodiesAtPath(boundary: number, path: string): string[];
};

s.test("rewritten catalog queries match the legacy GROUP BY results at every boundary", async () => {
	await withStore((store, sqlite) => {
		const boundaries = seed(store, sqlite, 120);
		const internal = store as Internal;
		const samplePaths = ["notes/n1.md", "notes/n0.md", "renamed/r0.md", "renamed/r2.md", "notes/n3.md", "renamed/r18.md", "missing.md"];
		for (const boundary of [...boundaries, boundaries.at(-1)! + 5]) {
			assert.equal(store.countActiveCatalogAt(boundary), sqlite.sql.exec<{ count: number }>(legacyCountActive, boundary).one().count,
				`active count at ${boundary}`);
			for (const path of samplePaths) {
				assert.deepEqual(internal.activeBodiesAtPath(boundary, path),
					sqlite.sql.exec<{ body_id: string }>(legacyActiveAtPath, boundary, path).toArray().map((row) => row.body_id).sort(),
					`owners of ${path} at ${boundary}`);
			}
			const snapshot = store.rootAuthoritySnapshotAt(boundary);
			assert.deepEqual(snapshot.markdown.map((row) => [row.sequence, row.bodyId, row.path, row.lifecycle]),
				sqlite.sql.exec<{ sequence: number; body_id: string; path: string; lifecycle: string }>(legacyMarkdownHeads, boundary)
					.toArray().map((row) => [row.sequence, row.body_id, row.path, row.lifecycle]), `markdown heads at ${boundary}`);
			const semantic = sqlite.sql.exec<{ sequence: number; document_id: string; lifecycle: string }>(legacySemanticHeads, boundary).toArray();
			assert.deepEqual(snapshot.semantic.map((row) => [row.sequence, row.documentId, row.lifecycle]),
				semantic.map((row) => [row.sequence, row.document_id, row.lifecycle]), `semantic heads at ${boundary}`);
			assert.deepEqual(store.listActiveSemanticAt(boundary).map((row) => row.documentId),
				semantic.filter((row) => row.lifecycle === "active").map((row) => row.document_id));
			assert.equal(store.countActiveSemanticAt(boundary), semantic.filter((row) => row.lifecycle === "active").length);
			const attachments = sqlite.sql.exec<{ sequence: number; path: string; lifecycle: string; content_hash: string | null }>(
				legacyAttachmentHeads, boundary).toArray();
			assert.deepEqual(snapshot.attachments.map((row) => [row.sequence, row.path, row.lifecycle, row.contentHash]),
				attachments.map((row) => [row.sequence, row.path, row.lifecycle, row.content_hash]), `attachments at ${boundary}`);
			assert.deepEqual(store.attachmentCatalogAt(boundary, "", 3).map((row) => row.path), attachments.slice(0, 3).map((row) => row.path));
			assert.deepEqual(store.activeAttachmentCatalogAt(boundary).map((row) => row.path),
				attachments.filter((row) => row.lifecycle === "active").map((row) => row.path));
			assert.deepEqual(snapshot.blobs.map((row) => [row.contentHash, row.size, row.mime]),
				sqlite.sql.exec<{ content_hash: string; size: number; mime: string }>(legacyBlobs, boundary, boundary)
					.toArray().map((row) => [row.content_hash, row.size, row.mime]), `blobs at ${boundary}`);
		}
	});
});

s.test("EXPLAIN QUERY PLAN: mutation, bootstrap and alarm catalog queries use indexes only (no SCAN, no TEMP B-TREE)", async () => {
	await withStore((store, sqlite, recorder) => {
		const boundaries = seed(store, sqlite, 60);
		const internal = store as Internal;
		const current = store.currentSequence();
		const historical = boundaries[2]!;
		const cases: Array<[string, () => void]> = [
			["activeBodiesAtPath cold (index build)", () => internal.activeBodiesAtPath(current, "notes/n1.md")],
			["activeBodiesAtPath warm", () => internal.activeBodiesAtPath(current, "notes/n1.md")],
			["activeBodiesAtPath historical", () => internal.activeBodiesAtPath(historical, "notes/n1.md")],
			["activeCatalogHeadAtPath", () => store.activeCatalogHeadAtPath(current, "notes/n1.md")],
			["countActiveCatalogAt current", () => store.countActiveCatalogAt(current)],
			["countActiveCatalogAt historical", () => store.countActiveCatalogAt(historical)],
			["rootAuthoritySnapshotAt", () => store.rootAuthoritySnapshotAt(current)],
			["listActiveSemanticAt", () => store.listActiveSemanticAt(current)],
			["countActiveSemanticAt", () => store.countActiveSemanticAt(historical)],
			["attachmentCatalogAt", () => store.attachmentCatalogAt(current, "", 5)],
			["activeAttachmentCatalogAt", () => store.activeAttachmentCatalogAt(historical, "a/1.png", 5)],
			["listCatalogAt", () => store.listCatalogAt(historical, "", 10)],
			["listActiveCatalogAt", () => store.listActiveCatalogAt(current, "", 10)],
			["listJournalCheckpointCandidates", () => store.listJournalCheckpointCandidates(1, 1, 25)],
		];
		for (const [label, action] of cases) assertIndexedPlans(sqlite, record(recorder, action), label);
		// The detector itself: the legacy GROUP BY form is rejected.
		assert.throws(() => assertIndexedPlans(sqlite, [{ query: legacyCountActive, bindings: [current] }], "legacy"), /full scan/);
		// A mutation after the index is warm reads only the appended events.
		mutate(store, { bodyId: "body-new", fileId: "file-new", path: "fresh.md", previousPath: null, lifecycle: "active", bodyGeneration: 1 });
		const afterMutation = store.currentSequence();
		const refresh = record(recorder, () => internal.activeBodiesAtPath(afterMutation, "fresh.md"));
		assertIndexedPlans(sqlite, refresh, "activeBodiesAtPath after mutation");
		assert.equal(refresh.length, 1, `warm path check is one primary-key range read of the new events: ${JSON.stringify(refresh.map((r) => r.query))}`);
	});
});

s.test("path uniqueness: conflicts are rejected and rollbacks never leave a stale path index", async () => {
	await withStore((store, sqlite) => {
		seed(store, sqlite, 12);
		const internal = store as Internal;
		// Store-guarded rollback: the conflict throws inside the store's transaction.
		assert.throws(() => mutate(store, { bodyId: "intruder", fileId: "f-x", path: "notes/n1.md", previousPath: null,
			lifecycle: "active", bodyGeneration: 1 }), /active_path_conflict/);
		assert.deepEqual(internal.activeBodiesAtPath(store.currentSequence(), "notes/n1.md"), ["body-00001"]);
		// Foreign rollback (outside the store's guard) after the index absorbed an
		// uncommitted event, then the same sequence reused by a different event.
		const before = store.currentSequence();
		assert.throws(() => sqlite.transactionSync(() => {
			mutate(store, { bodyId: "ghost", fileId: "f-g", path: "ghost.md", previousPath: null, lifecycle: "active", bodyGeneration: 1 });
			assert.deepEqual(internal.activeBodiesAtPath(store.currentSequence(), "ghost.md"), ["ghost"]);
			throw new Error("abort");
		}), /abort/);
		assert.equal(store.currentSequence(), before);
		mutate(store, { bodyId: "real", fileId: "f-r", path: "real.md", previousPath: null, lifecycle: "active", bodyGeneration: 1 });
		assert.equal(store.currentSequence(), before + 1, "sequence reused after the rollback");
		assert.deepEqual(internal.activeBodiesAtPath(store.currentSequence(), "ghost.md"), [], "rolled-back owner is gone");
		assert.deepEqual(internal.activeBodiesAtPath(store.currentSequence(), "real.md"), ["real"]);
		mutate(store, { bodyId: "ghost2", fileId: "f-g2", path: "ghost.md", previousPath: null, lifecycle: "active", bodyGeneration: 1 });
		assert.equal(store.countActiveCatalogAt(store.currentSequence()),
			sqlite.sql.exec<{ count: number }>(legacyCountActive, store.currentSequence()).one().count);
		// A rename frees the old path for another body in the same vault.
		mutate(store, { bodyId: "real", fileId: "f-r", path: "real2.md", previousPath: "real.md", lifecycle: "active", bodyGeneration: 1 });
		mutate(store, { bodyId: "taker", fileId: "f-t", path: "real.md", previousPath: null, lifecycle: "active", bodyGeneration: 1 });
		assert.deepEqual(internal.activeBodiesAtPath(store.currentSequence(), "real.md"), ["taker"]);
	});
});

await s.done();
