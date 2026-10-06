// D8a reset-streams, D8c `epoch=`, O9 (a daily-limit failure on an operator RPC is a typed `cf_daily_limit`) and the
// H3 debug route, through the real Router, config host and vault hosts on Node SQLite.
import assert from "node:assert/strict";

import { CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE } from "../../server/src/dailyLimit";
import { blobKey } from "../../server/src/router";
import { encodeAppendFrame } from "../../server/src/streams/protocol";
import { suite } from "../harness.ts";
import { appendCommitted, newDevice, type DeviceSeed, type FakeSocket, type VaultObject } from "./helpers/workerHarness.ts";
import {
	claim,
	deviceFeed,
	deviceFetch,
	enrollVia,
	json,
	ownerCode,
	resetRows,
	rows,
	withWorld,
	type World,
} from "./helpers/operatorWorld.ts";

const s = suite("reset");

const ADDRESS = "c".repeat(64);
const EPOCH_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function tableCounts(vault: VaultObject): { heads: number; segments: number; checkpoints: number } {
	const count = (table: string) => vault.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
	return { heads: count("stream_head"), segments: count("stream_segment"), checkpoints: count("stream_checkpoint") };
}

function checkpoint(world: World, vaultId: string, device: DeviceSeed, query: string, body = new Uint8Array([5, 5])):
	Promise<Response> {
	return deviceFetch(world, vaultId, device, `streams/checkpoint?${query}`,
		{ method: "PUT", body, headers: { "Content-Type": "application/octet-stream" } });
}

function reset(world: World, cookie: string, vaultId: string, body: unknown = { confirmVaultId: vaultId }): Promise<Response> {
	return world.fetch(`/operator/vaults/${vaultId}/reset-streams`, { method: "POST", cookie, json: body });
}

/** One more append on an open streams socket, flushed (H6 caps sockets per device, so the fixture reuses one). */
function commit(vault: VaultObject, socket: FakeSocket, stream: string, clientFrameId: string, payload: Uint8Array): void {
	const frame = encodeAppendFrame({ stream, clientFrameId, payload });
	vault.host.webSocketMessage(socket, frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
	vault.host.relay.flush("forced");
}

async function dailyLimited(response: Response, label: string): Promise<void> {
	assert.equal(response.status, 503, label);
	assert.equal((await json(response)).error, "cf_daily_limit", label);
	assert.ok(Number(response.headers.get("Retry-After")) >= 1, `${label}: Retry-After`);
}

/** A claimed vault with one enrolled device, five committed frames on two streams (sealed segments included), a
 * checkpoint and a blob. */
async function populated(world: World) {
	const claimed = await claim(world);
	const laptop = newDevice("laptop-device-0001");
	await enrollVia(world, claimed.pairingCode, laptop);
	const socket = appendCommitted(claimed.vault, laptop.deviceId, "ns", "frame-1", new Uint8Array([1]));
	commit(claimed.vault, socket, "ns", "frame-2", new Uint8Array([2]));
	commit(claimed.vault, socket, "other", "frame-3", new Uint8Array([3]));
	commit(claimed.vault, socket, "other", "frame-4", new Uint8Array(70_000).fill(4));
	commit(claimed.vault, socket, "other", "frame-5", new Uint8Array(70_000).fill(5));
	assert.equal((await checkpoint(world, claimed.vaultId, laptop, "stream=ns&coversSeq=2&expectedCoversSeq=0")).status, 200);
	world.bucket.objects.set(blobKey(claimed.vaultId, ADDRESS), new Uint8Array([9]));
	const feed = await json(await deviceFeed(world, claimed.vaultId, laptop));
	assert.equal(feed.head, 5);
	return { ...claimed, laptop, socket, epoch: feed.vaultEpoch as string };
}

// ---- D8a --------------------------------------------------------------------------------------------------------

s.test("T-RESET (WB): confirmation; ONE transaction of H+S+C+1 rows; devices, codes and blobs kept; sockets 1001", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault, laptop, socket, epoch } = await populated(world);
		const code = await json(await ownerCode(world, cookie, vaultId));
		const other = (await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "B" } })))
			.vault as { vaultId: string };

		for (const body of [{}, { confirmVaultId: other.vaultId }, { confirmVaultId: vaultId.toUpperCase() },
			{ confirmVaultId: 42 }, [vaultId], "x"]) {
			const refused = await reset(world, cookie, vaultId, body);
			assert.deepEqual([refused.status, await json(refused)], [400, { error: "confirmation_mismatch" }], JSON.stringify(body));
		}
		assert.equal(socket.closed, null, "a mismatch resets nothing");
		assert.equal((await json(await deviceFeed(world, vaultId, laptop))).vaultEpoch, epoch);

		const counts = tableCounts(vault);
		assert.ok(counts.heads === 2 && counts.segments > 0 && counts.checkpoints > 0, JSON.stringify(counts));
		resetRows(world);
		const transactions = vault.transactions.count;
		const response = await reset(world, cookie, vaultId);
		assert.equal(response.status, 200);
		const body = await json(response);
		assert.deepEqual(Object.keys(body), ["vaultEpoch"]);
		const vaultEpoch = body.vaultEpoch as string;
		assert.match(vaultEpoch, EPOCH_PATTERN);
		assert.notEqual(vaultEpoch, epoch);
		assert.equal(vault.transactions.count - transactions, 1, "ONE transactionSync");
		assert.deepEqual(rows(world, vault), { config: 0, vault: counts.heads + counts.segments + counts.checkpoints + 1 },
			"§6.2 reset = H+S+C+1 vault rows, 0 config rows");
		assert.deepEqual(tableCounts(vault), { heads: 0, segments: 0, checkpoints: 0 });
		assert.deepEqual(socket.closed, { code: 1001, reason: "streams reset" });

		const feed = await deviceFeed(world, vaultId, laptop);
		assert.equal(feed.status, 200, "the device stays enrolled");
		assert.deepEqual(await json(feed), { vaultEpoch, head: 0, changes: [], nextAfter: null });
		const read = await json(await deviceFetch(world, vaultId, laptop, "streams/read?stream=ns&after=0"));
		assert.deepEqual([read.lastSeq, read.checkpoint, read.rows], [0, null, []]);
		const stale = await deviceFetch(world, vaultId, laptop, `streams/feed?epoch=${epoch}`);
		assert.deepEqual([stale.status, await json(stale)], [409, { error: "vault_generation_mismatch", vaultEpoch }]);

		appendCommitted(vault, laptop.deviceId, "ns", "frame-1", new Uint8Array([7]));
		const after = await json(await deviceFetch(world, vaultId, laptop, "streams/read?stream=ns&after=0"));
		assert.deepEqual((after.rows as Array<{ seq: number }>).map((row) => row.seq), [1], "seqs restart at 1");

		const ticket = await deviceFetch(world, vaultId, laptop, "auth/ticket",
			{ method: "POST", body: JSON.stringify({ purpose: "streams" }), headers: { "Content-Type": "application/json" } });
		assert.equal(ticket.status, 200, "the ticket key stays");
		const devices = await json(await world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie }));
		assert.deepEqual((devices.devices as Array<{ deviceId: string }>).map((device) => device.deviceId), [laptop.deviceId]);
		assert.equal((await enrollVia(world, code.pairingCode as string, newDevice("phone-device-00001"))).vaultGeneration,
			vaultEpoch, "a pairing code minted before the reset still enrolls, at the new epoch");
		assert.deepEqual([...world.bucket.objects.keys()], [blobKey(vaultId, ADDRESS)], "blobs are kept");
		assert.equal((await deviceFetch(world, vaultId, laptop, `blobs/${ADDRESS}`)).status, 200);

		const unregistered = await world.fetch("/operator/vaults/AAAAAAAAAAAAAAAAAAAAAA/reset-streams",
			{ method: "POST", cookie, json: { confirmVaultId: "AAAAAAAAAAAAAAAAAAAAAA" } });
		assert.deepEqual([unregistered.status, await json(unregistered)], [404, { error: "unknown_vault" }]);
	});
});

s.test("D8a daily limit: a failure inside the transaction rolls it back → 503 cf_daily_limit, nothing changed", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault, laptop, socket, epoch } = await populated(world);
		const counts = tableCounts(vault);
		// The limit hits the last statement of the transaction, after the three DELETEs ran.
		const exec = vault.model.exec.bind(vault.model);
		const statements: string[] = [];
		vault.model.exec = ((query: string, ...bindings: unknown[]) => {
			statements.push(query);
			if (query.startsWith("UPDATE vault_meta")) throw new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE);
			return exec(query, ...bindings);
		}) as typeof vault.model.exec;
		await dailyLimited(await reset(world, cookie, vaultId), "reset");
		vault.model.exec = exec;
		assert.ok(statements.some((query) => query.startsWith("DELETE FROM stream_segment")), "the DELETEs ran first");
		assert.deepEqual(tableCounts(vault), counts, "rolled back");
		assert.equal(socket.closed, null, "no socket closed");
		vault.host.latch.clear();
		const feed = await json(await deviceFeed(world, vaultId, laptop));
		assert.deepEqual([feed.vaultEpoch, feed.head], [epoch, 5], "the epoch and head are unchanged");

		vault.host.latch.simulate(true);
		await dailyLimited(await reset(world, cookie, vaultId), "simulated reset");
		vault.host.latch.simulate(false);
		assert.deepEqual(tableCounts(vault), counts);
		assert.equal((await reset(world, cookie, vaultId)).status, 200, "the reset works once the limit lifts");
	});
});

// ---- O9 ---------------------------------------------------------------------------------------------------------

s.test("O9: a daily-limit failure on any operator RPC (vault or config DO) is 503 cf_daily_limit with Retry-After", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault, laptop } = await populated(world);
		vault.host.latch.simulate(true);
		await dailyLimited(await world.fetch(`/operator/vaults/${vaultId}/devices/${laptop.deviceId}`,
			{ method: "DELETE", cookie }), "revoke");
		await dailyLimited(await ownerCode(world, cookie, vaultId), "owner-code");
		await dailyLimited(await reset(world, cookie, vaultId), "reset-streams");
		await dailyLimited(await world.fetch(`/operator/vaults/${vaultId}`,
			{ method: "DELETE", cookie, json: { confirmVaultId: vaultId } }), "delete vault");
		vault.host.latch.simulate(false);
		assert.equal((await deviceFeed(world, vaultId, laptop)).status, 200, "nothing was revoked or wiped");
		const listed = (await json(await world.fetch("/operator/state", { cookie }))).vaults as Array<{ vaultId: string }>;
		assert.ok(listed.some((entry) => entry.vaultId === vaultId), "the registry row stays");

		const exec = world.config.model.exec.bind(world.config.model);
		world.config.model.exec = ((query: string, ...bindings: unknown[]) => {
			if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) throw new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE);
			return exec(query, ...bindings);
		}) as typeof world.config.model.exec;
		await dailyLimited(await world.fetch("/operator/login", { method: "POST",
			json: { operatorRecoveryKey: `recovery-${"k".repeat(40)}` } }), "login");
		await dailyLimited(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "C" } }), "create vault");
		await dailyLimited(await world.fetch(`/operator/vaults/${vaultId}/restore`,
			{ method: "POST", cookie, json: { at: new Date(world.config.clock.now - 1000).toISOString() } }), "restore");
		world.config.model.exec = exec;
		assert.deepEqual((await json(await world.fetch("/operator/state", { cookie }))).pendingRestores, [],
			"a restore refused at step 0 leaves no journal row");
	});
});

// ---- D8c --------------------------------------------------------------------------------------------------------

s.test("D8c: epoch= on feed, read and checkpoint, checked right after bearer auth; mismatch (empty too) → 409", async () => {
	await withWorld(async (world) => {
		const { vaultId, vault, laptop, epoch } = await populated(world);
		const mismatch = { error: "vault_generation_mismatch", vaultEpoch: epoch };
		for (const path of ["streams/feed", "streams/read?stream=ns"]) {
			const sep = path.includes("?") ? "&" : "?";
			assert.equal((await deviceFetch(world, vaultId, laptop, path)).status, 200, `${path}: absent`);
			assert.equal((await deviceFetch(world, vaultId, laptop, `${path}${sep}epoch=${epoch}`)).status, 200, `${path}: match`);
			for (const wrong of ["", "x", `${epoch}x`, epoch.toLowerCase() === epoch ? "Z" : epoch.toLowerCase()]) {
				const response = await deviceFetch(world, vaultId, laptop, `${path}${sep}epoch=${encodeURIComponent(wrong)}`);
				assert.deepEqual([response.status, await json(response)], [409, mismatch], `${path}: epoch=${wrong}`);
			}
		}
		const bare = await deviceFetch(world, vaultId, laptop, "streams/feed?epoch");
		assert.deepEqual([bare.status, await json(bare)], [409, mismatch], "a bare epoch is the empty value");

		// Before any other validation: bad cursors, a missing stream and bad checkpoint parameters still get the 409.
		for (const path of ["streams/feed?after=-1&epoch=x", "streams/read?epoch=x", "streams/read?stream=&after=z&epoch=x"]) {
			const response = await deviceFetch(world, vaultId, laptop, path);
			assert.deepEqual([response.status, await json(response)], [409, mismatch], path);
		}
		// After bearer auth: a stranger gets 401 whatever the epoch.
		const stranger = newDevice("stranger-device-01");
		assert.equal((await deviceFetch(world, vaultId, stranger, "streams/feed?epoch=x")).status, 401);
		assert.equal((await deviceFetch(world, vaultId, stranger, `streams/feed?epoch=${epoch}`)).status, 401);

		// A checkpoint with a stale epoch writes nothing.
		const counts = tableCounts(vault);
		resetRows(world);
		for (const query of ["stream=other&coversSeq=3&expectedCoversSeq=0&epoch=x", "coversSeq=0&epoch=",
			"stream=other&coversSeq=3&expectedCoversSeq=0&epoch"]) {
			const response = await checkpoint(world, vaultId, laptop, query);
			assert.deepEqual([response.status, await json(response)], [409, mismatch], query);
		}
		assert.deepEqual(rows(world, vault), { config: 0, vault: 0 });
		assert.deepEqual(tableCounts(vault), counts);
		const ok = await checkpoint(world, vaultId, laptop, `stream=other&coversSeq=3&expectedCoversSeq=0&epoch=${epoch}`);
		assert.equal(ok.status, 200, "a matching epoch writes");
		// Not on other device routes.
		assert.equal((await deviceFetch(world, vaultId, laptop, "auth/ticket?epoch=x", { method: "POST",
			body: JSON.stringify({ purpose: "streams" }), headers: { "Content-Type": "application/json" } })).status, 200);
	});
});

// ---- H3 debug route -----------------------------------------------------------------------------------------------

s.test("H3: the debug route (YAOS_DEBUG_ROUTES=1, bearer) drives latch.simulate; writes 503, reads stay", async () => {
	await withWorld(async (world) => {
		const { vaultId, vault, laptop } = await populated(world);
		const simulate = (enabled: unknown, device: DeviceSeed = laptop) => deviceFetch(world, vaultId, device,
			"debug/simulate-daily-limit", { method: "POST", body: JSON.stringify({ enabled }),
				headers: { "Content-Type": "application/json" } });
		assert.equal((await simulate(true, newDevice("stranger-device-01"))).status, 401);
		const bad = await simulate("yes");
		assert.deepEqual([bad.status, await json(bad)], [400, { error: "invalid_request" }]);
		const on = await simulate(true);
		assert.deepEqual([on.status, await json(on)], [200, { ok: true, enabled: true }]);
		assert.equal(vault.host.latch.simulating(), true);
		await dailyLimited(await checkpoint(world, vaultId, laptop, "stream=other&coversSeq=3&expectedCoversSeq=0"), "checkpoint");
		assert.equal((await deviceFeed(world, vaultId, laptop)).status, 200, "reads are never blocked");
		const off = await simulate(false);
		assert.deepEqual([off.status, await json(off)], [200, { ok: true, enabled: false }]);
		assert.equal((await checkpoint(world, vaultId, laptop, "stream=other&coversSeq=3&expectedCoversSeq=0")).status, 200);
	}, { debugRoutes: true });
});

await s.done();
