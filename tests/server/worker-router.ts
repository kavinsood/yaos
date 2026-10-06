// Worker router (server/src/worker.ts) against DECISIONS §2.2 and D5: method and path match, format checks, size
// caps, CORS, the capabilities cache, and T-LEGACY-404 (every removed route → 404 with zero DO calls). The vault DO
// is a real VaultHost on SQLite; the config DO is a namespace that records every access.
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
	type VaultObject,
} from "./helpers/workerHarness.ts";

const s = suite("worker-router");

const ORIGIN = "https://yaos.test";
const SECRET = "B".repeat(32);

interface World {
	router: Router;
	env: WorkerEnv;
	cluster: VaultCluster;
	upgrades: RecordingUpgrades;
	config: { accesses: string[] };
	claimed: { claimed: boolean };
	vaultId: string;
	vault: VaultObject;
	owner: DeviceSeed;
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** Vault-DO fetches plus config-DO accesses since the world was made (or since the last `resetCalls`). */
	doCalls(): number;
	resetCalls(): void;
}

async function withWorld(
	check: (world: World) => Promise<void>,
	options: { bucket?: boolean; debug?: boolean } = {},
): Promise<void> {
	const cluster = new VaultCluster();
	try {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const vault = await cluster.seed(vaultId, [owner]);
		const claimed = { claimed: true };
		const config = recordingConfigNamespace(claimed);
		const upgrades = new RecordingUpgrades();
		const env = {
			YAOS_VAULT: cluster.namespace(),
			YAOS_CONFIG: config.namespace,
			...(options.bucket ? { YAOS_BUCKET: {} as R2Bucket } : {}),
			...(options.debug ? { YAOS_DEBUG_ROUTES: "1" } : {}),
		} as WorkerEnv;
		const router = new Router({ upgrades });
		const world: World = {
			router, env, cluster, upgrades, config, claimed, vaultId, vault, owner,
			fetch: (path, init) => router.fetch(new Request(`${ORIGIN}${path}`, init), env),
			doCalls: () => cluster.fetches.length + config.accesses.length,
			resetCalls: () => { cluster.fetches.length = 0; config.accesses.length = 0; },
		};
		await check(world);
	} finally {
		cluster.close();
	}
}

async function body(response: Response): Promise<unknown> {
	return JSON.parse(await response.text()) as unknown;
}

async function assertNotFound(world: World, method: string, path: string, init: RequestInit = {}): Promise<void> {
	world.resetCalls();
	const response = await world.fetch(path, { method, ...init });
	assert.equal(response.status, 404, `${method} ${path}: status`);
	assert.equal(await response.text(), "{\"error\":\"not_found\"}", `${method} ${path}: body`);
	assert.equal(world.doCalls(), 0, `${method} ${path}: zero DO calls`);
}

// ---- T-LEGACY-404 -------------------------------------------------------------

s.test("T-LEGACY-404: the D5 legacy list → 404 not_found, zero DO calls", async () => {
	await withWorld(async (world) => {
		const v = `/vault/${world.vaultId}`;
		const token = bearer(world.owner);
		const jsonBody = { headers: { ...token, "Content-Type": "application/json" }, body: "{}" };
		// e2e/conformance/tests/operator.ts T-LEGACY-404, request for request.
		await assertNotFound(world, "GET", `${v}/members`, { headers: token });
		await assertNotFound(world, "GET", `${v}/invitations`, { headers: token });
		await assertNotFound(world, "PATCH", `${v}/governance`, jsonBody);
		await assertNotFound(world, "POST", `${v}/device-links`, jsonBody);
		await assertNotFound(world, "GET", `${v}/settings-sync/conformance`, { headers: token });
		await assertNotFound(world, "PUT", `${v}/settings-sync/conformance/seed`, jsonBody);
		await assertNotFound(world, "POST", `${v}/catch-up`, jsonBody);
		await assertNotFound(world, "POST", `${v}/bootstrap/start`, jsonBody);
		await assertNotFound(world, "DELETE", "/operator/devices/owner-device-0001", { headers: { Cookie: "yaos_operator=x" } });
	});
});

s.test("T-LEGACY-404: §5 row 14, /provision and other removed routes → 404, zero DO calls", async () => {
	await withWorld(async (world) => {
		const v = `/vault/${world.vaultId}`;
		const token = { headers: bearer(world.owner) };
		const post = { headers: bearer(world.owner), body: "{}" };
		const removed: Array<[string, string, RequestInit?]> = [
			// §5 row 14 "Still used" identity routes.
			["GET", `${v}/me`, token], ["GET", `${v}/devices`, token], ["POST", `${v}/invitations`, post],
			["DELETE", `${v}/invitations/x`, token], ["GET", `${v}/principals/p/devices`, token], ["PATCH", `${v}/principals/p`, post],
			["DELETE", `${v}/devices/d`, token], ["POST", `${v}/ownership/transfers`, post], ["DELETE", `${v}/governance`, token],
			["POST", `${v}/leave`, post], ["GET", `${v}/audit`, token], ["POST", `${v}/auth/device`, post],
			["DELETE", `${v}/auth/device`, token],
			// Semantic sockets, server CRDT HTTP, relay v2, recovery, debug/admin (relay-wire §14).
			["GET", `${v}/ws/root`, token], ["GET", `${v}/ws/body/b1`, token], ["GET", `${v}/ws/semantic/s1`, token],
			["POST", `${v}/body/b1/candidate`, post], ["GET", `${v}/body/b1`, token], ["GET", `${v}/head/b1`, token],
			["POST", `${v}/lifecycle/create-bulk`, post], ["POST", `${v}/attachments/publish`, post],
			["GET", `${v}/bootstrap/x/root`, token], ["GET", `${v}/operations/o/outcome`, token], ["HEAD", `${v}/body/b1`, token],
			["POST", `${v}/body/b1/compaction-lease`, post], ["GET", `${v}/recovery/snapshots`, token], ["GET", `${v}/snapshots`, token],
			["GET", `${v}/debug/recent`, token], ["POST", `${v}/debug/compact`, post], ["POST", `${v}/debug/simulate-restart`, post],
			["GET", `${v}/debug/sql-rows`, token], ["GET", `${v}/root`, token], ["GET", `${v}/status`, token],
			// Operator and top-level routes outside §2.2.
			["POST", `/operator/vaults/${world.vaultId}/provision`, post], ["PATCH", `/operator/vaults/${world.vaultId}`, post],
			["GET", `/operator/vaults/${world.vaultId}/deletion`], ["POST", `/operator/vaults/${world.vaultId}/emergency-destroy`],
			["POST", "/operator/pairing-codes", post], ["DELETE", "/operator/pairing-codes/x"], ["GET", "/operator/vaults"],
			["POST", "/api/update-metadata", post], ["GET", "/api/other"], ["GET", "/enroll"], ["GET", "/claim"],
			["GET", "/favicon.ico"], ["GET", "/vault"], ["GET", `${v}`], ["GET", `${v}/`],
			// OPTIONS outside the preflight scope (§2.2 dropped /operator/).
			["OPTIONS", "/operator/login"], ["OPTIONS", "/claim"], ["OPTIONS", "/"],
		];
		for (const [method, path, init] of removed) await assertNotFound(world, method, path, init);
	});
});

// ---- route table ----------------------------------------------------------------

s.test("§2.2: static pages and CORS preflight answer without a DO", async () => {
	await withWorld(async (world) => {
		world.resetCalls();
		for (const path of ["/", "/mobile-setup"]) {
			const response = await world.fetch(path);
			assert.equal(response.status, 200, path);
			assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/, path);
			assert.equal(response.headers.get("Access-Control-Allow-Origin"), null, `${path}: no CORS`);
		}
		for (const path of ["/api/capabilities", "/api/anything", "/enroll", `/vault/${world.vaultId}/streams/feed`, "/vault/x"]) {
			const response = await world.fetch(path, { method: "OPTIONS" });
			assert.equal(response.status, 204, path);
			assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*", path);
			assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type", path);
		}
		assert.equal(world.doCalls(), 0);
	});
});

s.test("§2.2 / D5: operator routes refuse a cross-site write or a missing session before any DO call; P3 routes 501; bad ids → 404", async () => {
	await withWorld(async (world) => {
		const id = world.vaultId;
		const writes: Array<[string, string]> = [
			["POST", "/claim"], ["POST", "/operator/login"], ["POST", "/operator/logout"], ["POST", "/operator/vaults"],
			["POST", `/operator/vaults/${id}/owner-code`], ["DELETE", `/operator/vaults/${id}`],
			["DELETE", `/operator/vaults/${id}/devices/owner-device-0001`],
		];
		for (const [method, path] of writes) {
			for (const origin of [undefined, "https://evil.test", "null"]) {
				world.resetCalls();
				const response = await world.fetch(path, { method, body: "{}",
					headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) } });
				assert.equal(response.status, 403, `${method} ${path} Origin ${origin}`);
				assert.deepEqual(await body(response), { error: "forbidden_origin" });
				assert.equal(world.doCalls(), 0, `${method} ${path}: no DO call`);
			}
		}
		for (const path of ["/operator/state", `/operator/vaults/${id}/devices`]) {
			world.resetCalls();
			const response = await world.fetch(path);
			assert.equal(response.status, 401, path);
			assert.deepEqual(await body(response), { error: "unauthorized" });
			assert.equal(world.doCalls(), 0, `${path}: no cookie, no DO call`);
		}
		for (const path of [`/operator/vaults/${id}/reset-streams`, `/operator/vaults/${id}/restore`]) {
			world.resetCalls();
			const response = await world.fetch(path, { method: "POST", body: "{}" });
			assert.equal(response.status, 501, path);
			assert.deepEqual(await body(response), { error: "not_implemented" }, path);
			assert.equal(world.doCalls(), 0, `${path}: no DO call (P3)`);
		}
		await assertNotFound(world, "GET", `/operator/vaults/${id}/owner-code`);
		await assertNotFound(world, "POST", "/operator/vaults/short/owner-code");
		await assertNotFound(world, "DELETE", `/operator/vaults/${id}/devices/short`);
		await assertNotFound(world, "DELETE", `/operator/vaults/${id}/devices/${"d".repeat(129)}`);
		await assertNotFound(world, "DELETE", `/operator/vaults/${id}/devices/owner%2Ddevice%2D0001`);
		await assertNotFound(world, "GET", `/operator/vaults/${id}/devices/owner-device-0001`);
		await assertNotFound(world, "PATCH", `/operator/vaults/${id}`);
	});
});

s.test("T-UNKNOWN-VAULT-401: device routes on an unknown vault answer as a bad credential; no DDL", async () => {
	await withWorld(async (world) => {
		const unknown = newVaultId();
		const token = bearer(world.owner);
		for (const [method, path] of [["GET", "streams/feed"], ["GET", "streams/read?stream=ns"], ["PUT", "streams/checkpoint"],
			["POST", "auth/ticket"], ["POST", "auth/pairing-code"]] as const) {
			const response = await world.fetch(`/vault/${unknown}/${path}`,
				{ method, headers: token, ...(method === "GET" ? {} : { body: "{}" }) });
			assert.equal(response.status, 401, path);
			assert.deepEqual(await body(response), { error: "unauthorized" }, path);
			assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*", `${path}: CORS`);
		}
		const upgrade = await world.fetch(`/vault/${unknown}/ws/streams?streamsVersion=1&ticket=t`,
			{ headers: { Upgrade: "websocket" } });
		assert.equal(upgrade.headers.get("X-Test-Upgrade"), "rejected");
		const object = world.cluster.object(unknown);
		assert.deepEqual(object.upgrades.rejected,
			[{ frame: { type: "error", code: "unauthorized" }, code: 1008, reason: "unauthorized" }]);
		const plain = await world.fetch(`/vault/${unknown}/ws/streams?streamsVersion=1`);
		assert.equal(plain.status, 401);
		assert.ok(object.statements.every((sql) => /^SELECT vault_id/.test(sql)), "only the vault_meta probe ran");
		assert.equal(object.statements.length, 1, "the unknown state is cached");
		assert.equal(object.model.totals.cf, 0, "zero rows written");
	});
});

s.test("§2.2: bearer device routes reach the vault DO; a wrong token is 401", async () => {
	await withWorld(async (world) => {
		const v = `/vault/${world.vaultId}`;
		const feed = await world.fetch(`${v}/streams/feed`, { headers: bearer(world.owner) });
		assert.equal(feed.status, 200);
		assert.equal(feed.headers.get("Access-Control-Allow-Origin"), "*");
		const page = await body(feed) as { vaultEpoch: string; head: number };
		assert.equal(page.vaultEpoch, world.vault.host.load()!.meta.vaultGeneration);
		const stranger = newDevice("stranger-device-01");
		for (const headers of [bearer(stranger), {}, { Authorization: "Basic abc" }]) {
			const response = await world.fetch(`${v}/streams/feed`, { headers });
			assert.equal(response.status, 401);
		}
		const ticket = await world.fetch(`${v}/auth/ticket`, { method: "POST", headers: bearer(world.owner), body: "{}" });
		assert.equal(ticket.status, 400);
		assert.deepEqual(await body(ticket), { error: "invalid_ticket_scope" });
		const code = await world.fetch(`${v}/auth/pairing-code`, { method: "POST", headers: bearer(world.owner), body: "{}" });
		assert.equal(code.status, 200);
		const minted = await body(code) as { obsidianUrl: string; mobileSetupUrl: string };
		assert.ok(minted.mobileSetupUrl.startsWith(`${ORIGIN}/mobile-setup#`), "the public origin reaches the vault DO");
		assert.ok(minted.obsidianUrl.includes(`host=${encodeURIComponent(ORIGIN)}`));
		const spoofed = await world.fetch(`${v}/auth/pairing-code`, { method: "POST",
			headers: { ...bearer(world.owner), "X-YAOS-Origin": "https://evil.test" }, body: "{}" });
		const spoofedBody = await body(spoofed) as { mobileSetupUrl: string };
		assert.ok(spoofedBody.mobileSetupUrl.startsWith(`${ORIGIN}/`), "a client-sent X-YAOS-Origin is replaced");
	});
});

s.test("streams routes: exact method and path (moved from streams-relay)", async () => {
	await withWorld(async (world) => {
		const v = `/vault/${world.vaultId}`;
		appendCommitted(world.vault, world.owner.deviceId, "ns", "frame-1", new Uint8Array([7]));
		const routed: Array<[string, string, RequestInit, number]> = [
			["GET", `${v}/ws/streams?streamsVersion=1`, { headers: { Upgrade: "websocket" } }, 200],
			["GET", `${v}/streams/feed`, { headers: bearer(world.owner) }, 200],
			["GET", `${v}/streams/read?stream=ns`, { headers: bearer(world.owner) }, 200],
			["PUT", `${v}/streams/checkpoint?stream=ns&coversSeq=1&expectedCoversSeq=0`,
				{ headers: bearer(world.owner), body: "x" }, 200],
		];
		for (const [method, path, init, status] of routed) {
			world.resetCalls();
			const response = await world.fetch(path, { method, ...init });
			assert.equal(response.status, status, `${method} ${path}`);
			assert.deepEqual(world.cluster.fetches.map((call) => [call.method, call.url]),
				[[method, `https://vault.internal${path.slice(v.length)}`]], `${method} ${path}: forwarded with its query`);
		}
		await assertNotFound(world, "POST", `${v}/streams/feed`, { body: "{}" });
		await assertNotFound(world, "GET", `${v}/streams/checkpoint`);
		await assertNotFound(world, "GET", `${v}/streams/other`);
		await assertNotFound(world, "GET", `${v}/ws/streams/x`);
		await assertNotFound(world, "GET", `${v}/streams/feed/`);
		await assertNotFound(world, "GET", `/vault/${world.vaultId}//streams/feed`);
	});
});

// ---- format checks and caps -----------------------------------------------------

s.test("vaultId format: anything but 22 base64url characters → 404 before any DO", async () => {
	await withWorld(async (world) => {
		const id = world.vaultId;
		for (const bad of [id.slice(1), `${id}A`, `${id.slice(1)}=`, `${id.slice(1)}.`, encodeURIComponent(`${id.slice(1)}/`),
			`${id.slice(2)}%2D`, "A".repeat(21) + "+"]) {
			await assertNotFound(world, "GET", `/vault/${bad}/streams/feed`, { headers: bearer(world.owner) });
		}
	});
});

s.test("D3: the pairing code is checked after trim; malformed → 400 invalid_code with no DO call", async () => {
	await withWorld(async (world) => {
		const id = world.vaultId;
		const malformed: unknown[] = [`${id}.${SECRET.slice(1)}`, `${id}.${SECRET}A`, `${id}${SECRET}`, `${id.slice(1)}.${SECRET}A`,
			`${id}.${SECRET.slice(1)}=`, `${id}:${SECRET}`, "", 42, null, `${id}.${SECRET}\u0000`];
		for (const pairingCode of malformed) {
			world.resetCalls();
			const response = await world.fetch("/enroll", { method: "POST", body: JSON.stringify({ pairingCode }) });
			assert.equal(response.status, 400, `code ${JSON.stringify(pairingCode)}`);
			assert.deepEqual(await body(response), { error: "invalid_code" });
			assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
			assert.equal(world.doCalls(), 0);
		}
		for (const raw of ["not json", "", "[]", "{}"]) {
			world.resetCalls();
			const response = await world.fetch("/enroll", { method: "POST", body: raw });
			assert.equal(response.status, 400, `body ${JSON.stringify(raw)}`);
			assert.deepEqual(await body(response), { error: "invalid_code" });
			assert.equal(world.doCalls(), 0);
		}
		world.resetCalls();
		const large = await world.fetch("/enroll",
			{ method: "POST", body: JSON.stringify({ pairingCode: `${id}.${SECRET}`, pad: "x".repeat(70_000) }) });
		assert.equal(large.status, 413);
		assert.equal(world.doCalls(), 0);

		const unknown = newVaultId();
		world.resetCalls();
		const unknownVault = await world.fetch("/enroll",
			{ method: "POST", body: JSON.stringify({ pairingCode: `  ${unknown}.${SECRET}\n` }) });
		assert.equal(unknownVault.status, 404, "trimmed code reaches the vault DO named by it");
		assert.deepEqual(await body(unknownVault), { error: "invalid_code" });
		assert.deepEqual(world.cluster.fetches.map((call) => [call.name, call.method, call.url]),
			[[unknown, "POST", "https://vault.internal/enroll"]]);
		assert.equal(world.config.accesses.length, 0);
		assert.equal(world.cluster.object(unknown).model.totals.cf, 0, "unknown vault: zero writes");

		const known = await world.fetch("/enroll", { method: "POST", body: JSON.stringify({ pairingCode: `${id}.${SECRET}` }) });
		assert.equal(known.status, 400, "known vault: the vault DO checks the other fields");
		assert.deepEqual(await body(known), { error: "invalid enrollment request" });
	});
});

s.test("streamsVersion: anything but 1 → update_required (frame + 1008, or 426) before any DO call", async () => {
	await withWorld(async (world) => {
		const cases: Array<[string, number | null]> = [["", null], ["?streamsVersion=", null], ["?streamsVersion=%20", null],
			["?streamsVersion=0", 0], ["?streamsVersion=2", 2], ["?streamsVersion=abc", null], ["?streamsVersion=-1", null],
			["?streamsVersion=1.5", null]];
		for (const [query, client] of cases) {
			world.resetCalls();
			world.upgrades.rejected.length = 0;
			const response = await world.fetch(`/vault/${world.vaultId}/ws/streams${query}`, { headers: { Upgrade: "websocket" } });
			assert.equal(response.headers.get("X-Test-Upgrade"), "rejected", query);
			assert.deepEqual(world.upgrades.rejected, [{
				frame: { type: "error", code: "update_required", reason: "streams_version_mismatch", clientStreamsVersion: client,
					serverStreamsVersion: 1 },
				code: 1008, reason: "update required",
			}], query);
			const plain = await world.fetch(`/vault/${world.vaultId}/ws/streams${query}`);
			assert.equal(plain.status, 426, query);
			assert.deepEqual(await body(plain), { error: "update_required", reason: "streams_version_mismatch",
				clientStreamsVersion: client, serverStreamsVersion: 1 });
			assert.equal(world.doCalls(), 0, query);
		}
		world.resetCalls();
		const ok = await world.fetch(`/vault/${world.vaultId}/ws/streams?streamsVersion=1`, { headers: { Upgrade: "websocket" } });
		assert.equal(ok.headers.get("X-Test-Upgrade"), "rejected", "version 1 reaches the vault DO, which wants a ticket");
		assert.deepEqual(world.vault.upgrades.rejected.map((entry) => entry.frame), [{ type: "error", code: "unauthorized" }]);
		assert.equal(world.cluster.fetches.length, 1);
	});
});

s.test("checkpoint: Content-Length above 4 MiB → 413 before any DO call; a bad Content-Length → 400", async () => {
	await withWorld(async (world) => {
		const path = `/vault/${world.vaultId}/streams/checkpoint?stream=ns&coversSeq=1&expectedCoversSeq=0`;
		const request = (length: string) => new Request(`${ORIGIN}${path}`, { method: "PUT",
			headers: { ...bearer(world.owner), "Content-Length": length }, body: "x" });
		world.resetCalls();
		const tooLarge = await world.router.fetch(request(String(4 * 1024 * 1024 + 1)), world.env);
		assert.equal(tooLarge.status, 413);
		assert.deepEqual(await body(tooLarge), { error: "body_too_large" });
		const invalid = await world.router.fetch(request("12x"), world.env);
		assert.equal(invalid.status, 400);
		assert.deepEqual(await body(invalid), { error: "invalid_content_length" });
		assert.equal(world.doCalls(), 0);
	});
});

s.test("blobs: no bucket → 503; address regex; 10 MiB PUT cap; no DO call (P3 adds the bearer check and R2)", async () => {
	await withWorld(async (world) => {
		const v = `/vault/${world.vaultId}`;
		const address = "a".repeat(64);
		world.resetCalls();
		for (const [method, path] of [["GET", `blobs/${address}`], ["PUT", `blobs/${address}`], ["POST", "blobs/exists"]] as const) {
			const response = await world.fetch(`${v}/${path}`,
				{ method, headers: bearer(world.owner), ...(method === "GET" ? {} : { body: "x" }) });
			assert.equal(response.status, 503, `${method} ${path}`);
			assert.deepEqual(await body(response), { error: "attachments_unavailable" });
		}
		assert.equal(world.doCalls(), 0);
	});
	await withWorld(async (world) => {
		const v = `/vault/${world.vaultId}`;
		world.resetCalls();
		for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "exists"]) {
			const response = await world.fetch(`${v}/blobs/${bad}`, { headers: bearer(world.owner) });
			assert.equal(response.status, 400, bad);
			assert.deepEqual(await body(response), { error: "invalid_address" });
		}
		const tooLarge = await world.router.fetch(new Request(`${ORIGIN}${v}/blobs/${"b".repeat(64)}`, { method: "PUT",
			headers: { ...bearer(world.owner), "Content-Length": String(10 * 1024 * 1024 + 1) }, body: "x" }), world.env);
		assert.equal(tooLarge.status, 413);
		const address = "c".repeat(64);
		for (const [method, path] of [["GET", `blobs/${address}`], ["PUT", `blobs/${address}`], ["POST", "blobs/exists"]] as const) {
			const response = await world.fetch(`${v}/${path}`,
				{ method, headers: bearer(world.owner), ...(method === "GET" ? {} : { body: "x" }) });
			assert.equal(response.status, 501, `${method} ${path}`);
		}
		await assertNotFound(world, "DELETE", `${v}/blobs/${"c".repeat(64)}`);
		await assertNotFound(world, "GET", `${v}/blobs/${"c".repeat(64)}/x`);
		assert.equal(world.doCalls(), 0);
	}, { bucket: true });
});

s.test("debug/simulate-daily-limit: 404 with no DO call unless YAOS_DEBUG_ROUTES=1", async () => {
	await withWorld(async (world) => {
		await assertNotFound(world, "POST", `/vault/${world.vaultId}/debug/simulate-daily-limit`, { headers: bearer(world.owner) });
	});
	await withWorld(async (world) => {
		world.resetCalls();
		const response = await world.fetch(`/vault/${world.vaultId}/debug/simulate-daily-limit`,
			{ method: "POST", headers: bearer(world.owner) });
		assert.equal(response.status, 501, "P3 (H3)");
		assert.equal(world.cluster.fetches.length, 1);
		const unauthorized = await world.fetch(`/vault/${world.vaultId}/debug/simulate-daily-limit`, { method: "POST" });
		assert.equal(unauthorized.status, 401);
	}, { debug: true });
});

// ---- capabilities -------------------------------------------------------------

s.test("capabilities: the five kept fields; the config DO is asked only until claimed is seen", async () => {
	await withWorld(async (world) => {
		world.claimed.claimed = false;
		world.resetCalls();
		const first = await world.fetch("/api/capabilities");
		assert.equal(first.status, 200);
		assert.equal(first.headers.get("Access-Control-Allow-Origin"), "*");
		assert.equal(await first.text(),
			"{\"claimed\":false,\"attachments\":false,\"maxBlobUploadBytes\":10485760,\"serverVersion\":\"1.0.0\",\"streams\":1}");
		assert.ok(world.config.accesses.includes("stub.isClaimed"));
		world.resetCalls();
		await world.fetch("/api/capabilities");
		assert.ok(world.config.accesses.includes("stub.isClaimed"), "unclaimed: asked again");
		world.claimed.claimed = true;
		const claimed = await body(await world.fetch("/api/capabilities")) as { claimed: boolean };
		assert.equal(claimed.claimed, true);
		world.resetCalls();
		world.claimed.claimed = false;
		const cached = await body(await world.fetch("/api/capabilities")) as { claimed: boolean };
		assert.equal(cached.claimed, true, "claimed=true is cached forever");
		assert.deepEqual(world.config.accesses, [], "no config access once claimed was seen");
		assert.equal(world.cluster.fetches.length, 0);
	});
	await withWorld(async (world) => {
		const capabilities = await body(await world.fetch("/api/capabilities")) as { attachments: boolean };
		assert.equal(capabilities.attachments, true);
	}, { bucket: true });
});

// ---- Worker plumbing ------------------------------------------------------------

s.test("an unread request body is drained in finally; a thrown error is 500 internal_error", async () => {
	await withWorld(async (world) => {
		const request = new Request(`${ORIGIN}/claim`, { method: "POST", body: "{\"recoveryKey\":\"x\"}" });
		const response = await world.router.fetch(request, world.env);
		assert.equal(response.status, 403, "no Origin: refused before the body is read");
		assert.equal(request.bodyUsed, true, "the body was read to the end");
		const boom = () => { throw new Error("boom"); };
		const failing: WorkerEnv = { ...world.env, YAOS_VAULT: new Proxy({}, { get: () => boom }) as WorkerEnv["YAOS_VAULT"] };
		const original = console.error;
		console.error = () => {};
		try {
			const failed = await world.router.fetch(new Request(`${ORIGIN}/vault/${world.vaultId}/streams/feed`), failing);
			assert.equal(failed.status, 500);
			assert.deepEqual(await body(failed), { error: "internal_error" });
		} finally {
			console.error = original;
		}
	});
});

await s.done();
