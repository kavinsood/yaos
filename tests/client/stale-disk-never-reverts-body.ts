/**
 * B3 regression: a device holding stale disk content must never turn it into
 * Y.Text ops that delete committed remote content.
 *
 * Deployed reproduction (experiments/results/B2-B3.md): device B kept a warm
 * body for a closed note; A's edit reached B's Y.Doc over the body socket but
 * not B's disk. A later disk scan flagged the file (stat drift) and
 * `syncFileFromDisk` diffed the body toward the stale disk text under
 * `disk-commit`, committing a candidate that removed A's edit. The same
 * two-way comparison drove the bound-file local-only and open-idle recovery
 * branches. The disk-index baseline (content YAOS last wrote or saw agree)
 * proves such disk content carries no local edit (`D == B`), so the body wins.
 */
import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { MarkdownView, TFile } from "obsidian";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import {
	contentBaselineHash,
	currentContentHash,
	setCurrentContentHash,
	type DiskIndex,
	type DiskIndexEntry,
} from "../../src/sync/diskIndex";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { StoredBodySettlementV1 } from "../../src/sync/bodySettlement";
import {
	VaultSync,
	type CandidateRecord,
	type BodyReceipt,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import type { DiskIngestPort } from "../../src/runtime/engineControlPort";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { canonicalMarkdownHash } from "../../server/src/shared/markdownCodec";

installDomCrypto();
const s = suite("stale-disk-never-reverts-body");

const BASE = "# Note\n\nseed content\n";
const REMOTE = `${BASE}\nremote edit from device A`;
const LOCAL = `${BASE}\nlocal edit on this device`;

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const owned = new Uint8Array(bytes.byteLength);
	owned.set(bytes);
	return owned.buffer;
}

async function baselineEntry(
	content: string,
	stat = { mtime: 1, size: content.length },
	scope: string | null = SCOPE,
): Promise<DiskIndexEntry> {
	const entry: DiskIndexEntry = { ...stat };
	setCurrentContentHash(entry, await contentBaselineHash(content), scope ?? undefined);
	return entry;
}

interface ClosedFixture {
	runtime: VaultSync;
	controller: ReconciliationController;
	mirror: DiskMirror | null;
	submissions: CandidateRecord[];
	scheduledWrites: string[];
	createCommits: string[];
	artifacts: Map<string, string>;
	/** Paths offered for three-way conflict review. */
	reviews: string[];
	/** Content of every conflict note written, in order. */
	artifactWrites: string[];
	/** Every frontmatter ingest guard evaluation: [previous, next, blocked]. */
	frontmatterChecks: Array<[string | null, string, boolean]>;
	/** Baselines handed to the common-base store. */
	commonBaseWrites: Array<{ path: string; hash: string; content: string }>;
	/** The local identity the controller runs under (null: not known yet). */
	setControllerScope: (scope: string | null) => void;
	disk: () => string;
	setDisk: (content: string) => void;
	onNextRead: (hook: (() => void) | null) => void;
	diskIndex: () => DiskIndex;
	ingest: (reason?: "create" | "modify") => Promise<void>;
	applyRemote: (content: string) => void;
	releaseSubmissions: () => void;
	destroy: () => Promise<void>;
}

const SCOPE = "local-db-1";

/**
 * A real VaultSync holding a loaded but closed body (no editor consumer), as a
 * warm body is after its note closes, wired to the production controller.
 * With `realMirror` the production DiskMirror projects to the fake vault.
 */
async function closedBodyFixture(options: {
	disk: string;
	baseline: string | null;
	loadBody: boolean;
	storedContent?: string;
	/** Whether the path has an active body at all (false: deleted/never synced). */
	mapped?: boolean;
	/** Scope the baseline was written under; the controller runs under SCOPE. */
	baselineScope?: string | null;
	realMirror?: boolean;
	/** Common base (bootstrap settlement) available to DiskMirror, if any. */
	commonBase?: string | null;
	/** Hold every candidate submission until `releaseSubmissions()`. */
	holdSubmissions?: boolean;
	/** Provide Obsidian's atomic `vault.process` (compare-and-swap path). */
	withProcess?: boolean;
	/** Configure DiskMirror without the common-base API (closed-file planner path). */
	noCommonBaseApi?: boolean;
	/** The body's seed content (default BASE); `storedContent`/remotes append to it. */
	seedContent?: string;
	/** The frontmatter ingest guard (default: never blocks). */
	blockFrontmatter?: (previous: string | null, next: string) => boolean;
	reviewNeverResolves?: boolean;
}): Promise<ClosedFixture> {
	const path = "Closed.md";
	const bodyId = "body-closed";
	const documents = new Map<string, StoredDocument>();
	const candidates = new Map<string, CandidateRecord>();
	const seedText = options.seedContent ?? BASE;
	const seed = new Y.Doc({ guid: bodyId });
	seed.getText("body").insert(0, seedText);
	const peer = new Y.Doc({ guid: bodyId });
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(seed));
	if (options.storedContent !== undefined && options.storedContent !== seedText) {
		const text = seed.getText("body");
		text.insert(text.length, options.storedContent.slice(seedText.length));
	}
	documents.set(bodyId, {
		kind: "body",
		documentId: bodyId,
		bodyEpoch: 1,
		durableBaseline: seedText,
		generation: 2,
		encodedState: exactArrayBuffer(Y.encodeStateAsUpdate(seed)),
		dirty: false,
		updatedAt: 1,
	});
	seed.destroy();
	const database: VaultDatabasePort = {
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => ({ ...operation, localSequence: operation.localSequence || 1 }),
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	};
	const submissions: CandidateRecord[] = [];
	let release: () => void = () => {};
	let gate: Promise<void> = options.holdSubmissions
		? new Promise<void>((resolve) => { release = resolve; })
		: Promise.resolve();
	const server = partialOf<VaultServerPort>({
		currentHead: async (requested) => ({ bodyId: requested, bodyEpoch: 1, generation: 2 }),
		submitCandidate: async (candidate): Promise<BodyReceipt> => {
			await gate;
			submissions.push(candidate);
			return {
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: candidate.bodyId,
				bodyEpoch: candidate.bodyEpoch, clientId: "device-1", candidateId: candidate.candidateId,
				candidateDigest: candidate.candidateDigest, durableGeneration: 3 + submissions.length,
				runtimeEpoch: "epoch-1",
			};
		},
	});
	const awareness = partialOf<SyncAwarenessPort>({
		setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map(),
	});
	const provider = partialOf<SyncProviderPort>({
		awareness, documentOrigin: {}, ws: null, wsconnected: false, wsconnecting: false, synced: false,
		url: "ws://test/root", connect: () => {}, disconnect: () => {}, destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server, providerFactory: () => provider,
	});
	if (options.mapped !== false) {
		runtime.ydoc.transact(() => runtime.pathToId.set(path, bodyId), "indexeddb-bootstrap");
	}
	if (options.loadBody) await runtime.bodies.load(bodyId);
	const createCommits: string[] = [];
	const commitDiskBody = runtime.commitDiskBody.bind(runtime);
	runtime.commitDiskBody = async (input) => {
		if (input.lifecycle !== "create") return commitDiskBody(input);
		// Fresh admission needs the full lifecycle server; the decision is what is under test.
		createCommits.push(input.content);
		return { lifecycle: "create", revived: false, receipt: null };
	};

	const file = new TFile();
	file.path = path;
	Object.assign(file, { stat: { ctime: 1, mtime: 1, size: options.disk.length } });
	let disk = options.disk;
	let readHook: (() => void) | null = null;
	const artifacts = new Map<string, string>();
	const artifactWrites: string[] = [];
	const reviews: string[] = [];
	const commonBaseWrites: Array<{ path: string; hash: string; content: string }> = [];
	let controllerScope: string | null = SCOPE;
	const frontmatterChecks: Array<[string | null, string, boolean]> = [];
	const guard = (previous: string | null, next: string): boolean => {
		const blocked = options.blockFrontmatter?.(previous, next) ?? false;
		frontmatterChecks.push([previous, next, blocked]);
		return blocked;
	};
	const baselineScope = options.baselineScope === undefined ? SCOPE : options.baselineScope;
	let diskIndex: DiskIndex = options.baseline === null
		? {}
		// Stat drift (the size no longer matches) is what put the path on the
		// reconcile inventory in the deployed trace.
		: { [path]: await baselineEntry(options.baseline, { mtime: 1, size: 1 }, baselineScope) };
	const scheduledWrites: string[] = [];
	let ingestPort: DiskIngestPort | null = null;
	const vault = {
		read: async () => {
			const value = disk;
			const hook = readHook;
			readHook = null;
			hook?.();
			return value;
		},
		modify: async (_file: TFile, content: string) => { disk = content; },
		create: async (created: string, content: string) => {
			artifacts.set(created, content);
			artifactWrites.push(content);
			const artifact = new TFile();
			artifact.path = created;
			return artifact;
		},
		getAbstractFileByPath: (requested: string) => requested === path ? file : null,
		adapter: { stat: async () => ({ mtime: 2, size: disk.length }) },
		...(options.withProcess ? {
			process: async (_file: TFile, fn: (data: string) => string) => {
				disk = fn(disk);
				return disk;
			},
		} : {}),
	};
	const app = { vault, workspace: { iterateAllLeaves: () => {}, getActiveViewOfType: () => null } };
	let controller: ReconciliationController | null = null;
	let mirror: DiskMirror | null = null;
	if (options.realMirror) {
		mirror = new DiskMirror(
			app as never,
			runtime,
			partialOf<EditorBindingManager>({ isBound: () => false, getLastEditorActivityForPath: () => null }),
			false,
			undefined,
			() => false,
		);
		const commonBase = options.commonBase ?? null;
		// Mirrors main.ts: a planned import is conditional on the planned body.
		const commitLocalBody = async (input: {
			bodyId: string; path: string; content: string;
			reason: "external-edit" | "delete-revive"; expectedBodyContent?: string;
		}) => {
			if (input.expectedBodyContent !== undefined) {
				return (await runtime.commitBodyCandidateIfCurrent({
					bodyId: input.bodyId,
					path: input.path,
					expectedContent: input.expectedBodyContent,
					content: input.content,
					candidateId: crypto.randomUUID(),
					reason: input.reason,
				})).kind;
			}
			await runtime.commitDiskBody(input);
			return "completed" as const;
		};
		if (options.noCommonBaseApi) {
			mirror.configureSettlement({
				getBaseline: (requested) => ({ contentHash: currentContentHash(diskIndex[requested]) ?? null }),
				commitLocalBody,
			});
		} else mirror.configureSettlement({
			getBaseline: (requested) => ({ contentHash: currentContentHash(diskIndex[requested]) ?? null }),
			commitLocalBody,
			shouldBlockDiskIngest: (_path, current, next) => guard(current, next),
			reviewConflict: async ({ path: reviewed }) => {
				reviews.push(reviewed);
				if (options.reviewNeverResolves) return new Promise<string | null>(() => {});
				return null;
			},
			getCommonBase: async () => commonBase === null
				? { kind: "missing" as const }
				: {
					kind: "available" as const,
					settlement: partialOf<StoredBodySettlementV1>({
						format: 1,
						content: commonBase,
						contentHash: await contentBaselineHash(commonBase),
					}) as StoredBodySettlementV1,
				},
			commitMergedBody: async (input) => (await runtime.commitBodyCandidateIfCurrent({
				bodyId: input.bodyId,
				path: input.path,
				expectedContent: input.expectedBodyContent,
				content: input.mergedContent,
				candidateId: crypto.randomUUID(),
				reason: "three-way-merge",
			})).kind,
			markDivergence: () => {},
		});
		mirror.setDiskWriteCallback((written, hash, content) => {
			controller?.recordProjectedDiskWrite(written, hash, content);
			scheduledWrites.push(written);
		});
		mirror.setDiskMovedBeforeWriteHandler((moved) => controller?.handleDiskMovedBeforeWrite(moved));
	}
	controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "Test device" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [], externalEditPolicy: "always" }) as never,
		getVaultSync: () => runtime,
		getDiskMirror: () => mirror ?? ({
			isPreservedUnresolved: () => false,
			clearPreservedUnresolved: () => {},
			scheduleWrite: (requested: string) => { scheduledWrites.push(requested); },
			readCommonBaseContent: async () => null,
			settleBody: async () => "preserved-unresolved",
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		getBaselineScope: () => controllerScope,
		persistCommonBase: (written, hash, content) => { commonBaseWrites.push({ path: written, hash, content }); },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: (_path, previous, next) => guard(previous, next),
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		registerDiskIngestPort: (port) => { ingestPort = port; },
	});
	return {
		runtime,
		controller,
		mirror,
		reviews,
		artifactWrites,
		frontmatterChecks,
		commonBaseWrites,
		setControllerScope: (scope) => { controllerScope = scope; },
		submissions,
		scheduledWrites,
		createCommits,
		artifacts,
		disk: () => disk,
		setDisk: (content) => { disk = content; },
		onNextRead: (hook) => { readHook = hook; },
		diskIndex: () => diskIndex,
		ingest: async (reason = "modify") => {
			if (!ingestPort) throw new Error("disk ingest port was not registered");
			await (ingestPort as DiskIngestPort).ingestDiskFileNow(path, reason);
		},
		applyRemote: (content: string) => {
			// A remote peer's edit, merged exactly as a body socket or
			// server catch-up merges it: a Yjs update, not local ops.
			const text = peer.getText("body");
			const before = Y.encodeStateVector(peer);
			text.insert(text.length, content.slice(text.length));
			const target = runtime.getTextForPath(path)?.doc;
			if (!target) throw new Error("body is not loaded");
			Y.applyUpdate(target, Y.encodeStateAsUpdate(peer, before), "server-catch-up");
		},
		releaseSubmissions: () => { release(); gate = Promise.resolve(); },
		destroy: async () => { mirror?.destroy(); peer.destroy(); await runtime.destroy(); },
	};
}

async function eventually(condition: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

s.test("stale disk of a closed warm body never reverts a merged remote edit", async () => {
	const fixture = await closedBodyFixture({ disk: BASE, baseline: BASE, loadBody: true });
	fixture.applyRemote(REMOTE);
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE);

	await fixture.ingest();

	assert.equal(fixture.submissions.length, 0, "no candidate is built from disk that never changed");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE, "the remote edit survives");
	assert.deepEqual(fixture.scheduledWrites, ["Closed.md"], "the body is materialized to the stale disk instead");
	assert.equal(fixture.diskIndex()["Closed.md"]?.size, BASE.length, "the stat is refreshed so the scan settles");
	assert.equal(
		fixture.diskIndex()["Closed.md"]?.contentHash,
		await contentBaselineHash(BASE),
		"the baseline keeps naming the content disk actually holds",
	);
	await fixture.destroy();
});

s.test("stale disk of an evicted body never reverts the body's newer stored state", async () => {
	const fixture = await closedBodyFixture({ disk: BASE, baseline: BASE, loadBody: false, storedContent: REMOTE });
	await fixture.ingest();
	assert.equal(fixture.submissions.length, 0, "an unloaded body is not loaded just to be reverted");
	await fixture.runtime.bodies.load("body-closed");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE);
	await fixture.destroy();
});

s.test("a genuine disk edit is still imported", async () => {
	const fixture = await closedBodyFixture({ disk: LOCAL, baseline: BASE, loadBody: true });
	await fixture.ingest();
	assert.equal(fixture.submissions.length, 1, "disk that changed since its baseline is local input");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), LOCAL);
	assert.equal(
		fixture.diskIndex()["Closed.md"]?.contentHash,
		await contentBaselineHash(LOCAL),
		"the imported content becomes the new baseline",
	);
	await fixture.destroy();
});

// Round 2 (REVIEW N2): a two-way import with no trusted baseline was the
// P0c N2 shape - nothing proves the body holds no change disk never saw. The
// body is now merged on its stored common base, or both sides are preserved.
s.test("without a baseline, a disk edit over a body still at its stored common base imports (three-way)", async () => {
	const fixture = await closedBodyFixture({ disk: LOCAL, baseline: null, loadBody: true, realMirror: true, commonBase: BASE });
	await fixture.ingest();
	await eventually(() => fixture.runtime.getPathContent("Closed.md") === LOCAL, "the edit is imported");
	assert.equal(fixture.submissions.length, 1);
	assert.equal(fixture.artifacts.size, 0, "a clean merge needs no conflict note");
	await fixture.destroy();
});

s.test("without a baseline or common base, a loaded body differing from disk preserves both", async () => {
	const fixture = await closedBodyFixture({ disk: LOCAL, baseline: null, loadBody: true, realMirror: true, commonBase: null });
	fixture.applyRemote(REMOTE);
	await fixture.ingest();
	await eventually(() => fixture.artifacts.size === 1, "disk is preserved as a conflict note");
	assert.deepEqual([...fixture.artifacts.values()], [LOCAL], "the disk side survives");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE, "the body is not two-way imported over");
	assert.equal(fixture.submissions.length, 0);
	await fixture.destroy();
});

s.test("B2: a remote update to a closed warm body is written to unchanged disk", async () => {
	const fixture = await closedBodyFixture({ disk: BASE, baseline: BASE, loadBody: true });
	fixture.applyRemote(REMOTE);
	fixture.controller.scheduleRemoteBodyMaterialization("Closed.md");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.deepEqual(fixture.scheduledWrites, ["Closed.md"]);
	assert.equal(fixture.submissions.length, 0);
	await fixture.destroy();
});

s.test("B2: a remote update never overwrites a closed note's unsynced disk edit", async () => {
	const fixture = await closedBodyFixture({ disk: LOCAL, baseline: BASE, loadBody: true });
	fixture.applyRemote(REMOTE);
	fixture.controller.scheduleRemoteBodyMaterialization("Closed.md");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.deepEqual(fixture.scheduledWrites, [], "disk that moved is ingested, not overwritten");
	await fixture.destroy();
});

s.test("B2: a live body is promoted to a head only when its content verifiably matches", async () => {
	const fixture = await closedBodyFixture({ disk: BASE, baseline: BASE, loadBody: true });
	fixture.applyRemote(REMOTE);
	const head = (content: string) => ({
		bodyId: "body-closed", bodyEpoch: 1, generation: 7,
		size: new TextEncoder().encode(content).byteLength,
	});
	assert.equal(
		await fixture.runtime.promoteLoadedBodyToHead({ ...head(BASE), contentHash: await canonicalMarkdownHash(BASE) }),
		false,
		"a head naming other content is never recorded",
	);
	assert.equal(fixture.runtime.bodies.get("body-closed")?.generation, 2);
	assert.equal(
		await fixture.runtime.promoteLoadedBodyToHead({ ...head(REMOTE), contentHash: await canonicalMarkdownHash(REMOTE) }),
		true,
	);
	assert.equal(fixture.runtime.bodies.get("body-closed")?.generation, 7);
	await fixture.destroy();
});

/** An open, healthy binding whose editor and disk hold `disk`, body `crdt`. */
async function boundFixture(options: {
	disk: string;
	editor: string;
	crdt: string;
	baseline: string;
	/** Content DiskMirror knows as the common base (the baseline's content). */
	knownBase?: string | null;
	/** false: the note is open but its editor is not bound (bind pending, reading view). */
	bound?: boolean;
	/** The open editor's bind is resolving (or gave up resolving) a divergence. */
	bindBlocked?: boolean;
	/** A remote update reaching the body while the controller awaits the base lookup. */
	remoteDuringBaseLookup?: string;
	/** Whether the body has an editor session (default true). */
	bodyOpen?: boolean;
}) {
	const path = "Open.md";
	const doc = new Y.Doc();
	const ytext = doc.getText("body");
	ytext.insert(0, options.crdt);
	const origins: unknown[] = [];
	doc.on("afterTransaction", (transaction) => { origins.push(transaction.origin); });
	const file = new TFile();
	file.path = path;
	const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
		file,
		editor: { getValue: (): string => options.editor },
	});
	let diskIndex: DiskIndex = { [path]: await baselineEntry(options.baseline, { mtime: 1, size: 1 }) };
	let ingestPort: DiskIngestPort | null = null;
	const rebinds: string[] = [];
	const quarantined: string[] = [];
	const conditionalCommits: string[] = [];
	const artifacts = new Map<string, string>();
	const baseHash = await contentBaselineHash(options.baseline);
	let remoteDuringBaseLookup = options.remoteDuringBaseLookup;
	const injectRemote = () => {
		if (remoteDuringBaseLookup === undefined) return;
		const remote = remoteDuringBaseLookup;
		remoteDuringBaseLookup = undefined;
		doc.transact(() => {
			ytext.delete(0, ytext.length);
			ytext.insert(0, remote);
		}, "provider-remote");
	};
	const controller = new ReconciliationController({
		app: {
			vault: {
				read: async () => options.disk,
				create: async (created: string, content: string) => { artifacts.set(created, content); },
				getAbstractFileByPath: (requested: string) => requested === path ? file : null,
				adapter: { stat: async () => ({ mtime: 2, size: options.disk.length }) },
			},
			workspace: { iterateAllLeaves: (callback: (leaf: { view: MarkdownView }) => void) => callback({ view }) },
		} as never,
		getSettings: () => ({ deviceName: "Test device" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [], externalEditPolicy: "always" }) as never,
		getVaultSync: () => ({
			getTextForPath: (requested: string) => requested === path ? ytext : null,
			getFileIdForText: () => "body-open",
			getFileId: () => "body-open",
			isBodyOpen: () => options.bodyOpen !== false,
			commitBodyCandidateIfCurrent: async (input: { expectedContent: string; content: string }) => {
				conditionalCommits.push(input.content);
				if (ytext.toString() !== input.expectedContent) return { kind: "superseded" };
				if (input.expectedContent === input.content) return { kind: "completed", receipt: null, unchanged: true };
				doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, input.content); }, "disk-commit");
				return { kind: "completed", receipt: {} };
			},
		}) as never,
		getDiskMirror: () => ({
			isPreservedUnresolved: () => false,
			clearPreservedUnresolved: () => {},
			scheduleWrite: () => {},
			readCommonBaseContent: async (_bodyId: string, hash: string) => {
				injectRemote();
				return options.knownBase != null && hash === baseHash ? options.knownBase : null;
			},
			readWholeCommonBase: async () => {
				injectRemote();
				return options.knownBase != null ? { content: options.knownBase, hash: baseHash } : null;
			},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => options.bound !== false,
			isBindResolutionBlocked: () => options.bindBlocked === true,
			quarantineBinding: (_view: MarkdownView, reason: string) => { quarantined.push(reason); },
			getBindingDebugInfoForView: () => ({ leafId: "leaf-1", storedCmId: "cm-1", liveCmId: "cm-1", cmMatches: true }),
			getCollabDebugInfoForView: () => ({
				hasSyncFacet: true, awarenessMatchesProvider: true, yTextMatchesExpected: true,
				undoManagerMatchesFacet: true, facetFileId: null, expectedFileId: null,
			}),
			repair: () => true,
			rebind: (_view: MarkdownView, _device: string, reason: string) => { rebinds.push(reason); },
			unbindByPath: () => {},
			getLastEditorActivityForPath: () => null,
		}) as never,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		getBaselineScope: () => SCOPE,
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		registerDiskIngestPort: (port) => { ingestPort = port; },
	});
	return {
		ytext,
		origins,
		rebinds,
		quarantined,
		artifacts,
		conditionalCommits,
		controller,
		diskIndex: () => diskIndex,
		ingest: async () => {
			if (!ingestPort) throw new Error("disk ingest port was not registered");
			await (ingestPort as DiskIngestPort).ingestDiskFileNow(path, "modify");
		},
	};
}

s.test("a stale editor and disk never drive the bound local-only recovery over a remote edit", async () => {
	const fixture = await boundFixture({ disk: BASE, editor: BASE, crdt: REMOTE, baseline: BASE });
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), REMOTE);
	assert.deepEqual(fixture.origins, [], "no Y.Text transaction was generated from stale content");
	assert.deepEqual(
		fixture.rebinds,
		["bound-editor-diverged-from-body"],
		"S2: a bound editor that lags its body is rebound (bind-time resolution) instead of left broken",
	);
});

s.test("stale disk never drives the bound open-idle recovery over a remote edit", async () => {
	const fixture = await boundFixture({ disk: BASE, editor: REMOTE, crdt: REMOTE, baseline: BASE });
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), REMOTE);
	assert.deepEqual(fixture.origins, []);
});

s.test("a saved local edit in a bound editor is still recovered into the body", async () => {
	const fixture = await boundFixture({ disk: LOCAL, editor: LOCAL, crdt: BASE, baseline: BASE });
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), LOCAL);
});

// ---------------------------------------------------------------------------
// Review findings (R-B1, R-B2, S1, S2, S3)
// ---------------------------------------------------------------------------

const LOCAL_TOP = `local heading\n${BASE}`;
const MERGED = `local heading\n${REMOTE}`;

for (const [label, content] of [["restored note", BASE], ["recreated empty note", ""]] as const) {
	s.test(`R-B1: with no body at the path, a ${label} equal to a leftover baseline is created`, async () => {
		const fixture = await closedBodyFixture({ disk: content, baseline: content, loadBody: false, mapped: false });
		await fixture.ingest("create");
		assert.deepEqual(fixture.createCommits, [content], "a restore/recreate is admitted as a create");
		await fixture.destroy();
	});
}

s.test("R-B2: remote and disk edits to a closed note merge on the baseline; both survive", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL_TOP, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	fixture.applyRemote(REMOTE);
	fixture.controller.scheduleRemoteBodyMaterialization("Closed.md");
	await eventually(() => fixture.disk() === MERGED, "the merge reaches disk");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), MERGED, "the body holds both edits");
	assert.equal(fixture.artifacts.size, 0, "a clean merge needs no conflict note");
	assert.equal(fixture.submissions.length, 1, "the merge is committed once");
	await fixture.destroy();
});

s.test("R-B2: a disk edit ingested while a closed body is ahead merges instead of reverting", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL_TOP, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	fixture.applyRemote(REMOTE);
	await fixture.ingest();
	await eventually(() => fixture.disk() === MERGED, "the merge reaches disk");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), MERGED);
	await fixture.destroy();
});

s.test("R-B2: overlapping closed-note edits preserve both sides", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	fixture.applyRemote(REMOTE);
	fixture.controller.scheduleRemoteBodyMaterialization("Closed.md");
	await eventually(() => fixture.artifacts.size > 0, "a conflict note is written");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(fixture.disk(), LOCAL, "the disk edit stays at the path");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE, "the remote edit stays in the body");
	assert.deepEqual([...fixture.artifacts.values()], [REMOTE], "the remote side is preserved as a note too");
	assert.equal(fixture.submissions.length, 0, "no two-way import reverted the remote edit");
	fixture.applyRemote(`${REMOTE} and more`);
	fixture.controller.scheduleRemoteBodyMaterialization("Closed.md");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(fixture.artifacts.size, 1, "further remote keystrokes do not create one conflict note each");
	assert.equal(fixture.disk(), LOCAL);
	await fixture.destroy();
});

s.test("R-B2: without any common base, disk is preserved before the body is projected", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL_TOP, baseline: BASE, loadBody: true, realMirror: true, commonBase: null,
	});
	fixture.applyRemote(REMOTE);
	fixture.controller.scheduleRemoteBodyMaterialization("Closed.md");
	await eventually(() => fixture.disk() === REMOTE, "the body is projected");
	assert.deepEqual([...fixture.artifacts.values()], [LOCAL_TOP], "the disk edit survives as a conflict note");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE);
	assert.equal(fixture.submissions.length, 0);
	await fixture.destroy();
});

s.test("S1: a planned write never clobbers a disk save that lands before it runs", async () => {
	const fixture = await closedBodyFixture({
		disk: BASE, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	const mirror = fixture.mirror!;
	fixture.applyRemote(REMOTE);
	mirror.scheduleWrite("Closed.md", { expectedDiskHash: await contentBaselineHash(BASE) });
	fixture.setDisk(LOCAL_TOP);
	await mirror.flushWrite("Closed.md");
	assert.equal(fixture.disk(), LOCAL_TOP, "disk moved after the plan: nothing was written");
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.notEqual(fixture.disk(), REMOTE, "the still-queued write does not overwrite it either");
	await eventually(() => fixture.disk() === MERGED, "the re-plan merges both edits");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), MERGED);
	await fixture.destroy();
});

for (const withProcess of [true, false]) {
	s.test(`S1: compare-and-swap refuses a write when disk changes between read and modify (${withProcess ? "vault.process" : "re-read"})`, async () => {
		const fixture = await closedBodyFixture({
			disk: BASE, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE, withProcess,
		});
		const mirror = fixture.mirror!;
		fixture.applyRemote(REMOTE);
		fixture.onNextRead(() => fixture.setDisk(LOCAL_TOP));
		await mirror.flushWrite("Closed.md");
		assert.equal(fixture.disk(), LOCAL_TOP, "the external save survives the racing write");
		await eventually(() => fixture.disk() === MERGED, "the re-plan merges both edits");
		await fixture.destroy();
	});
}

s.test("S3: a baseline from another local incarnation never makes disk look unchanged", async () => {
	for (const baselineScope of ["previous-local-db", null]) {
		// IndexedDB was lost/reset: the body came back from the server (BASE)
		// while disk (and the stale baseline) hold the uncommitted offline edit.
		// Nothing trusted relates them (the common base went with the
		// database), so both are preserved: the offline edit as a conflict
		// note, never overwritten without a copy.
		const fixture = await closedBodyFixture({
			disk: LOCAL, baseline: LOCAL, loadBody: true, baselineScope, realMirror: true, commonBase: null,
		});
		await fixture.ingest();
		await eventually(() => fixture.artifacts.size === 1, "the offline edit is preserved");
		assert.deepEqual([...fixture.artifacts.values()], [LOCAL], `offline edit kept (scope ${String(baselineScope)})`);
		assert.equal(fixture.submissions.length, 0, "no import from an untrusted comparison");
		await fixture.destroy();
	}
});

s.test("S3: a baseline is not persisted while the body's local edit is not durably committed", async () => {
	const fixture = await closedBodyFixture({ disk: LOCAL, baseline: BASE, loadBody: true, holdSubmissions: true });
	// A local edit whose candidate cannot reach the server yet (offline).
	const commit = fixture.runtime.commitDiskBody({
		bodyId: "body-closed", path: "Closed.md", content: LOCAL, reason: "external-edit",
	});
	await eventually(() => fixture.runtime.bodies.get("body-closed")?.dirty === true, "the body holds local work");
	// DiskMirror projects that body to disk (e.g. on close).
	fixture.controller.recordProjectedDiskWrite("Closed.md", await contentBaselineHash(LOCAL), LOCAL);
	assert.equal(
		fixture.diskIndex()["Closed.md"]?.contentHash,
		await contentBaselineHash(BASE),
		"uncommitted content never becomes a persisted baseline (it would outlive an IndexedDB loss)",
	);
	fixture.releaseSubmissions();
	await commit;
	await eventually(() => fixture.runtime.bodies.get("body-closed")?.dirty === false, "the candidate is durable");
	fixture.controller.notifyLocalWorkSettled();
	assert.equal(fixture.diskIndex()["Closed.md"]?.contentHash, await contentBaselineHash(LOCAL));
	assert.equal(fixture.diskIndex()["Closed.md"]?.baselineScope, SCOPE, "bound to the local identity");
	await fixture.destroy();
});

s.test("S2: bound local-only recovery applies the baseline->disk delta onto a moved body", async () => {
	const fixture = await boundFixture({ disk: LOCAL_TOP, editor: LOCAL_TOP, crdt: REMOTE, baseline: BASE, knownBase: BASE });
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), MERGED, "the remote edit is not deleted by a two-way diff");
	assert.ok(fixture.rebinds.includes("bound-file-local-only-three-way"), "the editor is rebound to show the merge");
});

s.test("S2: overlapping bound local-only edits preserve the body before the editor wins", async () => {
	const fixture = await boundFixture({ disk: LOCAL, editor: LOCAL, crdt: REMOTE, baseline: BASE, knownBase: BASE });
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), LOCAL);
	assert.deepEqual([...fixture.artifacts.values()], [REMOTE]);
});

s.test("S2: with an unknown baseline content the bound local-only recovery is unchanged (two-way)", async () => {
	const fixture = await boundFixture({ disk: LOCAL_TOP, editor: LOCAL_TOP, crdt: REMOTE, baseline: BASE, knownBase: null });
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), LOCAL_TOP);
	assert.equal(fixture.artifacts.size, 0);
});

// ---------------------------------------------------------------------------
// Round 2: deployed P0c N2 and review findings N1, N3, N4, N6, N9, N11
// ---------------------------------------------------------------------------

/** Run `hook` once, right before the next conditional body commit applies. */
function beforeNextConditionalCommit(fixture: ClosedFixture, hook: () => void, skip = 0): void {
	const original = fixture.runtime.commitBodyCandidateIfCurrent.bind(fixture.runtime);
	let calls = 0;
	fixture.runtime.commitBodyCandidateIfCurrent = async (input) => {
		if (calls++ === skip) hook();
		return original(input);
	};
}

s.test("P0c N2: a remote edit reaching a closed body after the closed-file import decision is never diffed away", async () => {
	// The deployed shape: git overwrote a closed note (D != B, C == B), the
	// planner chose import-disk-to-crdt, and A's edit reached the warm body
	// before the commit. The import is conditional on the planned body.
	const fixture = await closedBodyFixture({
		disk: LOCAL_TOP, baseline: BASE, loadBody: true, realMirror: true, noCommonBaseApi: true,
	});
	beforeNextConditionalCommit(fixture, () => fixture.applyRemote(REMOTE));
	const outcome = await fixture.mirror!.settleBody({
		path: "Closed.md", bodyId: "body-closed", generation: 2, content: BASE,
	});
	assert.equal(outcome, "replan", "the body moved after the plan: re-plan, never a blind import");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE, "A's edit survives");
	assert.equal(fixture.submissions.length, 0, "no candidate was built from the stale plan");
	assert.equal(fixture.disk(), LOCAL_TOP, "and the external write is untouched");
	await fixture.destroy();
});

s.test("P0c N2: a remote edit reaching a closed body between ingest planning and apply is never diffed away", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL_TOP, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	beforeNextConditionalCommit(fixture, () => fixture.applyRemote(REMOTE));
	await fixture.ingest();
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE, "superseded: the remote edit is intact");
	assert.equal(fixture.submissions.length, 0);
	// The re-plan sees both sides moved and merges them on the baseline.
	await fixture.ingest();
	await eventually(() => fixture.disk() === MERGED, "the re-plan merges both edits");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), MERGED);
	assert.equal(fixture.artifacts.size, 0);
	await fixture.destroy();
});

s.test("P0c N2: a disk edit to an evicted body is planned against the loaded body", async () => {
	const fixture = await closedBodyFixture({ disk: LOCAL, baseline: BASE, loadBody: false });
	await fixture.ingest();
	assert.equal(fixture.runtime.getPathContent("Closed.md"), LOCAL, "body == baseline: a plain local edit");
	assert.equal(fixture.submissions.length, 1);
	await fixture.destroy();
});

s.test("P0c N2: a remote edit during bound local-only planning is never diffed away", async () => {
	const REMOTE2 = `${REMOTE} and more`;
	const fixture = await boundFixture({
		disk: LOCAL_TOP, editor: LOCAL_TOP, crdt: REMOTE, baseline: BASE, knownBase: BASE, remoteDuringBaseLookup: REMOTE2,
	});
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), REMOTE2, "the merge planned on the older body is not applied");
	assert.deepEqual(fixture.origins, ["provider-remote"], "only the remote update touched the body");
});

s.test("P0c N2: the bound open-idle recovery merges on the baseline instead of a two-way import", async () => {
	const fixture = await boundFixture({ disk: LOCAL_TOP, editor: REMOTE, crdt: REMOTE, baseline: BASE, knownBase: BASE });
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), MERGED, "the external write and the remote edit both survive");
});

s.test("REVIEW N1: an open but unbound editor never takes a two-way import over a moved body", async () => {
	const merged = await boundFixture({
		disk: LOCAL_TOP, editor: LOCAL_TOP, crdt: REMOTE, baseline: BASE, knownBase: BASE, bound: false,
	});
	await merged.ingest();
	assert.equal(merged.ytext.toString(), MERGED, "three-way on the baseline");

	const overlap = await boundFixture({
		disk: LOCAL, editor: LOCAL, crdt: REMOTE, baseline: BASE, knownBase: BASE, bound: false,
	});
	await overlap.ingest();
	await overlap.ingest();
	assert.equal(overlap.ytext.toString(), REMOTE, "overlap: the body is left alone");
	assert.deepEqual([...overlap.artifacts.values()], [LOCAL], "disk is preserved, once");
});

s.test("REVIEW N1: ingest waits while the open editor's bind resolution is pending or abandoned", async () => {
	const fixture = await boundFixture({
		disk: LOCAL_TOP, editor: LOCAL_TOP, crdt: REMOTE, baseline: BASE, knownBase: BASE, bound: false, bindBlocked: true,
	});
	await fixture.ingest();
	assert.equal(fixture.ytext.toString(), REMOTE);
	assert.deepEqual(fixture.origins, []);
	assert.equal(fixture.artifacts.size, 0);
});

s.test("REVIEW N11: a bound editor that keeps diverging after rebinds is detached", async () => {
	const fixture = await boundFixture({ disk: BASE, editor: BASE, crdt: REMOTE, baseline: BASE });
	for (let attempt = 0; attempt < 12 && fixture.quarantined.length === 0; attempt++) await fixture.ingest();
	assert.deepEqual(fixture.quarantined, ["bound-editor-diverged-from-body"]);
	assert.equal(fixture.ytext.toString(), REMOTE);
});

s.test("G1: an unresolved human decision never blocks settlement or opens a modal", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
		reviewNeverResolves: true,
	});
	fixture.applyRemote(REMOTE);
	const outcome = await Promise.race([
		fixture.mirror!.settleBody({ path: "Closed.md", bodyId: "body-closed", generation: 2, content: REMOTE }),
		new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 200)),
	]);
	assert.equal(outcome, "preserved-unresolved");
	assert.equal(fixture.artifacts.size, 1);
	assert.equal(fixture.reviews.length, 0);
	await fixture.destroy();
});

s.test("REVIEW N4: a preserved overlap is not preserved or offered for review again by later ingests", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	fixture.applyRemote(REMOTE);
	await fixture.ingest();
	await eventually(() => fixture.artifactWrites.length === 1, "the overlap is preserved");
	await fixture.ingest();
	await fixture.ingest();
	assert.equal(fixture.artifactWrites.length, 1, "one conflict note per unresolved overlap");
	assert.deepEqual(fixture.reviews, [], "review opens only on explicit user action");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE);
	assert.equal(fixture.disk(), LOCAL);
	await fixture.destroy();
});

s.test("round 4 (2): external autosaves during an unresolved overlap add no conflict note and no review", async () => {
	const fixture = await closedBodyFixture({
		disk: LOCAL, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	fixture.applyRemote(REMOTE);
	await fixture.ingest();
	await eventually(() => fixture.artifactWrites.length === 1, "the overlap is preserved");
	for (let save = 1; save <= 4; save++) {
		// An external editor autosaves the conflicting line again and again.
		fixture.setDisk(`${LOCAL} (autosave ${save})`);
		await fixture.ingest();
	}
	assert.equal(fixture.artifactWrites.length, 1, "the note already holds the body (C); nothing new to preserve");
	assert.deepEqual(fixture.artifactWrites, [REMOTE]);
	assert.deepEqual(fixture.reviews, [], "autosaves never open a review modal");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), REMOTE, "the body is untouched");
	assert.equal(fixture.disk(), `${LOCAL} (autosave 4)`, "and so is the disk");
	// A new body state is a new overlap to preserve.
	fixture.applyRemote(`${REMOTE} and more`);
	fixture.setDisk(`${LOCAL} (autosave 5)`);
	await fixture.ingest();
	await eventually(() => fixture.artifactWrites.length === 2, "a new body state is preserved");
	await fixture.destroy();
});

s.test("REVIEW N6: forgetting a path's plans drops a stale disk expectation", async () => {
	const fixture = await closedBodyFixture({
		disk: BASE, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	const mirror = fixture.mirror!;
	fixture.applyRemote(REMOTE);
	mirror.scheduleWrite("Closed.md", { expectedDiskHash: await contentBaselineHash(LOCAL) });
	mirror.forgetPathPlans(["Closed.md"]);
	await mirror.flushWrite("Closed.md");
	assert.equal(fixture.disk(), REMOTE, "a plan about a replaced file no longer blocks the write");
	await fixture.destroy();
});

s.test("REVIEW N6: a settled body clears an older disk expectation", async () => {
	const fixture = await closedBodyFixture({
		disk: BASE, baseline: BASE, loadBody: true, realMirror: true, commonBase: BASE,
	});
	const mirror = fixture.mirror!;
	mirror.scheduleWrite("Closed.md", { expectedDiskHash: await contentBaselineHash(LOCAL) });
	assert.equal(
		await mirror.settleBody({ path: "Closed.md", bodyId: "body-closed", generation: 2, content: BASE }),
		"settled",
	);
	fixture.applyRemote(REMOTE);
	await mirror.flushWrite("Closed.md");
	assert.equal(fixture.disk(), REMOTE);
	await fixture.destroy();
});

s.test("REVIEW N3: a persisted baseline is stored as the body's common base", async () => {
	const fixture = await closedBodyFixture({ disk: BASE, baseline: BASE, loadBody: true });
	fixture.applyRemote(REMOTE);
	const hash = await contentBaselineHash(REMOTE);
	fixture.controller.recordProjectedDiskWrite("Closed.md", hash, REMOTE);
	assert.deepEqual(fixture.commonBaseWrites, [{ path: "Closed.md", hash, content: REMOTE }]);
	await fixture.destroy();
});

s.test("REVIEW N9: a baseline recorded while the local identity is unknown keeps the entry's scope", async () => {
	const fixture = await closedBodyFixture({ disk: BASE, baseline: BASE, loadBody: true });
	fixture.applyRemote(REMOTE);
	fixture.setControllerScope(null);
	fixture.controller.recordProjectedDiskWrite("Closed.md", await contentBaselineHash(REMOTE), REMOTE);
	const held = fixture.diskIndex()["Closed.md"];
	assert.equal(held?.contentHash, await contentBaselineHash(BASE), "nothing is written under an unknown identity");
	assert.equal(held?.baselineScope, SCOPE, "the previous scope is not stripped");
	fixture.controller.notifyLocalWorkSettled();
	assert.equal(fixture.diskIndex()["Closed.md"]?.contentHash, await contentBaselineHash(BASE), "still held back");
	fixture.setControllerScope(SCOPE);
	fixture.controller.notifyLocalWorkSettled();
	assert.equal(fixture.diskIndex()["Closed.md"]?.contentHash, await contentBaselineHash(REMOTE));
	assert.equal(fixture.diskIndex()["Closed.md"]?.baselineScope, SCOPE);
	await fixture.destroy();
});

// ---------------------------------------------------------------------------
// Round 4: re-plan loop, autosave conflict notes, frontmatter guard ordering
// ---------------------------------------------------------------------------

const FM_BASE = `---\ntags: [a]\n---\n${BASE}`;
const FM_OTHER_PROPS = `---\ntags: [b]\n---\n${BASE}`;

/** Count re-queues; each one runs the re-plan right away (bounded by the test). */
function countRequeues(controller: ReconciliationController, replan: () => Promise<void>, limit = 20) {
	const requeues: string[] = [];
	const runs: Promise<void>[] = [];
	controller.markMarkdownDirty = (file) => {
		requeues.push(file.path);
		if (requeues.length <= limit) runs.push(replan());
	};
	return { requeues, settle: async () => { while (runs.length) await runs.shift(); } };
}

s.test("round 4 (1a): properties-only external change to a closed note under the guard settles, no re-plan loop", async () => {
	const fixture = await closedBodyFixture({
		disk: FM_OTHER_PROPS, baseline: FM_BASE, loadBody: true, seedContent: FM_BASE,
		blockFrontmatter: (previous, next) => previous !== null && previous.startsWith("---") && next !== previous,
	});
	const conditional: string[] = [];
	const original = fixture.runtime.commitBodyCandidateIfCurrent.bind(fixture.runtime);
	fixture.runtime.commitBodyCandidateIfCurrent = async (input) => { conditional.push(input.content); return original(input); };
	const loop = countRequeues(fixture.controller, () => fixture.ingest());
	await fixture.ingest();
	await loop.settle();
	assert.deepEqual(loop.requeues, [], "nothing to commit is not a superseded plan");
	assert.equal(fixture.submissions.length, 0, "no candidate");
	assert.equal(fixture.runtime.getPathContent("Closed.md"), FM_BASE, "held properties kept");
	assert.equal(fixture.diskIndex()["Closed.md"]?.size, FM_OTHER_PROPS.length, "the stat advances so the scan settles");
	assert.equal(fixture.diskIndex()["Closed.md"]?.mtime, 2);
	assert.equal(currentContentHash(fixture.diskIndex()["Closed.md"]), await contentBaselineHash(FM_BASE));
	assert.ok(conditional.length <= 1, "at most one no-op conditional commit");
	await fixture.destroy();
});

s.test("round 4 (1a): a conditional commit of content the body already holds is a no-op completion", async () => {
	const fixture = await closedBodyFixture({ disk: BASE, baseline: BASE, loadBody: true });
	const outcome = await fixture.runtime.commitBodyCandidateIfCurrent({
		bodyId: "body-closed", path: "Closed.md", expectedContent: BASE, content: BASE,
		candidateId: "noop", reason: "test",
	});
	assert.deepEqual(outcome, { kind: "completed", receipt: null, unchanged: true });
	assert.equal(fixture.submissions.length, 0, "no candidate is captured");
	await fixture.destroy();
});

s.test("round 4 (1b): an unbound open note whose disk edits the closed body already holds settles, no re-plan loop", async () => {
	// merge(B, D, C) == C: disk's edit is already in the body.
	const fixture = await boundFixture({
		disk: LOCAL_TOP, editor: LOCAL_TOP, crdt: MERGED, baseline: BASE, knownBase: BASE, bound: false, bodyOpen: false,
	});
	const loop = countRequeues(fixture.controller, () => fixture.ingest());
	await fixture.ingest();
	await loop.settle();
	assert.deepEqual(loop.requeues, [], "no re-queue");
	assert.deepEqual(fixture.conditionalCommits, [], "nothing to commit");
	assert.equal(fixture.ytext.toString(), MERGED);
	assert.equal(fixture.diskIndex()["Open.md"]?.size, LOCAL_TOP.length, "the stat advances");
	assert.equal(
		currentContentHash(fixture.diskIndex()["Open.md"]),
		await contentBaselineHash(BASE),
		"disk and body do not agree: the baseline is not advanced to either",
	);
});

s.test("round 4 (1): superseded disk imports re-plan a bounded number of times, then give up", async () => {
	const fixture = await closedBodyFixture({ disk: LOCAL, baseline: BASE, loadBody: true });
	let attempts = 0;
	fixture.runtime.commitBodyCandidateIfCurrent = async () => { attempts++; return { kind: "superseded" }; };
	const loop = countRequeues(fixture.controller, () => fixture.ingest());
	await fixture.ingest();
	await loop.settle();
	assert.equal(loop.requeues.length, 3, "three re-plans, then a logged give-up");
	assert.equal(attempts, 4);
	assert.equal(fixture.runtime.getPathContent("Closed.md"), BASE);
	await fixture.destroy();
});

s.test("round 4 (3): with no trusted baseline, stripped YAML on a closed note is held by the guard, body unchanged", async () => {
	const fixture = await closedBodyFixture({
		disk: BASE, baseline: null, loadBody: true, seedContent: FM_BASE, realMirror: true, commonBase: FM_BASE,
		blockFrontmatter: (previous, next) => previous !== null && previous.startsWith("---") && !next.startsWith("---"),
	});
	const loop = countRequeues(fixture.controller, () => fixture.ingest());
	await fixture.ingest();
	await loop.settle();
	assert.ok(
		fixture.frontmatterChecks.some(([previous, next, blocked]) => previous === FM_BASE && next === BASE && blocked),
		"the guard saw the disk content before any settle or commit",
	);
	assert.equal(fixture.runtime.getPathContent("Closed.md"), FM_BASE, "the properties are not stripped from the body");
	assert.equal(fixture.submissions.length, 0);
	assert.equal(fixture.disk(), BASE, "disk is not overwritten either");
	assert.deepEqual(loop.requeues, []);
	await fixture.destroy();
});

s.test("round 4 (3): with no trusted baseline, a body edit alongside stripped YAML imports the body only", async () => {
	const edited = `${BASE}\nlocal line`;
	const fixture = await closedBodyFixture({
		disk: edited, baseline: null, loadBody: true, seedContent: FM_BASE, realMirror: true, commonBase: FM_BASE,
		blockFrontmatter: (previous, next) => previous !== null && previous.startsWith("---") && !next.startsWith("---"),
	});
	await fixture.ingest();
	assert.equal(fixture.runtime.getPathContent("Closed.md"), `---\ntags: [a]\n---\n${edited}`, "held properties + disk body");
	assert.equal(fixture.submissions.length, 1);
	await fixture.destroy();
});

s.test("round 4 (3): a remote materialization never commits a disk merge the guard blocks", async () => {
	const fmRemote = `${FM_BASE}\nremote edit from device A`;
	const fixture = await closedBodyFixture({
		disk: `local heading\n${BASE}`, baseline: FM_BASE, loadBody: true, seedContent: FM_BASE,
		realMirror: true, commonBase: FM_BASE,
		blockFrontmatter: (previous, next) => previous !== null && previous.startsWith("---") && !next.startsWith("---"),
	});
	fixture.applyRemote(fmRemote);
	fixture.controller.scheduleRemoteBodyMaterialization("Closed.md");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(fixture.runtime.getPathContent("Closed.md"), fmRemote, "the stripped-YAML merge is not committed");
	assert.equal(fixture.submissions.length, 0);
	assert.equal(fixture.disk(), `local heading\n${BASE}`);
	await fixture.destroy();
});

await s.done();
