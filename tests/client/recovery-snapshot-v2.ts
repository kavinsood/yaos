import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { DEFAULT_SETTINGS } from "../../src/settings";
import {
	RecoveryClient,
	type CaptureStatus,
	type RecoveryTransport,
	type RecoveryTransportResponse,
	type RestoreItem,
} from "../../src/snapshots/recoveryClient";
import { parsePendingRecoveryState } from "../../src/snapshots/recoveryState";
import { suite } from "../harness.ts";

installDomCrypto();

const s = suite("recovery-snapshot-v2");
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const CAPTURE_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const RESTORE_ID = "22222222-2222-4222-8222-222222222222";

function response(
	status: number,
	json: unknown,
	bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(),
	headers: Record<string, string> = {},
): RecoveryTransportResponse {
	const arrayBuffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(arrayBuffer).set(bytes);
	return { status, json, text: JSON.stringify(json), arrayBuffer, headers };
}

function transport(handler: (url: URL, method: string, body: unknown) => Promise<RecoveryTransportResponse> | RecoveryTransportResponse): RecoveryTransport {
	return {
		request: async (request) => handler(new URL(request.url), request.method, request.body ? JSON.parse(request.body) : null),
	};
}

function client(using: RecoveryTransport): RecoveryClient {
	return new RecoveryClient({ ...DEFAULT_SETTINGS, host: "https://sync.example", deviceToken: "token", vaultId: "vault-test" }, undefined, using);
}

function captureStatus(state: CaptureStatus["state"]): CaptureStatus {
	return {
		captureId: "capture-1",
		state,
		boundarySequence: 42,
		processedEntries: state === "cancelled" ? 3 : 0,
		totalEntries: 10,
		contentObjectsWritten: 1,
		contentObjectsReused: 2,
		manifestNodesWritten: 1,
		bytesRead: 100,
		bytesWritten: 50,
		retryCount: 0,
		nextAttemptAt: null,
		error: null,
		pinSoftExpiresAt: null,
		pinHardExpiresAt: null,
		snapshotId: null,
	};
}

s.test("capture returns immediately after the 202 admission response", async () => {
	const calls: string[] = [];
	const recovery = client(transport((url, method, body) => {
		calls.push(`${method} ${url.pathname}`);
		s.check((body as { reason: string }).reason === "manual", "manual capture reason is sent");
		return response(202, { captureId: "capture-1", boundarySequence: 42, state: "queued", statusUrl: "/status" });
	}));
	const started = await recovery.startCapture("manual", CAPTURE_REQUEST_ID);
	s.check(started.captureId === "capture-1" && calls.length === 1, "client does not poll or await R2 work inside startCapture");
});

s.test("persisted capture and restore identities survive restart without persisting content plans", () => {
	const hydrated = parsePendingRecoveryState({
		activeCaptureId: "capture-1",
		activeRestore: { restoreId: RESTORE_ID, snapshotId: "snapshot-1" },
		lastCaptureStatus: captureStatus("retrying"),
		lastRestoreStatus: null,
		lastRecoveryStatus: null,
		plan: [{ path: "must-not-be-hydrated.md", content: "secret" }],
	});
	s.check(hydrated.activeCaptureId === "capture-1", "active capture resumes after restart");
	s.check(hydrated.activeRestore?.restoreId === RESTORE_ID, "active restore resumes after restart");
	s.check(!("plan" in hydrated), "legacy full restore plans are not part of persisted state");
});

s.test("complete-with-gaps roots and unavailable entries remain visible but lack restorable content", async () => {
	const root = {
		format: "yaos-recovery-v2", snapshotFormatVersion: 2, snapshotId: "snapshot-1", vaultIdHash: HASH,
		vaultGenerationHash: OTHER_HASH, runtimeEpoch: "epoch-1", boundarySequence: 42, rootGeneration: 4, sourcePlanDigest: HASH,
		manifestGraphDigest: HASH, manifestNodeCount: 3, createdAt: "2026-08-24T00:00:00.000Z",
		completedAt: "2026-08-24T00:01:00.000Z", health: "complete_with_gaps", reason: "manual",
		activeFilesTreeHash: HASH, deletedFilesTreeHash: HASH, attachmentsTreeHash: HASH,
		totals: { activeFiles: 1, deletedFiles: 0, unavailableFiles: 1, attachments: 0, markdownBytes: 0, attachmentBytes: 0 },
		previousSnapshotId: null,
	};
	const recovery = client(transport((url) => {
		if (url.pathname.endsWith("/snapshots")) {
			return response(200, {
				snapshots: [{ snapshotId: "snapshot-1", boundarySequence: 42, rootKey: "ignored", rootHash: HASH, reason: "manual", pinned: false, createdAt: 1, completedAt: 2 }],
				nextCursor: null,
			});
		}
		if (url.pathname.endsWith("/snapshot-1")) return response(200, root);
		return response(200, { availability: "unavailable", path: "Broken.md", fileId: "file-1", bodyId: "body-1", bodyGeneration: 2, errorCode: "missing_history", errorReference: "error-ref" });
	}));
	const listed = await recovery.listSnapshots();
	const inspected = await recovery.getSnapshotRoot("snapshot-1");
	const entry = await recovery.lookupPathEntry("snapshot-1", "Broken.md");
	s.check(listed.snapshots[0]?.rootHash === HASH && inspected.health === "complete_with_gaps", "compact catalog leads to the complete-with-gaps root without a manifest");
	s.check(entry?.availability === "unavailable" && !("contentHash" in entry), "unavailable entry is visible without a content locator");
});

s.test("manifest entry parsers reject unsupported error codes", async () => {
	const recovery = client(transport((url) => {
		if (url.pathname.includes("/deleted/")) {
			return response(200, {
				availability: "unavailable",
				bodyId: "body-1",
				fileId: "file-1",
				lastPath: "Deleted.md",
				deletedAtSequence: 4,
				errorCode: "unexpected_deleted_error",
				errorReference: "error-ref",
				bodyReaped: false,
			});
		}
		if (url.searchParams.get("path") === "Broken.md") {
			return response(200, {
				availability: "unavailable",
				path: "Broken.md",
				fileId: "file-1",
				bodyId: "body-1",
				bodyGeneration: 2,
				errorCode: "unexpected_markdown_error",
				errorReference: "error-ref",
			});
		}
		return response(200, {
			availability: "unavailable",
			path: "Broken.png",
			expectedHash: HASH,
			expectedSize: 12,
			mime: "image/png",
			errorCode: "unexpected_attachment_error",
			errorReference: "error-ref",
		});
	}));
	let rejected = 0;
	for (const lookup of [
		() => recovery.lookupPathEntry("snapshot-1", "Broken.md"),
		() => recovery.lookupPathEntry("snapshot-1", "Broken.png"),
		() => recovery.lookupDeletedEntry("snapshot-1", "body-1"),
	]) {
		try {
			await lookup();
		} catch {
			rejected++;
		}
	}
	s.check(rejected === 3, "unknown manifest error codes fail closed across all entry kinds");
});

s.test("attachment descriptors are bounded and corrupt content fails closed", async () => {
	const bytes = new TextEncoder().encode("wrong bytes");
	const recovery = client(transport((url) => {
		if (url.pathname.endsWith("/entry")) return response(200, { availability: "available", path: "image.png", hash: HASH, size: 12, mime: "image/png" });
		return response(200, null, bytes, { "x-yaos-content-sha256": HASH, "x-yaos-content-size": String(bytes.byteLength) });
	}));
	const entry = await recovery.lookupPathEntry("snapshot-1", "image.png");
	s.check(entry?.availability === "available" && "hash" in entry, "attachment lookup reads one entry instead of a manifest");
	const item: RestoreItem = { kind: "attachment", itemId: "item-1", path: "image.png", contentHash: HASH, size: bytes.byteLength, mime: "image/png", contentUrl: "/content" };
	let rejected = false;
	try { await recovery.downloadRestoreItem(RESTORE_ID, item); } catch { rejected = true; }
	s.check(rejected, "attachment hash mismatch never creates a placeholder");
});

s.test("missing attachment content fails without creating a placeholder", async () => {
	const recovery = client(transport(() => response(404, { error: "content_not_found" })));
	const item: RestoreItem = {
		kind: "attachment",
		itemId: "missing-attachment",
		path: "missing.png",
		contentHash: HASH,
		size: 12,
		mime: "image/png",
		contentUrl: "/content",
	};
	let errorCode = "";
	try {
		await recovery.downloadRestoreItem(RESTORE_ID, item);
	} catch (error) {
		if (error && typeof error === "object" && "errorCode" in error) {
			errorCode = typeof error.errorCode === "string" ? error.errorCode : "";
		}
	}
	s.check(errorCode === "content_unavailable", "missing attachment is a terminal item failure");
});

s.test("changed Markdown targets are skipped before candidate publication", async () => {
	const bytes = new TextEncoder().encode("snapshot content");
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const recovery = client(transport(() => response(200, null, bytes, { "x-yaos-content-sha256": hash, "x-yaos-content-size": String(bytes.byteLength) })));
	let candidateCalls = 0;
	const item: Extract<RestoreItem, { kind: "markdown" }> = { kind: "markdown", itemId: "item-1", path: "Note.md", sourceKind: "active", sourceFileId: "source-file", sourceBodyId: "source-body", contentHash: hash, size: bytes.byteLength, contentUrl: "/content" };
	const result = await recovery.applyMarkdownItem(RESTORE_ID, "snapshot-1", item, { fileId: "live-file", bodyId: "live-body", generation: 1, contentHash: HASH }, {
		getLive: async () => ({ fileId: "live-file", bodyId: "live-body", generation: 2, contentHash: OTHER_HASH }),
		restoreExisting: async () => { candidateCalls++; throw new Error("must not publish"); },
		restoreFresh: async () => { candidateCalls++; throw new Error("must not publish"); },
		settleDisk: async () => { throw new Error("must not write disk"); },
	});
	s.check(result.outcome === "skipped-changed" && candidateCalls === 0, "changed-during-review cannot overwrite durable or disk state");
});

s.test("server-matching closed unloaded body is not ACKed when disk settlement is a no-op", async () => {
	const bytes = new TextEncoder().encode("snapshot content");
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const recovery = client(transport(() => response(200, null, bytes, { "x-yaos-content-sha256": hash, "x-yaos-content-size": String(bytes.byteLength) })));
	const live = { fileId: "live-file", bodyId: "live-body", generation: 7, contentHash: hash };
	const settlementInputs: Array<{ bodyId: string; generation: number; content: string }> = [];
	let rejected = false;
	try {
		await recovery.applyMarkdownItem(RESTORE_ID, "snapshot-1", {
			kind: "markdown",
			itemId: "closed-unloaded",
			path: "Closed.md",
			sourceKind: "active",
			sourceFileId: "live-file",
			sourceBodyId: "live-body",
			contentHash: hash,
			size: bytes.byteLength,
			contentUrl: "/content",
		}, live, {
			getLive: async () => live,
			restoreExisting: async () => { throw new Error("matching server body must not republish"); },
			restoreFresh: async () => { throw new Error("matching server body must not recreate"); },
			settleDisk: async (input) => {
				settlementInputs.push(input);
				return { contentHash: OTHER_HASH, size: input.expectedSize };
			},
		});
	} catch {
		rejected = true;
	}
	s.check(rejected, "mismatched read-after-write outcome remains unacknowledged and retryable");
	const settlementInput = settlementInputs[0];
	s.check(settlementInput?.bodyId === "live-body" && settlementInput.generation === 7 && settlementInput.content === "snapshot content", "server-matching branch explicitly settles the closed unloaded body");
});

s.test("deleted snapshot identities never overwrite a newer active path", async () => {
	const bytes = new TextEncoder().encode("deleted baseline");
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const recovery = client(transport(() => response(200, null, bytes, { "x-yaos-content-sha256": hash, "x-yaos-content-size": String(bytes.byteLength) })));
	const live = { fileId: "new-file", bodyId: "new-body", generation: 1, contentHash: OTHER_HASH };
	const result = await recovery.applyMarkdownItem(RESTORE_ID, "snapshot-1", {
		kind: "markdown",
		itemId: "deleted-item",
		path: "Recreated.md",
		sourceKind: "deleted",
		sourceFileId: "old-file",
		sourceBodyId: "old-body",
		contentHash: hash,
		size: bytes.byteLength,
		contentUrl: "/content",
	}, live, {
		getLive: async () => live,
		restoreExisting: async () => { throw new Error("deleted restore must not replace the active identity"); },
		restoreFresh: async () => { throw new Error("occupied path must not be recreated"); },
		settleDisk: async () => { throw new Error("occupied path must not be written"); },
	});
	s.check(result.outcome === "skipped-changed", "deleted restore is fresh-only and treats an occupied path as changed");
});

s.test("deleted Markdown restores mint a fresh identity and replay safely", async () => {
	const bytes = new TextEncoder().encode("deleted baseline");
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const recovery = client(transport(() => response(200, null, bytes, {
		"x-yaos-content-sha256": hash,
		"x-yaos-content-size": String(bytes.byteLength),
	})));
	let freshBodyId = "";
	const item: Extract<RestoreItem, { kind: "markdown" }> = {
		kind: "markdown",
		itemId: "deleted-fresh",
		path: "Recovered.md",
		sourceKind: "deleted",
		sourceFileId: "historical-file",
		sourceBodyId: "historical-body",
		contentHash: hash,
		size: bytes.byteLength,
		contentUrl: "/content",
	};
	const result = await recovery.applyMarkdownItem(RESTORE_ID, "snapshot-1", item, null, {
		getLive: async () => null,
		restoreExisting: async () => { throw new Error("deleted restore must not overwrite"); },
		restoreFresh: async (input) => {
			freshBodyId = `fresh-${input.candidateId}`;
			return {
				fileId: freshBodyId,
				bodyId: freshBodyId,
				lifecycleOperationId: "lifecycle-1",
				receipt: {
					vaultId: "vault-test",
					vaultGeneration: "generation-test",
					bodyId: freshBodyId,
					clientId: "client-test",
					candidateId: input.candidateId,
					candidateDigest: HASH,
					durableGeneration: 1,
					runtimeEpoch: "epoch-test",
				},
			};
		},
		settleDisk: async (input) => ({ contentHash: input.expectedContentHash, size: input.expectedSize }),
	});
	s.check(
		result.outcome === "created-fresh"
			&& freshBodyId !== item.sourceFileId
			&& freshBodyId !== item.sourceBodyId,
		"deleted history is restored through a fresh durable identity",
	);
});

s.test("bulk restore item and result handshake resumes from server-owned item IDs", async () => {
	const calls: string[] = [];
	const recovery = client(transport((url, method, body) => {
		calls.push(`${method} ${url.pathname}`);
		if (method === "POST" && url.pathname.endsWith("/restores")) {
			return response(202, { restoreId: RESTORE_ID, snapshotId: "snapshot-1", state: "running", processedEntries: 0, totalEntries: 1, retryCount: 0, nextAttemptAt: null, error: null });
		}
		if (url.pathname.endsWith("/items")) {
			return response(200, {
				items: [{ kind: "markdown", itemId: "item-stable", path: "Note.md", sourceKind: "active", sourceFileId: "file-1", sourceBodyId: "body-1", contentHash: HASH, size: 12, contentUrl: "/content" }],
				nextCursor: null,
			});
		}
		if (method === "POST" && url.pathname.endsWith("/results")) {
			s.check((body as { results: Array<{ itemId: string }> }).results[0]?.itemId === "item-stable", "result ACK is bound to the stable item ID");
			return response(200, { terminal: true });
		}
		return response(200, { restoreId: RESTORE_ID, snapshotId: "snapshot-1", state: "complete", processedEntries: 1, totalEntries: 1, retryCount: 0, nextAttemptAt: null, error: null });
	}));
	const started = await recovery.startRestore("snapshot-1", { kind: "all" }, RESTORE_ID);
	const page = await recovery.listRestoreItems(started.restoreId, null, 50);
	const result = { itemId: page.items[0]!.itemId, outcome: "restored" as const };
	const status = await recovery.reportRestoreResults(started.restoreId, [result]);
	const replayed = await recovery.reportRestoreResults(started.restoreId, [result]);
	s.check(page.items.length === 1 && status.processedItems === 1 && replayed.processedItems === 1, "bounded item page and idempotent result replay complete without a manifest");
	s.check(calls.filter((call) => call.endsWith("/results")).length === 2, "client can replay the stable result batch after an interrupted acknowledgement");
});

s.test("capture cancellation uses the resumable job endpoint and records terminal status", async () => {
	let method = "";
	const recovery = client(transport((_url, requestMethod) => {
		method = requestMethod;
		return response(200, captureStatus("cancelled"));
	}));
	const status = await recovery.cancelCapture("capture-1");
	s.check(method === "DELETE" && status.state === "cancelled", "cancellation is an idempotent DELETE with visible terminal state");
});

await s.done();
