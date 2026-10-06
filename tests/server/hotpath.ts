// T-HOTPATH (DECISIONS D2, §7): the seven device paths (feed, read, checkpoint, ticket, socket, enroll, pairing-code)
// make zero config-DO calls. Each request goes through the real Router with a config namespace that records every
// property access, and reaches a real VaultHost on SQLite through a fake vault namespace.
//
// P2 extends this table: when ticket, socket, enroll and pairing-code get their behaviour, update `status` (and the
// request bodies) here; the config-DO assertion stays as is.
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

interface HotPath {
	name: string;
	request(vaultId: string, device: DeviceSeed): Request;
	/** The status the vault DO answers today. 501: the behaviour lands in P2 (DECISIONS §9). */
	status: number;
}

const ORIGIN = "https://yaos.test";
const PAIRING_CODE_SECRET = "A".repeat(32);

const HOT_PATHS: HotPath[] = [
	{ name: "feed", status: 200,
		request: (id, device) => new Request(`${ORIGIN}/vault/${id}/streams/feed?after=0`, { headers: bearer(device) }) },
	{ name: "read", status: 200,
		request: (id, device) => new Request(`${ORIGIN}/vault/${id}/streams/read?stream=ns&after=0`, { headers: bearer(device) }) },
	{ name: "checkpoint", status: 200,
		request: (id, device) => new Request(`${ORIGIN}/vault/${id}/streams/checkpoint?stream=ns&coversSeq=1&expectedCoversSeq=0`, {
			method: "PUT", headers: { ...bearer(device), "Content-Type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3]),
		}) },
	{ name: "ticket", status: 501,
		request: (id, device) => new Request(`${ORIGIN}/vault/${id}/auth/ticket`, {
			method: "POST", headers: { ...bearer(device), "Content-Type": "application/json" },
			body: JSON.stringify({ purpose: "streams" }),
		}) },
	{ name: "socket", status: 501,
		request: (id) => new Request(`${ORIGIN}/vault/${id}/ws/streams?streamsVersion=1&ticket=t`,
			{ headers: { Upgrade: "websocket" } }) },
	{ name: "enroll", status: 501,
		request: (id, device) => new Request(`${ORIGIN}/enroll`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pairingCode: `${id}.${PAIRING_CODE_SECRET}`, enrollmentRequestId: "enroll-request-0001",
				deviceId: "new-device-000001", deviceToken: device.token, deviceName: "New device" }),
		}) },
	{ name: "pairing-code", status: 501,
		request: (id, device) => new Request(`${ORIGIN}/vault/${id}/auth/pairing-code`, {
			method: "POST", headers: { ...bearer(device), "Content-Type": "application/json" }, body: "{}",
		}) },
];

s.test("T-HOTPATH: the seven device paths reach only their vault DO; zero config-DO accesses", async () => {
	const cluster = new VaultCluster();
	try {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const vault = await cluster.seed(vaultId, [owner]);
		appendCommitted(vault, owner.deviceId, "ns", "frame-1", new Uint8Array([9]));
		const config = recordingConfigNamespace({ claimed: true });
		const env = { YAOS_VAULT: cluster.namespace(), YAOS_CONFIG: config.namespace } as WorkerEnv;
		const router = new Router({ upgrades: new RecordingUpgrades() });
		assert.equal(HOT_PATHS.length, 7);
		for (const path of HOT_PATHS) {
			const before = cluster.fetches.length;
			const response = await router.fetch(path.request(vaultId, owner), env);
			assert.equal(response.status, path.status, `${path.name}: status`);
			assert.deepEqual(cluster.fetches.slice(before).map((call) => call.name), [vaultId],
				`${path.name}: exactly one vault-DO call`);
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
