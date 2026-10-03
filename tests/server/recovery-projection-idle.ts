// Write-budget spike (idle drain), ported to relay v3 (batch 3): an idle vault does zero periodic work.
//
// Recovery projection used to be a polling RecoveryJob (one RPC per body, each a GROUP BY over
// the whole catalog). Since b3 P2 (snapshot format 4) it is a vault-local watermark pass that
// writes opaque, content-addressed state objects (stored CRDT bytes) to R2 on the debounced
// wake alarm: a catalog/journal write owes one wake, and an idle pass writes nothing and arms
// no alarm. Relay v3 group commits write neither a journal row nor a
// catalog event (only `relay_body_tail` and the head), so the tail is a projection input too.
// This suite wires a real VaultRuntime and RecoveryJobRuntime
// over real SQLite (NodeSqliteStorage) with a simulated clock and manual alarm hosts, seeds
// 100 notes, lets projection settle, then simulates an idle hour: no SQL statement may run in
// either actor and no alarm may be armed. A later mutation must still be projected.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { sha256HexSync } from "../../server/src/vaultDocumentStore";
import { VaultRuntime, isProjectionInputWrite } from "../../server/src/server";
import type { RelayBodyStore } from "../../server/src/relayBodyStore";
import { RecoveryJobRuntime } from "../../server/src/recoveryJob";
import { readRelayConfig } from "../../server/src/relayFlag";
import { contentObjectKey } from "../../server/src/recoveryProtocol";
import { VaultStore } from "../../server/src/vaultStore";
import { actorHeaders } from "../../server/src/vaultAuthority";
import type { VaultActorContext } from "../../server/src/collaboration";
import { FakeObjectStore } from "../mocks/workerEnv.ts";
import { decodeRecoveryStateObject } from "../../src/snapshots/recoveryStateDecode";
import { runStateProjectionPass, STATE_PROJECTION_LIMITS } from "../../server/src/recoveryStateProjection";
import { nextUtcMidnight } from "../../server/src/dailyLimit";
import { suite } from "../harness.ts";
import { recoveryRevisionIdentity } from "../../server/src/recoveryAuthorityStore";
import { RECOVERY_STATE_CONTENT_TYPE } from "../../server/src/shared/recoveryStateObject";
import { RecoveryClient, type RestoreItem } from "../../src/snapshots/recoveryClient";
import { DEFAULT_SETTINGS } from "../../src/settings";

const s = suite("recovery-projection-idle");

const VAULT_ID = "idle-vault-0001";
const GENERATION = "idle-generation-0001";
const OWNER: VaultActorContext = {
	vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "principal-owner", membershipRevision: 1,
	deviceId: "device-owner", deviceCredentialRevision: 1, role: "owner", policyVersion: 1, capabilityDigest: "owner-digest",
};

const realNow = Date.now;
let clock = realNow();

interface Counted { statements: number; written: number; reset(): void }

/** Counts every SQL statement and Node-written row an actor issues. */
function counted(sqlite: NodeSqliteStorage): { storage: NodeSqliteStorage; stats: Counted } {
	const stats: Counted = { statements: 0, written: 0, reset() { this.statements = 0; this.written = 0; } };
	const sql = new Proxy(sqlite.sql, {
		get(target, property) {
			if (property === "exec") {
				return (query: string, ...bindings: unknown[]) => {
					stats.statements++;
					const cursor = target.exec(query, ...(bindings as never[]));
					stats.written += cursor.rowsWritten;
					return cursor;
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
	const storage = new Proxy(sqlite, {
		get(target, property) {
			if (property === "sql") return sql;
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
	return { storage, stats };
}

class ManualAlarm {
	at: number | null = null;
	sets = 0;
	deletes = 0;
	readonly port = {
		setAlarm: async (scheduledTime: number) => { this.at = scheduledTime; this.sets++; },
		deleteAlarm: async () => { this.at = null; this.deletes++; },
		getAlarm: async () => this.at,
	};
	resetCounts(): void { this.sets = 0; this.deletes = 0; }
}

function note(i: number, salt = ""): string {
	const line = `Line of idle note ${i}${salt} with ordinary prose.\n`;
	return `# Note ${i}${salt}\n\n${line.repeat(20)}`;
}

function bodyFrame(text: string): Uint8Array {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, text);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}

function hashOf(text: string): string { return sha256HexSync(canonicalMarkdownBytes(text)); }
function sizeOf(text: string): number { return canonicalMarkdownBytes(text).byteLength; }

type Mode = "base" | "relay lean" | "relay v3";

interface World {
	vault: VaultRuntime;
	vaultSqlite: NodeSqliteStorage;
	jobSqlite: NodeSqliteStorage;
	vaultStats: Counted;
	jobStats: Counted;
	vaultAlarm: ManualAlarm;
	jobAlarm: ManualAlarm;
	vaultFetch(path: string, init?: RequestInit): Promise<Response>;
	createNotes(batch: string, notes: Array<{ name: string; text: string }>): Promise<void>;
	/** Relay v3: appends `suffix` to a note through a group commit (tail row + head; no journal, no catalog event). */
	groupCommit(name: string, before: string, suffix: string, unknownHash?: boolean): string;
	advanceTo(target: number): Promise<void>;
	settle(): Promise<void>;
	indexed(): Set<string>;
	objects: FakeObjectStore;
	/** Runs inside every R2 put, before the object is stored (may throw or mutate the vault). */
	putHook: ((key: string) => void | Promise<void>) | null;
	/** The stored state object for a plaintext hash, if projected. */
	stateObject(contentHash: string): Uint8Array | undefined;
	/** A new runtime (isolate) over the same storage, alarm and object store; the old one is abandoned. */
	restart(): void;
}

async function withWorld(mode: Mode, check: (world: World) => Promise<void>): Promise<void> {
	const docs = new Map<string, Y.Doc>();
	const directory = await mkdtemp(join(tmpdir(), "yaos-projection-idle-"));
	clock = realNow();
	Date.now = () => clock;
	const vaultSqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const jobSqlite = NodeSqliteStorage.open(join(directory, "job.sqlite"));
	try {
		const vaultSide = counted(vaultSqlite);
		const jobSide = counted(jobSqlite);
		const vaultAlarm = new ManualAlarm();
		const jobAlarm = new ManualAlarm();
		const tasks = new Set<Promise<unknown>>();
		const objects = new FakeObjectStore({ onPut: (key) => { const result = world.putHook?.(key); if (result instanceof Promise) throw new Error("putHook must be synchronous"); } });
		let vault!: VaultRuntime;
		let job!: RecoveryJobRuntime;
		job = new RecoveryJobRuntime({
			storage: jobSide.storage as never,
			alarms: jobAlarm.port,
			objectStore: objects,
			recoveryAuthority: { call: async (_name, request) => await vault.fetch(request) },
			controlPlane: { call: async () => { throw new Error("control plane is not used by projection"); } },
		});
		const makeVault = () => new VaultRuntime({
			storage: vaultSide.storage as never,
			sockets: {
				sockets: () => [],
				createPair: () => { throw new Error("no sockets in this suite"); },
				accept: () => {},
				upgradeResponse: () => { throw new Error("no sockets in this suite"); },
			},
			alarms: vaultAlarm.port,
			execution: {
				waitUntil: (task) => {
					const tracked = task.catch((error: unknown) => { throw error; }).finally(() => tasks.delete(tracked));
					tasks.add(tracked);
				},
			},
			objectStore: objects,
			recoveryJobs: { call: async (_name, request) => await job.fetch(request) },
			relayBodies: mode !== "base",
			...(mode === "relay lean" ? { relayConfig: readRelayConfig({ YAOS_RELAY_LEAN_ROWS: "true" }) } : {}),
			...(mode === "relay v3" ? { relayConfig: readRelayConfig({ YAOS_RELAY_LEAN_ROWS: "true", YAOS_RELAY_GROUP_COMMIT: "true" }) } : {}),
		});
		vault = makeVault();
		const settle = async () => { while (tasks.size > 0) await Promise.all([...tasks]); };
		let dispatches = 0;
		const world: World = {
			vault, vaultSqlite, jobSqlite, vaultStats: vaultSide.stats, jobStats: jobSide.stats, vaultAlarm, jobAlarm,
			vaultFetch: async (path, init = {}) => {
				const headers = actorHeaders(OWNER);
				new Headers(init.headers).forEach((value, name) => headers.set(name, value));
				headers.set("x-yaos-vault-id", VAULT_ID);
				headers.set("x-yaos-vault-generation", GENERATION);
				return await world.vault.fetch(new Request(`https://internal${path}`, { ...init, headers }));
			},
			// Seeds through the runtime's own (wake-watched) store, one body commit with its
			// catalog creation each, as the candidate/lifecycle paths finally do.
			createNotes: async (_batch, notes) => {
				const store = (world.vault as unknown as { store: VaultStore }).store;
				for (const entry of notes) {
					const doc = new Y.Doc();
					docs.set(entry.name, doc);
					doc.getText("body").insert(0, entry.text);
					store.commitUpdate({ documentId: `body-${entry.name}`, kind: "body", update: Y.encodeStateAsUpdate(doc),
						catalog: [{ bodyId: `body-${entry.name}`, fileId: `body-${entry.name}`, path: `${entry.name}.md`,
							previousPath: null, lifecycle: "active", bodyGeneration: 1,
							contentHash: hashOf(entry.text), size: sizeOf(entry.text) }] });
				}
			},
			groupCommit: (name, before, suffix, unknownHash = false) => {
				const relayStore = (world.vault as unknown as { relayStore: RelayBodyStore | null }).relayStore;
				assert.ok(relayStore, "relay v3 store");
				const doc = docs.get(name)!;
				assert.equal(doc.getText("body").toString(), before);
				const vector = Y.encodeStateVector(doc);
				doc.getText("body").insert(before.length, suffix);
				const after = doc.getText("body").toString();
				const store = (world.vault as unknown as { store: VaultStore }).store;
				relayStore.appendRelayGroupCommit({ bodyId: `body-${name}`, expectedEpoch: store.documentHead(`body-${name}`)!.semanticEpoch,
					update: Y.encodeStateAsUpdate(doc, vector), lastActor: OWNER,
					catalogContent: unknownHash ? null : { contentHash: hashOf(after), size: sizeOf(after) }, receipts: [], receiptTtlMs: 60_000 });
				return after;
			},
			settle,
			advanceTo: async (target) => {
				for (;;) {
					await settle();
					const due = [
						vaultAlarm.at !== null ? { kind: "vault" as const, at: vaultAlarm.at } : null,
						jobAlarm.at !== null ? { kind: "job" as const, at: jobAlarm.at } : null,
					].filter((entry): entry is { kind: "vault" | "job"; at: number } => entry !== null && entry.at <= target)
						.sort((left, right) => left.at - right.at)[0];
					if (!due) break;
					clock = Math.max(clock, due.at);
					// As on Cloudflare: a fired alarm is cleared before its handler runs.
					if (due.kind === "vault") { vaultAlarm.at = null; await world.vault.alarm(); }
					else { jobAlarm.at = null; await job.dispatch(`dispatch-${++dispatches}`); }
				}
				clock = Math.max(clock, target);
			},
			objects,
			restart: () => { vault = makeVault(); world.vault = vault; },
			putHook: null,
			stateObject: (contentHash) => objects.objects.get(contentObjectKey(VAULT_ID, GENERATION, contentHash)),
			indexed: () => new Set(vaultSqlite.sql.exec<{ content_hash: string }>(
				"SELECT content_hash FROM recovery_content_index").toArray().map((row) => row.content_hash)),
		};
		const provisioned = await world.vaultFetch("/__yaos/provision", {
			method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }),
		});
		assert.equal(provisioned.status, 201);
		(vault as unknown as { store: VaultStore }).store.installAuthorityFence({
			changeId: "idle-bootstrap", vaultId: VAULT_ID, vaultGeneration: GENERATION, subjectDigest: "idle-bootstrap-digest",
			subjects: [
				{ principalId: OWNER.principalId, role: OWNER.role, state: "active", membershipRevision: 1,
					policyVersion: 1, capabilityDigest: OWNER.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
				{ deviceId: OWNER.deviceId, principalId: OWNER.principalId, state: "active", credentialRevision: 1 },
			],
		});
		await check(world);
	} finally {
		Date.now = realNow;
		for (const doc of docs.values()) doc.destroy();
		vaultSqlite.close();
		jobSqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

const NOTES = Array.from({ length: 100 }, (_, i) => ({ name: `note-${String(i).padStart(3, "0")}`, text: note(i) }));

for (const mode of ["base", "relay lean", "relay v3"] as const) {

	s.test(`[${mode}] an idle vault does zero SQL work and arms no alarm for a simulated hour after settling`, async () => {
		await withWorld(mode, async (world) => {
			for (let offset = 0; offset < NOTES.length; offset += 25) {
				await world.createNotes(`seed-${offset}`, NOTES.slice(offset, offset + 25));
			}
			await world.advanceTo(Date.now() + 10 * 60_000);
			const indexed = world.indexed();
			for (const entry of NOTES) assert.ok(indexed.has(hashOf(entry.text)), `${entry.name} projected after settling`);
			assert.equal(world.vaultAlarm.at, null, "vault has no alarm once settled");
			assert.equal(world.jobAlarm.at, null, "projection job has no alarm once settled");

			world.vaultStats.reset();
			world.jobStats.reset();
			world.vaultAlarm.resetCounts();
			world.jobAlarm.resetCounts();
			const start = Date.now();
			for (let step = 1; step <= 120; step++) await world.advanceTo(start + step * 30_000);
			assert.deepEqual({
				vaultStatements: world.vaultStats.statements, vaultWritten: world.vaultStats.written,
				jobStatements: world.jobStats.statements, jobWritten: world.jobStats.written,
				vaultAlarmSets: world.vaultAlarm.sets, jobAlarmSets: world.jobAlarm.sets,
				vaultAlarm: world.vaultAlarm.at, jobAlarm: world.jobAlarm.at,
			}, {
				vaultStatements: 0, vaultWritten: 0, jobStatements: 0, jobWritten: 0,
				vaultAlarmSets: 0, jobAlarmSets: 0, vaultAlarm: null, jobAlarm: null,
			}, "idle hour: no reads, no writes, no alarms in either actor");
		});
	});

	s.test(`[${mode}] a note mutation still wakes projection, which then goes idle again`, async () => {
		await withWorld(mode, async (world) => {
			await world.createNotes("seed", NOTES.slice(0, 10));
			await world.advanceTo(Date.now() + 10 * 60_000);
			assert.equal(world.jobAlarm.at, null);
			// Long idle gap, then a mutation: the job must not need polling to see it.
			await world.advanceTo(Date.now() + 3 * 60 * 60_000);
			const fresh = { name: "late-note", text: note(999, " late") };
			await world.createNotes("late", [fresh]);
			await world.settle();
			assert.notEqual(world.vaultAlarm.at, null, "the mutation owes a projection wake (vault alarm armed)");
			assert.equal(world.indexed().has(hashOf(fresh.text)), false, "not projected before the wake");
			await world.advanceTo(Date.now() + 5 * 60_000);
			assert.ok(world.indexed().has(hashOf(fresh.text)), "the mutated note is projected without polling");
			const object = world.stateObject(hashOf(fresh.text));
			assert.ok(object, "the mutation produced a content-addressed state object");
			const decoded = await decodeRecoveryStateObject(object);
			assert.deepEqual(decoded.plain, canonicalMarkdownBytes(fresh.text), "the client decodes the opaque object to the exact plaintext");
			assert.equal(world.vaultAlarm.at, null, "vault idle again after the wake");
			assert.equal(world.jobAlarm.at, null, "projection job idle again after the pass");
			const wakeRows = world.vaultSqlite.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM recovery_projection_wake").one().count;
			assert.equal(wakeRows, 0, "the durable wake marker is cleared");
		});
	});
}

s.test("a mutation that lands while a pass is putting is projected by the next pass, then idle", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 5));
		await world.settle();
		const fresh = { name: "aaa-racing-note", text: note(7, " racing") };
		let injected = false;
		world.putHook = () => {
			if (injected) return;
			injected = true;
			// Inside the pass's first R2 put: a new body commits after the pass fixed its target.
			void world.createNotes("race", [fresh]);
		};
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.ok(injected, "the hook ran inside a pass");
		assert.ok(world.indexed().has(hashOf(fresh.text)), "the racing mutation was projected by a later pass");
		assert.equal(world.vaultAlarm.at, null, "then the vault sleeps");
		assert.equal(world.jobAlarm.at, null, "no RecoveryJob is involved in projection");
	});
});

s.test("the projection wake marker survives a runtime restart (eviction before the alarm)", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 3));
		await world.advanceTo(Date.now() + 10 * 60_000);
		const fresh = { name: "evicted-note", text: note(8, " evicted") };
		await world.createNotes("evict", [fresh]);
		await world.settle();
		// A fresh runtime instance has no in-memory wake flag; the durable marker drives the alarm.
		(world.vault as unknown as { projectionWakeOwed: boolean }).projectionWakeOwed = false;
		await world.advanceTo(Date.now() + 5 * 60_000);
		assert.ok(world.indexed().has(hashOf(fresh.text)), "projected from the durable marker");
	});
});

s.test("catalog listing is an indexed skip-scan (EXPLAIN QUERY PLAN), not a GROUP BY over every event", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-projection-plan-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	try {
		const store = new VaultStore(sqlite as never);
		store.vaultMetadata(); // initializes the schema
		const plan = (query: string, ...bindings: unknown[]) => sqlite.sql.exec<{ detail: string }>(
			`EXPLAIN QUERY PLAN ${query}`, ...(bindings as never[])).toArray().map((row) => row.detail).join(" | ");
		const nextBody = plan("SELECT body_id FROM vault_catalog_events WHERE body_id > ? ORDER BY body_id LIMIT 1", "");
		assert.match(nextBody, /SEARCH vault_catalog_events USING COVERING INDEX vault_catalog_body_sequence \(body_id>\?\)/, nextBody);
		const head = plan(`SELECT catalog.sequence FROM vault_catalog_events catalog
			WHERE catalog.body_id = ? AND catalog.sequence <= ? ORDER BY catalog.sequence DESC LIMIT 1`, "b", 1);
		assert.match(head, /SEARCH catalog USING (COVERING )?INDEX vault_catalog_body_sequence \(body_id=\? AND sequence<\?\)/, head);
		assert.doesNotMatch(`${nextBody} ${head}`, /SCAN|TEMP B-TREE/);
		const legacy = plan(`SELECT e.body_id FROM vault_catalog_events e JOIN (
			SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events WHERE sequence <= ? GROUP BY body_id
			) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence WHERE e.body_id > ? ORDER BY e.body_id LIMIT 1`, 1, "");
		assert.match(legacy, /SCAN/, `the replaced query scans every catalog event: ${legacy}`);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("[relay v3] a group commit alone (tail row, no journal, no catalog event) wakes projection, then idles at 0 rows", async () => {
	await withWorld("relay v3", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 4));
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.equal(world.vaultAlarm.at, null);
		assert.equal(world.jobAlarm.at, null);
		const journalBefore = world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_journal").one().count;
		const eventsBefore = world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_catalog_events").one().count;
		const after = world.groupCommit(NOTES[2]!.name, NOTES[2]!.text, "\nappended by a relay v3 group commit\n");
		assert.equal(world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_journal").one().count,
			journalBefore, "group commit wrote no journal row");
		assert.equal(world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_catalog_events").one().count,
			eventsBefore, "group commit wrote no catalog event");
		await world.settle();
		assert.notEqual(world.vaultAlarm.at, null, "the tail write owes a projection wake");
		assert.equal(world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM recovery_projection_wake").one().count, 1);
		await world.advanceTo(Date.now() + 5 * 60_000);
		assert.ok(world.indexed().has(hashOf(after)), "the group-committed content is projected");
		const tailObject = world.stateObject(hashOf(after));
		assert.ok(tailObject, "the tail-only head has a state object");
		assert.equal(new TextDecoder().decode((await decodeRecoveryStateObject(tailObject)).plain), after,
			"checkpoint + tail record bytes decode on the client to the group-committed text");
		assert.equal(world.vaultAlarm.at, null, "vault idle again");
		assert.equal(world.jobAlarm.at, null, "job idle again");
		world.vaultStats.reset();
		world.jobStats.reset();
		world.vaultAlarm.resetCounts();
		world.jobAlarm.resetCounts();
		const start = Date.now();
		for (let step = 1; step <= 120; step++) await world.advanceTo(start + step * 30_000);
		assert.deepEqual([world.vaultStats.statements, world.vaultStats.written, world.jobStats.statements, world.jobStats.written,
			world.vaultAlarm.sets, world.jobAlarm.sets], [0, 0, 0, 0, 0, 0], "idle hour after a group commit: 0 rows, 0 alarms");
	});
});

s.test("[relay v3] the shared vault alarm keeps both deadlines: an earlier one fires first, the wake is re-armed, a later one never displaces it", async () => {
	await withWorld("relay v3", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 2));
		await world.advanceTo(Date.now() + 10 * 60_000);
		const after = world.groupCommit(NOTES[0]!.name, NOTES[0]!.text, " shared-alarm edit");
		await world.settle();
		const wakeAt = world.vaultAlarm.at!;
		assert.ok(wakeAt > Date.now(), "the wake is owed in the future");
		const arm = (at: number) => (world.vault as unknown as { armAlarmEarliest(at: number): Promise<void> }).armAlarmEarliest(at);
		await arm(wakeAt + 10 * 60_000);
		assert.equal(world.vaultAlarm.at, wakeAt, "a later deadline (e.g. a maintenance retry) does not push out the wake");
		const earlier = Date.now() + 5_000;
		await arm(earlier);
		assert.equal(world.vaultAlarm.at, earlier, "an earlier deadline (e.g. the relay checkpoint) wins the single alarm");
		await world.advanceTo(earlier);
		assert.equal(world.vaultAlarm.at, wakeAt, "the earlier alarm ran and re-armed the owed wake at its due time");
		assert.equal(world.indexed().has(hashOf(after)), false, "not projected before the wake is due");
		await world.advanceTo(wakeAt + 5 * 60_000);
		assert.ok(world.indexed().has(hashOf(after)), "the wake fired after the earlier deadline");
		assert.equal(world.vaultAlarm.at, null);
	});
});

s.test("projection inputs: relay v3 tail appends and hash backfills owe a wake; trims, deletes and bookkeeping do not", () => {
	for (const query of [
		"INSERT INTO vault_catalog_events(sequence, body_id) VALUES (?, ?)",
		"INSERT INTO vault_journal(sequence) VALUES (?)",
		"\n\t\t\tINSERT INTO vault_semantic_catalog_events(\n sequence) VALUES (?)",
		"INSERT INTO relay_body_tail(body_id, body_epoch) VALUES (?, ?) ON CONFLICT(body_id) DO UPDATE SET data = excluded.data",
		"UPDATE relay_body_tail SET content_hash = ?, size = ? WHERE body_id = ?",
	]) assert.equal(isProjectionInputWrite(query), true, query);
	for (const query of [
		"UPDATE relay_body_tail SET base_sequence = ?, frames = ?, byte_length = ?, data = ?, updated_at = ? WHERE body_id = ?",
		"DELETE FROM relay_body_tail WHERE body_id = ?",
		"DELETE FROM vault_journal WHERE document_id = ? AND sequence <= ?",
		"UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = ?",
		"INSERT INTO relay_device_receipts(device_id) VALUES (?)",
		"INSERT INTO recovery_projection_wake(id, due_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING",
		"INSERT INTO recovery_content_index(content_hash) VALUES (?)",
		"SELECT * FROM vault_catalog_events",
	]) assert.equal(isProjectionInputWrite(query), false, query);
});

const stateRow = (world: World) => world.vaultSqlite.sql.exec<{ watermark: number; pending: string; updated_at: number }>(
	"SELECT watermark, pending, updated_at FROM recovery_state_projection WHERE id = 1").toArray()[0] ?? null;

s.test("rows: seeding 100 notes projects in bounded passes (64 puts each), then one edit costs a few rows", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES);
		await world.settle();
		world.vaultStats.reset();
		world.vaultAlarm.resetCounts();
		const putsBefore = world.objects.puts.length;
		await world.advanceTo(Date.now() + 10 * 60_000);
		const seedPuts = world.objects.puts.length - putsBefore;
		const seedWritten = world.vaultStats.written;
		const seedStatements = world.vaultStats.statements;
		assert.equal(seedPuts, NOTES.length, "one state object per changed note");
		assert.ok(world.vaultAlarm.sets >= 1, "a truncated pass re-owes a wake");
		// 1 content-index row per note + per pass: wake clear, state row, re-owed wake.
		assert.ok(seedWritten <= NOTES.length + 8, `seed projection wrote ${seedWritten} rows for ${NOTES.length} notes`);
		console.log(`[rows] seed: ${NOTES.length} notes, ${seedPuts} puts, ${seedWritten} rows written, ${seedStatements} statements (local)`);

		world.vaultStats.reset();
		const before = stateRow(world)!;
		const edited = { name: NOTES[5]!.name, text: `${NOTES[5]!.text}edited\n` };
		const store = (world.vault as unknown as { store: VaultStore }).store;
		const doc = new Y.Doc();
		doc.getText("body").insert(0, edited.text);
		store.commitUpdate({ documentId: `body-${edited.name}`, kind: "body", update: Y.encodeStateAsUpdate(doc),
			catalog: [{ bodyId: `body-${edited.name}`, fileId: `body-${edited.name}`, path: `${edited.name}.md`,
				previousPath: null, lifecycle: "active", bodyGeneration: 1, contentHash: hashOf(edited.text), size: sizeOf(edited.text) }] });
		doc.destroy();
		await world.settle();
		const mutationWritten = world.vaultStats.written;
		world.vaultStats.reset();
		const pass = await runStateProjectionPass({ store, objectStore: world.objects, vaultId: VAULT_ID, vaultGeneration: GENERATION });
		const passWritten = world.vaultStats.written;
		const passStatements = world.vaultStats.statements;
		assert.equal(pass.projected, 1, "the pass projects only the edited note");
		await world.advanceTo(Date.now() + 5 * 60_000);
		assert.ok(world.indexed().has(hashOf(edited.text)), "the edit is projected");
		assert.ok(stateRow(world)!.watermark > before.watermark, "the watermark advanced");
		// content index (1) + state row (1)
		assert.ok(passWritten <= 3, `one-note pass wrote ${passWritten} rows`);
		console.log(`[rows] one edit: mutation ${mutationWritten} rows; projection pass ${passWritten} rows written, ${passStatements} statements (local)`);
	});
});

s.test("an idle pass (watermark at head) reads two rows and writes none", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 3));
		await world.advanceTo(Date.now() + 10 * 60_000);
		const store = (world.vault as unknown as { store: VaultStore }).store;
		world.vaultStats.reset();
		const result = await runStateProjectionPass({ store, objectStore: world.objects, vaultId: VAULT_ID, vaultGeneration: GENERATION });
		assert.equal(result.idle, true);
		assert.equal(world.vaultStats.written, 0, "idle pass writes no rows");
		assert.ok(world.vaultStats.statements <= 3, `idle pass ran ${world.vaultStats.statements} statements`);
	});
});

s.test("R2 failure: no progress row and no index rows are written; the wake retries at +5 min, then projects", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 3));
		await world.advanceTo(Date.now() + 10 * 60_000);
		const before = stateRow(world)!;
		const fresh = { name: "r2-down-note", text: note(11, " r2") };
		await world.createNotes("r2", [fresh]);
		await world.settle();
		let failures = 0;
		world.putHook = () => { failures++; throw new Error("R2 internal error"); };
		world.vaultStats.reset();
		const dueAt = world.vaultAlarm.at!;
		await world.advanceTo(dueAt);
		assert.equal(failures, 1, "one put attempted, no tight retry");
		assert.deepEqual(stateRow(world), before, "the progress row is untouched by a failed pass");
		assert.equal(world.indexed().has(hashOf(fresh.text)), false);
		// wake marker clear + re-owed wake marker
		assert.ok(world.vaultStats.written <= 2, `failed pass wrote ${world.vaultStats.written} rows`);
		assert.ok(world.vaultAlarm.at !== null && world.vaultAlarm.at >= dueAt + 4 * 60_000, "the retry is minutes out");
		world.putHook = null;
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.equal(failures, 1);
		assert.ok(world.indexed().has(hashOf(fresh.text)), "projected on retry");
		assert.equal(world.vaultAlarm.at, null);
	});
});

s.test("daily row limit: the pass stops, owes the wake at 00:00 UTC, and does not loop", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 2));
		await world.advanceTo(Date.now() + 10 * 60_000);
		const fresh = { name: "limited-note", text: note(12, " limited") };
		await world.createNotes("limited", [fresh]);
		await world.settle();
		let attempts = 0;
		world.putHook = () => { attempts++; throw new Error("Exceeded allowed rows written in Durable Objects free tier."); };
		const dueAt = world.vaultAlarm.at!;
		await world.advanceTo(dueAt);
		assert.equal(attempts, 1);
		assert.equal(world.vaultAlarm.at, nextUtcMidnight(dueAt), "the wake is owed at the daily reset");
		world.vaultStats.reset();
		world.vaultAlarm.resetCounts();
		await world.advanceTo(Math.min(Date.now() + 60 * 60_000, nextUtcMidnight(dueAt) - 1));
		assert.equal(attempts, 1, "no retry before the reset");
		assert.deepEqual([world.vaultStats.statements, world.vaultAlarm.sets], [0, 0], "no tight alarm loop while limited");
		world.putHook = null;
		await world.advanceTo(nextUtcMidnight(dueAt) + 1);
		assert.ok(world.indexed().has(hashOf(fresh.text)), "projected after the reset");
	});
});

s.test("eviction mid-pass: a fresh store redoes the window, skips indexed content, and re-puts only the rest", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 6));
		await world.settle();
		const store = (world.vault as unknown as { store: VaultStore }).store;
		let puts = 0;
		world.putHook = () => { if (++puts === 3) throw new Error("isolate evicted"); };
		await assert.rejects(runStateProjectionPass({ store, objectStore: world.objects, vaultId: VAULT_ID, vaultGeneration: GENERATION }), /evicted/u);
		assert.equal(stateRow(world), null, "the interrupted pass saved no progress");
		assert.equal(world.indexed().size, 2, "content put before the eviction is indexed");
		assert.equal(store.stateObjectWritesInFlight(), 0, "the in-memory guard is released");
		world.putHook = null;
		const fresh = new VaultStore(world.vaultSqlite as never);
		const putsBefore = world.objects.puts.length;
		const result = await runStateProjectionPass({ store: fresh, objectStore: world.objects, vaultId: VAULT_ID, vaultGeneration: GENERATION });
		assert.equal(result.projected, 4, "only the unindexed bodies are put again");
		assert.ok(result.skipped >= 2, "indexed bodies are skipped (one read each)");
		assert.equal(world.objects.puts.length - putsBefore, 4);
		assert.equal(world.indexed().size, 6);
	});
});

s.test("budget: a pass stops at maxPuts and resumes from pending ids without losing any", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 10));
		await world.settle();
		const store = (world.vault as unknown as { store: VaultStore }).store;
		const ports = { store, objectStore: world.objects, vaultId: VAULT_ID, vaultGeneration: GENERATION };
		const limits = { ...STATE_PROJECTION_LIMITS, maxPuts: 4 };
		const first = await runStateProjectionPass(ports, limits);
		assert.deepEqual([first.projected, first.deferred, first.more], [4, 6, true]);
		const second = await runStateProjectionPass(ports, limits);
		const third = await runStateProjectionPass(ports, limits);
		assert.deepEqual([second.projected, third.projected, third.more], [4, 2, false]);
		assert.equal(world.indexed().size, 10);
		assert.equal((await runStateProjectionPass(ports, limits)).idle, true);
	});
});

s.test("b3-int 4c: an oversized body is projected alone in a fresh pass (solo); above the per-object bound it is dropped", async () => {
	await withWorld("base", async (world) => {
		const big = (name: string, bytes: number) => ({ name, text: `# ${name}\n\n${"x".repeat(bytes)}\n` });
		const notes = [
			{ name: "solo-a", text: note(901) }, { name: "solo-b", text: note(902) },
			big("solo-big", 6_000), big("solo-huge", 12_000),
			{ name: "solo-c", text: note(903) }, { name: "solo-d", text: note(904) },
		];
		await world.createNotes("solo", notes);
		await world.settle();
		const store = (world.vault as unknown as { store: VaultStore }).store;
		const ports = { store, objectStore: world.objects, vaultId: VAULT_ID, vaultGeneration: GENERATION };
		// Scaled-down limits: a 4 KB pass budget and an 8 KB per-object bound.
		const limits = { ...STATE_PROJECTION_LIMITS, maxBytes: 4_000, maxObjectBytes: 8_000 };
		const has = (name: string) => world.indexed().has(hashOf(notes.find((entry) => entry.name === name)!.text));
		const first = await runStateProjectionPass(ports, limits);
		assert.ok(first.more, "the oversized body is owed another pass");
		assert.ok(!has("solo-big"), "too large for what is left of a shared pass");
		assert.ok(has("solo-a") && has("solo-b"));
		const second = await runStateProjectionPass(ports, limits);
		assert.equal(second.projected, 1, "the next pass starts with the oversized body and spends itself on it");
		assert.ok(has("solo-big"), "projected alone, though larger than the per-pass budget");
		const state = await decodeRecoveryStateObject(world.stateObject(hashOf(notes[2]!.text))!);
		assert.equal(new TextDecoder().decode(state.plain), notes[2]!.text);
		for (let pass = 0; pass < 5 && (await runStateProjectionPass(ports, limits)).more; pass++);
		assert.ok(has("solo-c") && has("solo-d"), "the rest follows in later passes");
		assert.ok(!has("solo-huge"), "above the per-object bound: not projected (capture records missing_history)");
		assert.equal((await runStateProjectionPass(ports, limits)).idle, true, "no retry loop on the dropped body");
	});
});

s.test("inline hook (bulk create): projects named bodies best-effort without moving the watermark", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 4));
		await world.settle();
		const result = await world.vault.projectRecoveryStateInline(NOTES.slice(0, 4).map((entry) => `body-${entry.name}`));
		assert.deepEqual(result, { projected: 4, skipped: 0 });
		assert.equal(stateRow(world), null, "the inline hook does not move the watermark");
		const putsBefore = world.objects.puts.length;
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.equal(world.objects.puts.length, putsBefore, "the next watermark pass re-checks the ids and puts nothing");
		world.putHook = () => { throw new Error("R2 down"); };
		const failed = await world.vault.projectRecoveryStateInline(["body-unknown", `body-${NOTES[0]!.name}`]);
		assert.equal(failed.projected, 0, "never throws");
		world.vault.recoveryBulkCreateCommitted({ bodies: [{ bodyId: `body-${NOTES[1]!.name}` }] });
		await world.settle();
	});
});

s.test("query plans: watermark change collection and head resolution are index seeks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-state-plan-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	try {
		const store = new VaultStore(sqlite as never);
		store.vaultMetadata();
		store.recoveryStateChanges(0, 1, null, 1, 1);
		const plan = (query: string, ...bindings: unknown[]) => sqlite.sql.exec<{ detail: string }>(
			`EXPLAIN QUERY PLAN ${query}`, ...(bindings as never[])).toArray().map((row) => row.detail).join(" | ");
		const plans = {
			catalog: plan("SELECT sequence, body_id AS id FROM vault_catalog_events WHERE sequence > ? AND sequence <= ? ORDER BY sequence, body_id LIMIT ?", 0, 1, 1),
			catalogResume: plan("SELECT sequence, body_id AS id FROM vault_catalog_events WHERE (sequence, body_id) > (?, ?) AND sequence <= ? ORDER BY sequence, body_id LIMIT ?", 0, "", 1, 1),
			semantic: plan("SELECT sequence, document_id AS id FROM vault_semantic_catalog_events WHERE sequence > ? AND sequence <= ? ORDER BY sequence, document_id LIMIT ?", 0, 1, 1),
			journal: plan("SELECT sequence, document_id AS id FROM vault_journal WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?", 0, 1, 1),
		};
		for (const [name, detail] of Object.entries(plans)) {
			assert.match(detail, /SEARCH/, `${name}: ${detail}`);
			assert.doesNotMatch(detail, /TEMP B-TREE|SCAN/, `${name}: ${detail}`);
			console.log(`[plan] ${name}: ${detail}`);
		}
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
});


s.test("[relay v3] a large-state note with an unknown hash still gets projected and restored (b3-a1fix)", async () => {
	await withWorld("relay v3", async (world) => {
		const seed = { name: "big-note", text: `${"x".repeat(50_000)}\n` };
		await world.createNotes("seed", [seed]);
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.ok(world.indexed().has(hashOf(seed.text)), "the seed is projected under its plaintext hash");
		// As on the large-state path (state > exactMergeBytes): the client's hash claim is not
		// accepted, so the tail row and the coalesced catalog event carry no content hash.
		let text = seed.text;
		for (let save = 0; save < 3; save++) text = world.groupCommit(seed.name, text, `\nrewrite ${save}\n`, true);
		const store = (world.vault as unknown as { store: VaultStore }).store;
		const tail = world.vaultSqlite.sql.exec<{ content_hash: string | null; latest_sequence: number; generation: number }>(
			"SELECT content_hash, latest_sequence, generation FROM relay_body_tail WHERE body_id = ?", `body-${seed.name}`).toArray()[0];
		assert.ok(tail, "the rewrites live in a tail row");
		assert.equal(tail.content_hash, null, "the server holds no plaintext hash for the head");
		await world.advanceTo(Date.now() + 10 * 60_000);
		const revision = recoveryRevisionIdentity(`body-${seed.name}`, tail.generation, tail.latest_sequence);
		assert.ok(world.indexed().has(revision), "the unknown-hash head is projected under its revision identity");
		const object = world.stateObject(revision);
		assert.ok(object, "R2 holds the latest revision, not just the stale seed");
		const decoded = await decodeRecoveryStateObject(object);
		assert.equal(decoded.state.identity, "revision");
		assert.equal(new TextDecoder().decode(decoded.plain), text, "the opaque object decodes to the latest text");
		assert.equal(world.vaultAlarm.at, null, "nothing stays pending: the vault idles");
		assert.equal(world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM recovery_projection_wake").one().count, 0);

		// Capture: the plan names the revision identity (no "missing durable content identity" throw)
		// and the projection already covers it, so no materialisation is needed.
		const now = Date.now();
		const capture = store.createRecoveryCapture({
			captureId: "capture-a1fix", requestId: "request-a1fix", vaultId: VAULT_ID, vaultGeneration: GENERATION,
			boundarySequence: store.currentSequence(), rootGeneration: store.documentHead("root")?.generation ?? 0,
			runtimeEpoch: "epoch", reason: "manual", jobId: "job-a1fix", capabilityHash: "c".repeat(64),
			capabilityExpiresAt: now + 3_600_000, softExpiresAt: now + 1_800_000, hardExpiresAt: now + 3_600_000, now,
		});
		const plan = store.listCapturePlanAt(capture.captureId, "active", null, 100);
		const entry = plan.find((candidate) => candidate.kind === "active" && candidate.bodyId === `body-${seed.name}`);
		assert.ok(entry && entry.kind === "active", "the note is in the capture plan");
		assert.equal(entry.contentHash, revision, "the capture plan uses the projected identity");
		assert.deepEqual(store.missingCoverage(capture.captureId, [revision], [], capture.gcEpoch).contentHashes, [],
			"the projected object covers the capture");

		// Restore: the client binds the object to the revision identity and derives the plaintext hash and size.
		const arrayBuffer = new ArrayBuffer(object.byteLength);
		new Uint8Array(arrayBuffer).set(object);
		const client = new RecoveryClient({ ...DEFAULT_SETTINGS, host: "https://sync.example", deviceToken: "token", vaultId: VAULT_ID }, undefined, {
			request: async () => ({ status: 200, json: null, text: "", arrayBuffer, headers: {
				"content-type": RECOVERY_STATE_CONTENT_TYPE, "content-length": String(object.byteLength), "x-yaos-content-sha256": revision,
			} }),
		});
		const item: Extract<RestoreItem, { kind: "markdown" }> = { kind: "markdown", itemId: "item-1", path: `${seed.name}.md`, sourceKind: "active",
			sourceFileId: `body-${seed.name}`, sourceBodyId: `body-${seed.name}`, contentHash: entry.contentHash, size: entry.size, contentUrl: "/content" };
		const restored = await client.downloadRestoreItemVerified("22222222-2222-4222-8222-222222222222", item);
		assert.equal(new TextDecoder().decode(restored.bytes), text, "restore yields the latest text");
		assert.equal(restored.item.contentHash, hashOf(text), "the restore continues under the real plaintext hash");
		assert.equal(restored.item.size, sizeOf(text));
		const forged = new RecoveryClient({ ...DEFAULT_SETTINGS, host: "https://sync.example", deviceToken: "token", vaultId: VAULT_ID }, undefined, {
			request: async () => ({ status: 200, json: null, text: "", arrayBuffer, headers: {
				"content-type": RECOVERY_STATE_CONTENT_TYPE, "content-length": String(object.byteLength), "x-yaos-content-sha256": "d".repeat(64),
			} }),
		});
		await assert.rejects(forged.downloadRestoreItemVerified("22222222-2222-4222-8222-222222222222", { ...item, contentHash: "d".repeat(64) }),
			/identity mismatch/, "an object served for another identity fails closed");
	});
});

s.test("A2: an isolate that dies mid-pass (put never returns) still owes the wake; a new runtime projects it, then idles", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 3));
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.equal(world.vaultAlarm.at, null);
		const fresh = { name: "crash-note", text: note(11, " crash") };
		await world.createNotes("crash", [fresh]);
		await world.settle();
		const due = world.vaultAlarm.at;
		assert.notEqual(due, null, "the mutation armed the wake");
		// The next projection put hangs forever: the isolate is reset inside the pass.
		const put = world.objects.put.bind(world.objects);
		let hung = false;
		world.objects.put = (async (...args: Parameters<typeof put>) => {
			if (!hung) { hung = true; return await new Promise<void>(() => {}); }
			return await put(...args);
		}) as typeof world.objects.put;
		clock = Math.max(clock, due!);
		world.vaultAlarm.at = null; // fired: cleared before the handler runs
		void world.vault.alarm();
		for (let spin = 0; spin < 200 && !hung; spin++) await new Promise((resolve) => setImmediate(resolve));
		assert.ok(hung, "the pass reached its put");
		assert.notEqual(world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM recovery_projection_wake").one().count, 0,
			"the durable wake marker is not cleared before the pass completes");
		assert.notEqual(world.vaultAlarm.at, null, "the lease armed a retry alarm before the pass");
		world.restart();
		await world.advanceTo(Date.now() + 15 * 60_000);
		assert.ok(world.indexed().has(hashOf(fresh.text)), "the retry alarm projected the note in a new runtime");
		assert.equal(world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM recovery_projection_wake").one().count, 0,
			"the marker is cleared after the successful pass");
		assert.equal(world.vaultAlarm.at, null, "then the vault idles");
	});
});

s.test("A2: an owed wake whose alarm was lost is re-armed by the next request to a new runtime", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 2));
		await world.advanceTo(Date.now() + 10 * 60_000);
		const fresh = { name: "lost-alarm-note", text: note(12, " lost") };
		await world.createNotes("lost", [fresh]);
		await world.settle();
		assert.notEqual(world.vaultSqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM recovery_projection_wake").one().count, 0);
		world.vaultAlarm.at = null; // the alarm is lost (never fires)
		world.restart();
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.equal(world.indexed().has(hashOf(fresh.text)), false, "nothing fires without an alarm");
		const probe = await world.vaultFetch("/__yaos/a1fix-probe");
		await probe.arrayBuffer().catch(() => undefined);
		await world.settle();
		assert.notEqual(world.vaultAlarm.at, null, "the first request of the new runtime re-armed the owed wake");
		await world.advanceTo(Date.now() + 10 * 60_000);
		assert.ok(world.indexed().has(hashOf(fresh.text)), "projected after the re-arm");
	});
});

s.test("A2: a maintenance step that throws does not starve the projection wake", async () => {
	await withWorld("base", async (world) => {
		await world.createNotes("seed", NOTES.slice(0, 2));
		await world.advanceTo(Date.now() + 10 * 60_000);
		const fresh = { name: "maint-note", text: note(13, " maint") };
		await world.createNotes("maint", [fresh]);
		await world.settle();
		const store = (world.vault as unknown as { store: VaultStore }).store;
		const reap = store.reapExpiredRecoveryCaptures.bind(store);
		let threw = 0;
		store.reapExpiredRecoveryCaptures = () => { threw++; throw new Error("maintenance boom"); };
		const due = world.vaultAlarm.at!;
		clock = Math.max(clock, due);
		world.vaultAlarm.at = null;
		await assert.rejects(world.vault.alarm(), /maintenance boom/, "the alarm still reports the failure (platform retry)");
		assert.ok(threw > 0);
		assert.ok(world.indexed().has(hashOf(fresh.text)), "the wake ran despite the maintenance error");
		store.reapExpiredRecoveryCaptures = reap;
	});
});

await s.done();
