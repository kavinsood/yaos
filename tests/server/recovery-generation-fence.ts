import {
	handleVaultRecoveryRpc,
	type RecoveryRpcServicePort,
	type RecoveryRpcStorePort,
} from "../../server/src/recoveryRpcRouter";
import { ActorRecoveryRouteAuthority } from "../../server/src/recoveryPublicAuthority";
import {
	RECOVERY_PUBLIC_RPC_HEADER,
	RECOVERY_PUBLIC_RPC_PATH,
	RECOVERY_RPC_HEADER,
	RECOVERY_RPC_PATH,
} from "../../server/src/recoveryProtocol";
import {
	ACTOR_CAPABILITY_DIGEST_HEADER,
	ACTOR_DEVICE_HEADER,
	ACTOR_DEVICE_NAME_HEADER,
	ACTOR_DEVICE_REVISION_HEADER,
	ACTOR_MEMBERSHIP_REVISION_HEADER,
	ACTOR_POLICY_VERSION_HEADER,
	ACTOR_PRINCIPAL_HEADER,
	ACTOR_ROLE_HEADER,
} from "../../server/src/vaultAuthority";
import { suite } from "../harness.ts";

const s = suite("recovery-generation-fence");
const vaultId = "vault-fence-aa";
const vaultGeneration = "generation-fence-aa";

const internalMethods = [
	"checkRecoveryJobLease", "getCapturePlanPage", "getRecipeDescriptors", "getRecipeChunk",
	"acquireMaterializationLease", "releaseMaterializationLease", "acknowledgeContentMaterialized",
	"acknowledgeManifestNodeMaterialized", "acknowledgeManifestNodesMaterialized", "checkRecoveryCoverage",
	"getIncrementalBase", "getCatalogDeltaPage", "resetCaptureDelta", "recordRecoveryDefects",
	"finalizeCapture", "acknowledgeJobCancelled", "getProjectionWorkPage", "getProjectionRecipeDescriptor",
	"getProjectionRecipeChunk", "acknowledgeProjectionContentMaterialized", "validateRestoreAuthority",
	"completeRestore", "getGcRootPage", "completeGcMark", "acquireSweepLease", "releaseSweepLease",
	"invalidateSweptObjects", "completeGcSweep", "abortRecoveryGc",
] as const;

const publicMethods = [
	"startRecoveryCapture", "getRecoveryCaptureStatus", "cancelRecoveryCapture", "listRecoverySnapshots",
	"authorizeRecoverySnapshotRead", "deleteRecoverySnapshot", "startRecoveryRestore", "getRecoveryRestoreStatus",
	"listRecoveryRestoreItems", "getRecoveryRestoreItemContent", "recordRecoveryRestoreResults",
	"cancelRecoveryRestore", "applyRecoveryRetention", "startRecoveryGc", "getRecoveryStatus",
] as const;

function rpcRequest(
	path: string,
	header: string,
	generation: string,
	method: string,
	params: unknown = { vaultId, vaultGeneration: generation },
): Request {
	return new Request(`https://internal${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[header]: "1",
			"x-yaos-vault-generation": generation,
		},
		body: JSON.stringify({ method, params }),
	});
}

function recoveryStore(metadata: { vaultId: string; vaultGeneration: string }): RecoveryRpcStorePort {
	return {
		vaultMetadata: () => metadata,
	};
}

s.test("every internal and public recovery RPC rejects stale generations before dispatch", async () => {
	let calls = 0;
	const service = new Proxy<RecoveryRpcServicePort>({}, {
		get: () => async () => {
			calls++;
			return null;
		},
	});
	const store = recoveryStore({ vaultId, vaultGeneration });
	for (const method of internalMethods) {
		const response = await handleVaultRecoveryRpc(
			rpcRequest(RECOVERY_RPC_PATH, RECOVERY_RPC_HEADER, "generation-stale-aa", method),
			vaultId,
			store,
			service,
		);
		if (response?.status !== 404) throw new Error(`stale internal ${method} returned ${response?.status}`);
	}
	for (const method of publicMethods) {
		const response = await handleVaultRecoveryRpc(
			rpcRequest(RECOVERY_PUBLIC_RPC_PATH, RECOVERY_PUBLIC_RPC_HEADER, "generation-stale-aa", method),
			vaultId,
			store,
			service,
		);
		if (response?.status !== 404) throw new Error(`stale public ${method} returned ${response?.status}`);
	}
	if (calls !== 0) throw new Error(`stale generation dispatched ${calls} recovery methods`);
});

s.test("projection work dispatches only with exact generation and private header", async () => {
	let calls = 0;
	let dispatchedGeneration: string | null = null;
	const service: RecoveryRpcServicePort = {
		async getProjectionWorkPage(input) {
			calls++;
			dispatchedGeneration = input.vaultGeneration;
			return { entries: [], nextCursor: null, terminal: true };
		},
	};
	const store = recoveryStore({ vaultId, vaultGeneration });
	const projectionParams = {
		vaultId,
		vaultGeneration,
		leaseId: "lease-fence-aa",
		capability: "capability-fence-aa",
		cursor: null,
		maxEntries: 10,
		maxResponseBytes: 16_384,
	};
	const wrongHeader = await handleVaultRecoveryRpc(
		rpcRequest(RECOVERY_RPC_PATH, RECOVERY_PUBLIC_RPC_HEADER, vaultGeneration, "getProjectionWorkPage", projectionParams),
		vaultId,
		store,
		service,
	);
	const accepted = await handleVaultRecoveryRpc(
		rpcRequest(RECOVERY_RPC_PATH, RECOVERY_RPC_HEADER, vaultGeneration, "getProjectionWorkPage", projectionParams),
		vaultId,
		store,
		service,
	);
	const envelope = await accepted?.json() as { ok?: boolean; result?: { terminal?: boolean } } | undefined;
	if (wrongHeader?.status !== 404 || accepted?.status !== 200 || envelope?.ok !== true
		|| envelope.result?.terminal !== true || dispatchedGeneration !== vaultGeneration || calls !== 1) {
		throw new Error("projection generation/header fence changed");
	}
});

s.test("vault identity mismatch is indistinguishable from a stale generation", async () => {
	let calls = 0;
	const service = new Proxy<RecoveryRpcServicePort>({}, {
		get: () => async () => {
			calls++;
			return null;
		},
	});
	const store = recoveryStore({ vaultId: "another-vault-aa", vaultGeneration });
	const response = await handleVaultRecoveryRpc(
		rpcRequest(RECOVERY_RPC_PATH, RECOVERY_RPC_HEADER, vaultGeneration, "checkRecoveryJobLease"),
		vaultId,
		store,
		service,
	);
	const body = await response?.json() as { error?: { message?: string } } | undefined;
	if (response?.status !== 404 || body?.error?.message !== "not found" || calls !== 0) {
		throw new Error("vault identity mismatch leaked or dispatched");
	}
});

s.test("public recovery authority forwards the exact authenticated actor", async () => {
	const calls: Array<{ actorName: string; request: Request }> = [];
	const authority = new ActorRecoveryRouteAuthority({
		async call(name, request) {
			calls.push({ actorName: name, request });
			return Response.json({ ok: true, result: null });
		},
	}, vaultId, vaultId, vaultGeneration, {
		vaultId,
		vaultGeneration,
		principalId: "owner-principal-aa",
		membershipRevision: 7,
		deviceId: "owner-device-aa",
		deviceName: "Owner laptop",
		deviceCredentialRevision: 11,
		role: "owner",
		policyVersion: 1,
		capabilityDigest: "owner-capability-digest-aa",
	});
	await authority.getRecoveryStatus({ vaultId });
	const forwarded = calls[0];
	if (!forwarded || forwarded.actorName !== vaultId) throw new Error("public recovery request was not forwarded to the exact vault actor");
	const headers = forwarded.request.headers;
	const expected = new Map([
		[ACTOR_PRINCIPAL_HEADER, "owner-principal-aa"],
		[ACTOR_MEMBERSHIP_REVISION_HEADER, "7"],
		[ACTOR_DEVICE_HEADER, "owner-device-aa"],
		[ACTOR_DEVICE_NAME_HEADER, "Owner laptop"],
		[ACTOR_DEVICE_REVISION_HEADER, "11"],
		[ACTOR_ROLE_HEADER, "owner"],
		[ACTOR_POLICY_VERSION_HEADER, "1"],
		[ACTOR_CAPABILITY_DIGEST_HEADER, "owner-capability-digest-aa"],
		["x-yaos-vault-id", vaultId],
		["x-yaos-vault-generation", vaultGeneration],
		[RECOVERY_PUBLIC_RPC_HEADER, "1"],
	]);
	for (const [name, value] of expected) {
		if (headers.get(name) !== value) throw new Error(`public recovery actor header ${name} was not exact`);
	}
	const body = await forwarded.request.json() as { method?: string };
	if (body.method !== "getRecoveryStatus") throw new Error("public recovery method changed in forwarding");
});

await s.done();
