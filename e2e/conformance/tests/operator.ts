/** D5 operator routes (devices list, revoke, reset-streams, restore probe, legacy 404s) and D7 revoke semantics. */
import type { Ctx } from "../lib/context.ts";
import { memo, secret } from "../lib/context.ts";
import type { TestDef } from "../lib/results.ts";
import { device, operatorCookie, vault } from "../lib/fixture.ts";
import type { Device, Vault } from "../lib/fixture.ts";
import { brief, http, isRouteMissing } from "../lib/http.ts";
import type { HttpResult } from "../lib/http.ts";
import { StreamSocket } from "../lib/socket.ts";
import { findDeviceEntries, id, now, payloadOf, round, tokenLikeKeys } from "../lib/util.ts";

const enc = encodeURIComponent;

/** Registers credential-looking strings found in a response so they can never reach output. */
function guard(ctx: Ctx, value: unknown) {
	if (Array.isArray(value)) value.forEach((v) => guard(ctx, v));
	else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (typeof child === "string" && /code|token|ticket|secret|key/i.test(key)) secret(ctx, child);
			else guard(ctx, child);
		}
	}
}

function leaksSecret(ctx: Ctx, value: unknown): boolean {
	const text = JSON.stringify(value ?? null);
	return [...ctx.secrets].some((s) => s.length >= 16 && text.includes(s));
}

function deviceListReport(ctx: Ctx, response: HttpResult, v: Vault) {
	guard(ctx, response.value);
	const ids = new Set(v.devices.map((d) => d.deviceId));
	const entries = findDeviceEntries(response.value).filter((e) => ids.has(e.deviceId as string));
	return { ...brief(response), vaultDevicesListed: new Set(entries.map((e) => e.deviceId)).size, vaultDevices: ids.size,
		entryKeys: [...new Set(entries.flatMap((e) => Object.keys(e)))].sort(), tokenLikeKeys: tokenLikeKeys(entries),
		allHaveDeviceName: entries.every((e) => typeof e.deviceName === "string" || typeof e.name === "string"),
		leaksKnownSecret: leaksSecret(ctx, response.value) };
}

async function bearerProbe(ctx: Ctx, v: Vault, d: Device) {
	const token = d.token;
	const results = {
		ticket: await http(ctx, "POST", `${v.path}/auth/ticket`, { token, json: { purpose: "streams" } }),
		feed: await http(ctx, "GET", `${v.path}/streams/feed?after=0`, { token }),
		read: await http(ctx, "GET", `${v.path}/streams/read?stream=ns&after=0`, { token }),
		pairingCode: await http(ctx, "POST", `${v.path}/auth/pairing-code`, { token, json: { purpose: "device" } }),
	};
	for (const r of Object.values(results)) guard(ctx, r.value);
	return Object.fromEntries(Object.entries(results).map(([k, r]) => [k, brief(r)])) as Record<string, { status: number; error?: unknown }>;
}

/** Opens a socket for `victim`, runs `revoke`, and measures error frame + close. */
async function revokeWithSocket(ctx: Ctx, v: Vault, victim: Device, revoke: () => Promise<HttpResult>) {
	const socket = await StreamSocket.connect(ctx, v.vaultId, victim, `victim-${victim.label}`);
	const from = socket.mark();
	// undici moves to CLOSING when the server's close frame arrives but fires `close` only when TCP ends: poll for the former.
	let closeFrameAt: number | null = null;
	const poll = setInterval(() => { if (closeFrameAt === null && socket.ws.readyState >= WebSocket.CLOSING) closeFrameAt = now(); }, 5);
	const t0 = now();
	const response = await revoke();
	guard(ctx, response.value);
	const ok = response.status >= 200 && response.status < 300;
	// On today's Worker the close (TCP end) reaches the client ~10 s after the error frame; wait until 16 s after the request.
	const close = await socket.waitClose(ok ? Math.max(0, t0 + 16000 - now()) : 1500);
	clearInterval(poll);
	const errorFrame = socket.events.slice(from).find((e) => e.control?.type === "error");
	return { response, ok, socket: { errorCode: errorFrame?.control.code ?? null, closeCode: close?.code ?? null,
		errorBeforeClose: !!errorFrame && !!close && errorFrame.at <= close.at, errorLatencyMs: errorFrame ? round(errorFrame.at - t0) : null,
		closeLatencyMs: close ? round(close.at - t0) : null, closeFrameLatencyMs: closeFrameAt === null ? null : round(closeFrameAt - t0),
		timeline: socket.timeline(from) } };
}

/** T-REVOKE-4403 criteria: error frame and close frame each < 1 s after the revoke request was sent, close code 4403.
 * The TCP end (undici's `close`) is platform teardown (~10 s on the legacy Worker): recorded, not judged. */
function revokeTiming(s: { errorCode: unknown; closeCode: unknown; errorLatencyMs: number | null; closeLatencyMs: number | null;
	closeFrameLatencyMs: number | null }) {
	const errorOk = s.errorCode === "authority_superseded" && s.errorLatencyMs !== null && s.errorLatencyMs < 1000;
	const closeOk = s.closeCode === 4403 && s.closeFrameLatencyMs !== null && s.closeFrameLatencyMs < 1000;
	return { errorOk, closeOk, line: `error frame ${s.errorCode ?? "none"} at +${s.errorLatencyMs ?? "?"} ms (< 1 s: ${errorOk}); close frame at +${
		s.closeFrameLatencyMs ?? "?"} ms (< 1 s, code ${s.closeCode ?? "none"}: ${closeOk}); TCP end at +${s.closeLatencyMs ?? "?"} ms` };
}

function revokeOutcome(ctx: Ctx) {
	return memo(ctx, "revoke", async () => {
		const v = await vault(ctx, "revoke", ["A", "V", "L"]);
		const cookie = await operatorCookie(ctx);
		const victim = device(v, "V");
		const primary = await revokeWithSocket(ctx, v, victim, () => http(ctx, "DELETE",
			`/operator/vaults/${enc(v.vaultId)}/devices/${enc(victim.deviceId)}`, { cookie }));
		const routeMissing = isRouteMissing(primary.response);
		let legacy: unknown = null;
		let legacyBearer: unknown = null;
		if (routeMissing) {
			// Legacy equivalent: the operator route refuses devices that belong to a principal (every owner-code / device-link
			// enrollment) with 409 collaboration_authority_required (server/src/config.ts handleRevokeDevice), so fall back
			// to the owner-side collaboration revoke DELETE /vault/:id/devices/:deviceId, which installs an authority fence.
			const l = device(v, "L");
			const operatorRun = await revokeWithSocket(ctx, v, l, () => http(ctx, "DELETE", `/operator/devices/${enc(l.deviceId)}`, { cookie }));
			legacy = { operatorDelete: { response: brief(operatorRun.response), ...operatorRun.socket } };
			if (!operatorRun.ok) {
				const ownerRun = await revokeWithSocket(ctx, v, l, () => http(ctx, "DELETE", `${v.path}/devices/${enc(l.deviceId)}`,
					{ token: v.owner.token, json: { requestId: id(18) } }));
				legacy = { ...legacy as object, ownerDelete: { response: brief(ownerRun.response), ...ownerRun.socket } };
			}
			legacyBearer = await bearerProbe(ctx, v, l);
		}
		return { v, victim, primary: { response: brief(primary.response), ok: primary.ok, ...primary.socket }, routeMissing, legacy, legacyBearer };
	});
}

const ROUTE_DEVICES = "GET /operator/vaults/:vaultId/devices";
const ROUTE_REVOKE = "DELETE /operator/vaults/:vaultId/devices/:deviceId";
const ROUTE_RESET = "POST /operator/vaults/:vaultId/reset-streams";

export const tests: TestDef[] = [
	{
		id: "T-DEVICES-LIST", group: "decision", area: "D5 operator", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const cookie = await operatorCookie(ctx);
			const response = await http(ctx, "GET", `/operator/vaults/${enc(v.vaultId)}/devices`, { cookie });
			t.expect("200; every enrolled device listed with deviceId + deviceName; no token-like fields or values");
			if (isRouteMissing(response)) {
				t.routeMissing(ROUTE_DEVICES, brief(response));
				t.info("legacy GET /operator/state (cookie)", deviceListReport(ctx, await http(ctx, "GET", "/operator/state", { cookie }), v));
				t.info("legacy GET /vault/:id/devices (owner bearer)", deviceListReport(ctx,
					await http(ctx, "GET", `${v.path}/devices`, { token: v.owner.token }), v));
				return;
			}
			const report = deviceListReport(ctx, response, v);
			const ids = new Set(v.devices.map((d) => d.deviceId));
			const entries = findDeviceEntries(response.value).filter((e) => ids.has(e.deviceId as string));
			t.observe("report", report);
			t.check("200", response.status === 200, brief(response));
			t.check("every enrolled device listed", report.vaultDevicesListed === ids.size, report);
			t.check("entries carry deviceId + deviceName strings", entries.length > 0
				&& entries.every((e) => typeof e.deviceId === "string" && typeof e.deviceName === "string"), report.entryKeys);
			t.check("no token-like keys", (report.tokenLikeKeys as string[]).length === 0, report.tokenLikeKeys);
			t.check("no known secret values", !report.leaksKnownSecret);
		},
	},
	{
		id: "T-REVOKE-4403", group: "decision", area: "D7 revoke", expectedBefore: "FAIL",
		async run(ctx, t) {
			const r = await revokeOutcome(ctx);
			t.expect("2xx; victim socket gets error authority_superseded and close frame 4403, each < 1 s after the request");
			if (r.routeMissing) {
				t.routeMissing(ROUTE_REVOKE, r.primary);
				t.info("legacy revoke (DELETE /operator/devices/:id, then owner DELETE /vault/:id/devices/:id) -> victim socket", r.legacy);
				const owner = (r.legacy as { ownerDelete?: Parameters<typeof revokeTiming>[0] } | null)?.ownerDelete;
				if (owner) t.info(`legacy owner revoke, timing criteria: ${revokeTiming(owner).line}`);
				return;
			}
			t.observe("result", r.primary);
			const timing = revokeTiming(r.primary);
			t.check("revoke 2xx", r.primary.ok, r.primary.response);
			t.check("error authority_superseded < 1 s after the request", timing.errorOk,
				{ errorCode: r.primary.errorCode, errorLatencyMs: r.primary.errorLatencyMs });
			t.check("close frame 4403 < 1 s after the request", timing.closeOk,
				{ closeCode: r.primary.closeCode, closeFrameLatencyMs: r.primary.closeFrameLatencyMs });
			t.info(timing.line);
		},
	},
	{
		id: "T-REVOKE-401", group: "decision", area: "D7 revoke", expectedBefore: "FAIL",
		async run(ctx, t) {
			const r = await revokeOutcome(ctx);
			t.expect("revoked bearer -> 401 on ticket, feed, read, pairing-code");
			if (r.routeMissing) {
				t.routeMissing(ROUTE_REVOKE, r.primary);
				t.info("legacy-revoked bearer statuses", r.legacyBearer);
				return;
			}
			const probe = await bearerProbe(ctx, r.v, r.victim);
			t.observe("statuses", probe);
			for (const [route, result] of Object.entries(probe)) t.check(`${route} 401`, result.status === 401, result);
		},
	},
	{
		id: "T-RESET", group: "decision", area: "D8a reset", expectedBefore: "FAIL", timeoutMs: 120000,
		async run(ctx, t) {
			const v = await vault(ctx, "reset", ["A", "B"]);
			const cookie = await operatorCookie(ctx);
			const A = device(v, "A");
			const a = await StreamSocket.connect(ctx, v.vaultId, A, "A");
			const b = await StreamSocket.connect(ctx, v.vaultId, device(v, "B"), "B");
			const oldEpoch = a.ready.vaultEpoch;
			await a.appendAll([{ stream: "ns", id: "r-1", payload: payloadOf("r-1", 100) }, { stream: "b:reset", id: "r-2", payload: payloadOf("r-2", 100) },
				{ stream: "b:reset", id: "r-3", payload: payloadOf("r-3", 100) }]);
			const marks = [a.mark(), b.mark()];
			t.expect("200 {vaultEpoch}; sockets close 1001; reconnect: new vaultEpoch, head 0; feed after=0 empty; same token gets a ticket; next append seq 1");
			const response = await http(ctx, "POST", `/operator/vaults/${enc(v.vaultId)}/reset-streams`, { cookie, json: { confirmVaultId: v.vaultId } });
			// Restore has no spec test: probe only (status), after everything else, on this run's own vault.
			const probeRestore = async () => {
				const restore = await http(ctx, "POST", `/operator/vaults/${enc(v.vaultId)}/restore`, { cookie, json: {} });
				guard(ctx, restore.value);
				t.info("restore route probe (POST /operator/vaults/:vaultId/restore {} on this run's reset vault): "
					+ (isRouteMissing(restore) ? "route-missing (Worker 404)" : `present, status ${restore.status}`), brief(restore));
			};
			if (isRouteMissing(response)) {
				t.routeMissing(ROUTE_RESET, brief(response));
				t.info("no legacy equivalent (DELETE /operator/vaults/:id and emergency-destroy delete the vault; not a stream reset)");
				await probeRestore();
				return;
			}
			t.check("reset 200 {vaultEpoch} with a new epoch", response.status === 200 && typeof response.value?.vaultEpoch === "string"
				&& response.value.vaultEpoch !== oldEpoch, brief(response, { epochChanged: response.value?.vaultEpoch !== oldEpoch }));
			const [ca, cb] = await Promise.all([a.waitClose(15000), b.waitClose(15000)]);
			t.check("live sockets close 1001", ca?.code === 1001 && cb?.code === 1001,
				{ a: ca?.code ?? null, b: cb?.code ?? null, timelineA: a.timeline(marks[0]), timelineB: b.timeline(marks[1]) });
			const ticket = await http(ctx, "POST", `${v.path}/auth/ticket`, { token: A.token, json: { purpose: "streams" } });
			guard(ctx, ticket.value);
			t.check("same token still gets a ticket", ticket.status === 200, brief(ticket));
			const a2 = await StreamSocket.connect(ctx, v.vaultId, A, "A2");
			t.check("reconnect: vaultEpoch differs, head 0", a2.ready.vaultEpoch !== oldEpoch && a2.ready.head === 0,
				{ epochChanged: a2.ready.vaultEpoch !== oldEpoch, head: a2.ready.head, matchesResetResponse: a2.ready.vaultEpoch === response.value?.vaultEpoch });
			const feed = await http(ctx, "GET", `${v.path}/streams/feed?after=0`, { token: A.token });
			t.check("feed after=0 empty", feed.status === 200 && feed.value?.changes?.length === 0, brief(feed, { changes: feed.value?.changes?.length }));
			const seq = (await a2.appendAll([{ stream: "ns", id: "after-reset", payload: payloadOf("after", 50) }])).get("after-reset")!;
			t.check("next append gets seq 1", seq.seq === 1 && !seq.deduped, { seq: seq.seq, deduped: seq.deduped });
			await probeRestore();
		},
	},
	{
		id: "T-LEGACY-404", group: "decision", area: "D5 operator", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "legacy", ["A", "S"]);
			const cookie = await operatorCookie(ctx);
			const token = v.owner.token;
			const sacrificial = device(v, "S");
			const requests: [string, () => Promise<HttpResult>][] = [
				["GET /vault/:id/members", () => http(ctx, "GET", `${v.path}/members`, { token })],
				["GET /vault/:id/invitations", () => http(ctx, "GET", `${v.path}/invitations`, { token })],
				["PATCH /vault/:id/governance {}", () => http(ctx, "PATCH", `${v.path}/governance`, { token, json: {} })],
				["POST /vault/:id/device-links {}", () => http(ctx, "POST", `${v.path}/device-links`, { token, json: {} })],
				["GET /vault/:id/settings-sync/:x", () => http(ctx, "GET", `${v.path}/settings-sync/conformance`, { token })],
				["PUT /vault/:id/settings-sync/:x/seed {}", () => http(ctx, "PUT", `${v.path}/settings-sync/conformance/seed`, { token, json: {} })],
				["POST /vault/:id/catch-up {}", () => http(ctx, "POST", `${v.path}/catch-up`, { token, json: {} })],
				["POST /vault/:id/bootstrap/start {}", () => http(ctx, "POST", `${v.path}/bootstrap/start`, { token, json: {} })],
				["DELETE /operator/devices/:id (sacrificial device)", () => http(ctx, "DELETE", `/operator/devices/${enc(sacrificial.deviceId)}`, { cookie })],
			];
			t.expect("404 on every legacy route");
			for (const [name, run] of requests) {
				const response = await run();
				guard(ctx, response.value);
				t.check(name, response.status === 404, brief(response));
			}
		},
	},
];
