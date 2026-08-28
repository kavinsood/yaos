import type { CaptureStarted, CaptureStatus, RecoverySnapshotCatalogEntry } from "./recoveryProtocol";
import { isSafeRecoveryIdentity } from "./recoveryProtocol";
import {
	RecoveryReadError,
	RecoveryReadService,
	type RetainedSnapshotRoot,
} from "./recoveryReadService";
import { safeBlobPath, safeMarkdownPath } from "./shared/vaultPath";
import type { ObjectStorePort } from "./platformPorts";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CATALOG_PAGE = 100;
const MAX_RESTORE_ITEMS_PAGE = 100;
const MAX_RESTORE_SELECTION_ITEMS = 1_000;
const MAX_RESULT_BATCH = 100;
const MAX_CURSOR_BYTES = 4 * 1024;

export interface StartRestoreRequest {
	requestId: string;
	snapshotId: string;
	selection:
		| { kind: "all" }
		| { kind: "markdown-paths"; paths: string[] }
		| { kind: "attachment-paths"; paths: string[] }
		| { kind: "deleted-identities"; bodyIds: string[] };
}

export interface RestoreItemResult {
	itemId: string;
	outcome: "restored" | "created-fresh" | "skipped-changed" | "failed";
	errorCode?: string;
}

/** Public-safe vault authority. Recipe, plan, lease, and finalization RPCs are intentionally absent. */
export interface RecoveryRouteAuthority {
	startRecoveryCapture(input: { vaultId: string; reason: "daily" | "manual" | "pre-bulk-operation"; requestId: string }): Promise<CaptureStarted>;
	getRecoveryCaptureStatus(input: { vaultId: string; captureId: string }): Promise<CaptureStatus | null>;
	cancelRecoveryCapture(input: { vaultId: string; captureId: string }): Promise<unknown>;
	listRecoverySnapshots(input: { vaultId: string; cursor: string | null; limit: number }): Promise<{ snapshots: RecoverySnapshotCatalogEntry[]; nextCursor: string | null }>;
	authorizeRecoverySnapshotRead(input: { vaultId: string; snapshotId: string }): Promise<RetainedSnapshotRoot | null>;
	deleteRecoverySnapshot(input: { vaultId: string; snapshotId: string }): Promise<{ deleted: boolean }>;
	startRecoveryRestore(input: { vaultId: string } & StartRestoreRequest): Promise<unknown>;
	getRecoveryRestoreStatus(input: { vaultId: string; restoreId: string }): Promise<unknown>;
	listRecoveryRestoreItems(input: { vaultId: string; restoreId: string; cursor: string | null; limit: number }): Promise<unknown>;
	getRecoveryRestoreItemContent(input: { vaultId: string; restoreId: string; itemId: string }): Promise<Response>;
	recordRecoveryRestoreResults(input: { vaultId: string; restoreId: string; results: RestoreItemResult[] }): Promise<unknown>;
	cancelRecoveryRestore(input: { vaultId: string; restoreId: string }): Promise<unknown>;
	applyRecoveryRetention(input: { vaultId: string; policy: Record<string, unknown> }): Promise<unknown>;
	startRecoveryGc(input: { vaultId: string; requestId: string }): Promise<unknown>;
	getRecoveryStatus(input: { vaultId: string }): Promise<unknown>;
}

export interface RecoveryRouteOptions {
	vaultId: string;
	authority: RecoveryRouteAuthority;
	bucket?: ObjectStorePort;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
export function isPublicRecoveryRouteShape(method: string, parts: readonly string[]): boolean {
	if (parts[0] !== "recovery") return false;
	if (method === "POST" && parts.length === 2) {
		return parts[1] === "captures" || parts[1] === "restores"
			|| parts[1] === "retention" || parts[1] === "gc";
	}
	if (method === "GET" && parts.length === 2) return parts[1] === "snapshots" || parts[1] === "status";
	if ((method === "GET" || method === "DELETE") && parts.length === 3) {
		return (parts[1] === "captures" || parts[1] === "snapshots" || parts[1] === "restores")
			&& parts[2]!.length > 0;
	}
	if (method === "GET" && parts.length === 4 && parts[1] === "snapshots") {
		return parts[2]!.length > 0 && (parts[3] === "entry" || parts[3] === "file");
	}
	if (method === "GET" && parts.length === 4 && parts[1] === "restores") {
		return parts[2]!.length > 0 && parts[3] === "items";
	}
	if (method === "POST" && parts.length === 4 && parts[1] === "restores") {
		return parts[2]!.length > 0 && parts[3] === "results";
	}
	if (method === "GET" && parts.length === 5 && parts[1] === "snapshots") {
		return parts[2]!.length > 0 && parts[3] === "deleted" && parts[4]!.length > 0;
	}
	if (method === "GET" && parts.length === 6) {
		return (parts[1] === "snapshots" && parts[2]!.length > 0 && parts[3] === "deleted"
				&& parts[4]!.length > 0 && parts[5] === "file")
			|| (parts[1] === "restores" && parts[2]!.length > 0 && parts[3] === "items"
				&& parts[4]!.length > 0 && parts[5] === "content");
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("invalid_request_shape");
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
	const declared = request.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw new Error("request_too_large");
	if (!request.body) return {};
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		const value: unknown = chunk.value;
		if (!(value instanceof Uint8Array)) throw new Error("invalid_request_body");
		byteLength += value.byteLength;
		if (byteLength > MAX_REQUEST_BYTES) {
			await reader.cancel();
			throw new Error("request_too_large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (bytes.byteLength === 0) return {};
	let parsed: unknown;
	try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
	catch { throw new Error("invalid_json"); }
	if (!isRecord(parsed)) throw new Error("invalid_json_object");
	return parsed;
}

function safeId(value: unknown, code: string): asserts value is string {
	if (typeof value !== "string" || !isSafeRecoveryIdentity(value)) throw new Error(code);
}

function decodedId(segment: string, code: string): string {
	let decoded: string;
	try { decoded = decodeURIComponent(segment); } catch { throw new Error(code); }
	if (decoded !== segment) throw new Error(code);
	safeId(decoded, code);
	return decoded;
}

function boundedCursor(url: URL): string | null {
	const cursor = url.searchParams.get("cursor");
	if (cursor === null) return null;
	for (const character of cursor) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) throw new Error("invalid_cursor");
	}
	if (new TextEncoder().encode(cursor).byteLength > MAX_CURSOR_BYTES) throw new Error("invalid_cursor");
	return cursor;
}

function boundedLimit(url: URL, maximum: number): number {
	const raw = url.searchParams.get("limit");
	if (raw === null) return Math.min(50, maximum);
	if (!/^\d+$/.test(raw)) throw new Error("invalid_limit");
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("invalid_limit");
	return value;
}

function onlyQuery(url: URL, allowed: readonly string[]): void {
	const traceKeys = ["device", "trace", "boot"] as const;
	const permitted = new Set([...allowed, ...traceKeys]);
	for (const key of url.searchParams.keys()) if (!permitted.has(key)) throw new Error("invalid_query");
	for (const key of permitted) if (url.searchParams.getAll(key).length > 1) throw new Error("invalid_query");
}

function parseRestoreRequest(body: Record<string, unknown>): StartRestoreRequest {
	assertExactKeys(body, ["requestId", "snapshotId", "selection"]);
	safeId(body.requestId, "invalid_request_id");
	safeId(body.snapshotId, "invalid_snapshot_id");
	if (!isRecord(body.selection)) throw new Error("invalid_restore_selection");
	const selection = body.selection;
	if (selection.kind === "all") {
		assertExactKeys(selection, ["kind"]);
		return { requestId: body.requestId, snapshotId: body.snapshotId, selection: { kind: "all" } };
	}
	if (selection.kind === "markdown-paths" || selection.kind === "attachment-paths") {
		assertExactKeys(selection, ["kind", "paths"]);
		if (!Array.isArray(selection.paths) || selection.paths.length < 1 || selection.paths.length > MAX_RESTORE_SELECTION_ITEMS) throw new Error("invalid_restore_selection");
		const paths = selection.paths.map((path) => {
			if (typeof path !== "string") throw new Error("invalid_restore_path");
			const canonical = selection.kind === "markdown-paths" ? safeMarkdownPath(path) : safeBlobPath(path);
			if (canonical !== path) throw new Error("invalid_restore_path");
			return path;
		});
		if (new Set(paths).size !== paths.length) throw new Error("duplicate_restore_item");
		return { requestId: body.requestId, snapshotId: body.snapshotId, selection: { kind: selection.kind, paths } };
	}
	if (selection.kind === "deleted-identities") {
		assertExactKeys(selection, ["kind", "bodyIds"]);
		if (!Array.isArray(selection.bodyIds) || selection.bodyIds.length < 1 || selection.bodyIds.length > MAX_RESTORE_SELECTION_ITEMS) throw new Error("invalid_restore_selection");
		const bodyIds = selection.bodyIds.map((bodyId) => {
			safeId(bodyId, "invalid_body_id");
			return bodyId;
		});
		if (new Set(bodyIds).size !== bodyIds.length) throw new Error("duplicate_restore_item");
		return { requestId: body.requestId, snapshotId: body.snapshotId, selection: { kind: "deleted-identities", bodyIds } };
	}
	throw new Error("invalid_restore_selection");
}

function parseResults(body: Record<string, unknown>): RestoreItemResult[] {
	assertExactKeys(body, ["results"]);
	if (!Array.isArray(body.results) || body.results.length < 1 || body.results.length > MAX_RESULT_BATCH) throw new Error("invalid_restore_results");
	const results = body.results.map((candidate): RestoreItemResult => {
		if (!isRecord(candidate)) throw new Error("invalid_restore_result");
		const expectedKeys = candidate.errorCode === undefined ? ["itemId", "outcome"] : ["itemId", "outcome", "errorCode"];
		assertExactKeys(candidate, expectedKeys);
		safeId(candidate.itemId, "invalid_restore_item_id");
		if (candidate.outcome !== "restored" && candidate.outcome !== "created-fresh" && candidate.outcome !== "skipped-changed" && candidate.outcome !== "failed") throw new Error("invalid_restore_outcome");
		if (candidate.errorCode !== undefined && (typeof candidate.errorCode !== "string" || candidate.errorCode.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(candidate.errorCode))) throw new Error("invalid_restore_error_code");
		return { itemId: candidate.itemId, outcome: candidate.outcome, ...(candidate.errorCode === undefined ? {} : { errorCode: candidate.errorCode }) };
	});
	if (new Set(results.map((result) => result.itemId)).size !== results.length) throw new Error("duplicate_restore_result");
	return results;
}

async function retainedRoot(authority: RecoveryRouteAuthority, vaultId: string, snapshotId: string): Promise<RetainedSnapshotRoot> {
	const retained = await authority.authorizeRecoverySnapshotRead({ vaultId, snapshotId });
	if (!retained) throw new RecoveryReadError("snapshot_not_found", 404);
	return retained;
}

function contentResponse(bytes: Uint8Array, hash: string, contentType = "text/markdown; charset=utf-8"): Response {
	return new Response(bytes.slice().buffer, {
		headers: {
			"cache-control": "no-store",
			"content-type": contentType,
			"content-length": String(bytes.byteLength),
			"x-yaos-content-sha256": hash,
			"x-yaos-content-size": String(bytes.byteLength),
		},
	});
}

/** Strict authenticated RFC-v2 public recovery subrouter. */
export async function handleRecoveryRoute(request: Request, parts: string[], options: RecoveryRouteOptions): Promise<Response> {
	const url = new URL(request.url);
	const authority = options.authority;
	try {
		if (request.method === "POST" && parts.length === 2 && parts[1] === "captures") {
			const body = await boundedJson(request);
			assertExactKeys(body, ["reason", "requestId"]);
			if (body.reason !== "daily" && body.reason !== "manual" && body.reason !== "pre-bulk-operation") throw new Error("invalid_snapshot_reason");
			safeId(body.requestId, "invalid_request_id");
			return json(await authority.startRecoveryCapture({ vaultId: options.vaultId, reason: body.reason, requestId: body.requestId }), 202);
		}
		if (parts.length === 3 && parts[1] === "captures") {
			const captureId = decodedId(parts[2]!, "invalid_capture_id");
			if (request.method === "GET") {
				const status = await authority.getRecoveryCaptureStatus({ vaultId: options.vaultId, captureId });
				return status ? json(status) : json({ error: "capture_not_found" }, 404);
			}
			if (request.method === "DELETE") return json(await authority.cancelRecoveryCapture({ vaultId: options.vaultId, captureId }), 202);
		}
		if (request.method === "GET" && parts.length === 2 && parts[1] === "snapshots") {
			onlyQuery(url, ["cursor", "limit"]);
			return json(await authority.listRecoverySnapshots({ vaultId: options.vaultId, cursor: boundedCursor(url), limit: boundedLimit(url, MAX_CATALOG_PAGE) }));
		}
		if (parts.length >= 3 && parts[1] === "snapshots") {
			const snapshotId = decodedId(parts[2]!, "invalid_snapshot_id");
			if (request.method === "DELETE" && parts.length === 3) {
				const result = await authority.deleteRecoverySnapshot({ vaultId: options.vaultId, snapshotId });
				return result.deleted ? json(result, 202) : json({ error: "snapshot_not_found" }, 404);
			}
			if (request.method === "GET") {
				if (!options.bucket) throw new RecoveryReadError("recovery_storage_unavailable", 503);
				const retained = await retainedRoot(authority, options.vaultId, snapshotId);
				const readService = new RecoveryReadService(
					options.bucket,
					options.vaultId,
					retained.vaultGeneration,
				);
				if (parts.length === 3) return json(await readService.root(retained));
				if (parts.length === 4 && (parts[3] === "entry" || parts[3] === "file")) {
					onlyQuery(url, ["path"]);
					const path = url.searchParams.get("path");
					if (path === null || (safeMarkdownPath(path) !== path && safeBlobPath(path) !== path)) throw new Error("invalid_path");
					if (parts[3] === "entry") {
						const entry = await readService.entry(retained, path);
						return entry ? json(entry) : json({ error: "snapshot_entry_not_found" }, 404);
					}
					const file = await readService.file(retained, path);
					return contentResponse(file.bytes, file.hash, file.contentType);
				}
				if (parts.length === 5 && parts[3] === "deleted") {
					const bodyId = decodedId(parts[4]!, "invalid_body_id");
					const entry = await readService.deletedEntry(retained, bodyId);
					return entry ? json(entry) : json({ error: "deleted_entry_not_found" }, 404);
				}
				if (parts.length === 6 && parts[3] === "deleted" && parts[5] === "file") {
					const bodyId = decodedId(parts[4]!, "invalid_body_id");
					const file = await readService.deletedFile(retained, bodyId);
					return contentResponse(file.bytes, file.entry.availability === "available" ? file.entry.baselineContentHash : "");
				}
			}
		}
		if (request.method === "POST" && parts.length === 2 && parts[1] === "restores") {
			return json(await authority.startRecoveryRestore({ vaultId: options.vaultId, ...parseRestoreRequest(await boundedJson(request)) }), 202);
		}
		if (parts.length >= 3 && parts[1] === "restores") {
			const restoreId = decodedId(parts[2]!, "invalid_restore_id");
			if (parts.length === 3 && request.method === "GET") {
				const status = await authority.getRecoveryRestoreStatus({ vaultId: options.vaultId, restoreId });
				return status ? json(status) : json({ error: "restore_not_found" }, 404);
			}
			if (parts.length === 3 && request.method === "DELETE") return json(await authority.cancelRecoveryRestore({ vaultId: options.vaultId, restoreId }), 202);
			if (parts.length === 4 && parts[3] === "items" && request.method === "GET") {
				onlyQuery(url, ["cursor", "limit"]);
				return json(await authority.listRecoveryRestoreItems({ vaultId: options.vaultId, restoreId, cursor: boundedCursor(url), limit: boundedLimit(url, MAX_RESTORE_ITEMS_PAGE) }));
			}
			if (parts.length === 6 && parts[3] === "items" && parts[5] === "content" && request.method === "GET") {
				const itemId = decodedId(parts[4]!, "invalid_restore_item_id");
				return authority.getRecoveryRestoreItemContent({ vaultId: options.vaultId, restoreId, itemId });
			}
			if (parts.length === 4 && parts[3] === "results" && request.method === "POST") {
				return json(await authority.recordRecoveryRestoreResults({ vaultId: options.vaultId, restoreId, results: parseResults(await boundedJson(request)) }));
			}
		}
		if (request.method === "POST" && parts.length === 2 && parts[1] === "retention") {
			return json(await authority.applyRecoveryRetention({ vaultId: options.vaultId, policy: await boundedJson(request) }), 202);
		}
		if (request.method === "POST" && parts.length === 2 && parts[1] === "gc") {
			const body = await boundedJson(request);
			assertExactKeys(body, ["requestId"]);
			safeId(body.requestId, "invalid_request_id");
			return json(await authority.startRecoveryGc({ vaultId: options.vaultId, requestId: body.requestId }), 202);
		}
		if (request.method === "GET" && parts.length === 2 && parts[1] === "status") return json(await authority.getRecoveryStatus({ vaultId: options.vaultId }));
		return json({ error: "not_found" }, 404);
	} catch (error) {
		if (error instanceof RecoveryReadError) return json({ error: error.code }, error.status);
		const message = error instanceof Error ? error.message : String(error);
		const status = message === "request_too_large" ? 413
			: /(?:_| )not(?:_| )found$/.test(message) ? 404
				: message.includes("unavailable") ? 503
					: message.startsWith("invalid_") || message.startsWith("invalid ") || message.startsWith("duplicate_") ? 400
						: message.endsWith("_limit") || message.includes("active_") ? 429
							: 409;
		return json({ error: message }, status);
	}
}

export const RECOVERY_PUBLIC_LIMITS = Object.freeze({
	requestBytes: MAX_REQUEST_BYTES,
	catalogPage: MAX_CATALOG_PAGE,
	restoreItemsPage: MAX_RESTORE_ITEMS_PAGE,
	restoreSelectionItems: MAX_RESTORE_SELECTION_ITEMS,
	resultBatch: MAX_RESULT_BATCH,
	cursorBytes: MAX_CURSOR_BYTES,
});
