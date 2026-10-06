// P3 evidence: Durable Object rows read by the catalog queries, before
// (3908abe GROUP BY) and after (skip-scan + in-memory path index), on a
// 10k-event catalog. Statements are recorded from both store versions running
// on the same Node SQLite file, then replayed in a local workerd SQLite Durable
// Object (miniflare) whose `cursor.rowsRead` is the billed metric.
//
// usage: node tests/run-typescript.mjs --test-aliases scripts/relay2/catalog-rows-read.ts <legacy-root> [out.json]
//   <legacy-root> holds `git archive 3908abe server/src packages/server-node/src`
//   plus a node_modules symlink.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as Y from "yjs";
import { NodeSqliteStorage } from "../../tests/server/helpers/nodeSqliteStorage";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import type { CatalogMutation } from "../../server/src/vaultCatalogStore";

interface Recorded { query: string; bindings: unknown[] }
interface Recording { on: boolean; log: Recorded[] }
type AnyStore = VaultStore & { activeBodiesAtPath(boundary: number, path: string): string[] };

const legacyRoot = resolve(process.argv[2] ?? "");
const outFile = process.argv[3];
const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

function recordingStorage(sqlite: NodeSqliteStorage, recording: Recording): VaultStoragePort {
	return {
		sql: { exec(query: string, ...bindings: unknown[]) {
			if (recording.on) recording.log.push({ query, bindings });
			return sqlite.sql.exec(query, ...bindings);
		} },
		transactionSync<T>(closure: () => T): T { return sqlite.transactionSync(closure); },
	} as unknown as VaultStoragePort;
}

function record(recording: Recording, action: () => unknown): Recorded[] {
	recording.log = [];
	recording.on = true;
	try { action(); } finally { recording.on = false; }
	return recording.log;
}

function commit(store: VaultStore, mutation: CatalogMutation): void {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, mutation.path);
	store.commitUpdate({ documentId: mutation.bodyId, update: Y.encodeStateAsUpdate(doc), kind: "body", catalog: [mutation] });
	doc.destroy();
}

function seed(store: VaultStore, sqlite: NodeSqliteStorage, bodies: number, eventsPerBody: number): void {
	const pad = (i: number) => String(i).padStart(6, "0");
	for (let i = 0; i < bodies; i++) {
		commit(store, { bodyId: `body-${pad(i)}`, fileId: `file-${i}`, path: `notes/${pad(i)}.md`, previousPath: null, lifecycle: "active", bodyGeneration: 1 });
	}
	for (let round = 1; round < eventsPerBody; round++) {
		for (let i = 0; i < bodies; i++) {
			const from = round === 1 ? `notes/${pad(i)}.md` : `r${round - 1}/${pad(i)}.md`;
			const last = round === eventsPerBody - 1;
			commit(store, { bodyId: `body-${pad(i)}`, fileId: `file-${i}`, path: last && i % 5 === 0 ? from : `r${round}/${pad(i)}.md`,
				previousPath: last && i % 5 === 0 ? null : from, lifecycle: last && i % 5 === 0 ? "tombstoned" : "active", bodyGeneration: 1 });
		}
	}
	let sequence = store.currentSequence();
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < 200; i++) {
			sequence++;
			if (i < 50) sqlite.sql.exec(`INSERT INTO vault_semantic_catalog_events(sequence, document_id, file_id, kind, format, format_version,
			 path, previous_path, lifecycle, generation, document_epoch, content_hash, size, mutation_index)
			 VALUES (?, ?, ?, 'canvas', 'json-canvas', 1, ?, NULL, 'active', ?, 1, NULL, NULL, 0)`, sequence, `canvas-${i}`, `cfile-${i}`,
			`c/${i}-${round}.canvas`, round + 1).toArray();
			sqlite.sql.exec(`INSERT INTO vault_attachment_catalog_events(sequence, path, content_hash, size, mime, lifecycle, operation_id)
			 VALUES (?, ?, ?, 10, 'image/png', 'active', ?)`, sequence, `a/${i}.png`, `${(i * 7 + round).toString(16).padStart(64, "0")}`,
			`op-${round}-${i}`).toArray();
		}
	}
	sqlite.sql.exec("UPDATE vault_clock SET sequence = ?", sequence).toArray();
}

function dump(sqlite: NodeSqliteStorage): Recorded[] {
	const statements: Recorded[] = [];
	const objects = sqlite.sql.exec<{ type: string; name: string; sql: string | null }>(
		"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type = 'index', rowid",
	).toArray();
	for (const object of objects) if (object.sql) statements.push({ query: object.sql, bindings: [] });
	for (const object of objects.filter((entry) => entry.type === "table")) {
		const rows = sqlite.sql.exec<Record<string, unknown>>(`SELECT * FROM "${object.name}"`).toArray();
		for (const row of rows) {
			const columns = Object.keys(row);
			statements.push({
				query: `INSERT INTO "${object.name}"(${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				bindings: columns.map((c) => row[c]),
			});
		}
	}
	return statements;
}

function encode(value: unknown): unknown {
	if (value instanceof Uint8Array) return { $b: Buffer.from(value).toString("base64") };
	if (value instanceof ArrayBuffer) return { $b: Buffer.from(value).toString("base64") };
	return value;
}

const WORKER = `
const decode = (v) => v && typeof v === "object" && "$b" in v ? Uint8Array.from(atob(v.$b), (c) => c.charCodeAt(0)).buffer : v;
export class Replay {
  constructor(state) { this.sql = state.storage.sql; }
  async fetch(request) {
    const body = await request.json();
    const out = [];
    for (const st of body.statements) {
      const cursor = this.sql.exec(st.query, ...st.bindings.map(decode));
      const rows = cursor.toArray();
      out.push({ rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten, rows: rows.length });
    }
    return Response.json(out);
  }
}
export default { fetch(request, env) { return env.REPLAY.get(env.REPLAY.idFromName(new URL(request.url).pathname)).fetch(request); } };`;

async function main(): Promise<void> {
	const requireFromServer = createRequire(join(repoRoot, "server/package.json"));
	// Node's own require (not the jiti loader, which breaks miniflare's CJS bundle).
	const { Miniflare } = requireFromServer("miniflare") as typeof import("miniflare");
	const legacy = await import(pathToFileURL(join(legacyRoot, "server/src/vaultStore.ts")).href) as { VaultStore: new (s: VaultStoragePort) => AnyStore };
	const mf = new Miniflare({
		modules: true, script: WORKER, compatibilityDate: "2025-01-01",
		durableObjects: { REPLAY: { className: "Replay", useSQLite: true } },
	});
	let dbCounter = 0;
	async function replay(db: string, statements: Recorded[]): Promise<Array<{ rowsRead: number; rowsWritten: number; rows: number }>> {
		const out: Array<{ rowsRead: number; rowsWritten: number; rows: number }> = [];
		for (let offset = 0; offset < statements.length; offset += 2000) {
			const response = await mf.dispatchFetch(`http://replay/${db}`, { method: "POST",
				body: JSON.stringify({ statements: statements.slice(offset, offset + 2000).map((st) => ({ query: st.query, bindings: st.bindings.map(encode) })) }) });
			if (!response.ok) throw new Error(`replay failed: ${response.status} ${await response.text()}`);
			out.push(...await response.json() as typeof out);
		}
		return out;
	}
	const results: Record<string, unknown> = {};
	for (const shape of [{ name: "10k-bodies-x1", bodies: 10_000, events: 1 }, { name: "2500-bodies-x4", bodies: 2_500, events: 4 }]) {
		const directory = await mkdtemp(join(tmpdir(), "yaos-catalog-rows-"));
		const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
		try {
			const recording: Recording = { on: false, log: [] };
			const writer = new VaultStore(recordingStorage(sqlite, recording)) as AnyStore;
			const t0 = Date.now();
			seed(writer, sqlite, shape.bodies, shape.events);
			const seedMs = Date.now() - t0;
			// One more create through a warm store: the per-mutation path check.
			const warm = writer;
			warm.activeBodiesAtPath(warm.currentSequence(), "fresh.md");
			commit(warm, { bodyId: "body-fresh", fileId: "file-fresh", path: "fresh.md", previousPath: null, lifecycle: "active", bodyGeneration: 1 });
			const current = warm.currentSequence();
			const historical = current - 100;
			const fresh = new VaultStore(recordingStorage(sqlite, recording)) as AnyStore;
			const old = new legacy.VaultStore(recordingStorage(sqlite, recording));
			old.currentSequence();
			fresh.currentSequence();
			const catalogEvents = sqlite.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM vault_catalog_events").one().c;
			const scenarios: Array<[string, Recorded[], Recorded[]]> = [
				["path check (mutation): after one new event, warm", record(recording, () => old.activeBodiesAtPath(current, "notes/000001.md")),
					record(recording, () => warm.activeBodiesAtPath(current, "notes/000001.md"))],
				["path check (mutation): warm, no new events", record(recording, () => old.activeBodiesAtPath(current, "x.md")),
					record(recording, () => warm.activeBodiesAtPath(current, "x.md"))],
				["path check (mutation): cold instance (index build)", record(recording, () => old.activeBodiesAtPath(current, "x.md")),
					record(recording, () => fresh.activeBodiesAtPath(current, "x.md"))],
				["countActiveCatalogAt current (bootstrap)", record(recording, () => old.countActiveCatalogAt(current)),
					record(recording, () => warm.countActiveCatalogAt(current))],
				["countActiveCatalogAt current-100 (bootstrap)", record(recording, () => old.countActiveCatalogAt(historical)),
					record(recording, () => warm.countActiveCatalogAt(historical))],
				["countActiveSemanticAt (bootstrap)", record(recording, () => old.countActiveSemanticAt(current)),
					record(recording, () => warm.countActiveSemanticAt(current))],
				["rootAuthoritySnapshotAt (canvas compaction)", record(recording, () => old.rootAuthoritySnapshotAt(current)),
					record(recording, () => warm.rootAuthoritySnapshotAt(current))],
				["activeAttachmentCatalogAt page of 100", record(recording, () => old.activeAttachmentCatalogAt(current, "", 100)),
					record(recording, () => warm.activeAttachmentCatalogAt(current, "", 100))],
				["listJournalCheckpointCandidates, every body journaled (alarm)", record(recording, () => old.listJournalCheckpointCandidates(50, 1 << 20, 25)),
					record(recording, () => warm.listJournalCheckpointCandidates(50, 1 << 20, 25))],
			];
			const db = `db-${dbCounter++}`;
			await replay(db, dump(sqlite));
			// Steady state: checkpointed bodies have no journal rows; keep 20.
			sqlite.sql.exec("DELETE FROM vault_journal WHERE document_id NOT IN (SELECT document_id FROM vault_journal GROUP BY document_id ORDER BY document_id LIMIT 20)").toArray();
			const idle: [string, Recorded[], Recorded[]] = ["listJournalCheckpointCandidates, 20 bodies journaled (alarm)",
				record(recording, () => old.listJournalCheckpointCandidates(50, 1 << 20, 25)),
				record(recording, () => warm.listJournalCheckpointCandidates(50, 1 << 20, 25))];
			const idleDb = `db-${dbCounter++}`;
			await replay(idleDb, dump(sqlite));
			const rows: Array<Record<string, unknown>> = [];
			for (const [label, before, after] of scenarios) {
				const b = await replay(db, before), a = await replay(db, after);
				rows.push({ scenario: label, beforeRowsRead: b.reduce((sum, r) => sum + r.rowsRead, 0), beforeStatements: b.length,
					afterRowsRead: a.reduce((sum, r) => sum + r.rowsRead, 0), afterStatements: a.length });
			}
			{
				const [label, before, after] = idle;
				const b = await replay(idleDb, before), a = await replay(idleDb, after);
				rows.push({ scenario: label, beforeRowsRead: b.reduce((sum, r) => sum + r.rowsRead, 0), beforeStatements: b.length,
					afterRowsRead: a.reduce((sum, r) => sum + r.rowsRead, 0), afterStatements: a.length });
			}
			results[shape.name] = { catalogEvents, bodies: shape.bodies + 1, seedMs, rows };
			console.log(`\n== ${shape.name}: ${catalogEvents} catalog events, ${shape.bodies + 1} bodies (local workerd rowsRead)`);
			console.table(rows);
		} finally {
			sqlite.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
	await mf.dispose();
	if (outFile) await writeFile(outFile, JSON.stringify(results, null, 2));
}

await main();
