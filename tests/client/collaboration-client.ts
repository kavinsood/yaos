import { strict as assert } from "node:assert";
import { CollaborationClient } from "../../src/collaboration/client";
import { capabilitiesForRole } from "../../src/collaboration/authority";
import type { HttpRequester } from "../../src/utils/http";
import { suite } from "../harness.ts";

const s = suite("collaboration-client");

const transfer = {
	transferId: "transfer-one",
	fromPrincipalId: "principal-owner",
	toPrincipalId: "principal-member",
	createdAt: 100,
	expiresAt: 1_000,
};

s.test("canonical me projection carries immutable authority and relevant transfer offers", async () => {
	const request: HttpRequester = async () => ({
		status: 200,
		headers: {},
		text: "",
		arrayBuffer: new ArrayBuffer(0),
		json: {
			principal: { principalId: "principal-member", displayName: "Alice", colorSeed: "alice-seed" },
			device: { deviceId: "device-one", name: "Laptop" },
			actor: {
				vaultId: "vault-one",
				vaultGeneration: "generation-one",
				principalId: "principal-member",
				membershipRevision: 2,
				deviceId: "device-one",
				deviceCredentialRevision: 1,
				role: "member",
				policyVersion: 1,
				capabilityDigest: "digest-one",
			},
			capabilities: capabilitiesForRole("member"),
			ownershipTransfers: [transfer],
		},
	}) as never;
	const me = await new CollaborationClient("https://sync.example", "vault-one", "token", request).getMe();
	assert.equal(me.authority.principalId, "principal-member");
	assert.equal(me.ownershipTransfers[0]?.transferId, "transfer-one");
	assert.equal(Object.isFrozen(me.ownershipTransfers), true);
});

s.test("ownership offer accept and cancel use the exact public routes", async () => {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	const request: HttpRequester = async (input) => {
		calls.push({ url: input.url, method: input.method ?? "GET", body: typeof input.body === "string" ? input.body : undefined });
		const json = input.method === "POST" && input.url.endsWith("/ownership/transfers")
			? { transfer }
			: input.method === "POST" ? { pending: false } : { ok: true };
		return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json } as never;
	};
	const client = new CollaborationClient("https://sync.example", "vault-one", "token", request);
	assert.equal((await client.createOwnershipTransfer("principal-member")).transferId, "transfer-one");
	assert.equal((await client.acceptOwnershipTransfer("transfer-one", "request-one")).pending, false);
	await client.cancelOwnershipTransfer("transfer-one");
	assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [
		{ url: "https://sync.example/vault/vault-one/ownership/transfers", method: "POST" },
		{ url: "https://sync.example/vault/vault-one/ownership/transfers/transfer-one", method: "POST" },
		{ url: "https://sync.example/vault/vault-one/ownership/transfers/transfer-one", method: "DELETE" },
	]);
	assert.deepEqual(JSON.parse(calls[0]!.body ?? "{}"), { targetPrincipalId: "principal-member" });
	assert.deepEqual(JSON.parse(calls[1]!.body ?? "{}"), { requestId: "request-one" });
});

s.test("governance mutations carry stable request identities", async () => {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	const request: HttpRequester = async (input) => {
		calls.push({ url: input.url, method: input.method ?? "GET", body: typeof input.body === "string" ? input.body : undefined });
		return { status: 202, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { change: { state: "pending" } } } as never;
	};
	const client = new CollaborationClient("https://sync.example", "vault-one", "token", request);
	await client.revokeDevice("device-two", "request-device");
	await client.removeMember("principal-member", "request-member");
	assert.equal((await client.renamePrincipal("principal-owner", "Kavin", "request-profile")).pending, true);
	assert.deepEqual(calls.map(({ method, body }) => ({ method, body: JSON.parse(body ?? "{}") })), [
		{ method: "DELETE", body: { requestId: "request-device" } },
		{ method: "DELETE", body: { requestId: "request-member" } },
		{ method: "PATCH", body: { displayName: "Kavin", requestId: "request-profile" } },
	]);
});

s.test("vault governance uses the owner-only public endpoint", async () => {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	const request: HttpRequester = async (input) => {
		calls.push({ url: input.url, method: input.method ?? "GET", body: typeof input.body === "string" ? input.body : undefined });
		const kind = input.method === "PATCH" ? "vault-rename" : "vault-destroy";
		return { status: input.method === "PATCH" ? 200 : 202, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {
			governanceRequest: { governanceRequestId: `governance-${kind}`, kind, state: kind === "vault-rename" ? "complete" : "awaiting-operator-confirmation", createdAt: 100 },
		} } as never;
	};
	const client = new CollaborationClient("https://sync.example", "vault-one", "token", request);
	assert.equal((await client.renameVault("Research", "rename-request-id")).state, "complete");
	assert.equal((await client.requestVaultDestruction("destroy-request-id")).state, "awaiting-operator-confirmation");
	assert.deepEqual(calls.map((call) => ({ url: call.url, method: call.method, body: JSON.parse(call.body ?? "{}") })), [
		{ url: "https://sync.example/vault/vault-one/governance", method: "PATCH", body: { name: "Research", requestId: "rename-request-id" } },
		{ url: "https://sync.example/vault/vault-one/governance", method: "DELETE", body: { requestId: "destroy-request-id" } },
	]);
});

s.test("audit and exact committed outcomes are parsed without guessing", async () => {
	const request: HttpRequester = async (input) => {
		if (input.url.endsWith("/audit")) return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { events: [{
			eventId: "event-one", vaultId: "vault-one", kind: "member_removed", actorPrincipalId: "principal-owner",
			actorDeviceId: "device-owner", targetPrincipalId: "principal-member", targetDeviceId: null, createdAt: 10, detail: null,
		}] } } as never;
		if (input.url.includes("operation-missing")) return { status: 404, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { error: "operation_outcome_not_found" } } as never;
		return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {
			operationId: "operation-one", requestDigest: "a".repeat(64), vaultSequence: 42, committed: true,
		} } as never;
	};
	const client = new CollaborationClient("https://sync.example", "vault-one", "token", request);
	assert.equal((await client.listSecurityAudit())[0]?.kind, "member_removed");
	const authority = { requestDigest: "a".repeat(64), membershipRevision: 3, deviceCredentialRevision: 4, deviceId: "device-one" };
	assert.equal((await client.getCommittedOperationOutcome({ operationId: "operation-one", ...authority }))?.vaultSequence, 42);
	assert.equal(await client.getCommittedOperationOutcome({ operationId: "operation-missing", ...authority }), null);
});

await s.done();
