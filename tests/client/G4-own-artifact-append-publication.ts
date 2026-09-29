import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import { ConflictEpisodes } from "../../src/sync/conflictEpisodes";
import { DiskMirror } from "../../src/sync/diskMirror";
import { contentBaselineHash, setCurrentContentHash, type DiskIndex } from "../../src/sync/diskIndex";
import { VaultSync, type CandidateRecord, type SyncProviderPort, type VaultDatabasePort, type VaultServerPort } from "../../src/sync/vaultSync";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import type { DiskIngestPort } from "../../src/runtime/engineControlPort";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("G4-own-artifact-append-publication");

async function fixture(options: {
	large?: boolean;
	baseline?: "body" | "older" | "missing";
	tamper?: boolean;
	rawTamper?: boolean;
	divergentBody?: boolean;
	blockFrontmatter?: boolean;
} = {}) {
	const artifacts = new Map<string, string>();
	const episodeBodyId = "original-note-body";
	const episodes = new ConflictEpisodes({ episodes: {}, artifacts: {} }, {
		read: async (path) => artifacts.get(path) ?? null,
		write: async (path, content, expected) => {
			assert.equal(artifacts.get(path) ?? null, expected);
			artifacts.set(path, content);
		},
		persist: async () => {}, changed: () => {}, notify: () => {},
	});
	const firstVersion = options.large ? "first preserved version\n" + "a".repeat(349900) : "first preserved version\n";
	if (options.large) {
		const earlierPart = "previous artifact part\n" + "p".repeat(900000);
		await episodes.preserve({ bodyId: episodeBodyId, path: "note-2.md", body: earlierPart, disk: earlierPart, device: "Mac 2" });
	}
	await episodes.preserve({ bodyId: episodeBodyId, path: "note-2.md", body: firstVersion, disk: firstVersion, device: "Mac 2" });
	const path = episodes.get(episodeBodyId)!.parts.at(-1)!;
	if (options.large) assert.ok(path.includes("part 2"), "the publication race occurs on a genuine rolled-over part");
	const prefix = artifacts.get(path)!;
	const secondVersion = options.large ? "next preserved version\n" + "b".repeat(349900) : "next preserved version\n";
	await episodes.preserve({ bodyId: episodeBodyId, path: "note-2.md", body: firstVersion, disk: secondVersion, device: "Mac 2" });
	const appended = artifacts.get(path)!;
	assert.equal(appended.startsWith(prefix), true);
	assert.equal(await episodes.isArtifact(path, appended), true);
	if (options.tamper) artifacts.set(path, appended + "unverified local edit\n");
	if (options.rawTamper) artifacts.set(path, appended.replace(/\n/g, "\r\n"));
	const initialBody = options.divergentBody ? prefix + "independent remote edit\n" : prefix;
	const bodyId = "artifact-body";
	const seed = new Y.Doc({ guid: bodyId });
	seed.getText("body").insert(0, initialBody);
	const state = Y.encodeStateAsUpdate(seed);
	const owned = new Uint8Array(state.byteLength);
	owned.set(state);
	const documents = new Map<string, StoredDocument>([[bodyId, {
		kind: "body", documentId: bodyId, bodyEpoch: 1, durableBaseline: prefix,
		generation: 2, encodedState: owned.buffer, dirty: false, updatedAt: 1,
	}]]);
	seed.destroy();
	const candidates = new Map<string, CandidateRecord>();
	const submissions: CandidateRecord[] = [];
	const database: VaultDatabasePort = {
		getDocument: async (requested) => documents.get(requested) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => ({ ...operation, localSequence: operation.localSequence || 1 }),
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	};
	const server = partialOf<VaultServerPort>({
		currentHead: async () => ({ bodyId, bodyEpoch: 1, generation: 2 }),
		submitCandidate: async (candidate) => {
			if (candidate.candidateId === "already-receipted-create") throw new Error("candidate_id_reused_with_different_digest");
			submissions.push(candidate);
			return {
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId, bodyEpoch: 1,
				clientId: "device-1", candidateId: candidate.candidateId,
				candidateDigest: candidate.candidateDigest, durableGeneration: 3 + submissions.length,
				runtimeEpoch: "runtime-1",
			};
		},
	});
	const provider = partialOf<SyncProviderPort>({
		awareness: { setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map() },
		documentOrigin: {}, ws: null, wsconnected: false, wsconnecting: false, synced: false,
		url: "ws://test/root", connect: () => {}, disconnect: () => {}, destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
	const runtime = new VaultSync({ vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1", host: "https://sync.test", token: "token", database, server, providerFactory: () => provider });
	runtime.ydoc.transact(() => runtime.pathToId.set(path, bodyId), "indexeddb-bootstrap");
	await runtime.bodies.load(bodyId);
	const file = Object.assign(new TFile(), { path, stat: { ctime: 1, mtime: 2, size: appended.length } });
	let diskIndex: DiskIndex = {};
	if (options.baseline !== "missing") {
		const entry = { mtime: 1, size: prefix.length };
		setCurrentContentHash(entry, await contentBaselineHash(options.baseline === "older" ? prefix.slice(0, 100) : prefix));
		diskIndex[path] = entry;
	}
	const app = {
		vault: {
			read: async () => artifacts.get(path)!,
			getAbstractFileByPath: (requested: string) => requested === path ? file : null,
			process: async (_file: TFile, transform: (content: string) => string) => {
				const next = transform(artifacts.get(path)!);
				artifacts.set(path, next);
				return next;
			},
			adapter: { stat: async () => ({ mtime: 2, size: artifacts.get(path)!.length }) },
		},
		workspace: { iterateAllLeaves: () => {}, getActiveViewOfType: () => null },
	};
	const mirror = new DiskMirror(app as never, runtime, partialOf<EditorBindingManager>({ isBound: () => false }), false);
	mirror.configureSettlement({
		conflictEpisodes: episodes,
		getBaseline: () => ({ contentHash: diskIndex[path]?.contentHash ?? null, trustedWhole: true }),
		getCommonBase: async () => ({ kind: "missing" }),
		commitLocalBody: async (input) => (await runtime.commitBodyCandidateIfCurrent({ bodyId: input.bodyId, path: input.path, content: input.content, expectedContent: input.expectedBodyContent!, candidateId: crypto.randomUUID(), reason: input.reason })).kind,
		commitMergedBody: async (input) => (await runtime.commitBodyCandidateIfCurrent({ bodyId: input.bodyId, path: input.path, content: input.mergedContent, expectedContent: input.expectedBodyContent, candidateId: crypto.randomUUID(), reason: "three-way-merge" })).kind,
		shouldBlockDiskIngest: () => options.blockFrontmatter === true,
	});
	let ingest: DiskIngestPort | null = null;
	const controller = new ReconciliationController({
		app: app as never, getConflictEpisodes: () => episodes,
		getSettings: () => ({ deviceName: "Mac 2" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, externalEditPolicy: "always" }) as never,
		getVaultSync: () => runtime, getDiskMirror: () => mirror, getBlobSync: () => null, getEditorBindings: () => null,
		getDiskIndex: () => diskIndex, setDiskIndex: (next) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => options.blockFrontmatter === true,
		refreshServerCapabilities: async () => {}, validateOpenEditorBindings: () => {}, onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false, setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {}, refreshStatusBar: () => {}, trace: () => {}, scheduleTraceStateSnapshot: () => {}, log: () => {},
		registerDiskIngestPort: (port) => { ingest = port; },
	});
	return {
		path, bodyId, prefix, appended, runtime, mirror, controller, episodes, submissions, artifacts,
		disk: () => artifacts.get(path)!,
		ingest: () => (ingest as unknown as DiskIngestPort).ingestDiskFileNow(path, "modify"),
		settle: () => mirror.settleBody({ path, bodyId, generation: 2, content: initialBody, onMissingBase: "preserve-disk" }),
		destroy: async () => { mirror.destroy(); episodes.dispose(); await runtime.destroy(); },
	};
}

for (const baseline of ["body", "older", "missing"] as const) {
	tests.test(`verified own append publishes through conditional candidate with ${baseline} baseline`, async () => {
		const subject = await fixture({ baseline, large: true });
		try {
			await subject.ingest();
			assert.ok(subject.runtime.getTextForPath(subject.path)!.toJSON() === subject.appended, "body includes every verified preserved version");
			assert.ok(subject.disk() === subject.appended, "disk history is not truncated");
			assert.equal(subject.submissions.length, 1);
			assert.equal(subject.runtime.bodies.get(subject.bodyId)!.dirty, false);
			for (const version of subject.episodes.get("original-note-body")!.versions) await subject.episodes.readVersion("original-note-body", version.hash);
			assert.equal(subject.episodes.list().length, 1, "no nested conflict episode");
		} finally { await subject.destroy(); }
	});
}

tests.test("remote settlement retains and publishes a verified own append instead of projecting its stale prefix", async () => {
	const subject = await fixture({ baseline: "older" });
	try {
		assert.equal(await subject.settle(), "replan");
		assert.equal(subject.disk(), subject.appended);
		assert.equal(subject.runtime.getTextForPath(subject.path)!.toJSON(), subject.appended);
		assert.equal(subject.submissions.length, 1);
		for (const version of subject.episodes.get("original-note-body")!.versions) await subject.episodes.readVersion("original-note-body", version.hash);
		assert.equal(subject.episodes.list().length, 1);
	} finally { await subject.destroy(); }
});

tests.test("an already receipted create operation id is not reused for a newer artifact append", async () => {
	const subject = await fixture();
	try {
		const internals = subject.controller as unknown as { syncFileFromDisk(file: TFile, reason: "create", opId: string, coalesced: string[], admission: { bodyId: string; candidateId: string; isCurrent(): boolean }): Promise<void> };
		await internals.syncFileFromDisk(Object.assign(new TFile(), { path: subject.path }), "create", "already-receipted-create", [], { bodyId: subject.bodyId, candidateId: "already-receipted-create", isCurrent: () => true });
		assert.equal(subject.submissions.length, 1);
		assert.notEqual(subject.submissions[0]!.candidateId, "already-receipted-create");
		assert.equal(subject.runtime.getTextForPath(subject.path)!.toJSON(), subject.appended);
	} finally { await subject.destroy(); }
});

for (const operation of ["ingest", "settle"] as const) {
	for (const negative of ["tamper", "rawTamper", "divergentBody", "blockFrontmatter"] as const) {
		tests.test(`${operation}: ${negative} cannot take the verified append shortcut`, async () => {
			const subject = await fixture({ [negative]: true, baseline: "missing" });
			try {
				await subject[operation]();
				assert.equal(subject.submissions.length, 0);
			} finally { await subject.destroy(); }
		});
	}
	for (const race of ["disk", "episodeAppend", "body", "path"] as const) {
		tests.test(`${operation}: ${race} moving during async verification defers without a candidate or stale projection`, async () => {
			const subject = await fixture({ baseline: "missing" });
			const verify = subject.episodes.isArtifact.bind(subject.episodes);
			let moved = false;
			subject.episodes.isArtifact = async (path, content) => {
				const result = await verify(path, content);
				if (!moved) {
					moved = true;
					if (race === "disk") subject.artifacts.set(subject.path, subject.appended + "interleaving edit\n");
					if (race === "episodeAppend") await subject.episodes.preserve({ bodyId: "original-note-body", path: "note-2.md", body: "interleaving preserved version\n", disk: "interleaving preserved version\n", device: "Mac 2" });
					if (race === "body") {
						const text = subject.runtime.getTextForPath(subject.path)!;
						text.doc!.transact(() => text.insert(text.length, "interleaving remote edit\n"), "server-catch-up");
					}
					if (race === "path") subject.runtime.bodies.coordinator.replacePathBindings([[subject.path, "replacement-body"]]);
				}
				return result;
			};
			try {
				await subject[operation]();
				assert.equal(moved, true);
				assert.equal(subject.submissions.length, 0);
				assert.ok(subject.disk().startsWith(subject.appended), "a moved proof never permits truncating the artifact");
			} finally { await subject.destroy(); }
		});
	}
	tests.test(`${operation}: body movement inside the conditional commit rejects the captured append`, async () => {
		const subject = await fixture({ baseline: "missing" });
		const commit = subject.runtime.commitBodyCandidateIfCurrent.bind(subject.runtime);
		let moved = false;
		subject.runtime.commitBodyCandidateIfCurrent = async (input) => {
			moved = true;
			const text = subject.runtime.getTextForPath(subject.path)!;
			text.doc!.transact(() => text.insert(text.length, "later remote edit\n"), "server-catch-up");
			return commit(input);
		};
		try {
			await subject[operation]();
			assert.equal(moved, true);
			assert.equal(subject.submissions.length, 0);
			assert.ok(subject.disk() === subject.appended);
			assert.ok(subject.runtime.getTextForPath(subject.path)!.toJSON().endsWith("later remote edit\n"));
		} finally { await subject.destroy(); }
	});
}

await tests.done();
