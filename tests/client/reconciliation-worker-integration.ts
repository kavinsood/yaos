import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { ReconciliationWorker } from "../../src/runtime/reconciliationWorker";
import { PRODUCT_EVENT_KIND } from "../../src/observability/productEventKinds";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../../src/runtime/engineControlPort";
import { ConflictEpisodes } from "../../src/sync/conflictEpisodes";
import type { StoredBodySettlementV1 } from "../../src/sync/bodySettlement";
import { DiskMirror } from "../../src/sync/diskMirror";
import { contentBaselineHash, currentContentHash, setCurrentContentHash, type DiskIndex } from "../../src/sync/diskIndex";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { VaultSync, type CandidateRecord, type SyncProviderPort, type VaultDatabasePort, type VaultServerPort } from "../../src/sync/vaultSync";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("reconciliation-worker-integration");

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

async function bounded<Result>(promise: Promise<Result>): Promise<Result> {
	let timer!: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("integration operation timed out")), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function fixture(kind: "artifact" | "closed" | "projection" = "closed") {
	const disk = new Map<string, string>();
	const episodes = new ConflictEpisodes({ episodes: {}, artifacts: {} }, {
		read: async (path) => disk.get(path) ?? null,
		write: async (path, content, expected) => {
			assert.equal(disk.get(path) ?? null, expected);
			disk.set(path, content);
		},
		persist: async () => {}, changed: () => {}, notify: () => {},
	});
	let path = "Closed.md";
	let prefix = "before";
	let appended = "before\nafter";
	if (kind === "artifact") {
		const version = "first preserved version\n";
		await episodes.preserve({ bodyId: "original-note-body", path: "note-2.md", body: version, disk: version, device: "Mac 2" });
		path = episodes.get("original-note-body")!.parts.at(-1)!;
		prefix = disk.get(path)!;
		await episodes.preserve({ bodyId: "original-note-body", path: "note-2.md", body: version, disk: "next preserved version\n", device: "Mac 2" });
		appended = disk.get(path)!;
		assert.ok(appended.startsWith(prefix));
		assert.equal(await episodes.isArtifact(path, appended), true);
	}
	const bodyId = kind === "artifact" ? "artifact-body" : "body-closed";
	const otherPath = "Independent.md";
	const otherBodyId = "body-independent";
	const bodyContent = kind === "projection" ? "remote" : prefix;
	disk.set(path, kind === "projection" ? prefix : appended);
	disk.set(otherPath, "independent before");
	const documents = new Map<string, StoredDocument>();
	for (const [identity, content] of [[bodyId, bodyContent], [otherBodyId, "independent before"]]) {
		const seed = new Y.Doc({ guid: identity });
		seed.getText("body").insert(0, content!);
		const state = Y.encodeStateAsUpdate(seed);
		const owned = new Uint8Array(state.byteLength);
		owned.set(state);
		documents.set(identity!, {
			kind: "body", documentId: identity!, bodyEpoch: 1, durableBaseline: content!,
			generation: 1, encodedState: owned.buffer, dirty: false, updatedAt: 1,
		});
		seed.destroy();
	}
	const candidates = new Map<string, CandidateRecord>();
	const submissions: CandidateRecord[] = [];
	const database: VaultDatabasePort = {
		getDocument: async (identity) => documents.get(identity) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_identity, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => ({ ...operation, localSequence: operation.localSequence || 1 }),
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	};
	const gates: ReturnType<typeof gate>[] = [];
	const receiptBlocks = new Map<string, ReturnType<typeof gate>>();
	const server = partialOf<VaultServerPort>({
		currentHead: async (identity) => ({ bodyId: identity, bodyEpoch: 1, generation: 1 }),
		submitCandidate: async (candidate) => {
			submissions.push(candidate);
			const blocked = receiptBlocks.get(candidate.bodyId);
			receiptBlocks.delete(candidate.bodyId);
			if (blocked) await blocked.promise;
			return {
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: candidate.bodyId,
				bodyEpoch: candidate.bodyEpoch, clientId: "device-1", candidateId: candidate.candidateId,
				candidateDigest: candidate.candidateDigest,
				durableGeneration: 1 + submissions.filter((submitted) => submitted.bodyId === candidate.bodyId).length,
				runtimeEpoch: "epoch-1",
			};
		},
	});
	const provider = partialOf<SyncProviderPort>({
		awareness: { setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map() },
		documentOrigin: {}, ws: null, wsconnected: false, wsconnecting: false, synced: false,
		url: "ws://test/root", connect: () => {}, disconnect: () => {}, destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server, providerFactory: () => provider,
		onDurableBodyCommitted: () => { controller.notifyLocalWorkSettled(); },
		onProductEvent: (event) => {
			if (event.kind === PRODUCT_EVENT_KIND.serverReceiptConfirmed) controller.notifyLocalWorkSettled();
		},
	});
	runtime.ydoc.transact(() => {
		runtime.pathToId.set(path, bodyId);
		runtime.pathToId.set(otherPath, otherBodyId);
	}, "indexeddb-bootstrap");
	await runtime.bodies.load(bodyId);
	await runtime.bodies.load(otherBodyId);
	assert.equal(runtime.isBodyLoaded(bodyId), true);
	assert.equal(runtime.isBodyOpen(bodyId), false);
	let diskIndex: DiskIndex = {};
	for (const [diskPath, content] of [[path, prefix], [otherPath, "independent before"]]) {
		const entry = { mtime: 1, size: content!.length };
		setCurrentContentHash(entry, await contentBaselineHash(content!));
		diskIndex[diskPath!] = entry;
	}
	const files = new Map([path, otherPath].map((diskPath) => [diskPath,
		Object.assign(new TFile(), { path: diskPath, stat: { ctime: 1, mtime: 2, size: disk.get(diskPath)!.length } }),
	]));
	const reads: string[] = [];
	const writes: string[] = [];
	const agreements: string[] = [];
	const indexWrites: DiskIndex[] = [];
	const readBlocks = new Map<string, { entered: ReturnType<typeof gate>; held: ReturnType<typeof gate>; error?: Error }>();
	const statBlocks = new Map<string, { entered: ReturnType<typeof gate>; held: ReturnType<typeof gate> }>();
	const app = {
		vault: {
			read: async (file: TFile) => {
				reads.push(file.path);
				const content = disk.get(file.path)!;
				const blocked = readBlocks.get(file.path);
				readBlocks.delete(file.path);
				if (blocked) {
					blocked.entered.release();
					await blocked.held.promise;
					if (blocked.error) throw blocked.error;
				}
				return content;
			},
			getAbstractFileByPath: (requested: string) => files.get(requested) ?? null,
			process: async (file: TFile, transform: (content: string) => string) => {
				const next = transform(disk.get(file.path)!);
				writes.push(file.path);
				disk.set(file.path, next);
				return next;
			},
			adapter: {
				stat: async (requested: string) => {
					const stat = { mtime: 2, size: disk.get(requested)!.length };
					const blocked = statBlocks.get(requested);
					statBlocks.delete(requested);
					if (blocked) {
						blocked.entered.release();
						await blocked.held.promise;
					}
					return stat;
				},
			},
		},
		workspace: { iterateAllLeaves: () => {}, getActiveViewOfType: () => null },
	};
	const worker = new ReconciliationWorker();
	const mirror = new DiskMirror(app as never, runtime, partialOf<EditorBindingManager>({ isBound: () => false }), false);
	mirror.setReconciliationWorker(worker);
	mirror.configureSettlement({
		conflictEpisodes: episodes,
		getBaseline: (diskPath) => ({ contentHash: currentContentHash(diskIndex[diskPath]) ?? null, trustedWhole: true }),
		getCommonBase: async (identity) => {
			if (kind === "artifact" && identity === bodyId) return { kind: "missing" };
			const content = identity === otherBodyId ? "independent before" : prefix;
			return {
				kind: "available",
				settlement: partialOf<StoredBodySettlementV1>({ format: 1, content, contentHash: await contentBaselineHash(content) }),
			};
		},
		commitLocalBody: async (input) => (await runtime.commitBodyCandidateIfCurrent({
			bodyId: input.bodyId, path: input.path, content: input.content, expectedContent: input.expectedBodyContent!,
			candidateId: crypto.randomUUID(), reason: input.reason, waitForReceipt: false,
		})).kind,
		commitMergedBody: async (input) => (await runtime.commitBodyCandidateIfCurrent({
			bodyId: input.bodyId, path: input.path, content: input.mergedContent, expectedContent: input.expectedBodyContent,
			candidateId: crypto.randomUUID(), reason: "three-way-merge", waitForReceipt: false,
		})).kind,
		shouldBlockDiskIngest: () => false,
	});
	let ingest!: DiskIngestPort;
	const controller = new ReconciliationController({
		app: app as never, getConflictEpisodes: () => episodes,
		getSettings: () => ({ deviceName: "Mac 2" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, externalEditPolicy: "always" }) as never,
		getVaultSync: () => runtime, getDiskMirror: () => mirror, getBlobSync: () => null, getEditorBindings: () => null,
		getDiskIndex: () => diskIndex, setDiskIndex: (next) => { diskIndex = next; indexWrites.push(next); },
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {}, validateOpenEditorBindings: () => {}, onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false, setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {}, refreshStatusBar: () => {}, trace: () => {}, scheduleTraceStateSnapshot: () => {}, log: () => {},
		registerDiskIngestPort: (port) => { ingest = port; },
	});
	mirror.setDiskWriteCallback((diskPath, hash, content) => {
		agreements.push(diskPath);
		controller.recordProjectedDiskWrite(diskPath, hash, content);
	});
	const pending: Promise<unknown>[] = [];
	function track<Result>(promise: Promise<Result>): Promise<Result> {
		pending.push(promise);
		void promise.catch(() => {});
		return promise;
	}
	return {
		path, bodyId, otherPath, otherBodyId, prefix, appended, bodyContent,
		runtime, worker, controller, mirror, episodes, files, disk, documents, candidates, submissions, reads, writes, agreements, indexWrites,
		index: () => diskIndex,
		blockRead: (diskPath = path, error?: Error) => {
			const entered = gate();
			const held = gate();
			gates.push(held);
			readBlocks.set(diskPath, { entered, held, error });
			return { entered: entered.promise, release: held.release };
		},
		blockStat: (diskPath = path) => {
			const entered = gate();
			const held = gate();
			gates.push(held);
			statBlocks.set(diskPath, { entered, held });
			return { entered: entered.promise, release: held.release };
		},
		blockReceipt: () => {
			const held = gate();
			gates.push(held);
			receiptBlocks.set(bodyId, held);
			return held;
		},
		ingest: (diskPath = path) => track(ingest.ingestDiskFileNow(diskPath, "modify")),
		settle: (content = bodyContent, diskPath = path, identity = bodyId) => track(mirror.settleBody({
			path: diskPath, bodyId: identity, generation: runtime.bodies.get(identity)!.generation,
			content, onMissingBase: "preserve-disk",
		})),
		destroy: async () => {
			for (const held of gates) held.release();
			try {
				await bounded(Promise.allSettled(pending));
				await bounded(worker.whenIdle());
			} finally {
				mirror.destroy();
				episodes.dispose();
				await runtime.destroy();
			}
		},
	};
}

async function queued(subject: Awaited<ReturnType<typeof fixture>>) {
	await until(() => subject.worker.diagnostics().queued === 1, { message: "other module queued behind shared filesystem work" });
	assert.equal(subject.worker.diagnostics().active, 1);
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function assertPublishedAppend(subject: Awaited<ReturnType<typeof fixture>>) {
	await until(() => subject.candidates.size === 0 && !subject.runtime.bodies.get(subject.bodyId)!.dirty, { message: "durable artifact append receipt" });
	assert.equal(subject.runtime.getPathContent(subject.path), subject.appended);
	assert.equal(subject.disk.get(subject.path), subject.appended);
	assert.equal(subject.submissions.length, 1, "only one durable append candidate is published");
	assert.equal(subject.candidates.size, 0);
	assert.equal(subject.runtime.bodies.get(subject.bodyId)!.dirty, false);
	assert.equal(subject.writes.length, 0, "the verified history is never projected back to its stale prefix");
	assert.equal(subject.episodes.list().length, 1, "no nested conflict episode is produced");
	for (const version of subject.episodes.get("original-note-body")!.versions) {
		await subject.episodes.readVersion("original-note-body", version.hash);
	}
	assert.equal(currentContentHash(subject.index()[subject.path]), await contentBaselineHash(subject.appended));
	await bounded(subject.worker.whenIdle());
	assert.deepEqual(subject.worker.diagnostics(), { active: 0, queued: 0 });
}

for (const first of ["ingest", "settle"] as const) {
	tests.test(`${first} enters artifact verification first while the shared FIFO preserves the append`, async () => {
		const subject = await fixture("artifact");
		try {
			const blocked = subject.blockRead();
			const firstWork = subject[first]();
			await bounded(blocked.entered);
			const secondWork = first === "ingest" ? subject.settle() : subject.ingest();
			await queued(subject);
			assert.deepEqual(subject.reads, [subject.path], "the other module has not started a competing filesystem read");
			assert.equal(subject.submissions.length, 0);
			assert.equal(subject.runtime.getPathContent(subject.path), subject.prefix);
			blocked.release();
			await bounded(Promise.all([firstWork, secondWork]));
			await assertPublishedAppend(subject);
		} finally { await subject.destroy(); }
	});
}

tests.test("a pending durable receipt frees the worker while agreement waits for accepted data", async () => {
	const subject = await fixture();
	try {
		const receipt = subject.blockReceipt();
		const imported = subject.ingest();
		await until(() => subject.submissions.length === 1, { message: "closed-body candidate submission" });
		await bounded(imported);
		await bounded(subject.worker.whenIdle());
		const settled = subject.settle(subject.appended);
		assert.equal(await bounded(settled), "replan", "pending local work cannot establish durable disk agreement");
		assert.equal(await bounded(subject.settle("independent before", subject.otherPath, subject.otherBodyId)), "settled", "independent filesystem settlement is not held behind a network receipt");
		assert.ok(subject.reads.includes(subject.otherPath));
		assert.equal(subject.candidates.size, 1);
		assert.equal(currentContentHash(subject.index()[subject.path]), await contentBaselineHash(subject.prefix));
		assert.deepEqual(subject.agreements, [subject.otherPath]);
		assert.equal(subject.runtime.bodies.get(subject.bodyId)!.dirty, true);
		const durableDocument = subject.documents.get(subject.bodyId)!;
		const reconstructed = new Y.Doc({ guid: subject.bodyId });
		try {
			Y.applyUpdate(reconstructed, new Uint8Array(durableDocument.encodedState));
			assert.equal(reconstructed.getText("body").toString(), subject.appended, "the pending candidate's body is locally durable before ACK");
		} finally { reconstructed.destroy(); }
		receipt.release();
		await until(() => subject.candidates.size === 0 && !subject.runtime.bodies.get(subject.bodyId)!.dirty, { message: "withheld candidate receipt completes" });
		assert.equal(await bounded(subject.settle(subject.appended)), "settled");
		assert.equal(subject.runtime.getPathContent(subject.path), subject.appended);
		assert.equal(currentContentHash(subject.index()[subject.path]), await contentBaselineHash(subject.appended));
		assert.equal(subject.candidates.size, 0);
		assert.equal(subject.submissions.length, 1);
		assert.deepEqual(subject.agreements, [subject.otherPath, subject.path]);
	} finally { await subject.destroy(); }
});

tests.test("DiskMirror projection finishes before queued controller ingestion reads the remote body", async () => {
	const subject = await fixture("projection");
	try {
		const blocked = subject.blockRead();
		const projected = subject.settle();
		await bounded(blocked.entered);
		const imported = subject.ingest();
		await queued(subject);
		assert.deepEqual(subject.reads, [subject.path]);
		assert.deepEqual(subject.writes, []);
		assert.equal(subject.disk.get(subject.path), subject.prefix);
		blocked.release();
		assert.equal(await bounded(projected), "settled");
		await bounded(imported);
		assert.deepEqual(subject.writes, [subject.path]);
		assert.equal(subject.disk.get(subject.path), "remote");
		assert.equal(subject.runtime.getPathContent(subject.path), "remote");
		assert.equal(subject.submissions.length, 0, "stale disk is not re-imported as a candidate");
		assert.equal(currentContentHash(subject.index()[subject.path]), await contentBaselineHash("remote"));
	} finally { await subject.destroy(); }
});

tests.test("controller reset fences a captured disk read before any body, candidate, or baseline mutation", async () => {
	const subject = await fixture();
	try {
		const beforeIndex = structuredClone(subject.index());
		const beforeDocument = structuredClone(subject.documents.get(subject.bodyId));
		const blocked = subject.blockRead();
		const imported = subject.ingest();
		await bounded(blocked.entered);
		subject.controller.reset();
		blocked.release();
		await bounded(imported);
		assert.equal(subject.runtime.getPathContent(subject.path), subject.prefix);
		assert.equal(subject.disk.get(subject.path), subject.appended);
		assert.deepEqual(subject.documents.get(subject.bodyId), beforeDocument);
		assert.deepEqual(subject.index(), beforeIndex);
		assert.equal(subject.indexWrites.length, 0);
		assert.equal(subject.submissions.length, 0);
		assert.equal(subject.candidates.size, 0);
		await bounded(subject.ingest());
		assert.equal(subject.runtime.getPathContent(subject.path), subject.appended, "fresh filesystem work can import after reset");
		assert.equal(subject.submissions.length, 1);
	} finally { await subject.destroy(); }
});

tests.test("a TFile renamed during its held disk read expires the source without changing the runtime catalog or importing content", async () => {
	const subject = await fixture();
	try {
		const file = subject.files.get(subject.path)!;
		const beforeCatalog = [...subject.runtime.pathToId.entries()];
		const beforeDocuments = structuredClone(subject.documents);
		const beforeIndex = structuredClone(subject.index());
		const blocked = subject.blockRead();
		const imported = subject.ingest();
		await bounded(blocked.entered);
		file.path = "Moved-during-read.md";
		assert.equal(subject.files.get(subject.path), file, "the original lookup still returns the same mutable source handle");
		assert.equal(subject.runtime.getFileId(subject.path), subject.bodyId);
		assert.equal(subject.runtime.getFileId(file.path) ?? null, null);
		assert.deepEqual([...subject.runtime.pathToId.entries()], beforeCatalog);
		blocked.release();
		await bounded(imported);
		assert.equal(subject.runtime.getPathContent(subject.path), subject.prefix);
		assert.equal(subject.runtime.getPathContent(subject.otherPath), "independent before");
		assert.equal(subject.disk.get(subject.path), subject.appended);
		assert.deepEqual([...subject.runtime.pathToId.entries()], beforeCatalog);
		assert.deepEqual(subject.documents, beforeDocuments);
		assert.deepEqual(subject.index(), beforeIndex);
		assert.equal(subject.submissions.length, 0);
		assert.equal(subject.candidates.size, 0);
		assert.equal(subject.indexWrites.length, 0);
		assert.deepEqual(subject.writes, []);
		assert.deepEqual(subject.agreements, []);
		await bounded(subject.worker.whenIdle());
		assert.deepEqual(subject.worker.diagnostics(), { active: 0, queued: 0 });
	} finally { await subject.destroy(); }
});

tests.test("reset during baseline stat retains a receipted body candidate without advancing the stale disk index", async () => {
	const subject = await fixture();
	try {
		const beforeIndex = structuredClone(subject.index());
		const blocked = subject.blockStat();
		const imported = subject.ingest();
		await bounded(blocked.entered);
		assert.equal(subject.submissions.length, 1);
		assert.equal(subject.candidates.size, 0, "the durable receipt has already cleared the candidate");
		assert.equal(subject.runtime.getPathContent(subject.path), subject.appended);
		assert.equal(subject.runtime.bodies.get(subject.bodyId)!.dirty, false);
		const durableDocument = structuredClone(subject.documents.get(subject.bodyId)!);
		assert.equal(durableDocument.generation, 2);
		assert.equal(durableDocument.dirty, false);
		const reconstructed = new Y.Doc({ guid: subject.bodyId });
		try {
			Y.applyUpdate(reconstructed, new Uint8Array(durableDocument.encodedState));
			assert.equal(reconstructed.getText("body").toString(), subject.appended, "the committed body is persisted before stat resolves");
		} finally { reconstructed.destroy(); }
		assert.deepEqual(subject.index(), beforeIndex);
		assert.equal(subject.indexWrites.length, 0);
		subject.controller.reset();
		blocked.release();
		await bounded(imported);
		assert.equal(subject.runtime.getPathContent(subject.path), subject.appended);
		assert.equal(subject.disk.get(subject.path), subject.appended);
		assert.deepEqual(subject.documents.get(subject.bodyId), durableDocument, "reset does not undo the durable body commit");
		assert.equal(subject.candidates.size, 0);
		assert.equal(subject.submissions.length, 1);
		assert.deepEqual(subject.index(), beforeIndex, "the pre-reset stat cannot advance the disk baseline");
		assert.equal(subject.indexWrites.length, 0);
	} finally { await subject.destroy(); }
});

tests.test("controller reset also invalidates DiskMirror suspended in a read without stale projection", async () => {
	const subject = await fixture("projection");
	try {
		const beforeIndex = structuredClone(subject.index());
		const blocked = subject.blockRead();
		const projected = subject.settle();
		await bounded(blocked.entered);
		subject.controller.reset();
		const fresh = subject.settle();
		await queued(subject);
		assert.deepEqual(subject.reads, [subject.path]);
		blocked.release();
		assert.equal(await bounded(projected), "replan");
		assert.equal(await bounded(fresh), "settled");
		assert.deepEqual(subject.writes, [subject.path], "only the fresh projection mutates disk");
		assert.deepEqual(subject.agreements, [subject.path]);
		assert.equal(subject.disk.get(subject.path), "remote");
		assert.equal(subject.runtime.getPathContent(subject.path), "remote");
		assert.equal(currentContentHash(subject.index()[subject.path]), await contentBaselineHash("remote"));
		assert.deepEqual(subject.index()[subject.otherPath], beforeIndex[subject.otherPath]);
		assert.equal(subject.submissions.length, 0);
	} finally { await subject.destroy(); }
});

tests.test("a real controller disk-read rejection frees the worker for queued DiskMirror settlement", async () => {
	const subject = await fixture("artifact");
	try {
		const failure = new Error("vault disk read failed");
		const blocked = subject.blockRead(subject.path, failure);
		const imported = subject.ingest();
		await bounded(blocked.entered);
		const settled = subject.settle();
		await queued(subject);
		assert.deepEqual(subject.reads, [subject.path]);
		blocked.release();
		await assert.rejects(bounded(imported), (error: unknown) => error === failure);
		assert.equal(await bounded(settled), "replan");
		await bounded(subject.ingest());
		await assertPublishedAppend(subject);
	} finally { await subject.destroy(); }
});

tests.test("all bodies wait in one FIFO while a filesystem read is blocked", async () => {
	const subject = await fixture();
	try {
		const blocked = subject.blockRead();
		const heldImport = subject.ingest();
		await bounded(blocked.entered);
		subject.disk.set(subject.otherPath, "independent before\nindependent after");
		const independentImport = subject.ingest(subject.otherPath);
		const independentSettlement = subject.settle("independent before", subject.otherPath, subject.otherBodyId);
		await until(() => subject.worker.diagnostics().queued === 2, { message: "both independent operations wait in the shared FIFO" });
		assert.deepEqual(subject.reads, [subject.path]);
		assert.equal(subject.submissions.length, 0);
		assert.equal(subject.runtime.getPathContent(subject.otherPath), "independent before");
		assert.equal(subject.runtime.getPathContent(subject.path), subject.prefix);
		assert.equal(currentContentHash(subject.index()[subject.path]), await contentBaselineHash(subject.prefix));
		assert.equal(subject.worker.diagnostics().active, 1);
		blocked.release();
		await bounded(Promise.all([heldImport, independentImport]));
		assert.equal(await bounded(independentSettlement), "replan", "a queued settlement cannot apply its pre-ingest body snapshot");
		await until(() => subject.candidates.size === 0 && !subject.runtime.bodies.get(subject.otherBodyId)!.dirty, { message: "independent additive input is accepted" });
		assert.equal(await bounded(subject.settle("independent before\nindependent after", subject.otherPath, subject.otherBodyId)), "settled");
		assert.equal(subject.runtime.getPathContent(subject.otherPath), "independent before\nindependent after");
		assert.equal(currentContentHash(subject.index()[subject.otherPath]), await contentBaselineHash("independent before\nindependent after"));
		assert.deepEqual(subject.submissions.map((candidate) => candidate.bodyId).sort(), [subject.bodyId, subject.otherBodyId].sort(), "each body publishes once without imposing filesystem FIFO on network submissions");
		assert.equal(subject.runtime.getPathContent(subject.path), subject.appended);
		assert.equal(subject.submissions.length, 2);
	} finally { await subject.destroy(); }
});

await tests.done();
