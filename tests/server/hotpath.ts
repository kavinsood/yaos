// T-HOTPATH (DECISIONS D2, §7): the seven device paths (feed, read, checkpoint, ticket, socket, enroll, pairing-code)
// make zero config-DO calls. Each request goes through the real Router with a config namespace that records every
// property access, and reaches a real VaultHost on SQLite through a fake vault namespace.
//
// Every row is the real P2 flow: a ticket is issued, a socket opens with a real ticket, a device enrolls with a
// real code, and a device mints a pairing code.
import assert from "node:assert/strict";

import { Router, type WorkerEnv } from "../../server/src/worker";
import { suite } from "../harness.ts";
import {
	RecordingUpgrades,
	VaultCluster,
	appendCommitted,
	bearer,
	newDevice,
	newVaultId,
	recordingConfigNamespace,
	type DeviceSeed,
} from "./helpers/workerHarness.ts";

const s = suite("hotpath");

interface HotContext {
	vaultId: string;
	device: DeviceSeed;
	/** A streams ticket of `device`, issued before the loop. */
	ticket: string;
	/** An unused owner code, minted before the loop. */
	pairingCode: string;
}

interface HotPath {
	name: string;
	request(context: HotContext): Request;
	status: number;
	check?(response: Response): Promise<void> | void;
}

const ORIGIN = "https://yaos.test";

const HOT_PATHS: HotPath[] = [
	{ name: "feed", status: 200,
		request: ({ vaultId, device }) => new Request(`${ORIGIN}/vault/${vaultId}/streams/feed?after=0`, { headers: bearer(device) }) },
	{ name: "read", status: 200,
		request: ({ vaultId, device }) => new Request(`${ORIGIN}/vault/${vaultId}/streams/read?stream=ns&after=0`,
			{ headers: bearer(device) }) },
	{ name: "checkpoint", status: 200,
		request: ({ vaultId, device }) => new Request(
			`${ORIGIN}/vault/${vaultId}/streams/checkpoint?stream=ns&coversSeq=1&expectedCoversSeq=0`, {
				method: "PUT", headers: { ...bearer(device), "Content-Type": "application/octet-stream" },
				body: new Uint8Array([1, 2, 3]),
			}) },
	{ name: "ticket", status: 200,
		request: ({ vaultId, device }) => new Request(`${ORIGIN}/vault/${vaultId}/auth/ticket`, {
			method: "POST", headers: { ...bearer(device), "Content-Type": "application/json" },
			body: JSON.stringify({ purpose: "streams" }),
		}),
		async check(response) {
			const body = await response.json() as { ticket?: unknown };
			assert.equal(typeof body.ticket, "string");
		} },
	{ name: "socket", status: 200,
		request: ({ vaultId, ticket }) => new Request(
			`${ORIGIN}/vault/${vaultId}/ws/streams?streamsVersion=1&ticket=${encodeURIComponent(ticket)}`,
			{ headers: { Upgrade: "websocket" } }),
		check(response) { assert.equal(response.headers.get("X-Test-Upgrade"), "accepted", "socket: admitted"); } },
	{ name: "enroll", status: 200,
		request: ({ pairingCode }) => new Request(`${ORIGIN}/enroll`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pairingCode, enrollmentRequestId: "enroll-request-0001",
				deviceId: "new-device-000001", deviceToken: newDevice("new-device-000001").token, deviceName: "New device" }),
		}),
		async check(response) {
			assert.deepEqual(Object.keys(await response.json() as object).sort(),
				["deviceId", "deviceName", "deviceToken", "host", "vaultGeneration", "vaultId"]);
		} },
	{ name: "pairing-code", status: 200,
		request: ({ vaultId, device }) => new Request(`${ORIGIN}/vault/${vaultId}/auth/pairing-code`, {
			method: "POST", headers: { ...bearer(device), "Content-Type": "application/json" }, body: "{}",
		}),
		async check(response) {
			const body = await response.json() as { purpose?: unknown };
			assert.equal(body.purpose, "device");
		} },
];

s.test("T-HOTPATH: the seven device paths reach only their vault DO; zero config-DO accesses", async () => {
	const cluster = new VaultCluster();
	try {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const vault = await cluster.seed(vaultId, [owner]);
		appendCommitted(vault, owner.deviceId, "ns", "frame-1", new Uint8Array([9]));
		const issued = await vault.host.fetch(new Request("https://vault.internal/auth/ticket", {
			method: "POST", headers: bearer(owner), body: JSON.stringify({ purpose: "streams" }) }));
		const { ticket } = await issued.json() as { ticket: string };
		const minted = await vault.host.mintOwnerCode("owner-bootstrap");
		assert.ok(minted);
		const context: HotContext = { vaultId, device: owner, ticket, pairingCode: minted.pairingCode };
		const config = recordingConfigNamespace({ claimed: true });
		const env = { YAOS_VAULT: cluster.namespace(), YAOS_CONFIG: config.namespace } as WorkerEnv;
		const router = new Router({ upgrades: new RecordingUpgrades() });
		assert.equal(HOT_PATHS.length, 7);
		for (const path of HOT_PATHS) {
			const before = cluster.fetches.length;
			const response = await router.fetch(path.request(context), env);
			assert.equal(response.status, path.status, `${path.name}: status`);
			await path.check?.(response);
			assert.deepEqual(cluster.fetches.slice(before).map((call) => call.name), [vaultId],
				`${path.name}: exactly one vault-DO call`);
			assert.deepEqual(cluster.rpcs, [], `${path.name}: no vault-DO RPC`);
			assert.deepEqual(config.accesses, [], `${path.name}: zero config-DO accesses`);
		}
	} finally {
		cluster.close();
	}
});

s.test("T-HOTPATH control: pre-claim /api/capabilities is the path that does reach the config DO", async () => {
	const cluster = new VaultCluster();
	try {
		const config = recordingConfigNamespace({ claimed: false });
		const env = { YAOS_VAULT: cluster.namespace(), YAOS_CONFIG: config.namespace } as WorkerEnv;
		const router = new Router({ upgrades: new RecordingUpgrades() });
		const response = await router.fetch(new Request(`${ORIGIN}/api/capabilities`), env);
		assert.equal(response.status, 200);
		assert.ok(config.accesses.includes("stub.isClaimed"), "the counting stub sees the call");
		assert.equal(cluster.fetches.length, 0);
	} finally {
		cluster.close();
	}
});

await s.done();
