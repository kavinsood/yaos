import * as Y from "yjs";
import { VaultStore } from "../../server/src/vaultStore";
import { actorHeaders } from "../../server/src/vaultAuthority";
import type { VaultActorContext } from "../../server/src/collaboration";
import type { VaultRuntime, VaultRuntimeOptions } from "../../server/src/server";
import type { VaultRuntimeStoragePort } from "../../server/src/platformPorts";

export async function bootstrapRoutesContract(
	storage: VaultRuntimeStoragePort,
	Runtime: new (options: VaultRuntimeOptions) => VaultRuntime,
): Promise<string[]> {
	const vaultId = "vault-g7-routes";
	const vaultGeneration = "generation-g7-routes";
	const store = new VaultStore(storage);
	const root = new Y.Doc({ guid: "root" });
	root.getMap("sys").set("schemaVersion", 8);
	store.provisionVault(vaultId, vaultGeneration, Y.encodeStateAsUpdate(root));
	root.destroy();
	const actor = (deviceId: string): VaultActorContext => ({ vaultId, vaultGeneration, principalId: "principal-g7",
		membershipRevision: 1, deviceId, deviceCredentialRevision: 1, role: "owner", policyVersion: 1, capabilityDigest: "g7-digest" });
	store.installAuthorityFence({ changeId: "g7-authority", vaultId, vaultGeneration, subjectDigest: "g7-digest", subjects: [
		{ principalId: "principal-g7", role: "owner", state: "active", membershipRevision: 1, policyVersion: 1,
			capabilityDigest: "g7-digest", displayName: "G7", colorSeed: "g7" },
		...["device-g7-a", "device-g7-b"].map((deviceId) => ({ deviceId, principalId: "principal-g7", state: "active" as const, credentialRevision: 1 })),
	] });
	const server = new Runtime({ storage,
		sockets: { sockets: () => [], createPair: () => { throw new Error("unexpected socket pair"); }, accept: () => {},
			upgradeResponse: () => { throw new Error("unexpected upgrade"); } },
		alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} }, execution: { waitUntil: () => {} },
	});
	const request = async (deviceId: string, path: string, body?: Record<string, unknown>) => {
		const headers = actorHeaders(actor(deviceId));
		headers.set("x-yaos-vault-id", vaultId);
		headers.set("x-yaos-vault-generation", vaultGeneration);
		return server.fetch(new Request(`https://g7.invalid${path}`, { headers,
			...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
		}));
	};
	const start = async (deviceId: string) => {
		const response = await request(deviceId, "/bootstrap/start", {});
		if (response.status !== 200) throw new Error(`start failed: ${response.status} ${await response.text()}`);
		return (await response.json() as { bootstrapId: string }).bootstrapId;
	};
	const [left, right] = await Promise.all([start("device-g7-a"), start("device-g7-b")]);
	if (left === right) throw new Error("runtime routes shared a bootstrap across devices");
	const sameDeviceStarts = await Promise.all(["new-attempt-g7-a", "new-attempt-g7-b"].map(async (attemptId) => {
		const response = await request("device-g7-a", "/bootstrap/start", { attemptId });
		if (response.status !== 200) throw new Error(`same-device start failed: ${response.status}`);
		return (await response.json() as { bootstrapId: string }).bootstrapId;
	}));
	if (sameDeviceStarts.some((id) => id !== left) || store.activePins().length !== 2) {
		throw new Error("same-device fresh HTTP attempts must reuse the existing operation without another pin");
	}
	const endpoints = (id: string): Array<[string, Record<string, unknown>?]> => [
		["/bootstrap/start", { attemptId: id, resume: true }], [`/bootstrap/${id}/root`], [`/bootstrap/${id}/catalog`],
		[`/bootstrap/${id}/semantic-catalog`], [`/bootstrap/${id}/body/body`], [`/bootstrap/${id}/semantic/canvas`],
		[`/bootstrap/${id}/bodies`, { bodyIds: ["body"] }], [`/bootstrap/${id}/renew`, { settledBodies: 0 }],
		[`/bootstrap/${id}/complete`, {}],
	];
	const matrix = async (deviceId: string, id: string, expectedStatus: number, reason: string) => {
		for (const [path, body] of endpoints(id)) {
			const response = await request(deviceId, path, body);
			const result = await response.json() as { error?: string; reason?: string };
			const code = expectedStatus === 403 ? "bootstrap_owner_mismatch" : "bootstrap_not_running";
			if (response.status !== expectedStatus || result.error !== code || result.reason !== reason) {
				throw new Error(`${path}: expected ${expectedStatus}/${reason}, got ${response.status}/${JSON.stringify(result)}`);
			}
		}
	};
	await matrix("device-g7-b", left, 403, "owner_mismatch");
	const foreignStart = await request("device-g7-b", "/bootstrap/start", { attemptId: left });
	if (foreignStart.status !== 403) throw new Error("fresh start using a foreign known ID must reject before own-operation fallback");
	await matrix("device-g7-a", "unknown-g7", 409, "unknown");
	await matrix("device-g7-a", "unknown%20g7", 409, "unknown");
	const completion = await request("device-g7-b", `/bootstrap/${right}/complete`, {});
	if (completion.status !== 200) throw new Error("first completion failed");
	const catalog = await request("device-g7-a", `/bootstrap/${left}/catalog`);
	if (catalog.status !== 200) throw new Error("one device completion wedged the other");
	await matrix("device-g7-b", right, 409, "complete");
	await start("device-g7-b");
	const completedStart = await request("device-g7-b", "/bootstrap/start", { attemptId: right });
	const completedError = await completedStart.json() as { error?: string; reason?: string };
	if (completedStart.status !== 409 || completedError.error !== "bootstrap_not_running" || completedError.reason !== "complete") {
		throw new Error("fresh start using a known completed ID must reject despite another own running operation");
	}
	storage.sql.exec("UPDATE vault_history_pins SET soft_expires_at = 0 WHERE pin_id = ?", left).toArray();
	await matrix("device-g7-a", left, 409, "expired");
	return ["concurrent authenticated route starts and independent completion", "9-route ownership/unknown/complete/expired matrices"];
}
