import * as Y from "yjs";
import {
	PersistenceCoordinator,
	type DocStore,
	type DocStoreCoalesceResult,
	type DocStoreJournalStats,
} from "../../server/src/persistenceCoordinator";
import { suite } from "../harness.ts";

const s = suite("persistence-coordinator-failures");

class RecordingStore implements DocStore {
	readonly journal: Uint8Array[] = [];
	snapshot: Uint8Array | null = null;
	appendCalls = 0;
	checkpointCalls = 0;
	coalesceCalls = 0;
	failAppend = false;
	failCheckpoint = false;
	appendStatsOverride: DocStoreJournalStats | null = null;
	coalesceResultOverride: DocStoreCoalesceResult | null = null;

	async appendUpdate(update: Uint8Array): Promise<DocStoreJournalStats | null> {
		this.appendCalls++;
		if (this.failAppend) throw new Error("injected append failure");
		this.journal.push(update.slice());
		return this.appendStatsOverride ?? this.getJournalStats();
	}

	async rewriteCheckpoint(update: Uint8Array): Promise<void> {
		this.checkpointCalls++;
		if (this.failCheckpoint) throw new Error("injected checkpoint failure");
		this.snapshot = update.slice();
		this.journal.length = 0;
	}

	getJournalStats(): DocStoreJournalStats {
		return {
			entryCount: this.journal.length,
			totalBytes: this.journal.reduce((sum, update) => sum + update.byteLength, 0),
		};
	}

	coalesceJournal(): DocStoreCoalesceResult {
		this.coalesceCalls++;
		if (this.coalesceResultOverride) return this.coalesceResultOverride;
		if (this.journal.length <= 1) return { status: "noop", stats: this.getJournalStats() };
		const merged = Y.mergeUpdates(this.journal);
		this.journal.length = 0;
		this.journal.push(merged);
		return { status: "ok", stats: this.getJournalStats() };
	}

	replay(): Y.Doc {
		const doc = new Y.Doc();
		if (this.snapshot) Y.applyUpdate(doc, this.snapshot);
		for (const update of this.journal) Y.applyUpdate(doc, update);
		return doc;
	}
}

class BlockingFirstAppendStore extends RecordingStore {
	private markFirstAppendStarted: (() => void) | null = null;
	private releaseFirstAppend: (() => void) | null = null;
	readonly firstAppendStarted = new Promise<void>((resolve) => {
		this.markFirstAppendStarted = resolve;
	});
	private readonly firstAppendGate = new Promise<void>((resolve) => {
		this.releaseFirstAppend = resolve;
	});

	override async appendUpdate(update: Uint8Array): Promise<DocStoreJournalStats | null> {
		this.appendCalls++;
		if (this.appendCalls === 1) {
			this.markFirstAppendStarted?.();
			await this.firstAppendGate;
		}
		this.journal.push(update.slice());
		return this.getJournalStats();
	}

	release(): void {
		this.releaseFirstAppend?.();
	}
}

function equalBytes(left: Uint8Array | null, right: Uint8Array): boolean {
	if (!left || left.byteLength !== right.byteLength) return false;
	return left.every((byte, index) => byte === right[index]);
}

s.section("append failures reach the configured threshold and fall back to a checkpoint");
{
	const doc = new Y.Doc();
	const store = new RecordingStore();
	const coordinator = new PersistenceCoordinator(doc, store);
	coordinator.setInitialStateVector(Y.encodeStateVector(doc));
	doc.getText("note").insert(0, "durable after threshold");
	store.failAppend = true;

	const first = await coordinator.enqueueSave();
	s.check(!first.success && first.method === "append", "first append failure remains an append failure below the threshold");
	s.check(store.appendCalls === 1 && store.checkpointCalls === 0, "first failure does not checkpoint before the threshold");

	const second = await coordinator.enqueueSave();
	s.check(second.success && second.method === "immediate-fallback", `second failure falls back immediately (method=${second.method})`);
	s.check(store.appendCalls === 2 && store.checkpointCalls === 1, "threshold attempt performs two appends then one checkpoint");
	const replayed = store.replay();
	s.check(replayed.getText("note").toString() === "durable after threshold", "checkpoint fallback contains the failed append payload");

	coordinator.dispose();
	doc.destroy();
	replayed.destroy();
}

s.section("append plus checkpoint failure never advances the persisted state vector");
{
	const doc = new Y.Doc();
	const store = new RecordingStore();
	const coordinator = new PersistenceCoordinator(doc, store, undefined, {
		checkpointFallbackAfterFailures: 1,
	});
	const persistedBefore = Y.encodeStateVector(doc);
	coordinator.setInitialStateVector(persistedBefore);
	doc.getText("note").insert(0, "not persisted");
	store.failAppend = true;
	store.failCheckpoint = true;

	const result = await coordinator.enqueueSave();

	s.check(!result.success && result.method === "immediate-fallback", "total storage failure reports failed immediate fallback");
	s.check(store.appendCalls === 1 && store.checkpointCalls === 1, "both persistence methods were attempted");
	s.check(equalBytes(coordinator.getLastPersistedStateVector(), persistedBefore), "failed writes leave persisted state vector at its prior value");
	s.check(coordinator.health.persistedGeneration === 0, "failed writes do not advance persisted generation");
	s.check(coordinator.health.dirty, "failed writes leave the document dirty for retry");

	coordinator.dispose();
	doc.destroy();
}

s.section("a queued save captures a fresh state vector after the prior save resolves");
{
	const doc = new Y.Doc();
	const store = new BlockingFirstAppendStore();
	const coordinator = new PersistenceCoordinator(doc, store);
	coordinator.setInitialStateVector(Y.encodeStateVector(doc));
	const text = doc.getText("note");
	text.insert(0, "first");
	const firstSave = coordinator.enqueueSave();
	await store.firstAppendStarted;

	text.insert(text.length, " second");
	const secondSave = coordinator.enqueueSave();
	store.release();
	const [first, second] = await Promise.all([firstSave, secondSave]);

	s.check(first.success && second.success, "both serialized saves succeed");
	s.check(store.appendCalls === 2, "change arriving during the first append is written by the queued save");
	s.check(equalBytes(coordinator.getLastPersistedStateVector(), Y.encodeStateVector(doc)), "queued save advances to the document's fresh state vector");
	const replayed = store.replay();
	s.check(replayed.getText("note").toString() === "first second", "both pre-queue and mid-flight changes survive replay");

	coordinator.dispose();
	doc.destroy();
	replayed.destroy();
}

s.section("entry pressure coalesces while byte pressure checkpoints");
{
	const entryDoc = new Y.Doc();
	const entryStore = new RecordingStore();
	entryStore.appendStatsOverride = { entryCount: 3, totalBytes: 30 };
	entryStore.coalesceResultOverride = { status: "ok", stats: { entryCount: 1, totalBytes: 25 } };
	const entryCoordinator = new PersistenceCoordinator(entryDoc, entryStore, undefined, {
		checkpointFallbackDeltaBytes: 1_000_000,
		journalCompactMaxEntries: 2,
		journalCompactMaxBytes: 1_000,
	});
	entryCoordinator.setInitialStateVector(Y.encodeStateVector(entryDoc));
	entryDoc.getText("note").insert(0, "entry pressure");

	const entryResult = await entryCoordinator.enqueueSave();
	s.check(entryResult.success, "entry-pressure append succeeds");
	s.check(entryStore.coalesceCalls === 1, "entry-count threshold invokes journal coalescing");
	s.check(entryStore.checkpointCalls === 0, "entry-count threshold does not rewrite the checkpoint when coalescing succeeds");

	const byteDoc = new Y.Doc();
	const byteStore = new RecordingStore();
	byteStore.appendStatsOverride = { entryCount: 1, totalBytes: 101 };
	const byteCoordinator = new PersistenceCoordinator(byteDoc, byteStore, undefined, {
		checkpointFallbackDeltaBytes: 1_000_000,
		journalCompactMaxEntries: 100,
		journalCompactMaxBytes: 100,
	});
	byteCoordinator.setInitialStateVector(Y.encodeStateVector(byteDoc));
	byteDoc.getText("note").insert(0, "byte pressure");

	const byteResult = await byteCoordinator.enqueueSave();
	s.check(byteResult.success, "byte-pressure append succeeds before compaction");
	s.check(byteStore.coalesceCalls === 0, "byte threshold does not route through entry coalescing");
	s.check(byteStore.checkpointCalls === 1, "byte threshold rewrites the checkpoint");
	s.check(byteCoordinator.health.lastCompactionReason === "byte_size_exceeded", "byte checkpoint records the byte-pressure reason");

	entryCoordinator.dispose();
	byteCoordinator.dispose();
	entryDoc.destroy();
	byteDoc.destroy();
}

await s.done();
