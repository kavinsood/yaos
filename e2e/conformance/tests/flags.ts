/** Rulings on the review flags: F1 enroll replay/conflict, F3 blob keys, F5 console routes, F6 vault delete, F7 provision,
 * F10 enroll body, F11 unknown vault. */
import type { Ctx } from "../lib/context.ts";
import { memo, secret } from "../lib/context.ts";
import type { TestDef } from "../lib/results.ts";
import { devicePairingCode, enrollBody, newDeviceIdentity, operatorCookie, vault } from "../lib/fixture.ts";
import { brief, http, isRouteMissing, vaultPath } from "../lib/http.ts";
import type { HttpResult } from "../lib/http.ts";
import { StreamSocket } from "../lib/socket.ts";
import { checkpointPath } from "../lib/streams.ts";
import { bytesEqual, id, payloadOf, sha256hex, sleep } from "../lib/util.ts";

const enc = encodeURIComponent;

/** Registers credential-looking strings found in a response so they can never reach output. */
function guard(ctx: Ctx, value: unknown) {
	if (Array.isArray(value)) value.forEach((v) => guard(ctx, v));
	else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (typeof child === "string" && /code|token|ticket|secret|key|hash/i.test(key)) secret(ctx, child);
			else guard(ctx, child);
		}
	}
}

async function post(ctx: Ctx, path: string, json: unknown, options: { token?: string; cookie?: string } = {}): Promise<HttpResult> {
	const response = await http(ctx, "POST", path, { ...options, json });
	guard(ctx, response.value);
	return response;
}

async function ticketStatus(ctx: Ctx, vaultId: string, token: string) {
	return brief(await post(ctx, `${vaultPath(vaultId)}/auth/ticket`, { purpose: "streams" }, { token }));
}

/** One device-code enrollment on a dedicated vault, keeping the exact body for replays (in memory only). */
function enrollFixture(ctx: Ctx) {
	return memo(ctx, "flags:enroll", async () => {
		const v = await vault(ctx, "enroll", ["A"]);
		const code = await devicePairingCode(ctx, v);
		const device = newDeviceIdentity(ctx, "R", v.key);
		const body = enrollBody(device, code);
		const statuses: number[] = [];
		let first: HttpResult | null = null;
		// A 202 (legacy fence) is itself an identical retry; keep going until a final answer.
		for (let attempt = 0; attempt < 10; attempt++) {
			first = await post(ctx, "/enroll", body);
			statuses.push(first.status);
			if (first.status !== 202) break;
			await sleep(1000);
		}
		return { v, device, body, first: first!, statuses };
	});
}

export const tests: TestDef[] = [
	{
		id: "T-CONSOLE-ROUTES", group: "decision", area: "D5 console (F5)", expectedBefore: "PASS",
		async run(ctx, t) {
			t.expect("GET / -> 200 text/html; GET /mobile-setup -> 200; OPTIONS preflight on device routes is not 404");
			for (const path of ["/", "/mobile-setup"]) {
				const response = await fetch(`${ctx.host}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30000) });
				await response.arrayBuffer();
				const type = response.headers.get("content-type") ?? "";
				t.check(`GET ${path} -> 200 html`, response.status === 200 && type.includes("text/html"), { status: response.status, type });
			}
			for (const path of [`${vaultPath(id(16))}/auth/ticket`, "/enroll"]) {
				const response = await fetch(`${ctx.host}${path}`, { method: "OPTIONS", signal: AbortSignal.timeout(30000), headers: {
					Origin: "app://obsidian.md", "Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "authorization,content-type" } });
				await response.arrayBuffer();
				t.check(`OPTIONS ${path.replace(/\/vault\/[^/]+/, "/vault/:id")} not 404`, response.status !== 404 && response.status < 500,
					{ status: response.status, allowOrigin: response.headers.get("access-control-allow-origin"),
						allowMethods: response.headers.get("access-control-allow-methods") });
			}
		},
	},
	{
		id: "T-ENROLL-REPLAY", group: "decision", area: "D3 enroll (F1)", expectedBefore: "PASS",
		async run(ctx, t) {
			const f = await enrollFixture(ctx);
			t.expect("first enroll 200; the identical body again -> 200 with the same deviceId/vaultId/vaultGeneration; the token gets a ticket");
			t.check("first enroll 200", f.first.status === 200 && f.first.value?.deviceId === f.device.deviceId, brief(f.first, { statuses: f.statuses }));
			const replay = await post(ctx, "/enroll", f.body);
			t.observe("replay", brief(replay, { replayed: replay.value?.replayed }));
			t.check("identical retry -> 200", replay.status === 200, brief(replay));
			t.check("same deviceId, vaultId, vaultGeneration", replay.value?.deviceId === f.device.deviceId && replay.value?.vaultId === f.v.vaultId
				&& replay.value?.vaultGeneration === f.first.value?.vaultGeneration,
			{ deviceId: replay.value?.deviceId === f.device.deviceId, vaultId: replay.value?.vaultId === f.v.vaultId,
				vaultGeneration: replay.value?.vaultGeneration === f.first.value?.vaultGeneration });
			const ticket = await ticketStatus(ctx, f.v.vaultId, f.device.token);
			t.check("token works after the replay (ticket 200)", ticket.status === 200, ticket);
		},
	},
	{
		id: "T-ENROLL-CONFLICT", group: "decision", area: "D3 enroll (F1)", expectedBefore: "PASS",
		async run(ctx, t) {
			const f = await enrollFixture(ctx);
			if (f.first.status !== 200) { t.fail("fixture enroll did not return 200", brief(f.first, { statuses: f.statuses })); return; }
			const otherToken = id(32);
			secret(ctx, otherToken);
			t.expect("same code + enrollmentRequestId with another deviceId or token -> 409 enrollment_request_conflict, no effect");
			const otherDevice = await post(ctx, "/enroll", { ...f.body, deviceId: id(16) });
			t.check("other deviceId -> 409 enrollment_request_conflict", otherDevice.status === 409
				&& otherDevice.value?.error === "enrollment_request_conflict", brief(otherDevice));
			const otherTok = await post(ctx, "/enroll", { ...f.body, deviceToken: otherToken });
			t.check("other deviceToken -> 409 enrollment_request_conflict", otherTok.status === 409
				&& otherTok.value?.error === "enrollment_request_conflict", brief(otherTok));
			const original = await ticketStatus(ctx, f.v.vaultId, f.device.token);
			t.check("original token still gets a ticket", original.status === 200, original);
			const conflicting = await ticketStatus(ctx, f.v.vaultId, otherToken);
			t.check("conflicting token -> 401", conflicting.status === 401, conflicting);
			// Unspecified by the ruling: is deviceName part of "the body"? Is the replay key per code or per vault?
			const renamed = await post(ctx, "/enroll", { ...f.body, deviceName: `${f.body.deviceName}-renamed` });
			t.info("same code + id + deviceId + token, other deviceName (unspecified)", brief(renamed, { replayed: renamed.value?.replayed }));
			const freshCode = await devicePairingCode(ctx, f.v);
			const otherCode = await post(ctx, "/enroll", { ...f.body, pairingCode: freshCode });
			t.info("same id + deviceId + token, fresh code of the same vault (unspecified)", brief(otherCode));
		},
	},
	{
		id: "T-ENROLL-BODY", group: "decision", area: "D3 enroll (F10)", expectedBefore: "FAIL",
		async run(ctx, t) {
			const f = await enrollFixture(ctx);
			const v = f.first.value ?? {};
			// The client reads exactly these six (src/host/ui/pairing.ts readEnrollment); D6 constants belong to VAULT_READY only.
			const SIX = ["deviceId", "deviceName", "deviceToken", "host", "vaultGeneration", "vaultId"];
			t.expect("200 body has exactly host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration");
			t.observe("keys", Object.keys(v).sort());
			t.check("200", f.first.status === 200, brief(f.first));
			t.check("six client fields", typeof v.host === "string" && v.deviceToken === f.device.token && v.vaultId === f.v.vaultId
				&& v.deviceId === f.device.deviceId && typeof v.deviceName === "string" && typeof v.vaultGeneration === "string",
			{ host: typeof v.host, deviceTokenEchoed: v.deviceToken === f.device.token, vaultId: v.vaultId === f.v.vaultId,
				deviceId: v.deviceId === f.device.deviceId, deviceName: typeof v.deviceName, vaultGeneration: typeof v.vaultGeneration });
			const extra = Object.keys(v).filter((k) => !SIX.includes(k)).sort();
			t.check("no other keys", extra.length === 0, { extra });
		},
	},
	{
		id: "T-UNKNOWN-VAULT-401", group: "decision", area: "D2 device routes (F11)", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const token = v.owner.token;
			const path = vaultPath(id(16));
			t.expect("a valid bearer of another vault on a well-formed unknown vaultId -> 401 on every device route");
			const cases: [string, () => Promise<HttpResult>][] = [
				["ticket", () => http(ctx, "POST", `${path}/auth/ticket`, { token, json: { purpose: "streams" } })],
				["pairing-code", () => http(ctx, "POST", `${path}/auth/pairing-code`, { token, json: { purpose: "device" } })],
				["feed", () => http(ctx, "GET", `${path}/streams/feed?after=0`, { token })],
				["read", () => http(ctx, "GET", `${path}/streams/read?stream=ns&after=0`, { token })],
				["checkpoint", () => http(ctx, "PUT", checkpointPath(path, "ns", 1, 0), { token, body: payloadOf("ck", 16) })],
			];
			for (const [name, run] of cases) {
				const response = await run();
				guard(ctx, response.value);
				t.check(`${name} 401`, response.status === 401, brief(response));
			}
			const blob = await http(ctx, "GET", `${path}/blobs/${"0".repeat(64)}`, { token });
			t.info("GET blob on the unknown vault (order of auth vs attachments_unavailable unspecified)", brief(blob));
		},
	},
	{
		id: "T-BLOB-KEY-RESET", group: "decision", area: "D9 blobs (F3)", expectedBefore: "SKIP",
		async run(ctx, t) {
			if (ctx.capabilities?.attachments !== true) { t.skip("capabilities.attachments=false (no R2 bucket)", { attachments: ctx.capabilities?.attachments ?? null }); return; }
			const v = await vault(ctx, "blobreset", ["A"]);
			const cookie = await operatorCookie(ctx);
			const bytes = payloadOf(`blob-reset-${id(6)}`, 50_000).map((b, i) => (b ^ (i * 13)) & 0xff);
			const address = sha256hex(bytes);
			t.expect("PUT blob, reset-streams 200, then GET returns the same bytes and exists lists it");
			const put = await http(ctx, "PUT", `${v.path}/blobs/${address}`, { token: v.owner.token, body: bytes });
			t.check("PUT 2xx", put.status >= 200 && put.status < 300, brief(put));
			const reset = await post(ctx, `/operator/vaults/${enc(v.vaultId)}/reset-streams`, { confirmVaultId: v.vaultId }, { cookie });
			if (isRouteMissing(reset)) { t.routeMissing("POST /operator/vaults/:vaultId/reset-streams", brief(reset)); return; }
			t.check("reset 200", reset.status === 200, brief(reset));
			const response = await fetch(`${ctx.host}${v.path}/blobs/${address}`, { headers: { Authorization: `Bearer ${v.owner.token}` } });
			const got = new Uint8Array(await response.arrayBuffer());
			t.check("GET after reset returns identical bytes", response.status === 200 && bytesEqual(got, bytes), { status: response.status, bytes: got.byteLength });
			const exists = await post(ctx, `${v.path}/blobs/exists`, { hashes: [address] }, { token: v.owner.token });
			t.check("exists lists it after reset", Array.isArray(exists.value?.present) && exists.value.present.includes(address), brief(exists));
		},
	},
	{
		id: "T-PROVISION-404", group: "decision", area: "D5 operator (F7)", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const cookie = await operatorCookie(ctx);
			const response = await post(ctx, `/operator/vaults/${enc(v.vaultId)}/provision`, {}, { cookie });
			t.expect("404 (route removed)");
			t.check("POST /operator/vaults/:id/provision -> 404", response.status === 404, brief(response));
		},
	},
	{
		id: "T-VAULT-DELETE-CONFIRM", group: "decision", area: "D5 operator (F6)", expectedBefore: "FAIL", timeoutMs: 90000,
		async run(ctx, t) {
			const v = await vault(ctx, "delete", ["A"]);
			const cookie = await operatorCookie(ctx);
			const route = `/operator/vaults/${enc(v.vaultId)}`;
			const del = async (json: unknown) => { const r = await http(ctx, "DELETE", route, { cookie, json }); guard(ctx, r.value); return r; };
			t.expect("missing or mismatched confirmVaultId -> 400; matching -> 200, live socket closes 1001, device routes -> 401");
			const missing = await del({});
			t.check("missing confirmVaultId -> 400", missing.status === 400, brief(missing));
			const mismatch = await del({ confirmVaultId: id(16) });
			t.check("mismatched confirmVaultId -> 400", mismatch.status === 400, brief(mismatch));
			const socket = await StreamSocket.connect(ctx, v.vaultId, v.owner, "A");
			const from = socket.mark();
			const matching = await del({ confirmVaultId: v.vaultId });
			if (matching.status !== 200) {
				t.check("matching confirmVaultId -> 200", false, brief(matching));
				t.info("route shape differs from F6 today; post-delete checks not run (the vault was not deleted)",
					{ missing: brief(missing), mismatch: brief(mismatch), matching: brief(matching) });
				return;
			}
			t.check("matching confirmVaultId -> 200", true, brief(matching));
			const close = await socket.waitClose(15000);
			t.check("live socket closes 1001", close?.code === 1001, { closeCode: close?.code ?? null, timeline: socket.timeline(from) });
			const ticket = await ticketStatus(ctx, v.vaultId, v.owner.token);
			t.check("ticket -> 401", ticket.status === 401, ticket);
			const feed = await http(ctx, "GET", `${v.path}/streams/feed?after=0`, { token: v.owner.token });
			t.check("feed -> 401", feed.status === 401, brief(feed));
		},
	},
];
