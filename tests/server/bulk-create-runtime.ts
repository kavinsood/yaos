// Write-budget spike W2: POST /lifecycle/create-bulk over real SQLite (NodeSqliteStorage)
// under VaultStore + VaultDocumentCache + VaultBulkCreateService. Every case runs in base
// mode and in relay lean-rows mode. Also measures rows/note, per-batch overhead and CPU.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpuUsage } from "node:process";

import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { snapshotRootMap } from "../../server/src/crdt/rootSchema";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import { SQLITE_BLOB_CHUNK_BYTES, sha256HexSync } from "../../server/src/vaultDocumentStore";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import type { VaultSocketService } from "../../server/src/vaultSocketService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import {
	BULK_CREATE_MAX_ITEMS, VaultBulkCreateService, type BulkCreateOutcome,
} from "../../server/src/vaultBulkCreateService";
import { suite } from "../harness.ts";
import { CfRowModel, type CfRowTotals } from "./helpers/cfRowModel.ts";

const s = suite("bulk-create-runtime");

const VAULT_ID = "bulk-create-vault";
const VAULT_GENERATION = "bulk-create-generation";
const owner = { vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION, principalId: "principal-owner",
	membershipRevision: 1, deviceId: "device-owner", deviceCredentialRevision: 1, role: "owner" as const,
	policyVersion: 1, capabilityDigest: "owner-digest" };

interface FileInput { operationId: string; bodyId: string; path: string; updates: Uint8Array[] }
interface AttachmentInput { operationId: string; path: string; hash: string; size: number; mime: string }
interface BulkResponse {
	status: number;
	json?: Record<string, unknown>;
	envelope?: { batchId: string; outcomes: BulkCreateOutcome[]; vaultSequence: number; rootGeneration: number;
		rootEpoch: number; replayed: boolean; rootUpdate?: Uint8Array };
}

interface Harness {
	store: VaultStore;
	lean: boolean;
	blobs: Set<string>;
	broadcasts: number;
	rows: CfRowTotals;
	resetRows(): void;
	send(batchId: string, files: FileInput[], attachments?: AttachmentInput[], extra?: Record<string, unknown>, actor?: typeof owner): Promise<BulkResponse>;
	text(bodyId: string): string;
	rootPaths(): Map<string, string>;
}

function bodyFrames(text: string, frameChars = 1_000_000): Uint8Array[] {
	const doc = new Y.Doc();
	const frames: Uint8Array[] = [];
	for (let offset = 0; offset < text.length; offset += frameChars) {
		const before = Y.encodeStateVector(doc);
		doc.getText("body").insert(offset, text.slice(offset, offset + frameChars));
		frames.push(Y.encodeStateAsUpdate(doc, before));
	}
	doc.destroy();
	return frames;
}

function file(name: string, text: string, path = `${name}.md`): FileInput {
	return { operationId: `op-${name}`, bodyId: `body-${name}`, path, updates: text ? bodyFrames(text) : [] };
}

function note(i: number, bytes = 2048): string {
	const line = `Line of note ${i} with some ordinary prose for sizing purposes.\n`;
	return `# Note ${i}\n\n${line.repeat(Math.ceil(bytes / line.length))}`.slice(0, bytes).trimEnd() + "\n";
}

function hashOf(text: string): string { return sha256HexSync(canonicalMarkdownBytes(text)); }

async function withHarness(lean: boolean, check: (harness: Harness) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-bulk-create-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const model = new CfRowModel(sqlite);
	const rows = model.totals;
	const storage = {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => model.exec(query, ...bindings),
		},
		transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure),
	} as unknown as VaultStoragePort;
	try {
		const store = new VaultStore(storage);
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", 8);
		root.getMap("sys").set("protocolVersion", 5);
		store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root), 1);
		root.destroy();
		if (lean) store.enableLeanRows();
		store.installAuthorityFence({ changeId: "bulk-bootstrap", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
			subjectDigest: "bulk-bootstrap-digest", subjects: [
				{ principalId: owner.principalId, role: owner.role, state: "active", membershipRevision: 1,
					policyVersion: 1, capabilityDigest: owner.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
				{ deviceId: owner.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
			] });
		const cache = new VaultDocumentCache(store, () => new Set<string>(), () => new Set<string>());
		const blobs = new Set<string>();
		const harness: Harness = {
			store, lean, blobs, broadcasts: 0, rows,
			resetRows: () => model.reset(),
			send: async (batchId, files, attachments = [], extra = {}, actor = owner) => {
				const body = encodeBinaryEnvelope({ batchId, rootEpoch: 1, files, attachments, ...extra });
				const response = await service.handle(new Request("https://internal/lifecycle/create-bulk", {
					method: "POST", body: body.slice().buffer,
				}), actor, () => null);
				if (response.headers.get("content-type")?.includes("json")) {
					return { status: response.status, json: await response.json() as Record<string, unknown> };
				}
				return { status: response.status,
					envelope: decodeBinaryEnvelope(new Uint8Array(await response.arrayBuffer())) as BulkResponse["envelope"] };
			},
			text: (bodyId) => {
				const document = store.reconstructDocument(bodyId);
				try { return crdtEngine.readText(document.doc, "body"); }
				finally { crdtEngine.destroyDocument(document.doc); }
			},
			rootPaths: () => {
				const document = store.reconstructDocument("root");
				try { return new Map([...snapshotRootMap(document.doc, "pathToId")].map(([key, value]) => [key, String(value)])); }
				finally { crdtEngine.destroyDocument(document.doc); }
			},
		};
		const service = new VaultBulkCreateService({
			store, cache,
			sockets: () => ({ broadcastDocumentUpdate: () => { harness.broadcasts++; } }) as unknown as VaultSocketService,
			vaultGeneration: () => VAULT_GENERATION,
			runtimeEpoch: "runtime-bulk",
			hasBlob: async (hash) => blobs.has(hash),
			flush: async () => true,
			validateActor: (actor) => store.validateActor(actor) === "allowed",
		});
		await check(harness);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function outcomesByOp(response: BulkResponse): Map<string, BulkCreateOutcome> {
	assert.equal(response.status, 200, JSON.stringify(response.json));
	return new Map(response.envelope!.outcomes.map((outcome) => [outcome.operationId, outcome]));
}

const modes = [false, true] as const;
for (const lean of modes) {
	const mode = lean ? "lean" : "base";

	s.test(`[${mode}] a batch creates bodies, catalog rows and one root update in one commit`, async () => {
		await withHarness(lean, async (h) => {
			const before = h.store.currentSequence();
			const response = await h.send("batch-1", [file("a", "alpha\n"), file("b", "beta\n"), file("empty", "")]);
			const outcomes = outcomesByOp(response);
			assert.deepEqual([...outcomes.values()].map((item) => item.outcome), ["created", "created", "created"]);
			assert.equal(outcomes.get("op-a")!.contentHash, hashOf("alpha\n"));
			const sequence = response.envelope!.vaultSequence;
			assert.equal(sequence, before + 1, "one sequence for the whole batch");
			assert.equal(h.store.currentSequence(), sequence);
			assert.equal(h.text("body-a"), "alpha\n");
			assert.equal(h.text("body-b"), "beta\n");
			assert.equal(h.text("body-empty"), "");
			assert.deepEqual(h.rootPaths(), new Map([["a.md", "body-a"], ["b.md", "body-b"], ["empty.md", "body-empty"]]));
			const head = h.store.getCatalogHeadAt(sequence, "body-a")!;
			assert.equal(head.path, "a.md");
			assert.equal(head.lifecycle, "active");
			assert.equal(head.contentHash, hashOf("alpha\n"));
			const feed = h.store.listChangesAfter(before);
			assert.equal(feed.length, 1, "one feed entry carries every created catalog row");
			assert.equal(feed[0]!.documentId, "root");
			assert.equal(feed[0]!.kind, "create");
			assert.deepEqual(feed[0]!.catalogs.map((item) => item.bodyId).sort(), ["body-a", "body-b", "body-empty"]);
			assert.equal(h.broadcasts, 1);
			assert.ok(response.envelope!.rootUpdate && response.envelope!.rootUpdate.byteLength > 0);
		});
	});

	s.test(`[${mode}] exact retry replays the stored receipt with zero writes; a changed retry is rejected`, async () => {
		await withHarness(lean, async (h) => {
			const files = [file("a", "alpha\n"), file("b", "beta\n")];
			const first = await h.send("batch-retry", files);
			assert.equal(first.status, 200);
			h.resetRows();
			const replay = await h.send("batch-retry", files);
			assert.equal(replay.status, 200);
			assert.equal(replay.envelope!.replayed, true);
			assert.deepEqual(replay.envelope!.outcomes, first.envelope!.outcomes);
			assert.equal(replay.envelope!.vaultSequence, first.envelope!.vaultSequence);
			assert.equal(h.rows.node, 0, "a replay writes nothing");
			const changed = await h.send("batch-retry", [file("a", "alpha changed\n"), file("b", "beta\n")]);
			assert.equal(changed.status, 409);
			assert.equal(changed.json!.error, "bulk_create_batch_identity_mismatch");
		});
	});

	s.test(`[${mode}] partial overlap with an earlier batch is rejected cleanly and names the items`, async () => {
		await withHarness(lean, async (h) => {
			assert.equal((await h.send("batch-first", [file("a", "alpha\n")])).status, 200);
			const sequence = h.store.currentSequence();
			const overlap = await h.send("batch-second", [file("a", "alpha\n"), file("c", "gamma\n")]);
			assert.equal(overlap.status, 409);
			assert.deepEqual(overlap.json, { error: "bulk_create_partial_overlap", operationIds: ["op-a"] });
			assert.equal(h.store.currentSequence(), sequence, "nothing committed");
			const rest = await h.send("batch-third", [file("c", "gamma\n")]);
			assert.equal(outcomesByOp(rest).get("op-c")!.outcome, "created");
		});
	});

	s.test(`[${mode}] in-batch and against-server path collisions, invalid paths: mixed outcomes`, async () => {
		await withHarness(lean, async (h) => {
			assert.equal((await h.send("seed", [file("same", "same text\n", "same.md"), file("diff", "server text\n", "diff.md")])).status, 200);
			const response = await h.send("mixed", [
				file("new", "new\n", "new.md"),
				file("same2", "same text\n", "same.md"),
				file("diff2", "local text\n", "diff.md"),
				file("dup", "dup\n", "new.md"),
				file("bad", "bad\n", "../escape.md"),
				file("notmd", "x\n", "folder/file.txt"),
			]);
			const outcomes = outcomesByOp(response);
			assert.equal(outcomes.get("op-new")!.outcome, "created");
			assert.equal(outcomes.get("op-same2")!.outcome, "exists-identical");
			assert.equal(outcomes.get("op-same2")!.existingBodyId, "body-same");
			assert.equal(outcomes.get("op-diff2")!.outcome, "exists-different");
			assert.equal(outcomes.get("op-diff2")!.existingBodyId, "body-diff");
			assert.equal(outcomes.get("op-dup")!.outcome, "rejected");
			assert.equal(outcomes.get("op-dup")!.reason, "duplicate_path_in_batch");
			assert.equal(outcomes.get("op-bad")!.outcome, "rejected");
			assert.equal(outcomes.get("op-bad")!.reason, "invalid_path");
			assert.equal(outcomes.get("op-notmd")!.outcome, "rejected");
			assert.deepEqual(response.envelope!.outcomes.map((item) => item.operationId),
				["op-new", "op-same2", "op-diff2", "op-dup", "op-bad", "op-notmd"], "outcomes keep request order");
			assert.equal(h.text("body-diff"), "server text\n", "exists-different never writes");
			assert.equal(h.store.existingBodyIds(["body-same2", "body-diff2", "body-dup"]).size, 0);
			assert.equal(h.rootPaths().get("new.md"), "body-new");
		});
	});

	s.test(`[${mode}] a batch with only existing paths writes nothing and stores no receipt`, async () => {
		await withHarness(lean, async (h) => {
			assert.equal((await h.send("seed", [file("a", "alpha\n")])).status, 200);
			h.resetRows();
			const sequence = h.store.currentSequence();
			const response = await h.send("noop", [file("a2", "alpha\n", "a.md")]);
			assert.equal(outcomesByOp(response).get("op-a2")!.outcome, "exists-identical");
			assert.equal(h.rows.node, 0);
			assert.equal(h.store.currentSequence(), sequence);
			assert.equal(h.store.bulkCreateReceipt("noop"), null);
		});
	});

	s.test(`[${mode}] a note larger than 1.75 MB is stored as a chunked snapshot and reads back`, async () => {
		await withHarness(lean, async (h) => {
			const text = "0123456789abcdef\n".repeat(150_000); // ~2.55 MB
			const big = file("big", text);
			assert.ok(big.updates.length >= 3);
			const response = await h.send("big-batch", [big]);
			assert.equal(outcomesByOp(response).get("op-big")!.outcome, "created");
			const chunks = h.store["storage"].sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_checkpoints WHERE document_id = ?", "body-big").one().count;
			assert.ok(chunks >= Math.ceil(text.length / SQLITE_BLOB_CHUNK_BYTES), `chunks=${chunks}`);
			assert.equal(h.text("body-big"), text);
		});
	});

	s.test(`[${mode}] attachments ride in the same batch; missing blobs and existing paths are typed`, async () => {
		await withHarness(lean, async (h) => {
			const hash = "a".repeat(64);
			const other = "b".repeat(64);
			h.blobs.add(hash);
			h.blobs.add(other);
			const attachment = (name: string, path: string, blob = hash, size = 10): AttachmentInput =>
				({ operationId: `att-${name}`, path, hash: blob, size, mime: "image/png" });
			const response = await h.send("with-attachments", [file("a", "![[x.png]]\n")], [
				attachment("x", "x.png"),
				attachment("y", "img/y.png"),
				attachment("missing", "z.png", "c".repeat(64)),
				attachment("dup", "x.png"),
			]);
			const outcomes = outcomesByOp(response);
			assert.equal(outcomes.get("op-a")!.outcome, "created");
			assert.equal(outcomes.get("att-x")!.outcome, "created");
			assert.equal(outcomes.get("att-y")!.outcome, "created");
			assert.equal(outcomes.get("att-missing")!.reason, "attachment_blob_missing");
			assert.equal(outcomes.get("att-dup")!.reason, "duplicate_path_in_batch");
			const sequence = response.envelope!.vaultSequence;
			assert.equal(h.store.attachmentHead("x.png")!.lifecycle, "active");
			assert.equal(h.store.attachmentHead("img/y.png")!.operationId, "att-y");
			assert.equal(h.store.listChangesAfter(sequence - 1).length, 1);
			const again = await h.send("attachments-again", [], [attachment("x2", "x.png"), attachment("y2", "img/y.png", other)]);
			const second = outcomesByOp(again);
			assert.equal(second.get("att-x2")!.outcome, "exists-identical");
			assert.equal(second.get("att-y2")!.outcome, "exists-different");
			assert.equal(second.get("att-y2")!.existingRevision, "att-y");
			const overlap = await h.send("attachments-overlap", [], [attachment("x", "q.png")]);
			assert.equal(overlap.status, 409);
			assert.deepEqual(overlap.json, { error: "bulk_create_partial_overlap", operationIds: ["att-x"] });
		});
	});

	s.test(`[${mode}] caps: >500 items and >4 MB are rejected before any work; root epoch is fenced`, async () => {
		await withHarness(lean, async (h) => {
			const many = Array.from({ length: BULK_CREATE_MAX_ITEMS + 1 }, (_, i) => file(`n${i}`, "x\n"));
			const tooMany = await h.send("too-many", many);
			assert.equal(tooMany.status, 413);
			assert.equal(tooMany.json!.error, "bulk_create_too_many_items");
			const big = "y".repeat(1_100_000) + "\n";
			const tooLarge = await h.send("too-large", [file("l1", big), file("l2", big), file("l3", big), file("l4", big)]);
			assert.equal(tooLarge.status, 413);
			const epoch = await h.send("epoch", [file("a", "a\n")], [], { rootEpoch: 2 });
			assert.equal(epoch.status, 409);
			assert.equal(h.store.existingBodyIds(["body-a"]).size, 0);
			const malformed = await h.send("malformed", [{ ...file("m", "m\n"), bodyId: "bad id!" }]);
			assert.equal(malformed.status, 400);
			const noncanonical = await h.send("noncanon", [{ ...file("crlf", ""), updates: bodyFrames("a\r\nb") }]);
			assert.equal(outcomesByOp(noncanonical).get("op-crlf")!.reason, "candidate_markdown_not_canonical");
		});
	});

	s.test(`[${mode}] an unknown or superseded device cannot bulk create`, async () => {
		await withHarness(lean, async (h) => {
			const response = await h.send("revoked", [file("a", "a\n")], [], {}, { ...owner, deviceCredentialRevision: 2 });
			assert.equal(response.status, 409);
			assert.equal(h.store.existingBodyIds(["body-a"]).size, 0);
		});
	});
}

// ---- Measurements: CF rows (exact workerd model, helpers/cfRowModel.ts) per batch of 1/100/500 notes
// and 1/50 attachments, per-table / per-index breakdown, CPU per batch (best of 3). Set
// YAOS_BULK_MEASURE_OUT=<file> to keep the JSON.
s.test("measure rows/note, per-batch overhead, per attachment and CPU (base and lean)", async () => {
	const report: Record<string, unknown> = {};
	type Sample = { node: number; cf: number; cpuMs: number; wallMs: number; byTable: Record<string, number>; byObject: Record<string, number> };
	for (const lean of modes) {
		const mode = lean ? "lean" : "base";
		const results: Record<string, Sample> = {};
		const cases: Array<[string, number, number]> = [["n1", 1, 0], ["n100", 100, 0], ["n500", 500, 0], ["a1", 0, 1], ["a50", 0, 50]];
		for (const [label, notes, attachments] of cases) {
			let best: Sample | null = null;
			for (let round = 0; round < 3; round++) {
				await withHarness(lean, async (h) => {
					// Warm one batch so lazy schema creation is not billed to the measurement.
					assert.equal((await h.send("warm", [file("warm", "warm\n")])).status, 200);
					const files = Array.from({ length: notes }, (_, i) => file(`m${i}`, note(i)));
					const atts = Array.from({ length: attachments }, (_, i) => {
						const hash = sha256HexSync(new TextEncoder().encode(`attachment-${i}`));
						h.blobs.add(hash);
						return { operationId: `att-${i}`, path: `img/a${i}.png`, hash, size: 100 + i, mime: "image/png" };
					});
					h.resetRows();
					const cpuStart = cpuUsage();
					const wallStart = performance.now();
					const response = await h.send(`measure-${label}`, files, atts);
					const wallMs = performance.now() - wallStart;
					const cpu = cpuUsage(cpuStart);
					const outcomes = outcomesByOp(response);
					assert.equal([...outcomes.values()].filter((item) => item.outcome === "created").length, notes + attachments);
					const sample: Sample = { node: h.rows.node, cf: h.rows.cf, cpuMs: (cpu.user + cpu.system) / 1000, wallMs,
						byTable: Object.fromEntries(h.rows.byTable), byObject: Object.fromEntries(h.rows.byObject) };
					if (best) assert.equal(sample.cf, best.cf, "rows are deterministic");
					if (!best || sample.cpuMs < best.cpuMs) best = sample;
				});
			}
			results[label] = best!;
		}
		const r = (label: string) => results[label]!;
		const perNoteNode = (r("n500").node - r("n100").node) / 400;
		const perNoteCf = (r("n500").cf - r("n100").cf) / 400;
		const perAttachmentNode = (r("a50").node - r("a1").node) / 49;
		const perAttachmentCf = (r("a50").cf - r("a1").cf) / 49;
		const perObject = (label: string, other: string, n: number) => Object.fromEntries(
			Object.keys(r(label).byObject).map((key) => [key, ((r(label).byObject[key] ?? 0) - (r(other).byObject[key] ?? 0)) / n]));
		report[mode] = {
			batches: results,
			rowsPerNote: { node: perNoteNode, cf: perNoteCf, byObject: perObject("n500", "n100", 400) },
			perBatch: { node: r("n100").node - 100 * perNoteNode, cf: r("n100").cf - 100 * perNoteCf },
			rowsPerAttachment: { node: perAttachmentNode, cf: perAttachmentCf, byObject: perObject("a50", "a1", 49) },
			rowsPerNoteAt: Object.fromEntries(["n1", "n100", "n500"].map((label) => [label, {
				node: r(label).node / Number(label.slice(1)), cf: r(label).cf / Number(label.slice(1)) }])),
			cpuMs: Object.fromEntries(Object.entries(results).map(([label, sample]) => [label, Math.round(sample.cpuMs * 10) / 10])),
		};
	}
	const text = JSON.stringify(report);
	console.log(`[bulk-create-measure] ${text}`);
	if (process.env.YAOS_BULK_MEASURE_OUT) (await import("node:fs")).writeFileSync(process.env.YAOS_BULK_MEASURE_OUT, JSON.stringify(report, null, 2));
});

await s.done();
