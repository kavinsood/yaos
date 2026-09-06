import { strict as assert } from "node:assert";
import { suite } from "../harness.ts";
import { BlobSyncManager, type AttachmentCatalogPort } from "../../src/sync/blobSync";
import type { AttachmentIntentOutcome } from "../../src/sync/vaultSync";
import type { AttachmentHead } from "../../src/types";
import { SnapshotService } from "../../src/snapshots/snapshotService";
import type { RestoreItem } from "../../src/snapshots/recoveryClient";

const s = suite("attachment-restore-cas");

const item: Extract<RestoreItem, { kind: "attachment" }> = {
	kind: "attachment",
	itemId: "a".repeat(48),
	path: "attachments/recovery.canvas",
	contentHash: "b".repeat(64),
	size: 17,
	mime: "application/json",
	contentUrl: "https://invalid.example/restore",
};

interface FixtureOptions {
	reviewed: AttachmentHead;
	current: AttachmentHead;
	outcome: AttachmentIntentOutcome;
}

function fixture(options: FixtureOptions) {
	let publishedIntent: { operationId: string; expectedRevision: string | null } | null = null;
	let forcedDownloads = 0;
	const catalog: AttachmentCatalogPort = {
		listAttachmentRefs: () => [],
		getAttachmentRef: () => undefined,
		getObservedAttachmentHead: () => options.current,
		getProjectedAttachmentHead: () => options.current,
		isAttachmentTombstoned: () => options.current.kind === "deleted",
		setAttachmentRef: async (
			_path: string,
			_hash: string,
			_size: number,
			_mime: string,
			intent: { operationId: string; expectedRevision: string | null },
		) => {
			publishedIntent = intent;
			return options.outcome;
		},
		deleteAttachmentRef: async () => options.outcome,
		renameAttachmentRef: async () => options.outcome,
		observeAttachmentChanges: () => () => undefined,
	};
	const blobSync = Object.create(BlobSyncManager.prototype) as BlobSyncManager;
	Object.defineProperty(blobSync, "forceDownloads", {
		value: async () => {
			forcedDownloads++;
			return 1;
		},
	});
	const service = new SnapshotService({
		getAttachmentCatalog: () => catalog,
		getBlobSync: () => blobSync,
	} as never);
	Reflect.set(service, "client", () => ({ downloadRestoreItem: async () => undefined }));
	const applyCandidate: unknown = Reflect.get(service, "applyAttachmentItem");
	if (typeof applyCandidate !== "function") throw new Error("SnapshotService attachment restore method is unavailable");
	const applyAttachmentItem = applyCandidate as (
		this: SnapshotService,
		restoreId: string,
		restoreItem: Extract<RestoreItem, { kind: "attachment" }>,
		liveAtReview: AttachmentHead,
	) => Promise<{ itemId: string; outcome: string }>;
	return {
		apply: () => applyAttachmentItem.call(
			service,
			"restore-1",
			item,
			options.reviewed,
		),
		publishedIntent: () => publishedIntent,
		forcedDownloads: () => forcedDownloads,
	};
}

s.test("restore publishes against the exact reviewed revision with stable identity", async () => {
	const reviewed: AttachmentHead = { kind: "deleted", revision: "delete-r1", previousHash: "a".repeat(64) };
	const test = fixture({ reviewed, current: reviewed, outcome: { kind: "committed", revision: `restore:${item.itemId}` } });
	assert.deepEqual(await test.apply(), { itemId: item.itemId, outcome: "restored" });
	assert.deepEqual(test.publishedIntent(), {
		operationId: `restore:${item.itemId}`,
		expectedRevision: "delete-r1",
	});
	assert.equal(test.forcedDownloads(), 1);
});

s.test("same-content ABA after review cannot authorize a different restore", async () => {
	const reviewed: AttachmentHead = { kind: "active", revision: "active-r1", hash: "a".repeat(64), size: 17 };
	const current: AttachmentHead = { kind: "active", revision: "active-r2", hash: "a".repeat(64), size: 17 };
	const test = fixture({ reviewed, current, outcome: { kind: "committed", revision: "unused" } });
	assert.deepEqual(await test.apply(), { itemId: item.itemId, outcome: "skipped-changed" });
	assert.equal(test.publishedIntent(), null);
	assert.equal(test.forcedDownloads(), 0);
});

s.test("terminal supersession is reported as changed and not downloaded", async () => {
	const reviewed: AttachmentHead = { kind: "missing", revision: null };
	const test = fixture({
		reviewed,
		current: reviewed,
		outcome: { kind: "superseded", current: { kind: "deleted", revision: "remote-r1", previousHash: null } },
	});
	assert.deepEqual(await test.apply(), { itemId: item.itemId, outcome: "skipped-changed" });
	assert.equal(test.forcedDownloads(), 0);
});

s.test("durably pending restore pauses instead of claiming completion", async () => {
	const reviewed: AttachmentHead = { kind: "missing", revision: null };
	const test = fixture({
		reviewed,
		current: reviewed,
		outcome: { kind: "durably-pending", operationId: `restore:${item.itemId}` },
	});
	await assert.rejects(test.apply(), /publication remains pending/);
	assert.equal(test.forcedDownloads(), 0);
});

await s.done();
