import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import {
	RECOVERY_PUBLIC_RPC_HEADER,
	RECOVERY_PUBLIC_RPC_PATH,
	RECOVERY_RPC_HEADER,
	RECOVERY_RPC_MAX_JSON_BYTES,
	RECOVERY_RPC_PATH,
	decodeRecoveryRpcPayload,
	encodeRecoveryRpcPayload,
	type RecoveryRpcRequest,
	type RecoveryRpcResponse,
} from "./recoveryProtocol";
import type { VaultRecoveryService } from "./vaultRecoveryService";

export type RecoveryRpcMethod =
	| "checkRecoveryJobLease" | "getCapturePlanPage" | "getRecipeDescriptors" | "getRecipeChunk"
	| "acquireMaterializationLease" | "releaseMaterializationLease" | "acknowledgeContentMaterialized"
	| "acknowledgeManifestNodeMaterialized" | "acknowledgeManifestNodesMaterialized" | "checkRecoveryCoverage"
	| "getIncrementalBase" | "getCatalogDeltaPage" | "resetCaptureDelta" | "recordRecoveryDefects"
	| "finalizeCapture" | "acknowledgeJobCancelled" | "getProjectionWorkPage" | "getProjectionRecipeDescriptor"
	| "getProjectionRecipeChunk" | "acknowledgeProjectionContentMaterialized" | "validateRestoreAuthority"
	| "completeRestore" | "getGcRootPage" | "completeGcMark" | "acquireSweepLease" | "releaseSweepLease"
	| "invalidateSweptObjects" | "completeGcSweep" | "abortRecoveryGc"
	| "startRecoveryCapture" | "getRecoveryCaptureStatus" | "cancelRecoveryCapture" | "listRecoverySnapshots"
	| "authorizeRecoverySnapshotRead" | "deleteRecoverySnapshot" | "startRecoveryRestore"
	| "getRecoveryRestoreStatus" | "listRecoveryRestoreItems" | "getRecoveryRestoreItemContent"
	| "recordRecoveryRestoreResults" | "cancelRecoveryRestore" | "applyRecoveryRetention" | "startRecoveryGc"
	| "getRecoveryStatus";

type InternalRecoveryRpcMethod = Exclude<RecoveryRpcMethod,
	| "startRecoveryCapture" | "getRecoveryCaptureStatus" | "cancelRecoveryCapture" | "listRecoverySnapshots"
	| "authorizeRecoverySnapshotRead" | "deleteRecoverySnapshot" | "startRecoveryRestore"
	| "getRecoveryRestoreStatus" | "listRecoveryRestoreItems" | "getRecoveryRestoreItemContent"
	| "recordRecoveryRestoreResults" | "cancelRecoveryRestore" | "applyRecoveryRetention" | "startRecoveryGc"
	| "getRecoveryStatus">;
type PublicRecoveryRpcMethod = Exclude<RecoveryRpcMethod, InternalRecoveryRpcMethod>;

export interface RecoveryRpcStorePort {
	vaultMetadata(): { vaultId: string; vaultGeneration: string } | null;
}

export type RecoveryRpcServicePort = Partial<Pick<VaultRecoveryService, RecoveryRpcMethod>>;

const INTERNAL_METHODS: Record<InternalRecoveryRpcMethod, true> = {
	checkRecoveryJobLease: true, getCapturePlanPage: true, getRecipeDescriptors: true, getRecipeChunk: true,
	acquireMaterializationLease: true, releaseMaterializationLease: true, acknowledgeContentMaterialized: true,
	acknowledgeManifestNodeMaterialized: true, acknowledgeManifestNodesMaterialized: true, checkRecoveryCoverage: true,
	getIncrementalBase: true, getCatalogDeltaPage: true, resetCaptureDelta: true, recordRecoveryDefects: true,
	finalizeCapture: true, acknowledgeJobCancelled: true, getProjectionWorkPage: true, getProjectionRecipeDescriptor: true,
	getProjectionRecipeChunk: true, acknowledgeProjectionContentMaterialized: true, validateRestoreAuthority: true,
	completeRestore: true, getGcRootPage: true, completeGcMark: true, acquireSweepLease: true, releaseSweepLease: true,
	invalidateSweptObjects: true, completeGcSweep: true, abortRecoveryGc: true,
};

const PUBLIC_METHODS: Record<PublicRecoveryRpcMethod, true> = {
	startRecoveryCapture: true, getRecoveryCaptureStatus: true, cancelRecoveryCapture: true, listRecoverySnapshots: true,
	authorizeRecoverySnapshotRead: true, deleteRecoverySnapshot: true, startRecoveryRestore: true,
	getRecoveryRestoreStatus: true, listRecoveryRestoreItems: true, getRecoveryRestoreItemContent: true,
	recordRecoveryRestoreResults: true, cancelRecoveryRestore: true, applyRecoveryRetention: true, startRecoveryGc: true,
	getRecoveryStatus: true,
};

function response(envelope: RecoveryRpcResponse, status = 200): Response {
	const body = JSON.stringify(envelope);
	if (new TextEncoder().encode(body).byteLength > RECOVERY_RPC_MAX_JSON_BYTES) {
		return Response.json(
			{ ok: false, error: { code: "recovery_rpc_failed", message: "recovery RPC response too large" } },
			{ status: 413, headers: { "cache-control": "no-store" } },
		);
	}
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}

async function readEnvelope(request: Request): Promise<RecoveryRpcRequest> {
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
		throw new Error("JSON required");
	}
	const bytes = await readBoundedBytes(request, RECOVERY_RPC_MAX_JSON_BYTES);
	const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
		|| Object.keys(decoded).length !== 2 || !("method" in decoded) || !("params" in decoded)
		|| typeof decoded.method !== "string" || decoded.method.length === 0 || decoded.method.length > 128) {
		throw new Error("invalid recovery RPC envelope");
	}
	return { method: decoded.method, params: decodeRecoveryRpcPayload(decoded.params) };
}

function authorizedGeneration(request: Request, vaultId: string, store: RecoveryRpcStorePort): boolean {
	const metadata = store.vaultMetadata();
	return metadata !== null
		&& metadata.vaultId === vaultId
		&& request.headers.get("x-yaos-vault-generation") === metadata.vaultGeneration;
}

function admittedMethod(internal: boolean, method: string): method is RecoveryRpcMethod {
	return Object.prototype.hasOwnProperty.call(internal ? INTERNAL_METHODS : PUBLIC_METHODS, method);
}

function requireObjectParams(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid recovery RPC parameters");
	return Object.fromEntries(Object.entries(value));
}

function requireStringParams(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("invalid recovery RPC parameters");
	return value;
}

async function invokeSelected(method: object | undefined, receiver: RecoveryRpcServicePort, params: unknown): Promise<unknown> {
	if (typeof method !== "function") throw new Error("recovery method unavailable");
	const result: unknown = Reflect.apply(method, receiver, [params]);
	return await Promise.resolve(result);
}

function dispatchRecoveryRpc(
	service: RecoveryRpcServicePort,
	method: RecoveryRpcMethod,
	params: unknown,
): Promise<unknown> {
	const objectParams = method === "releaseMaterializationLease" ? null : requireObjectParams(params);
	switch (method) {
		case "checkRecoveryJobLease": return invokeSelected(service.checkRecoveryJobLease, service, objectParams);
		case "getCapturePlanPage": return invokeSelected(service.getCapturePlanPage, service, objectParams);
		case "getRecipeDescriptors": return invokeSelected(service.getRecipeDescriptors, service, objectParams);
		case "getRecipeChunk": return invokeSelected(service.getRecipeChunk, service, objectParams);
		case "acquireMaterializationLease": return invokeSelected(service.acquireMaterializationLease, service, objectParams);
		case "releaseMaterializationLease": return invokeSelected(service.releaseMaterializationLease, service, requireStringParams(params));
		case "acknowledgeContentMaterialized": return invokeSelected(service.acknowledgeContentMaterialized, service, objectParams);
		case "acknowledgeManifestNodeMaterialized": return invokeSelected(service.acknowledgeManifestNodeMaterialized, service, objectParams);
		case "acknowledgeManifestNodesMaterialized": return invokeSelected(service.acknowledgeManifestNodesMaterialized, service, objectParams);
		case "checkRecoveryCoverage": return invokeSelected(service.checkRecoveryCoverage, service, objectParams);
		case "getIncrementalBase": return invokeSelected(service.getIncrementalBase, service, objectParams);
		case "getCatalogDeltaPage": return invokeSelected(service.getCatalogDeltaPage, service, objectParams);
		case "resetCaptureDelta": return invokeSelected(service.resetCaptureDelta, service, objectParams);
		case "recordRecoveryDefects": return invokeSelected(service.recordRecoveryDefects, service, objectParams);
		case "finalizeCapture": return invokeSelected(service.finalizeCapture, service, objectParams);
		case "acknowledgeJobCancelled": return invokeSelected(service.acknowledgeJobCancelled, service, objectParams);
		case "getProjectionWorkPage": return invokeSelected(service.getProjectionWorkPage, service, objectParams);
		case "getProjectionRecipeDescriptor": return invokeSelected(service.getProjectionRecipeDescriptor, service, objectParams);
		case "getProjectionRecipeChunk": return invokeSelected(service.getProjectionRecipeChunk, service, objectParams);
		case "acknowledgeProjectionContentMaterialized": return invokeSelected(service.acknowledgeProjectionContentMaterialized, service, objectParams);
		case "validateRestoreAuthority": return invokeSelected(service.validateRestoreAuthority, service, objectParams);
		case "completeRestore": return invokeSelected(service.completeRestore, service, objectParams);
		case "getGcRootPage": return invokeSelected(service.getGcRootPage, service, objectParams);
		case "completeGcMark": return invokeSelected(service.completeGcMark, service, objectParams);
		case "acquireSweepLease": return invokeSelected(service.acquireSweepLease, service, objectParams);
		case "releaseSweepLease": return invokeSelected(service.releaseSweepLease, service, objectParams);
		case "invalidateSweptObjects": return invokeSelected(service.invalidateSweptObjects, service, objectParams);
		case "completeGcSweep": return invokeSelected(service.completeGcSweep, service, objectParams);
		case "abortRecoveryGc": return invokeSelected(service.abortRecoveryGc, service, objectParams);
		case "startRecoveryCapture": return invokeSelected(service.startRecoveryCapture, service, objectParams);
		case "getRecoveryCaptureStatus": return invokeSelected(service.getRecoveryCaptureStatus, service, objectParams);
		case "cancelRecoveryCapture": return invokeSelected(service.cancelRecoveryCapture, service, objectParams);
		case "listRecoverySnapshots": return invokeSelected(service.listRecoverySnapshots, service, objectParams);
		case "authorizeRecoverySnapshotRead": return invokeSelected(service.authorizeRecoverySnapshotRead, service, objectParams);
		case "deleteRecoverySnapshot": return invokeSelected(service.deleteRecoverySnapshot, service, objectParams);
		case "startRecoveryRestore": return invokeSelected(service.startRecoveryRestore, service, objectParams);
		case "getRecoveryRestoreStatus": return invokeSelected(service.getRecoveryRestoreStatus, service, objectParams);
		case "listRecoveryRestoreItems": return invokeSelected(service.listRecoveryRestoreItems, service, objectParams);
		case "getRecoveryRestoreItemContent": return invokeSelected(service.getRecoveryRestoreItemContent, service, objectParams);
		case "recordRecoveryRestoreResults": return invokeSelected(service.recordRecoveryRestoreResults, service, objectParams);
		case "cancelRecoveryRestore": return invokeSelected(service.cancelRecoveryRestore, service, objectParams);
		case "applyRecoveryRetention": return invokeSelected(service.applyRecoveryRetention, service, objectParams);
		case "startRecoveryGc": return invokeSelected(service.startRecoveryGc, service, objectParams);
		case "getRecoveryStatus": return invokeSelected(service.getRecoveryStatus, service, objectParams);
	}
}

export async function handleVaultRecoveryRpc(
	request: Request,
	vaultId: string,
	store: RecoveryRpcStorePort,
	service: RecoveryRpcServicePort,
): Promise<Response | null> {
	const url = new URL(request.url);
	const internal = url.pathname === RECOVERY_RPC_PATH;
	const publicRpc = url.pathname === RECOVERY_PUBLIC_RPC_PATH;
	if (!internal && !publicRpc) return null;
	const expectedHeader = internal ? RECOVERY_RPC_HEADER : RECOVERY_PUBLIC_RPC_HEADER;
	if (request.method !== "POST" || request.headers.get(expectedHeader) !== "1"
		|| !authorizedGeneration(request, vaultId, store)) {
		return response({ ok: false, error: { code: "recovery_rpc_failed", message: "not found" } }, 404);
	}
	let envelope: RecoveryRpcRequest;
	try {
		envelope = await readEnvelope(request);
	} catch (error) {
		const status = error instanceof BoundedBodyError && error.kind === "body_too_large" ? 413 : 400;
		return response({
			ok: false,
			error: { code: "recovery_rpc_failed", message: error instanceof Error ? error.message : String(error) },
		}, status);
	}
	if (!admittedMethod(internal, envelope.method)) {
		return response({ ok: false, error: { code: "recovery_rpc_failed", message: "method not found" } }, 404);
	}
	try {
		const result = await dispatchRecoveryRpc(service, envelope.method, envelope.params);
		if (result instanceof Response) return result;
		return response({ ok: true, result: encodeRecoveryRpcPayload(result ?? null) });
	} catch (error) {
		return response({
			ok: false,
			error: { code: "recovery_rpc_failed", message: error instanceof Error ? error.message : String(error) },
		}, 409);
	}
}
