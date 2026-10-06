// D8b restore through the real Router, config host (config/restore.ts) and vault hosts on Node SQLite, with a fake
// PITR (helpers/fakePitr.ts): T-RESTORE-RESUME-WB (a crash between every pair of steps, resumed by the alarm or a
// second press, with or without a vault eviction), a write in the rewind window, the per-run rewind bound, the
// authority freeze, the 60 s flag, the error codes, "vault delete wins" and the §6.2 rows.
import assert from "node:assert/strict";

import { RESTORE_FLAG_TTL_MS } from "../../server/src/vault/host";
import { MAX_REWINDS_PER_RUN, RESTORE_WINDOW_MS, type RestoreVaultPort } from "../../server/src/config/restore";
import { encodeAppendFrame } from "../../server/src/streams/protocol";
import { blobKey } from "../../server/src/router";
import { suite } from "../harness.ts";
import { appendCommitted, crash, newDevice, type DeviceSeed, type FakeSocket, type VaultObject } from "./helpers/workerHarness.ts";
import { claim, deviceFeed, deviceFetch, enrollVia, json, ownerCode, resetRows, withWorld, type World } from "./helpers/operatorWorld.ts";

const s = suite("restore");

const PITR = { pitr: true };

interface Content {
	head: unknown;
	changes: unknown;
	rows: unknown;
}

interface Scenario {
	cookie: string;
	vaultId: string;
	vault: VaultObject;
	laptop: DeviceSeed;
	phone: DeviceSeed;
	tablet: DeviceSeed;
	/** An owner code minted before T and unused; one minted after T. */
	staleCode: string;
	lateCode: string;
	/** The restore point and its ISO form. */
	at: number;
	atIso: string;
	epochAtT: string;
	contentAtT: Content;
	codesAtT: number;
	epochBefore: string;
	contentBefore: Content;
	devicesBefore: unknown;
	/** The laptop's open streams socket at the press. */
	socket: FakeSocket;
	/** A streams ticket of the laptop issued just before the press. */
	ticket: string;
}

function advance(world: World, ms: number): void {
	world.config.clock.now += ms;
	for (const object of world.cluster.objects.values()) object.timers.advance(ms);
}

function commit(vault: VaultObject, socket: FakeSocket, stream: string, clientFrameId: string, payload: Uint8Array): void {
	const frame = encodeAppendFrame({ stream, clientFrameId, payload });
	vault.host.webSocketMessage(socket, frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
	vault.host.relay.flush("forced");
}

async function content(world: World, vaultId: string, device: DeviceSeed): Promise<Content> {
	const feed = await json(await deviceFeed(world, vaultId, device));
	const read = await json(await deviceFetch(world, vaultId, device, "streams/read?stream=ns&after=0"));
	return { head: feed.head, changes: feed.changes, rows: read.rows };
}

async function epochOf(world: World, vaultId: string, device: DeviceSeed): Promise<string> {
	const response = await deviceFeed(world, vaultId, device);
	assert.equal(response.status, 200, "feed");
	return (await json(response)).vaultEpoch as string;
}

async function devicesOf(world: World, cookie: string, vaultId: string): Promise<unknown> {
	return (await json(await world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie }))).devices;
}

async function mintCode(world: World, cookie: string, vaultId: string): Promise<string> {
	const response = await ownerCode(world, cookie, vaultId, "device");
	assert.equal(response.status, 200, "owner code");
	return (await json(response)).pairingCode as string;
}

function tryEnroll(world: World, pairingCode: string, device: DeviceSeed): Promise<Response> {
	return world.fetch("/enroll", { method: "POST", origin: null, json: { pairingCode,
		enrollmentRequestId: `enroll-${device.deviceId}`, deviceId: device.deviceId, deviceToken: device.token,
		deviceName: device.deviceName } });
}

function press(world: World, cookie: string, vaultId: string, at?: unknown): Promise<Response> {
	return world.fetch(`/operator/vaults/${vaultId}/restore`, { method: "POST", cookie, json: at === undefined ? {} : { at } });
}

function rawCount(vault: VaultObject, table: string): number {
	return vault.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
}

function journalRows(world: World): number {
	return world.config.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM restore_journal").one().n;
}

function markers(vault: VaultObject): { pending: string | null; last: string | null } {
	const row = vault.storage.sql.exec<{ pending_restore_id: string | null; last_restore_id: string | null }>(
		"SELECT pending_restore_id, last_restore_id FROM vault_meta WHERE id = 1").one();
	return { pending: row.pending_restore_id, last: row.last_restore_id };
}

async function pendingRestores(world: World, cookie: string): Promise<unknown> {
	return (await json(await world.fetch("/operator/state", { cookie }))).pendingRestores;
}

function aborts(vault: VaultObject): number {
	return vault.pitr!.calls.filter((call) => call === "abort").length;
}

/**
 * Before T: laptop and tablet enrolled, two frames on `ns`, an unused owner code; T is captured. After T: one more
 * frame, a reset-streams (new epoch, empty streams), a frame on `late`, the phone enrolled with a new code, the tablet
 * revoked and another unused code. The restore must bring back T's content with the pre-restore devices and no codes.
 */
async function scenario(world: World): Promise<Scenario> {
	const { cookie, vaultId, pairingCode, vault } = await claim(world);
	const laptop = newDevice("laptop-device-0001");
	const tablet = newDevice("tablet-device-0001");
	const phone = newDevice("phone-device-00001");
	await enrollVia(world, pairingCode, laptop);
	await enrollVia(world, await mintCode(world, cookie, vaultId), tablet);
	const staleCode = await mintCode(world, cookie, vaultId);
	const first = appendCommitted(vault, laptop.deviceId, "ns", "frame-a1", new Uint8Array([1]));
	commit(vault, first, "ns", "frame-a2", new Uint8Array([2]));
	world.bucket.objects.set(blobKey(vaultId, "d".repeat(64)), new Uint8Array([4]));
	advance(world, 1000);

	const at = world.config.clock.now;
	const epochAtT = await epochOf(world, vaultId, laptop);
	const contentAtT = await content(world, vaultId, laptop);
	assert.equal(contentAtT.head, 2);
	const codesAtT = rawCount(vault, "pairing_code");
	vault.pitr!.capture(at);
	advance(world, 10_000);

	commit(vault, first, "ns", "frame-b1", new Uint8Array([3]));
	const reset = await world.fetch(`/operator/vaults/${vaultId}/reset-streams`,
		{ method: "POST", cookie, json: { confirmVaultId: vaultId } });
	assert.equal(reset.status, 200);
	const socket = appendCommitted(vault, laptop.deviceId, "late", "frame-c1", new Uint8Array([5]));
	await enrollVia(world, await mintCode(world, cookie, vaultId), phone);
	assert.equal((await world.fetch(`/operator/vaults/${vaultId}/devices/${tablet.deviceId}`,
		{ method: "DELETE", cookie })).status, 200);
	const lateCode = await mintCode(world, cookie, vaultId);
	advance(world, 1000);

	const issued = await deviceFetch(world, vaultId, laptop, "auth/ticket",
		{ method: "POST", body: JSON.stringify({ purpose: "streams" }), headers: { "Content-Type": "application/json" } });
	const { ticket } = await json(issued) as { ticket: string };
	const epochBefore = await epochOf(world, vaultId, laptop);
	const contentBefore = await content(world, vaultId, laptop);
	assert.notDeepEqual(contentBefore, contentAtT);
	assert.notEqual(epochBefore, epochAtT);
	return { cookie, vaultId, vault, laptop, phone, tablet, staleCode, lateCode, at, atIso: new Date(at).toISOString(),
		epochAtT, contentAtT, codesAtT, epochBefore, contentBefore, devicesBefore: await devicesOf(world, cookie, vaultId),
		socket, ticket };
}

/** The end state of every finished restore. */
async function assertRestored(world: World, sc: Scenario, returnedEpoch?: string): Promise<void> {
	assert.deepEqual(await devicesOf(world, sc.cookie, sc.vaultId), sc.devicesBefore, "devices == pre-restore devices");
	assert.equal((await deviceFeed(world, sc.vaultId, sc.phone)).status, 200, "a device enrolled after T keeps working");
	assert.equal((await deviceFeed(world, sc.vaultId, sc.tablet)).status, 401, "a device revoked after T stays revoked");
	assert.equal(rawCount(sc.vault, "pairing_code"), 0, "no pairing codes");
	for (const code of [sc.staleCode, sc.lateCode]) {
		const refused = await tryEnroll(world, code, newDevice("intruder-device-01"));
		assert.equal(refused.status, 404, "no code from before the restore enrolls");
	}
	const epoch = await epochOf(world, sc.vaultId, sc.laptop);
	assert.notEqual(epoch, sc.epochBefore, "a new epoch (not the pre-restore one)");
	assert.notEqual(epoch, sc.epochAtT, "a new epoch (not T's)");
	if (returnedEpoch !== undefined) assert.equal(epoch, returnedEpoch);
	assert.deepEqual(await content(world, sc.vaultId, sc.laptop), sc.contentAtT, "stream content == T");
	assert.equal(journalRows(world), 0, "no journal row");
	assert.deepEqual(await pendingRestores(world, sc.cookie), []);
	const marker = markers(sc.vault);
	assert.equal(marker.pending, null);
	assert.ok(marker.last);
	assert.equal(world.bucket.objects.size, 1, "blobs are kept");
	assert.equal((await deviceFetch(world, sc.vaultId, sc.laptop, `blobs/${"d".repeat(64)}`)).status, 200,
		"no restoring flag is left");
}

/** Crashes the restore runner at (step, phase), once: the hook never settles, as when the config isolate dies. */
function crashAt(world: World, step: keyof RestoreVaultPort, phase: "before" | "after"): Promise<void> {
	return new Promise((reached) => {
		world.cluster.restoreHook = (current, currentPhase) => {
			if (current !== step || currentPhase !== phase) return;
			world.cluster.restoreHook = null;
			reached();
			return crash();
		};
	});
}

// ---- T-RESTORE-RESUME-WB --------------------------------------------------------------------------------------------

s.test("D8b: one press runs steps 0–4 → 200 {vaultEpoch}; T's content, pre-restore devices, no codes, new epoch", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		const response = await press(world, sc.cookie, sc.vaultId, sc.atIso);
		assert.equal(response.status, 200);
		const body = await json(response);
		assert.deepEqual(Object.keys(body), ["vaultEpoch"]);
		assert.deepEqual(sc.socket.closed, { code: 1013, reason: "restore_in_progress" }, "step 1 closes streams sockets 1013");
		assert.equal(aborts(sc.vault), 1);
		assert.deepEqual(sc.vault.pitr!.calls, ["getBookmarkForTime", "onNextSessionRestoreBookmark", "abort"]);
		await assertRestored(world, sc, body.vaultEpoch as string);
		assert.equal(world.config.alarms.history.length, 1, "step 0 armed the alarm");
		await world.config.fireAlarm();
		assert.equal(world.config.alarms.scheduled, null, "the alarm finds no journal row and stops");
	}, PITR);
});

const CRASH_POINTS: Array<[keyof RestoreVaultPort, "before" | "after"]> = [
	["prepareRestore", "before"], ["prepareRestore", "after"], ["rewind", "before"], ["rewind", "after"],
	["finishRestore", "before"], ["finishRestore", "after"],
];

for (const [step, phase] of CRASH_POINTS) {
	for (const evicted of [false, true]) {
		for (const resume of ["alarm", "press"] as const) {
			const label = `${phase} ${step}${evicted ? " + vault eviction" : ""}, resumed by ${resume}`;
			s.test(`T-RESTORE-RESUME-WB: crash ${label}`, async () => {
				await withWorld(async (world) => {
					const sc = await scenario(world);
					const reached = crashAt(world, step, phase);
					void press(world, sc.cookie, sc.vaultId, sc.atIso);
					await reached;
					assert.deepEqual(await pendingRestores(world, sc.cookie), [{ vaultId: sc.vaultId, at: sc.at }]);
					assert.equal(journalRows(world), 1);
					assert.notEqual(world.config.alarms.scheduled, null, "step 0 left an alarm");
					world.config.restart();
					if (evicted) sc.vault.restart();
					let returned: string | undefined;
					if (resume === "alarm") {
						await world.config.fireAlarm();
						assert.equal(world.config.alarms.scheduled, null, "done: not re-armed");
					} else {
						// The journaled `at` wins over the second press's.
						const again = await press(world, sc.cookie, sc.vaultId, new Date(world.config.clock.now - 5000).toISOString());
						assert.equal(again.status, 200);
						const body = await json(again);
						assert.deepEqual(Object.keys(body).sort(), ["at", "resumed", "vaultEpoch"]);
						assert.deepEqual([body.resumed, body.at], [true, sc.atIso]);
						returned = body.vaultEpoch as string;
					}
					await assertRestored(world, sc, returned);
					// D8b resume: "then always 2 → 3 → 4" re-arms the same bookmark once the vault was rewound but not
					// finished; a finished vault answers step 1 with its epoch (`last_restore_id`), so no second rewind.
					const rewoundUnfinished = (step === "rewind" && phase === "after") || (step === "finishRestore" && phase === "before");
					assert.equal(aborts(sc.vault), rewoundUnfinished ? 2 : 1, "rewinds");
				}, PITR);
			});
		}
	}
}

s.test("D8b: a second press during a running restore joins it (one run, one rewind)", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let reached!: () => void;
		const atRewind = new Promise<void>((resolve) => { reached = resolve; });
		world.cluster.restoreHook = async (step, phase) => {
			if (step !== "rewind" || phase !== "before") return;
			world.cluster.restoreHook = null;
			reached();
			await gate;
		};
		const first = press(world, sc.cookie, sc.vaultId, sc.atIso);
		await atRewind;
		// The runner decides "join" synchronously on entry; release the first run once the second press is in.
		const host = world.config.host;
		const restore = host.restore.bind(host);
		let entered!: () => void;
		const joined = new Promise<void>((resolve) => { entered = resolve; });
		host.restore = (vaultId, at) => {
			const result = restore(vaultId, at);
			entered();
			return result;
		};
		const second = press(world, sc.cookie, sc.vaultId, sc.atIso);
		await joined;
		release();
		const [one, two] = await Promise.all([first, second]);
		const [a, b] = [await json(one), await json(two)];
		assert.deepEqual([one.status, two.status], [200, 200]);
		assert.deepEqual(b, { vaultEpoch: a.vaultEpoch, resumed: true, at: sc.atIso });
		assert.equal(aborts(sc.vault), 1);
		await assertRestored(world, sc, a.vaultEpoch as string);
	}, PITR);
});

// ---- writes in the window, the rewind bound ------------------------------------------------------------------------

s.test("D8b: a write after the rewind (commit or enroll) sends step 3 back to step 2; the write is undone", async () => {
	for (const write of ["commit", "enroll"] as const) {
		await withWorld(async (world) => {
			const sc = await scenario(world);
			const intruder = newDevice("intruder-device-01");
			world.cluster.restoreHook = async (step, phase) => {
				if (step !== "rewind" || phase !== "after") return;
				world.cluster.restoreHook = null;
				// The new runtime (storage as of T) has no flag: a device writes before finishRestore runs.
				if (write === "commit") appendCommitted(sc.vault, sc.laptop.deviceId, "ns", "frame-window", new Uint8Array([9]));
				else assert.equal((await tryEnroll(world, sc.staleCode, intruder)).status, 200, "T's unused code enrolls");
			};
			const response = await press(world, sc.cookie, sc.vaultId, sc.atIso);
			assert.equal(response.status, 200, write);
			assert.equal(aborts(sc.vault), 2, `${write}: rewound twice`);
			await assertRestored(world, sc, (await json(response)).vaultEpoch as string);
			assert.equal((await deviceFeed(world, sc.vaultId, intruder)).status, 401, "the window's device is gone");
		}, PITR);
	}
});

s.test("D8b: writes after every rewind → 503 restore_incomplete after MAX_REWINDS_PER_RUN; the alarm finishes", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		let window = 0;
		world.cluster.restoreHook = (step, phase) => {
			if (step === "rewind" && phase === "after") {
				appendCommitted(sc.vault, sc.laptop.deviceId, "ns", `frame-window-${++window}`, new Uint8Array([9]));
			}
		};
		const response = await press(world, sc.cookie, sc.vaultId, sc.atIso);
		assert.deepEqual([response.status, await json(response)], [503, { error: "restore_incomplete" }]);
		assert.equal(aborts(sc.vault), MAX_REWINDS_PER_RUN);
		assert.equal(journalRows(world), 1, "the journal row stays");
		assert.deepEqual(await pendingRestores(world, sc.cookie), [{ vaultId: sc.vaultId, at: sc.at }]);
		assert.notEqual(world.config.alarms.scheduled, null);
		world.cluster.restoreHook = null;
		await world.config.fireAlarm();
		await assertRestored(world, sc);
	}, PITR);
});

s.test("D8b alarm backoff (G37): the newest journal row's age, clamped to 30 s..1 h; an eviction does not reset it", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		world.cluster.restoreHook = (step, phase) => {
			if (step === "prepareRestore" && phase === "before") throw new Error("transient");
		};
		const pressedAt = world.config.clock.now;
		const response = await press(world, sc.cookie, sc.vaultId, sc.atIso);
		assert.deepEqual([response.status, await json(response)], [503, { error: "restore_incomplete" }]);
		assert.equal(world.config.alarms.scheduled, pressedAt + 30_000, "step 0");
		const delays: number[] = [];
		for (let fired = 0; fired < 9; fired++) {
			advance(world, world.config.alarms.scheduled! - world.config.clock.now);
			if (fired % 2 === 1) world.config.restart();
			await world.config.fireAlarm();
			delays.push(world.config.alarms.scheduled! - world.config.clock.now);
		}
		assert.deepEqual(delays.map((delay) => delay / 1000), [30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);
		world.cluster.restoreHook = null;
		advance(world, world.config.alarms.scheduled! - world.config.clock.now);
		await world.config.fireAlarm();
		await assertRestored(world, sc);
		assert.equal(world.config.alarms.scheduled, null, "done: not re-armed");
	}, PITR);
});

// ---- the authority freeze and the flag ------------------------------------------------------------------------------

s.test("D8b authority freeze: revoke, owner-code and reset-streams → 409 restore_in_progress while journaled", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		const reached = crashAt(world, "rewind", "before");
		void press(world, sc.cookie, sc.vaultId, sc.atIso);
		await reached;
		world.config.restart();
		const rpcs = world.cluster.rpcs.length;
		for (const [method, path, body] of [
			["DELETE", `/operator/vaults/${sc.vaultId}/devices/${sc.phone.deviceId}`, undefined],
			["POST", `/operator/vaults/${sc.vaultId}/owner-code`, {}],
			["POST", `/operator/vaults/${sc.vaultId}/reset-streams`, { confirmVaultId: sc.vaultId }],
		] as const) {
			const response = await world.fetch(path, { method, cookie: sc.cookie, ...(body ? { json: body } : {}) });
			assert.deepEqual([response.status, await json(response)], [409, { error: "restore_in_progress" }], path);
		}
		assert.equal(world.cluster.rpcs.length, rpcs, "no frozen action reaches the vault DO");
		assert.equal((await world.fetch(`/operator/vaults/${sc.vaultId}/devices`, { cookie: sc.cookie })).status, 200);
		await world.config.fireAlarm();
		await assertRestored(world, sc);
		assert.equal((await world.fetch(`/operator/vaults/${sc.vaultId}/devices/${sc.phone.deviceId}`,
			{ method: "DELETE", cookie: sc.cookie })).status, 200, "unfrozen after step 4");
	}, PITR);
});

s.test("D8b flag: 60 s of 503 restore_in_progress on device routes and enroll, upgrades refused 1013; it expires", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		const reached = crashAt(world, "prepareRestore", "after");
		void press(world, sc.cookie, sc.vaultId, sc.atIso);
		await reached;
		assert.deepEqual(sc.socket.closed, { code: 1013, reason: "restore_in_progress" });
		assert.equal(markers(sc.vault).pending !== null, true, "step 1 wrote the marker");
		const json503 = { "Content-Type": "application/json" };
		for (const [path, init] of [
			["streams/feed", {}],
			["streams/read?stream=ns", {}],
			["streams/checkpoint?stream=late&coversSeq=1&expectedCoversSeq=0", { method: "PUT", body: new Uint8Array([1]) }],
			["auth/ticket", { method: "POST", body: JSON.stringify({ purpose: "streams" }), headers: json503 }],
			["auth/pairing-code", { method: "POST", body: "{}", headers: json503 }],
			[`blobs/${"d".repeat(64)}`, {}],
			["blobs", {}],
			[`blobs/${"d".repeat(64)}?ifUploadedBefore=${Number.MAX_SAFE_INTEGER}`, { method: "DELETE" }],
		] as Array<[string, RequestInit]>) {
			const response = await deviceFetch(world, sc.vaultId, sc.laptop, path, init);
			assert.deepEqual([response.status, await json(response)], [503, { error: "restore_in_progress" }], path);
			assert.equal(response.headers.get("Retry-After"), String(RESTORE_FLAG_TTL_MS / 1000), `${path}: Retry-After`);
		}
		const enroll = await tryEnroll(world, sc.lateCode, newDevice("intruder-device-01"));
		assert.deepEqual([enroll.status, await json(enroll)], [503, { error: "restore_in_progress" }]);
		const upgrade = await world.router.fetch(new Request(`https://yaos.test/vault/${sc.vaultId}/ws/streams?streamsVersion=1`
			+ `&ticket=${encodeURIComponent(sc.ticket)}`, { headers: { Upgrade: "websocket" } }), world.env);
		assert.equal(upgrade.headers.get("X-Test-Upgrade"), "rejected");
		assert.deepEqual(sc.vault.upgrades.rejected.at(-1),
			{ frame: { type: "error", code: "restore_in_progress" }, code: 1013, reason: "restore_in_progress" });
		assert.equal((await deviceFeed(world, sc.vaultId, newDevice("stranger-device-01"))).status, 401, "auth comes first");

		advance(world, RESTORE_FLAG_TTL_MS + 1);
		assert.equal((await deviceFeed(world, sc.vaultId, sc.laptop)).status, 200, "the flag expires after 60 s");
		world.config.restart();
		await world.config.fireAlarm();
		await assertRestored(world, sc);
	}, PITR);
});

// ---- errors -------------------------------------------------------------------------------------------------------

s.test("D8b errors: 400 invalid_restore_point (step 0, before the vault, before or without PITR history), 404 unknown_vault", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		const now = world.config.clock.now;
		const refused: unknown[] = [undefined, 42, "yesterday", "2023-11-14", new Date(now).toISOString().slice(0, 19),
			new Date(now + 1000).toISOString(), new Date(now - RESTORE_WINDOW_MS - 1).toISOString(), `${sc.atIso} `];
		for (const at of refused) {
			const response = await press(world, sc.cookie, sc.vaultId, at);
			assert.deepEqual([response.status, await json(response)], [400, { error: "invalid_restore_point" }], String(at));
		}
		const notObject = await world.fetch(`/operator/vaults/${sc.vaultId}/restore`, { method: "POST", cookie: sc.cookie,
			json: [sc.atIso] });
		assert.equal(notObject.status, 400);
		assert.equal(world.cluster.rpcs.filter((call) => call.method === "prepareRestore").length, 0, "no vault call");
		assert.equal(journalRows(world), 0);
		assert.deepEqual(world.config.alarms.history, []);

		const created = world.config.storage.sql.exec<{ created_at: number }>(
			"SELECT created_at FROM vault WHERE vault_id = ?", sc.vaultId).one().created_at;
		const early = await press(world, sc.cookie, sc.vaultId, new Date(created - 1000).toISOString());
		assert.deepEqual([early.status, await json(early)], [400, { error: "invalid_restore_point" }], "before the vault existed");
		assert.equal(journalRows(world), 0, "the journal row is dropped");
		assert.equal(sc.socket.closed, null, "no effect on the vault");
		assert.deepEqual(markers(sc.vault), { pending: null, last: null });
		// After the vault's init but before its PITR history: the fake rejects as Cloudflare does.
		const calls = sc.vault.pitr!.calls.length;
		const beforeHistory = await press(world, sc.cookie, sc.vaultId, new Date(sc.at - 500).toISOString());
		assert.deepEqual([beforeHistory.status, await json(beforeHistory)], [400, { error: "invalid_restore_point" }],
			"before the PITR history");
		assert.deepEqual(sc.vault.pitr!.calls.slice(calls), ["getBookmarkForTime"]);
		assert.equal(journalRows(world), 0, "the journal row is dropped");
		assert.equal(sc.socket.closed, null, "no effect on the vault");
		assert.deepEqual(markers(sc.vault), { pending: null, last: null });
		assert.equal((await world.fetch(`/operator/vaults/${sc.vaultId}/devices/${sc.phone.deviceId}`,
			{ method: "DELETE", cookie: sc.cookie })).status, 200, "no authority freeze is left");

		const unknown = await press(world, sc.cookie, "AAAAAAAAAAAAAAAAAAAAAA", sc.atIso);
		assert.deepEqual([unknown.status, await json(unknown)], [404, { error: "unknown_vault" }]);
		assert.equal((await press(world, "x".repeat(43), sc.vaultId, sc.atIso)).status, 401);
	}, PITR);
	// Before the vault's first snapshot: Cloudflare has no history at all.
	await withWorld(async (world) => {
		const { cookie, vaultId } = await claim(world);
		advance(world, 5000);
		const response = await press(world, cookie, vaultId, new Date(world.config.clock.now - 1000).toISOString());
		assert.deepEqual([response.status, await json(response)], [400, { error: "invalid_restore_point" }], "no history");
		assert.equal(journalRows(world), 0, "the journal row is dropped");
	}, PITR);
});

s.test("D8b: no PITR (local workerd's rejection, or no port) → 501 restore_unsupported, no effect, no journal row", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		sc.vault.pitr!.unsupported = true;
		const response = await press(world, sc.cookie, sc.vaultId, sc.atIso);
		assert.deepEqual([response.status, await json(response)], [501, { error: "restore_unsupported" }]);
		assert.equal(journalRows(world), 0);
		assert.equal(sc.socket.closed, null, "nothing happens before the bookmark");
		assert.deepEqual(markers(sc.vault), { pending: null, last: null });
		assert.equal((await deviceFeed(world, sc.vaultId, sc.laptop)).status, 200, "no flag");
	}, PITR);
	await withWorld(async (world) => {
		const { cookie, vaultId } = await claim(world);
		advance(world, 5000);
		const response = await press(world, cookie, vaultId, new Date(world.config.clock.now - 1000).toISOString());
		assert.deepEqual([response.status, await json(response)], [501, { error: "restore_unsupported" }]);
		assert.equal(journalRows(world), 0);
	});
});

s.test("D8b: vault delete wins (mid-run, after a crash, and during the rewind's await)", async () => {
	// Mid-run: the delete lands between the rewind and finishRestore.
	await withWorld(async (world) => {
		const sc = await scenario(world);
		world.cluster.restoreHook = async (step, phase) => {
			if (step !== "finishRestore" || phase !== "before") return;
			world.cluster.restoreHook = null;
			const deleted = await world.fetch(`/operator/vaults/${sc.vaultId}`,
				{ method: "DELETE", cookie: sc.cookie, json: { confirmVaultId: sc.vaultId } });
			assert.equal(deleted.status, 200);
		};
		const response = await press(world, sc.cookie, sc.vaultId, sc.atIso);
		assert.deepEqual([response.status, await json(response)], [404, { error: "unknown_vault" }]);
		assert.equal(journalRows(world), 0);
		assert.equal((await deviceFeed(world, sc.vaultId, sc.laptop)).status, 401, "the vault stays deleted");
	}, PITR);
	// After a crash: the alarm finds nothing to do.
	await withWorld(async (world) => {
		const sc = await scenario(world);
		const reached = crashAt(world, "rewind", "before");
		void press(world, sc.cookie, sc.vaultId, sc.atIso);
		await reached;
		world.config.restart();
		const deleted = await world.fetch(`/operator/vaults/${sc.vaultId}`,
			{ method: "DELETE", cookie: sc.cookie, json: { confirmVaultId: sc.vaultId } });
		assert.equal(deleted.status, 200, "delete is not frozen");
		assert.equal(journalRows(world), 0);
		const rpcs = world.cluster.rpcs.length;
		await world.config.fireAlarm();
		assert.equal(world.cluster.rpcs.length, rpcs, "no vault call");
		assert.equal(world.config.alarms.scheduled, null);
		assert.equal((await deviceFeed(world, sc.vaultId, sc.laptop)).status, 401);
	}, PITR);
	// During the rewind's await: the wipe would be undone by the armed bookmark, so the vault refuses it; the journal
	// row is already gone, the run stops, and the operator's retry deletes.
	await withWorld(async (world) => {
		const sc = await scenario(world);
		let release!: () => void;
		sc.vault.pitr!.pause = new Promise((resolve) => { release = resolve; });
		const pressed = press(world, sc.cookie, sc.vaultId, sc.atIso);
		while (!sc.vault.pitr!.calls.includes("onNextSessionRestoreBookmark")) await new Promise((resolve) => setImmediate(resolve));
		const first = await world.fetch(`/operator/vaults/${sc.vaultId}`,
			{ method: "DELETE", cookie: sc.cookie, json: { confirmVaultId: sc.vaultId } });
		assert.equal(first.status, 500, "the vault refuses a wipe while a rewind is armed");
		assert.equal(journalRows(world), 0, "the journal row went first");
		release();
		const response = await pressed;
		assert.deepEqual([response.status, await json(response)], [404, { error: "unknown_vault" }]);
		const retry = await world.fetch(`/operator/vaults/${sc.vaultId}`,
			{ method: "DELETE", cookie: sc.cookie, json: { confirmVaultId: sc.vaultId } });
		assert.equal(retry.status, 200);
		assert.equal((await deviceFeed(world, sc.vaultId, sc.laptop)).status, 401);
	}, PITR);
});

// ---- T-ROWS-WB ------------------------------------------------------------------------------------------------------

s.test("T-ROWS-WB restore: prepare 1, finish D+P+1, config 3 (journal INSERT, UPDATE, DELETE)", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		const marks = new Map<string, { vault: number; byTable: Map<string, number> }>();
		world.cluster.restoreHook = (step, phase) => {
			marks.set(`${step}:${phase}`, { vault: sc.vault.model.totals.cf, byTable: new Map(sc.vault.model.totals.byTable) });
		};
		resetRows(world);
		assert.equal((await press(world, sc.cookie, sc.vaultId, sc.atIso)).status, 200);
		const delta = (step: string) => marks.get(`${step}:after`)!.vault - marks.get(`${step}:before`)!.vault;
		assert.equal(delta("prepareRestore"), 1, "prepare: the marker (1 row)");
		assert.equal(delta("rewind"), 0, "the rewind writes no row");
		// T's device table (laptop, tablet) becomes the pre-restore one (laptop, phone): 1 DELETE + 1 INSERT.
		const devices = 2;
		assert.equal(delta("finishRestore"), devices + sc.codesAtT + 1, "finish: D + P + 1");
		const before = marks.get("finishRestore:before")!.byTable;
		const after = marks.get("finishRestore:after")!.byTable;
		const table = (name: string) => (after.get(name) ?? 0) - (before.get(name) ?? 0);
		assert.deepEqual([table("device"), table("pairing_code"), table("vault_meta")], [devices, sc.codesAtT, 1]);
		assert.equal(world.config.model.totals.cf, 3, "config: journal INSERT + UPDATE + DELETE");
		assert.deepEqual([...world.config.model.totals.byTable], [["restore_journal", 3]]);
	}, PITR);
});

s.test("D8b daily limit at step 0 → 503 cf_daily_limit, no journal row", async () => {
	await withWorld(async (world) => {
		const sc = await scenario(world);
		const exec = world.config.model.exec.bind(world.config.model);
		world.config.model.exec = ((query: string, ...bindings: unknown[]) => {
			if (query.startsWith("INSERT INTO restore_journal")) throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
			return exec(query, ...bindings);
		}) as typeof world.config.model.exec;
		const response = await press(world, sc.cookie, sc.vaultId, sc.atIso);
		world.config.model.exec = exec;
		assert.equal(response.status, 503);
		assert.equal((await json(response)).error, "cf_daily_limit");
		assert.equal(journalRows(world), 0);
		assert.equal(sc.socket.closed, null);
	}, PITR);
});

await s.done();
