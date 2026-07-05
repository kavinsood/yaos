import { TFile } from "obsidian";

const notices: string[] = [];
const obsidian = await import("obsidian");
(obsidian as { Notice: new (msg: string, timeout?: number) => void }).Notice = class {
	constructor(msg: string) {
		notices.push(msg);
	}
};

const { BlobSyncManager } = await import("../src/sync/blobSync");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function makeHarness() {
	const files = new Map<string, { file: TFile & { path: string; stat: { mtime: number; size: number } }; data: ArrayBuffer }>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let retryScheduled = false;

	function put(path: string, data: ArrayBuffer) {
		const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
		file.path = path;
		file.stat = { mtime: 1, size: data.byteLength };
		files.set(path, { file, data });
		return file;
	}

	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
			readBinary: async (file: TFile & { path: string }) => {
				const stored = files.get(file.path);
				if (!stored) throw new Error("missing file");
				return stored.data;
			},
		},
	} as any;

	const manager = new BlobSyncManager(
		app,
		{
			getBlobRef: () => null,
			setBlobRef: () => {
				throw new Error("setBlobRef should not be called on storage full");
			},
		} as any,
		{
			host: "https://worker.example",
			token: "token",
			vaultId: "vault",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		},
		{},
		(source, msg, details) => traces.push({ source, msg, details }),
	);

	const originalScheduleRetryKick = (manager as any).scheduleRetryKick.bind(manager);
	(manager as any).scheduleRetryKick = (...args: unknown[]) => {
		retryScheduled = true;
		return originalScheduleRetryKick(...args);
	};

	return { manager, put, traces, isRetryScheduled: () => retryScheduled };
}

console.log("\n--- Test 1: HTTP 507 upload is a permanent storage-full failure ---");
{
	notices.length = 0;
	const { manager, put, traces, isRetryScheduled } = makeHarness();
	put("img.png", bytes("attachment data"));

	(manager as any).blobClient = {
		exists: async () => [],
		upload: async () => {
			throw new Error("blob upload failed: 507 storage full");
		},
	};

	const item = {
		path: "img.png",
		sizeBytes: 15,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	(manager as any).uploadQueue.set("img.png", item);

	await (manager as any).processUpload(item);

	assert(
		!(manager as any).uploadQueue.has("img.png"),
		"upload queue item removed after storage full",
	);
	assert(
		(manager as any).getDebugSnapshot().permanentUploadFailures === 1,
		"permanent upload failure counter incremented",
	);
	assert(
		traces.some((event) => event.msg === "upload-storage-full" && event.details?.path === "img.png"),
		"upload-storage-full trace emitted",
	);
	assert(
		notices.some((notice) => /storage full/i.test(notice)),
		"user notice mentions storage full",
	);
	assert(!isRetryScheduled(), "no retry scheduled for storage full");
	assert(item.retries === 0, "retry counter not incremented for storage full");
}

console.log("\n--- Test 2: storage-full failure on first attempt does not retry ---");
{
	notices.length = 0;
	const { manager, put, traces, isRetryScheduled } = makeHarness();
	put("doc.pdf", bytes("pdf bytes"));

	(manager as any).blobClient = {
		exists: async () => [],
		upload: async () => {
			throw new Error("blob upload failed: 507 Insufficient Storage");
		},
	};

	const item = {
		path: "doc.pdf",
		sizeBytes: 9,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};

	await (manager as any).processUpload(item);

	assert(
		traces.some((event) => event.msg === "upload-storage-full"),
		"507 Insufficient Storage message is treated as storage full",
	);
	assert(!isRetryScheduled(), "507 on first attempt does not schedule retry");
	assert(item.retries === 0, "retries remain zero after immediate permanent failure");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
