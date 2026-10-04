// b3-n2: create-bulk reads per batch are O(batch), not O(vault).
//
// Before b3-n2, `VaultStore.activeCatalogHeadsAtPaths` (the D3 "occupied path"
// check, run twice per batch: service routing and the commit's re-check) was a
// GROUP BY body_id over every catalog event. Under workerd that read ~2 rows per
// vault body per call, so reads per batch grew linearly and a first-open import
// read O(N^2) rows in total (10k: 1.17M, M). It now reads the in-memory catalog
// path index (no new SQLite index, P3).
//
// Through the real VaultRuntime (create-bulk route, root flush, inline recovery
// projection hook), relay3 config (lean rows + relay bodies + group commit):
//   1. EXPLAIN QUERY PLAN for every statement a warm create-bulk batch issues
//      (fresh paths, an occupied path, an attachment): no SCAN of a real table
//      (one allowlisted rowid LIMIT 1) and no AUTOMATIC index.
//   2. Estimated billed reads per batch (rows returned + the row count of every
//      table a statement's plan scans; Node's rowsRead alone counts returned
//      rows only) stay flat: batch 20 / batch 1 <= 1.5.
//   3. The occupied-path check still answers exists-identical / exists-different
//      for paths created many batches earlier and after a rename (path index).
// Exact workerd rows read per batch: scripts/b3measure/bulkreads.ts.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import { VaultRuntime } from "../../server/src/server";
import { readRelayConfig } from "../../server/src/relayFlag";
import type { VaultStore } from "../../server/src/vaultStore";
import { actorHeaders } from "../../server/src/vaultAuthority";
import type { VaultActorContext } from "../../server/src/collaboration";
import type { BulkCreateOutcome } from "../../server/src/vaultBulkCreateService";
import { FakeObjectStore } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("bulk-create-reads");

const VAULT_ID = "bulk-reads-vault";
const GENERATION = "bulk-reads-generation";
const OWNER: VaultActorContext = { vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "p-owner", membershipRevision: 1,
	deviceId: "d-owner", deviceCredentialRevision: 1, role: "owner", policyVersion: 1, capabilityDigest: "owner-digest" };

const frames = new Map<string, Uint8Array>();
function frame(value: string): Uint8Array {
	const known = frames.get(value);
	if (known) return known;
	const doc = new Y.Doc();
	doc.getText("body").insert(0, value);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	frames.set(value, update);
	return update;
}
const text = (i: number) => `# Note ${i}\n\n${`Line ${i} of ordinary prose for sizing.\n`.repeat(8)}`;
const fileOf = (i: number, path = `f${i % 10}/n-${i}.md`, body = text(i)) =>
	({ operationId: `op-${i}`, bodyId: `body-${i}`, path, updates: [frame(body)] });

interface Recorded { query: string; bindings: unknown[]; cursor: { rowsRead: number } }

interface World {
	vault: VaultRuntime;
	store: VaultStore;
	sqlite: NodeSqliteStorage;
	recording: { on: boolean; log: Recorded[] };
	objects: FakeObjectStore;
	bulk(batchId: string, files: unknown[], attachments?: unknown[]): Promise<BulkCreateOutcome[]>;
	settle(): Promise<void>;
}

async function withWorld(check: (world: World) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-bulk-reads-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const recording: World["recording"] = { on: false, log: [] };
	const sql = new Proxy(sqlite.sql, { get(target, property) {
		if (property === "exec") {
			return (query: string, ...bindings: unknown[]) => {
				const cursor = target.exec(query, ...(bindings as never[]));
				if (recording.on) recording.log.push({ query, bindings, cursor: cursor as unknown as { rowsRead: number } });
				return cursor;
			};
		}
		const value = Reflect.get(target, property, target) as unknown;
		return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
	} });
	const storage = new Proxy(sqlite, { get(target, property) {
		if (property === "sql") return sql;
		const value = Reflect.get(target, property, target) as unknown;
		return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
	} });
	const tasks = new Set<Promise<unknown>>();
	let alarm: number | null = null;
	const objects = new FakeObjectStore();
	const vault = new VaultRuntime({ storage: storage as never,
		sockets: { sockets: () => [], createPair: () => { throw new Error("no sockets"); }, accept: () => {},
			upgradeResponse: () => { throw new Error("no sockets"); } },
		alarms: { setAlarm: async (at: number) => { alarm = at; }, deleteAlarm: async () => { alarm = null; }, getAlarm: async () => alarm },
		execution: { waitUntil: (task) => { const tracked = task.finally(() => tasks.delete(tracked)); tasks.add(tracked); } },
		objectStore: objects, recoveryJobs: { call: async () => new Response("{}", { status: 503 }) },
		relayBodies: true, relayConfig: readRelayConfig({ YAOS_RELAY_LEAN_ROWS: "true", YAOS_RELAY_GROUP_COMMIT: "1" }) });
	const fetchVault = async (path: string, init: RequestInit = {}) => {
		const headers = actorHeaders(OWNER);
		new Headers(init.headers).forEach((value, key) => headers.set(key, value));
		headers.set("x-yaos-vault-id", VAULT_ID);
		headers.set("x-yaos-vault-generation", GENERATION);
		return await vault.fetch(new Request(`https://internal${path}`, { ...init, headers }));
	};
	const settle = async () => {
		await new Promise((resolve) => setTimeout(resolve, 2));
		while (tasks.size) await Promise.all([...tasks]);
	};
	try {
		assert.equal((await fetchVault("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) })).status, 201);
		const store = (vault as unknown as { store: VaultStore }).store;
		store.installAuthorityFence({ changeId: "b", vaultId: VAULT_ID, vaultGeneration: GENERATION, subjectDigest: "d", subjects: [
			{ principalId: OWNER.principalId, role: OWNER.role, state: "active", membershipRevision: 1, policyVersion: 1,
				capabilityDigest: OWNER.capabilityDigest, displayName: "O", colorSeed: "o" },
			{ deviceId: OWNER.deviceId, principalId: OWNER.principalId, state: "active", credentialRevision: 1 }] } as never);
		await settle();
		const bulk = async (batchId: string, files: unknown[], attachments: unknown[] = []) => {
			const rootEpoch = store.documentHead("root")?.semanticEpoch ?? 1;
			const body = encodeBinaryEnvelope({ batchId, rootEpoch, files, attachments });
			const response = await fetchVault("/lifecycle/create-bulk", { method: "POST", body: body.slice().buffer });
			assert.equal(response.status, 200, await response.clone().text());
			const decoded = decodeBinaryEnvelope(new Uint8Array(await response.arrayBuffer())) as { outcomes: BulkCreateOutcome[] };
			await settle();
			return decoded.outcomes;
		};
		await check({ vault, store, sqlite, recording, objects, bulk, settle });
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function recorded(world: World, action: () => Promise<unknown>): Promise<Recorded[]> {
	world.recording.log = [];
	world.recording.on = true;
	try { await action(); } finally { world.recording.on = false; }
	return world.recording.log;
}

/**
 * Real-table scans that read O(1) rows: `recovery_gc_epochs.epoch` is the INTEGER PRIMARY KEY (rowid), so
 * `ORDER BY epoch DESC LIMIT 1` walks the rowid b-tree backwards and stops at the first row (workerd: 1 row read).
 */
const BOUNDED_SCANS = [/^\s*SELECT epoch FROM recovery_gc_epochs ORDER BY epoch DESC LIMIT 1\s*$/];

function realTables(sqlite: NodeSqliteStorage): Set<string> {
	return new Set(sqlite.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => row.name));
}

function planOf(sqlite: NodeSqliteStorage, statement: Recorded): string[] {
	return sqlite.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement.query}`, ...(statement.bindings as never[]))
		.toArray().map((row) => row.detail);
}

/** Real tables a plan walks in full ("SCAN t", "SCAN t USING [COVERING] INDEX i"); virtual tables, CTEs and subqueries excluded. */
function scannedTables(plan: string[], tables: Set<string>): string[] {
	return plan.flatMap((detail) => {
		const match = /^SCAN (\w+)/.exec(detail);
		return match && tables.has(match[1]!) ? [match[1]!] : [];
	});
}

/** Billed-read estimate for a recorded batch: rows returned plus a full table's rows for every scan in a plan. */
function estimatedReads(sqlite: NodeSqliteStorage, statements: Recorded[]): number {
	const tables = realTables(sqlite);
	const counts = new Map<string, number>();
	const rows = (table: string) => {
		if (!counts.has(table)) counts.set(table, sqlite.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`).one().n);
		return counts.get(table)!;
	};
	let total = 0;
	for (const statement of statements) {
		total += Number(statement.cursor.rowsRead) || 0;
		if (!/^\s*(SELECT|WITH)\b/i.test(statement.query)) continue;
		for (const table of scannedTables(planOf(sqlite, statement), tables)) total += rows(table);
	}
	return total;
}

s.test("every statement of a warm create-bulk batch plans without a full scan", async () => {
	await withWorld(async (world) => {
		const blob = new TextEncoder().encode("attachment bytes");
		const hash = (await import("node:crypto")).createHash("sha256").update(blob).digest("hex");
		await world.objects.put(`blobs/${hash}`, blob);
		for (let b = 0; b < 3; b++) await world.bulk(`seed-${b}`, Array.from({ length: 40 }, (_v, k) => fileOf(b * 40 + k)));
		const statements = await recorded(world, () => world.bulk("probe", [
			...Array.from({ length: 30 }, (_v, k) => fileOf(1000 + k)),
			{ ...fileOf(5), operationId: "op-re-5", bodyId: "body-re-5" },
			{ ...fileOf(2000, "f5/n-15.md", "different body\n") },
		], [{ operationId: "att-1", path: "img/a.png", hash, size: blob.byteLength, mime: "image/png" }]));
		assert.ok(statements.length > 0);
		const tables = realTables(world.sqlite);
		const offenders: string[] = [];
		for (const statement of statements) {
			const plan = planOf(world.sqlite, statement);
			const joined = plan.join(" | ");
			const scans = scannedTables(plan, tables);
			// A temp b-tree only sorts/groups what the plan's SEARCHes return (one document's chunks or
			// journal rows): bounded by key, never by vault size. A real-table SCAN is the O(vault) signal.
			const bounded = BOUNDED_SCANS.some((pattern) => pattern.test(statement.query));
			if ((scans.length > 0 && !bounded) || /AUTOMATIC/.test(joined)) {
				offenders.push(`${joined} :: ${statement.query.replace(/\s+/g, " ").slice(0, 160)}`);
			}
		}
		assert.deepEqual([...new Set(offenders)], [], "create-bulk statements with a full scan / temp b-tree");
	});
});

s.test("estimated billed reads per batch stay flat as the vault grows (batch 20 / batch 1 <= 1.5)", async () => {
	await withWorld(async (world) => {
		const BATCH = 100;
		const reads: number[] = [];
		// A full-size warm batch: the path index refresh re-reads the previous batch's tip rows.
		await world.bulk("warm", Array.from({ length: BATCH }, (_v, k) => fileOf(100_000 + k, `warm/w-${k}.md`)));
		for (let b = 0; b < 20; b++) {
			const files = Array.from({ length: BATCH }, (_v, k) => fileOf(b * BATCH + k));
			const statements = await recorded(world, () => world.bulk(`batch-${b}`, files));
			reads.push(estimatedReads(world.sqlite, statements));
		}
		const ratio = reads[19]! / reads[0]!;
		assert.ok(ratio <= 1.5, `reads per batch grew with the vault: ${reads.join(", ")} (ratio ${ratio.toFixed(2)})`);
	});
});

s.test("occupied paths from early batches and renamed paths still route as exists-*", async () => {
	await withWorld(async (world) => {
		for (let b = 0; b < 5; b++) await world.bulk(`seed-${b}`, Array.from({ length: 20 }, (_v, k) => fileOf(b * 20 + k)));
		const outcomes = await world.bulk("reoffer", [
			{ ...fileOf(0), operationId: "op-re-0", bodyId: "body-re-0" },
			{ ...fileOf(1, "f1/n-1.md", "changed\n"), operationId: "op-re-1", bodyId: "body-re-1" },
			{ ...fileOf(500, "fresh/n-500.md"), operationId: "op-new" },
		]);
		assert.deepEqual(outcomes.map((item) => [item.outcome, item.existingBodyId ?? null]), [
			["exists-identical", "body-0"], ["exists-different", "body-1"], ["created", null]]);
		// The in-memory index follows a rename: the old path frees, the new one is occupied.
		const before = world.store.getCatalogHeadAt(world.store.currentSequence(), "body-2")!;
		const doc = new Y.Doc();
		doc.getText("body").insert(0, "renamed\n");
		world.store.commitUpdate({ documentId: "body-2", update: Y.encodeStateAsUpdate(doc), kind: "body", catalog: [
			{ bodyId: "body-2", fileId: before.fileId, path: "moved/n-2.md", previousPath: before.path, lifecycle: "active",
				bodyGeneration: (world.store.documentHead("body-2")?.generation ?? 1) + 1 }] });
		doc.destroy();
		const owners = world.store.activeCatalogHeadsAtPaths([before.path, "moved/n-2.md", "nowhere.md"]);
		assert.equal(owners.has(before.path), false, "renamed-away path is free");
		assert.equal(owners.get("moved/n-2.md")?.bodyId, "body-2");
		assert.equal(owners.has("nowhere.md"), false);
	});
});
await s.done();
