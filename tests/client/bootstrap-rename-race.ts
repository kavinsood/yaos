import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { BootstrapClient, type ClientBodyState, type ClientCatalogEntry } from "../../src/sync/bootstrapClient";
import { BodyManager } from "../../src/sync/bodyManager";
import type { StoredBootstrapProgress, StoredDocument, StoredOutstandingBody } from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";

const s = suite("bootstrap-rename-race");

async function hash(content: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bodyState(bodyId: string, content: string, generation: number): ClientBodyState {
	const doc = new Y.Doc({ guid: bodyId });
	doc.getText("body").insert(0, content);
	const encodedState = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return { bodyId, generation, encodedState };
}

s.test("200 creates with 100 mid-bootstrap renames leave only authoritative targets", async () => {
	const heads = new Map<string, ClientCatalogEntry>();
	const staleEntries: ClientCatalogEntry[] = [];
	const states = new Map<string, ClientBodyState>();
	for (let index = 0; index < 200; index++) {
		const bodyId = `body-${index}`;
		const content = `content-${index}`;
		const entry: ClientCatalogEntry = {
			bodyId,
			fileId: bodyId,
			path: `created/${index}.md`,
			generation: 1,
			contentHash: await hash(content),
			size: new TextEncoder().encode(content).byteLength,
		};
		staleEntries.push({ ...entry });
		heads.set(bodyId, { ...entry });
		states.set(bodyId, bodyState(bodyId, content, 1));
	}

	let progress: StoredBootstrapProgress | null = null;
	const documents = new Map<string, StoredDocument>();
	const outstanding = new Map<string, StoredOutstandingBody>();
	const materializedPaths = new Map<string, string>();
	const database = {
		getBootstrapProgress: async () => progress,
		putBootstrapProgress: async (value: StoredBootstrapProgress) => { progress = { ...value }; },
		putFeedCursor: async () => {},
		getDocument: async (bodyId: string) => documents.get(bodyId) ?? null,
		putDocument: async (document: StoredDocument) => { documents.set(document.documentId, document); },
		deleteDocument: async (bodyId: string) => { documents.delete(bodyId); },
		getOutstanding: async (bodyId: string) => outstanding.get(bodyId) ?? null,
		putOutstanding: async (value: StoredOutstandingBody) => { outstanding.set(value.bodyId, value); },
		listOutstanding: async () => [...outstanding.values()],
		deleteOutstanding: async (bodyId: string) => { outstanding.delete(bodyId); },
		getMaterializedPath: async (bodyId: string) => materializedPaths.get(bodyId) ?? null,
		setMaterializedPath: async (bodyId: string, path: string) => { materializedPaths.set(bodyId, path); },
		setMaterializedPaths: async (values: Array<{ bodyId: string; path: string }>) => {
			for (const value of values) materializedPaths.set(value.bodyId, value.path);
		},
		deleteMaterializedPath: async (bodyId: string) => { materializedPaths.delete(bodyId); },
		listMaterializedPaths: async () => [...materializedPaths].map(([bodyId, path]) => ({ bodyId, path })),
	};
	const root = new Y.Doc();
	root.getMap("sys").set("schemaVersion", 4);
	const rootBytes = Y.encodeStateAsUpdate(root);
	root.destroy();
	const server = {
		start: async () => ({
			bootstrapId: "rename-race",
			createdAt: "2026-08-23T00:00:00.000Z",
			expiresAt: "2026-08-24T00:00:00.000Z",
			serverCompleted: false,
			capture: { vaultSequence: 0, rootGeneration: 1, rootCheckpointHash: await hashBytes(rootBytes) },
			catalog: { activeBodyCount: 200, pageSize: 1000, firstCursor: null, feedFloor: 0, highWater: 0 },
		}),
		root: async () => rootBytes,
		catalog: async () => ({ entries: staleEntries, nextCursor: null }),
		bodies: async (_id: string, bodyIds: string[]) => new Map(bodyIds.map((bodyId) => [bodyId, states.get(bodyId)!])),
		renew: async () => {},
		complete: async () => ({ currentHighWater: 0 }),
		changesAfter: async () => ({ entries: [], currentHighWater: 0, resetRequired: false }),
		currentHead: async (bodyId: string) => heads.get(bodyId) ?? null,
		currentBody: async (bodyId: string) => states.get(bodyId)!,
		currentHeads: async () => ({ entries: [...heads.values()], nextCursor: null }),
		settleRootThrough: async () => {},
	};
	const diskFiles = new Map<string, string>();
	const renamed = new Set<string>();
	const disk = {
		settleBody: async ({ path, bodyId, content }: { path: string; bodyId: string; content: string }) => {
			diskFiles.set(path, content);
			const index = Number(bodyId.slice("body-".length));
			if (index < 100 && !renamed.has(bodyId) && path === `created/${index}.md`) {
				renamed.add(bodyId);
				heads.set(bodyId, { ...heads.get(bodyId)!, path: `renamed/${index}.md`, generation: 2 });
				states.set(bodyId, bodyState(bodyId, content, 2));
			}
			return "settled" as const;
		},
		discardStaleBody: async ({ path, expectedContent }: { path: string; expectedContent: string }) => {
			if (diskFiles.get(path) !== expectedContent) return false;
			diskFiles.delete(path);
			return true;
		},
		settleRename: async ({ from, to, currentContent }: { from: string; to: string; currentContent: string }) => {
			const source = diskFiles.get(from);
			const target = diskFiles.get(to);
			if (source === currentContent && target === currentContent) {
				diskFiles.delete(from);
				return "source-deleted" as const;
			}
			if (source === currentContent && target === undefined) {
				diskFiles.delete(from);
				diskFiles.set(to, source);
				return "moved" as const;
			}
			return "preserved-unresolved" as const;
		},
		moveBodies: async () => {},
		deleteBody: async () => "deleted" as const,
	};
	const bodies = new BodyManager(database);
	const client = new BootstrapClient(server as never, database as never, bodies, disk, undefined, Date.now, 8);
	const result = await client.run("rename-race");
	assert.equal(result.stage, "complete");
	assert.equal(outstanding.size, 0);
	assert.equal(diskFiles.size, 200);
	assert.equal([...diskFiles.keys()].filter((path) => path.startsWith("renamed/")).length, 100);
	assert.equal([...diskFiles.keys()].filter((path) => path.startsWith("created/") && Number(path.slice(8, -3)) < 100).length, 0);
	for (let index = 0; index < 100; index++) {
		assert.equal(diskFiles.get(`renamed/${index}.md`), `content-${index}`);
		assert.equal(diskFiles.has(`created/${index}.md`), false);
	}
	assert.equal(client["bodySettlementWork"].size, 0, "every per-body settlement queue drains");
	assert.ok(bodies.stats().loaded <= 24, `loaded body count stays within the product maximum (${bodies.stats().loaded}/24)`);
	diskFiles.set("duplicate/150.md", "content-150");
	heads.set("body-150", {
		...heads.get("body-150")!,
		path: "duplicate/150.md",
		previousPath: "created/150.md",
		generation: 2,
	});
	states.set("body-150", bodyState("body-150", "content-150", 2));
	await client.settleBodyNow("body-150");
	assert.equal(diskFiles.has("created/150.md"), false, "previousPath settlement removes the exact duplicate old source");
	assert.equal(diskFiles.get("duplicate/150.md"), "content-150", "previousPath settlement leaves the exact target");
	assert.equal(materializedPaths.get("body-150"), "duplicate/150.md", "materialized path advances only after duplicate cleanup");
	await bodies.destroy();
});

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

await s.done();
