import type { App, Stat, TFolder } from "obsidian";
import { TFile } from "obsidian";
import { AttachmentOrchestrator } from "../../src/runtime/attachmentOrchestrator";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import type { BlobQueueSnapshot } from "../../src/sync/blobSync";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite, until } from "../harness.ts";

const s = suite("attachment-orchestrator-queue-lifecycle");

function assertSnapshot(
	actual: BlobQueueSnapshot | null,
	expected: BlobQueueSnapshot | null,
	message: string,
): void {
	s.check(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	await until(condition, { timeoutMs: 1000, intervalMs: 0, message });
}

interface Fixture {
	orchestrator: AttachmentOrchestrator;
	fireLayoutReady(): void;
	getPersistedQueue(): BlobQueueSnapshot | null;
	persistCalls(): number;
	clearCalls(): number;
	setPersistBarrier(barrier: Promise<void> | null): void;
	setClearBarrier(barrier: Promise<void> | null): void;
}

function makeFixture(initialPersistedQueue: BlobQueueSnapshot | null): Fixture {
	let persistedQueue = initialPersistedQueue;
	let persistCount = 0;
	let clearCount = 0;
	let persistBarrier: Promise<void> | null = null;
	let clearBarrier: Promise<void> | null = null;
	let onLayoutReady: (() => void) | null = null;
	const files = new Map<string, { file: TFile & { path: string; stat: { mtime: number; size: number } }; data: ArrayBuffer }>();
	let clock = 1;

	const app = partialOf<App>({
		workspace: {
			layoutReady: false,
			onLayoutReady: (callback: () => void) => {
				onLayoutReady = callback;
			},
		},
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
			getFiles: () => Array.from(files.values(), ({ file }) => file),
			createFolder: async (path: string) => partialOf<TFolder>({ path }),
			createBinary: async (path: string, data: ArrayBuffer) => {
				const file = new TFile() as TFile & {
					path: string;
					stat: { ctime: number; mtime: number; size: number };
				};
				const writtenAt = clock++;
				file.path = path;
				file.stat = { ctime: writtenAt, mtime: writtenAt, size: data.byteLength };
				files.set(path, { file, data });
				return file;
			},
			adapter: {
				// `type` is part of Stat but not of TFile.stat (FileStats), so it has
				// to be supplied here.  Every path this harness writes is a file.
				stat: async (path: string): Promise<Stat | null> => {
					const stat = files.get(path)?.file.stat;
					return stat === undefined ? null : { type: "file", ...stat };
				},
			},
		},
	});

	const attachmentRefs = new Map<string, { hash: string; size: number }>(
		(initialPersistedQueue?.downloads ?? []).flatMap((download) =>
			download.sizeBytes === undefined
				? []
				: [[download.path, { hash: download.hash, size: download.sizeBytes }]],
		),
	);
	const vaultSync = partialOf<VaultSync>({
		listAttachmentRefs: () => attachmentRefs,
		getAttachmentRef: (path) => attachmentRefs.get(path),
		isAttachmentTombstoned: () => false,
		setAttachmentRef: async (path, hash, size) => { attachmentRefs.set(path, { hash, size }); },
		deleteAttachmentRef: async (path) => { attachmentRefs.delete(path); },
		renameAttachmentRef: async (oldPath, newPath) => {
			const ref = attachmentRefs.get(oldPath);
			if (ref) attachmentRefs.set(newPath, ref);
			attachmentRefs.delete(oldPath);
		},
		observeAttachmentChanges: () => () => {},
	});

	const orchestrator = new AttachmentOrchestrator({
		app,
		getVaultSync: () => vaultSync,
		getRuntimeConfig: () => partialOf<RuntimeConfig>({
			enableAttachmentSync: true,
			host: "https://worker.example",
			deviceToken: "device-token",
			vaultId: "vault",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		}),
		getServerSupportsAttachments: () => true,
		getTraceHttpContext: () => undefined,
		getBlobHashCache: () => ({}),
		getExcludePatterns: () => [],
		persistBlobQueue: async (snapshot) => {
			persistCount++;
			await persistBarrier;
			persistedQueue = snapshot;
		},
		clearPersistedBlobQueue: async () => {
			clearCount++;
			await clearBarrier;
			persistedQueue = null;
		},
		getPreservedUnresolvedEntries: () => [],
		onPreservedUnresolvedChanged: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		refreshStatusBar: () => {},
		log: () => {},
	});

	return {
		orchestrator,
		fireLayoutReady: () => onLayoutReady?.(),
		getPersistedQueue: () => persistedQueue,
		persistCalls: () => persistCount,
		clearCalls: () => clearCount,
		setPersistBarrier: (barrier) => {
			persistBarrier = barrier;
		},
		setClearBarrier: (barrier) => {
			clearBarrier = barrier;
		},
	};
}

async function drainRestoredDownload(
	fixture: Fixture,
	data: ArrayBuffer,
): Promise<void> {
	// `manager` is non-null here: the orchestrator builds it in its constructor.
	// Object.assign overrides just `download` on the real BlobHttpClient — whose
	// class is not exported, so its type cannot be named — leaving the rest intact.
	Object.assign(fixture.orchestrator.manager!["blobClient"], {
		download: async (_hash: string, _timeoutMs: number): Promise<ArrayBuffer> => data,
	});
	fixture.orchestrator.markStartupReady("test");
	fixture.fireLayoutReady();
	await waitFor(
		() => fixture.orchestrator.manager?.exportQueue().downloads.length === 0,
		"restored download drains",
	);
}

s.section("Attachment orchestrator queue lifecycle");

{
	const remoteData = bytes("restored-download");
	const savedQueue: BlobQueueSnapshot = {
		uploads: [],
		downloads: [{
			path: "attachments/restored.bin",
			hash: await sha256Hex(remoteData),
			sizeBytes: remoteData.byteLength,
		}],
	};
	const fixture = makeFixture(savedQueue);
	fixture.orchestrator.hydrateSavedQueue(savedQueue);
	fixture.orchestrator.start("hydrate", false);
	const importedQueue = fixture.orchestrator.manager?.exportQueue();
	s.check(
		importedQueue?.uploads.length === 0 &&
			importedQueue.downloads.length === 1 &&
			importedQueue.downloads[0]?.path === savedQueue.downloads[0]?.path &&
			importedQueue.downloads[0]?.hash === savedQueue.downloads[0]?.hash,
		"hydrated queue imports into the active manager",
	);

	await drainRestoredDownload(fixture, remoteData);

	let releaseClear!: () => void;
	fixture.setClearBarrier(new Promise((resolve) => {
		releaseClear = resolve;
	}));
	const stopping = fixture.orchestrator.stop("drained");
	await Promise.resolve();
	s.check(fixture.orchestrator.manager === null, "stop removes the manager before terminal persistence");
	assertSnapshot(fixture.getPersistedQueue(), savedQueue, "saved queue remains durable until terminal clear resolves");
	releaseClear();
	await stopping;
	s.check(fixture.clearCalls() === 1, "empty active manager clears persisted queue at stop");
	assertSnapshot(fixture.getPersistedQueue(), null, "drained queue is removed from durable state");

	const recreated = makeFixture(fixture.getPersistedQueue());
	recreated.orchestrator.hydrateSavedQueue(recreated.getPersistedQueue());
	recreated.orchestrator.start("reload", false);
	assertSnapshot(
		recreated.orchestrator.manager?.exportQueue() ?? null,
		{ uploads: [], downloads: [] },
		"recreated orchestrator has no stale queue to import",
	);
	await recreated.orchestrator.destroy();
}

{
	const remoteData = bytes("status-tick-before-stop");
	const savedQueue: BlobQueueSnapshot = {
		uploads: [],
		downloads: [{
			path: "attachments/status-tick.bin",
			hash: await sha256Hex(remoteData),
			sizeBytes: remoteData.byteLength,
		}],
	};
	const fixture = makeFixture(savedQueue);
	fixture.orchestrator.hydrateSavedQueue(savedQueue);
	fixture.orchestrator.start("status-tick-race", false);

	let releasePersist!: () => void;
	fixture.setPersistBarrier(new Promise((resolve) => {
		releasePersist = resolve;
	}));
	fixture.orchestrator.handleStatusTick();
	await waitFor(() => fixture.persistCalls() === 1, "delayed status-tick checkpoint starts");

	await drainRestoredDownload(fixture, remoteData);
	const stopping = fixture.orchestrator.stop("status-tick-race");
	await Promise.resolve();
	s.check(fixture.clearCalls() === 0, "terminal clear waits behind the earlier status-tick save");
	fixture.orchestrator.handleStatusTick();
	s.check(fixture.persistCalls() === 1, "status ticks cannot queue stale snapshots after stop begins");

	releasePersist();
	await stopping;
	s.check(fixture.clearCalls() === 1, "terminal clear runs after the delayed status-tick save");
	assertSnapshot(fixture.getPersistedQueue(), null, "terminal clear wins over a delayed periodic save");
}

{
	const queued: BlobQueueSnapshot = {
		uploads: [],
		downloads: [{ path: "pending.bin", hash: "a".repeat(64), sizeBytes: 1 }],
	};
	const fixture = makeFixture(queued);
	fixture.orchestrator.hydrateSavedQueue(queued);
	fixture.orchestrator.start("nonempty-control", false);
	const expectedPersistedQueue = fixture.orchestrator.manager?.exportQueue() ?? null;
	await fixture.orchestrator.destroy();
	s.check(fixture.persistCalls() === 1, "nonempty active queue is persisted during destroy");
	s.check(fixture.clearCalls() === 0, "nonempty active queue is not cleared during destroy");
	assertSnapshot(fixture.getPersistedQueue(), expectedPersistedQueue, "destroy retains the nonempty queue snapshot");
}

{
	const savedQueue: BlobQueueSnapshot = {
		uploads: [{ path: "never-started.bin", sizeBytes: 1 }],
		downloads: [],
	};
	const fixture = makeFixture(savedQueue);
	fixture.orchestrator.hydrateSavedQueue(savedQueue);
	await fixture.orchestrator.destroy();
	s.check(fixture.persistCalls() === 0, "unstarted queue is not re-persisted");
	s.check(fixture.clearCalls() === 0, "unstarted queue is not cleared");
	assertSnapshot(fixture.getPersistedQueue(), savedQueue, "saved queue survives when attachment sync never starts");
}
await s.done();
