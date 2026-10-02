// Write-budget spike (int-bulk): bulk-create row trims and the lean -> base clock fix, over real
// SQLite (NodeSqliteStorage) under VaultStore + VaultDocumentCache + VaultBulkCreateService.
//
//  * the six bulk-create hot tables are WITHOUT ROWID on new databases and stay rowid on existing
//    ones (no rebuild, no schema bump); both shapes give identical results;
//  * EXPLAIN QUERY PLAN: no statement of the workload loses keyed access on the new shape;
//  * exact Cloudflare rows (helpers/cfRowModel.ts): <= 5 per note, 3 per attachment;
//  * relay lean rows on -> off on one database: create-bulk keeps allocating fresh sequences;
//  * YAOS_BULK_CREATE_MAX_ITEMS / _MAX_BYTES lower the caps, which /api/capabilities and every 413 report.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { snapshotRootMap } from "../../server/src/crdt/rootSchema";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { sha256HexSync } from "../../server/src/vaultDocumentStore";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import type { VaultSocketService } from "../../server/src/vaultSocketService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { VaultBulkCreateService, type BulkCreateOutcome } from "../../server/src/vaultBulkCreateService";
import { readBulkCreateLimits, type BulkCreateLimits } from "../../server/src/relayFlag";
import { getCapabilities } from "../../server/src/routes/auth";
import type { Env } from "../../server/src/routes/types";
import { suite } from "../harness.ts";
import { CfRowModel } from "./helpers/cfRowModel.ts";
import { comparePlans, CONVERTED_TABLES, isWithoutRowid, legacyTableDdl } from "./helpers/planCompare.ts";

const s = suite("wb-int-bulk");

const VAULT_ID = "int-bulk-vault";
const VAULT_GENERATION = "int-bulk-generation";
const owner = { vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION, principalId: "principal-owner",
	membershipRevision: 1, deviceId: "device-owner", deviceCredentialRevision: 1, role: "owner" as const,
	policyVersion: 1, capabilityDigest: "owner-digest" };

interface FileInput { operationId: string; bodyId: string; path: string; updates: Uint8Array[] }
interface AttachmentInput { operationId: string; path: string; hash: string; size: number; mime: string }
interface Envelope { outcomes: BulkCreateOutcome[]; vaultSequence: number; replayed: boolean }

function frames(text: string): Uint8Array[] {
	if (!text) return [];
	const doc = new Y.Doc();
	doc.getText("body").insert(0, text);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return [update];
}

function note(i: number, bytes = 2048): string {
	const line = `Line of note ${i} with some ordinary prose for sizing purposes.\n`;
	return `# Note ${i}\n\n${line.repeat(Math.ceil(bytes / line.length))}`.slice(0, bytes).trimEnd() + "\n";
}

const batches = new Map<string, FileInput[]>();
/** Cached per (prefix, count): a replayed batch must carry byte-identical updates (Yjs client ids are random). */
function files(prefix: string, count: number): FileInput[] {
	const key = `${prefix}:${count}`;
	const cached = batches.get(key);
	if (cached) return cached;
	const created = Array.from({ length: count }, (_v, i) => ({ operationId: `op-${prefix}-${i}`, bodyId: `body-${prefix}-${i}`,
		path: `${prefix}/n${i}.md`, updates: frames(note(i)) }));
	batches.set(key, created);
	return created;
}

/** One open of a database file: a fresh VaultStore (base or lean) over the same SQLite. */
class Open {
	readonly model: CfRowModel;
	readonly captured: string[] = [];
	readonly store: VaultStore;
	readonly blobs = new Set<string>();
	private readonly service: VaultBulkCreateService;

	constructor(readonly sqlite: NodeSqliteStorage, lean: boolean, provision: boolean, limits?: BulkCreateLimits) {
		this.model = new CfRowModel(sqlite);
		const storage = {
			sql: { exec: (query: string, ...bindings: unknown[]) => {
				this.captured.push(query);
				return this.model.exec(query, ...bindings);
			} },
			transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure),
		} as unknown as VaultStoragePort;
		this.store = new VaultStore(storage);
		if (lean) this.store.enableLeanRows();
		if (provision) {
			const root = new Y.Doc({ guid: "root" });
			root.getMap("sys").set("schemaVersion", 8);
			root.getMap("sys").set("protocolVersion", 5);
			this.store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root), 1);
			root.destroy();
			this.store.installAuthorityFence({ changeId: "bootstrap", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
				subjectDigest: "bootstrap-digest", subjects: [
					{ principalId: owner.principalId, role: owner.role, state: "active", membershipRevision: 1,
						policyVersion: 1, capabilityDigest: owner.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
					{ deviceId: owner.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
				] });
		}
		const cache = new VaultDocumentCache(this.store, () => new Set<string>(), () => new Set<string>());
		this.service = new VaultBulkCreateService({
			store: this.store, cache,
			sockets: () => ({ broadcastDocumentUpdate: () => {} }) as unknown as VaultSocketService,
			vaultGeneration: () => VAULT_GENERATION,
			runtimeEpoch: "runtime-int-bulk",
			hasBlob: async (hash) => this.blobs.has(hash),
			flush: async () => true,
			validateActor: (actor) => this.store.validateActor(actor) === "allowed",
			...(limits ? { limits } : {}),
		});
	}

	post(batchId: string, batch: FileInput[], attachments: AttachmentInput[] = []): Promise<Response> {
		return this.service.handle(new Request("https://internal/lifecycle/create-bulk", {
			method: "POST", body: encodeBinaryEnvelope({ batchId, rootEpoch: 1, files: batch, attachments }).slice().buffer,
		}), owner, () => null);
	}

	async send(batchId: string, batch: FileInput[], attachments: AttachmentInput[] = []): Promise<Envelope> {
		const response = await this.post(batchId, batch, attachments);
		if (response.status !== 200) throw new Error(`${batchId}: ${response.status} ${await response.text()}`);
		const envelope = decodeBinaryEnvelope(new Uint8Array(await response.arrayBuffer())) as Envelope;
		const created = envelope.outcomes.filter((outcome) => outcome.outcome === "created").length;
		if (!envelope.replayed) assert.equal(created, batch.length + attachments.length, `${batchId}: all created`);
		return envelope;
	}

	attachments(prefix: string, count: number): AttachmentInput[] {
		return Array.from({ length: count }, (_v, i) => {
			const hash = sha256HexSync(new TextEncoder().encode(`${prefix}-attachment-${i}`));
			this.blobs.add(hash);
			return { operationId: `att-${prefix}-${i}`, path: `${prefix}/a${i}.png`, hash, size: 100 + i, mime: "image/png" };
		});
	}

	text(bodyId: string): string {
		const document = this.store.reconstructDocument(bodyId);
		try { return crdtEngine.readText(document.doc, "body"); } finally { crdtEngine.destroyDocument(document.doc); }
	}

	rootPaths(): Record<string, string> {
		const document = this.store.reconstructDocument("root");
		try {
			return Object.fromEntries([...snapshotRootMap(document.doc, "pathToId")].map(([key, value]) => [key, String(value)]).sort());
		} finally { crdtEngine.destroyDocument(document.doc); }
	}

	/** Every reader the bulk tables serve: catalog, feed, catalog delta, attachments, bodies, checkpoints. */
	readerSnapshot(bodyIds: string[]): unknown {
		const store = this.store;
		const sequence = store.currentSequence();
		return {
			sequence,
			catalog: store.listCatalogAt(sequence),
			activeCount: store.countActiveCatalogAt(sequence),
			heads: bodyIds.map((bodyId) => [store.getCatalogHeadAt(sequence, bodyId), store.documentHead(bodyId)]),
			feed: store.listChangesAfter(0).map((entry) => ({ ...entry, update: undefined })),
			delta: store.catalogDeltaAt(0, sequence, null, 1000),
			attachments: store.attachmentCatalogAt(sequence),
			activeAttachments: store.activeAttachmentCatalogAt(sequence),
			texts: bodyIds.map((bodyId) => this.text(bodyId)),
			tails: bodyIds.map((bodyId) => store.documentJournalTailStats(bodyId)),
			root: this.rootPaths(),
		};
	}
}

async function withDatabase(check: (input: { path: string; open: (lean: boolean, provision?: boolean, limits?: BulkCreateLimits) => Open;
	legacy: (sqlite: NodeSqliteStorage) => Promise<void> }) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-int-bulk-"));
	const opened: NodeSqliteStorage[] = [];
	try {
		await check({
			path: directory,
			open: (lean, provision = true, limits) => {
				const sqlite = NodeSqliteStorage.open(join(directory, `vault-${opened.length}.sqlite`));
				opened.push(sqlite);
				return new Open(sqlite, lean, provision, limits);
			},
			legacy: async (sqlite) => { for (const ddl of await legacyTableDdl()) sqlite.sql.exec(ddl); },
		});
	} finally {
		for (const sqlite of opened) { try { sqlite.close(); } catch { /* closed */ } }
		await rm(directory, { recursive: true, force: true });
	}
}

/** Runs the bulk path and the readers: creates, attachments, an edit, a checkpoint, a replay. */
async function workload(db: Open): Promise<string[]> {
	await db.send("w-1", files("w1", 3));
	await db.send("w-2", files("w2", 2), db.attachments("w2", 2));
	const doc = new Y.Doc();
	Y.applyUpdate(doc, files("w1", 3)[0]!.updates[0]!);
	const before = Y.encodeStateVector(doc);
	doc.getText("body").insert(0, "edited ");
	const content = canonicalMarkdownBytes(doc.getText("body").toString());
	db.store.commitUpdate({ documentId: "body-w1-0", kind: "body", update: Y.encodeStateAsUpdate(doc, before),
		catalog: [{ bodyId: "body-w1-0", fileId: "body-w1-0", path: "w1/n0.md", previousPath: null, lifecycle: "active",
			bodyGeneration: 1, contentHash: sha256HexSync(content), size: content.byteLength }] });
	doc.destroy();
	db.store.writeCheckpoint("body-w1-0");
	const replay = await db.send("w-1", files("w1", 3));
	assert.equal(replay.replayed, true, "an identical batch replays from its receipt");
	assert.equal(db.text("body-w1-0"), `edited ${note(0)}`);
	return ["body-w1-0", "body-w1-1", "body-w1-2", "body-w2-0", "body-w2-1"];
}

s.test("new databases create the six bulk tables WITHOUT ROWID; the schema guard pins are untouched", async () => {
	await withDatabase(async ({ open }) => {
		const db = open(false);
		db.store.currentSequence();
		for (const table of CONVERTED_TABLES) assert.equal(isWithoutRowid(db.sqlite, table), true, `${table} WITHOUT ROWID`);
		for (const table of ["vault_journal", "vault_operation_outcomes", "vault_candidate_receipts"]) {
			const row = db.sqlite.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?", table).toArray()[0];
			if (row) assert.equal(/WITHOUT\s+ROWID/i.test(row.sql), false, `${table} keeps its rowid (INTEGER PK / rowid trim)`);
		}
		const meta = db.sqlite.sql.exec<{ schema_version: number; storage_format_version: number }>(
			"SELECT schema_version, storage_format_version FROM vault_meta WHERE id = 1").one();
		assert.deepEqual({ ...meta }, { schema_version: 8, storage_format_version: 4 }, "no schema / storage format bump");
	});
});

s.test("existing (rowid) databases are opened in place and give results identical to the new shape", async () => {
	for (const lean of [false, true]) {
		await withDatabase(async ({ open, legacy }) => {
			const fresh = open(lean);
			const legacySqlite = NodeSqliteStorage.open(join(tmpdir(), `yaos-int-bulk-legacy-${process.pid}-${lean}.sqlite`));
			try {
				await legacy(legacySqlite);
				const old = new Open(legacySqlite, lean, true);
				const bodyIds = await workload(fresh);
				await workload(old);
				for (const table of CONVERTED_TABLES) assert.equal(isWithoutRowid(legacySqlite, table), false, `${table} not rebuilt`);
				const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) =>
					/(_at|At)$/.test(key) ? undefined : item instanceof Uint8Array ? Array.from(item) : item));
				assert.deepEqual(strip(old.readerSnapshot(bodyIds)), strip(fresh.readerSnapshot(bodyIds)));
				// Plan proof on this workload's statements (the cross-suite capture is in scripts/relay2/wb/plan-compare.ts).
				const { compared, skipped } = comparePlans(fresh.sqlite, legacySqlite, [...fresh.captured, ...old.captured]);
				assert.equal(skipped.length, 0, JSON.stringify(skipped));
				assert.equal(compared.length >= 20, true, `the workload touched the converted tables (${compared.length})`);
				const regressions = compared.filter((entry) => entry.regression);
				assert.deepEqual(regressions, [], "no statement loses keyed access or gains a scan/sort on the new shape");
				const keyed = compared.filter((entry) => entry.fresh.some((detail) => / USING PRIMARY KEY /.test(detail))).length;
				assert.equal(keyed > 0, true, "lookups use the clustered primary key directly");
			} finally {
				legacySqlite.close();
				await rm(join(tmpdir(), `yaos-int-bulk-legacy-${process.pid}-${lean}.sqlite`), { force: true });
			}
		});
	}
});

s.test("exact Cloudflare rows: <= 5 per note, 3 per attachment, per-batch 6 (base) / 5 (lean); old shape 9 / 4", async () => {
	const measure = async (lean: boolean, legacyShape: boolean) => {
		const out: Record<string, number> = {};
		for (const [label, notes, attachments] of [["n100", 100, 0], ["n500", 500, 0], ["a1", 0, 1], ["a50", 0, 50]] as const) {
			await withDatabase(async ({ open, legacy }) => {
				let db: Open;
				if (legacyShape) {
					const sqlite = NodeSqliteStorage.open(join(tmpdir(), `yaos-int-bulk-rows-${process.pid}.sqlite`));
					await legacy(sqlite);
					db = new Open(sqlite, lean, true);
				} else db = open(lean);
				try {
					await db.send("warm", files("warm", 1));
					const atts = db.attachments(label, attachments);
					db.model.reset();
					await db.send(label, files(label, notes), atts);
					out[label] = db.model.totals.cf;
				} finally {
					if (legacyShape) {
						db.sqlite.close();
						await rm(join(tmpdir(), `yaos-int-bulk-rows-${process.pid}.sqlite`), { force: true });
					}
				}
			});
		}
		const perNote = (out.n500! - out.n100!) / 400;
		const perAttachment = (out.a50! - out.a1!) / 49;
		return { perNote, perBatch: out.n100! - 100 * perNote, perAttachment };
	};
	assert.deepEqual(await measure(false, false), { perNote: 5, perBatch: 6, perAttachment: 3 });
	assert.deepEqual(await measure(true, false), { perNote: 5, perBatch: 5, perAttachment: 3 });
	// An existing database keeps the old cost until it is re-created (cutover / restore).
	assert.deepEqual(await measure(false, true), { perNote: 9, perBatch: 7, perAttachment: 4 });
});

s.test("relay lean rows on -> off on one database: create-bulk allocates past the lean journal head", async () => {
	await withDatabase(async ({ open }) => {
		const lean = open(true);
		const first = await lean.send("lean-1", files("lean1", 2));
		const second = await lean.send("lean-2", files("lean2", 1));
		assert.equal(second.vaultSequence, first.vaultSequence + 1);
		const clock = lean.sqlite.sql.exec<{ sequence: number }>("SELECT sequence FROM vault_clock WHERE id = 1").one().sequence;
		assert.equal(clock < second.vaultSequence, true, "lean bulk create leaves vault_clock behind the journal head");
		const leanSnapshot = lean.readerSnapshot(["body-lean1-0", "body-lean1-1", "body-lean2-0"]);

		// Same database file, new object instance with the flag off (a redeploy without YAOS_RELAY_LEAN_ROWS).
		const base = new Open(lean.sqlite, false, false);
		assert.equal(base.store.currentSequence(), second.vaultSequence, "base readers see the lean journal tail");
		assert.deepEqual(base.readerSnapshot(["body-lean1-0", "body-lean1-1", "body-lean2-0"]), leanSnapshot);
		const third = await base.send("base-1", files("base1", 2));
		assert.equal(third.vaultSequence, second.vaultSequence + 1, "no UNIQUE(vault_journal.sequence) collision");
		const fourth = await base.send("base-2", files("base2", 1));
		assert.equal(fourth.vaultSequence, third.vaultSequence + 1);
		assert.equal(base.text("body-base1-1"), note(1));
		assert.equal(base.text("body-lean2-0"), note(0));
		assert.equal((await base.send("lean-1", files("lean1", 2))).replayed, true, "a lean-era batch still replays");

		// And back on: lean allocates from MAX(clock, journal) again.
		const again = new Open(lean.sqlite, true, false);
		const fifth = await again.send("lean-3", files("lean3", 1));
		assert.equal(fifth.vaultSequence, fourth.vaultSequence + 1);

		// The reconcile writes nothing on a vault whose clock is already at the head.
		const quiet = new Open(lean.sqlite, false, false);
		quiet.store.currentSequence();
		const afterLean = quiet.store.currentSequence();
		const settled = new Open(lean.sqlite, false, false);
		settled.store.currentSequence();
		assert.equal(settled.model.totals.cf, 0, "no clock write when already reconciled");
		assert.equal(settled.store.currentSequence(), afterLean);
	});
});

s.test("bulk create caps: env lowers them (clamped), capabilities and every 413 report the effective caps", async () => {
	const mib = 1024 * 1024;
	assert.deepEqual(readBulkCreateLimits({}), { maxItems: 500, maxBytes: 4 * mib });
	assert.deepEqual(readBulkCreateLimits({ YAOS_BULK_CREATE_MAX_ITEMS: "100", YAOS_BULK_CREATE_MAX_BYTES: String(mib) }),
		{ maxItems: 100, maxBytes: mib });
	assert.deepEqual(readBulkCreateLimits({ YAOS_BULK_CREATE_MAX_ITEMS: "5000", YAOS_BULK_CREATE_MAX_BYTES: String(64 * mib) }),
		{ maxItems: 500, maxBytes: 4 * mib }, "env can only lower the protocol caps");
	assert.deepEqual(readBulkCreateLimits({ YAOS_BULK_CREATE_MAX_ITEMS: "0", YAOS_BULK_CREATE_MAX_BYTES: "1" }),
		{ maxItems: 1, maxBytes: 64 * 1024 });
	assert.deepEqual(readBulkCreateLimits({ YAOS_BULK_CREATE_MAX_ITEMS: "lots", YAOS_BULK_CREATE_MAX_BYTES: "" }),
		{ maxItems: 500, maxBytes: 4 * mib });
	const caps = (env: Partial<Env>) => getCapabilities({ mode: "unclaimed", claimed: false }, env as Env).bulkCreate;
	assert.deepEqual(caps({}), { maxItems: 500, maxBytes: 4 * mib });
	assert.deepEqual(caps({ YAOS_BULK_CREATE_MAX_ITEMS: "3" }), { maxItems: 3, maxBytes: 4 * mib });

	await withDatabase(async ({ open }) => {
		const limits = readBulkCreateLimits({ YAOS_BULK_CREATE_MAX_ITEMS: "3", YAOS_BULK_CREATE_MAX_BYTES: String(64 * 1024) });
		const db = open(false, true, limits);
		const four = await db.post("caps-items", files("caps-items", 4));
		assert.equal(four.status, 413);
		assert.deepEqual(await four.json(), { error: "bulk_create_too_many_items", bulkCreate: { maxItems: 3, maxBytes: 65_536 } });
		const big = Array.from({ length: 2 }, (_v, i) => ({ operationId: `op-big-${i}`, bodyId: `body-big-${i}`,
			path: `big/n${i}.md`, updates: frames(note(i, 40 * 1024)) }));
		const tooLarge = await db.post("caps-bytes", big);
		assert.equal(tooLarge.status, 413);
		assert.deepEqual(await tooLarge.json(), { error: "bulk_create_too_large", bulkCreate: { maxItems: 3, maxBytes: 65_536 } });
		assert.equal(db.store.existingBodyIds(["body-big-0", "body-caps-items-0"]).size, 0, "a 413 writes nothing");
		await db.send("caps-ok", files("caps-ok", 3));
		await db.send("caps-single", big.slice(0, 1));
		const alone = (await db.post("caps-single-big", [{ ...big[1]!, updates: frames(note(1, 200 * 1024)) }])).status;
		assert.equal(alone, 200, "a single-file batch keeps the per-note ceiling");
		const defaults = open(false);
		assert.equal((await defaults.post("default-4", files("caps-items", 4))).status, 200);
	});
});

await s.done();
