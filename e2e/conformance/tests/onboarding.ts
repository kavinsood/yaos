/** D2 enroll, D3 pairing codes, D4 tickets. */
import type { Ctx } from "../lib/context.ts";
import type { Recorder, TestDef } from "../lib/results.ts";
import { enrollBody, newDeviceIdentity, vault } from "../lib/fixture.ts";
import { brief, http } from "../lib/http.ts";
import { StreamSocket } from "../lib/socket.ts";
import { id } from "../lib/util.ts";

const CODE_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$/;

function codeShape(code: string, vaultId: string) {
	const dot = code.indexOf(".");
	return { length: code.length, formatOk: CODE_RE.test(code), prefixIsVaultId: dot > 0 && code.slice(0, dot) === vaultId,
		hasDot: dot >= 0, charsetBase64Url: /^[A-Za-z0-9_.-]+$/.test(code) };
}

async function enrollAttempt(ctx: Ctx, code: string, label: string) {
	const device = newDeviceIdentity(ctx, label, "probe");
	return http(ctx, "POST", "/enroll", { json: enrollBody(device, code) });
}

/** Rejection = error frame `unauthorized` then close 1008, or an HTTP failure (handshake error -> 1006). Never VAULT_READY. */
export async function upgradeRejection(socket: StreamSocket, timeoutMs = 10000) {
	const close = await socket.waitClose(timeoutMs);
	const gotReady = socket.events.some((e) => e.control?.type === "VAULT_READY");
	const errorCodes = socket.events.filter((e) => e.control?.type === "error").map((e) => e.control.code);
	const httpFailure = close?.code === 1006 && socket.events.some((e) => e.type === "error") && !socket.events.some((e) => e.type === "control");
	const frameReject = errorCodes[0] === "unauthorized" && close?.code === 1008;
	return { rejected: !gotReady && (frameReject || httpFailure), observed: { closeCode: close?.code ?? null, errorCodes, gotReady,
		httpFailure, timeline: socket.timeline() } };
}

async function ticketCase(ctx: Ctx, t: Recorder, name: string, vaultId: string, ticket: string | null) {
	const socket = StreamSocket.raw(ctx, vaultId, ticket, name);
	const result = await upgradeRejection(socket);
	t.check(`${name}: rejected (unauthorized+1008 or HTTP failure)`, result.rejected, result.observed);
	socket.close();
}

export const tests: TestDef[] = [
	{
		id: "T-PAIR-FORMAT", group: "decision", area: "D3 pairing", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const owner = v.codes.find((c) => c.kind === "owner")!;
			const deviceCode = v.codes.find((c) => c.kind === "device")!;
			const o = codeShape(owner.code, v.vaultId);
			const d = codeShape(deviceCode.code, v.vaultId);
			t.expect("^[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{32}$, prefix == vaultId");
			t.check("owner code matches format", o.formatOk, o);
			t.check("owner code prefix == vaultId", o.prefixIsVaultId, o);
			t.check("device code matches format", d.formatOk, d);
			t.check("device code prefix == vaultId", d.prefixIsVaultId, d);
		},
	},
	{
		id: "T-PAIR-MALFORMED", group: "decision", area: "D3 pairing", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const cases: [string, string][] = [
				["short (5 chars)", "abcde"],
				["no dot (40 chars)", "x".repeat(40)],
				["vaultId + short secret", `${v.vaultId}.${"a".repeat(10)}`],
				["vaultId + bad charset", `${v.vaultId}.${"!".repeat(32)}`],
				["21-char prefix", `${"a".repeat(21)}.${"b".repeat(32)}`],
			];
			t.expect("400 {error:invalid_code} for each");
			for (const [name, code] of cases) {
				const response = await enrollAttempt(ctx, code, "malformed");
				t.check(name, response.status === 400 && response.value?.error === "invalid_code", brief(response));
			}
		},
	},
	{
		id: "T-PAIR-UNKNOWN-VAULT", group: "decision", area: "D3 pairing", expectedBefore: "FAIL",
		async run(ctx, t) {
			const code = `${id(16)}.${id(24)}`;
			const response = await enrollAttempt(ctx, code, "unknown");
			t.expect("404 {error:invalid_code} for an unknown vault and for an unknown secret on a known vault (D3, F2)");
			t.check("unknown vault -> 404 invalid_code", response.status === 404 && response.value?.error === "invalid_code",
				brief(response, { codeFormatOk: CODE_RE.test(code) }));
			const v = await vault(ctx, "main");
			const known = await enrollAttempt(ctx, `${v.vaultId}.${id(24)}`, "unknown-secret");
			t.check("known vault, unknown secret -> 404 invalid_code", known.status === 404 && known.value?.error === "invalid_code", brief(known));
		},
	},
	{
		id: "T-PAIR-USED", group: "decision", area: "D3 pairing", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			t.expect("{error:used_code} on re-use of an owner code and a device code");
			for (const kind of ["owner", "device"] as const) {
				const code = v.codes.find((c) => c.kind === kind)!.code;
				const response = await enrollAttempt(ctx, code, `reuse-${kind}`);
				t.check(`${kind} code re-use -> used_code`, response.value?.error === "used_code" && response.status >= 400, brief(response));
			}
		},
	},
	{
		id: "T-ENROLL-200", group: "decision", area: "D2 enroll", expectedBefore: "PASS",
		async run(ctx, t) {
			await vault(ctx, "main");
			const log = ctx.enrollLog;
			const first202 = log.filter((e) => e.firstStatus === 202).length;
			const observed = { enrolls: log.length, first200: log.filter((e) => e.firstStatus === 200).length, first202,
				other: log.filter((e) => e.firstStatus !== 200 && e.firstStatus !== 202).map((e) => e.firstStatus),
				bodyOk: log.filter((e) => e.bodyOk).length };
			t.expect("every enroll answers 200 on the first attempt (no 202 authorization_fence_pending), body has exactly host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration");
			t.observe("enrolls", observed);
			t.check("all first attempts 200", log.length > 0 && observed.first200 === log.length, observed);
			t.check("all 200 bodies well-formed", observed.bodyOk === log.length, observed);
		},
	},
	{
		id: "T-TICKET-CROSS-VAULT", group: "decision", area: "D4 ticket", expectedBefore: "PASS",
		async run(ctx, t) {
			const main = await vault(ctx, "main");
			const other = await vault(ctx, "happy");
			const ticket = await StreamSocket.ticket(ctx, other.vaultId, other.owner.token);
			t.expect("error unauthorized + close 1008, or HTTP failure; never VAULT_READY");
			await ticketCase(ctx, t, "vault-X ticket on vault-Y socket", main.vaultId, ticket);
		},
	},
	{
		id: "T-TICKET-BAD", group: "decision", area: "D4 ticket", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const good = await StreamSocket.ticket(ctx, v.vaultId, v.owner.token);
			const dot = good.indexOf(".");
			const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
			const tamperedSig = flip(good, dot + 5);
			const tamperedPayload = flip(good, Math.max(0, Math.floor(dot / 2)));
			t.expect("each: error unauthorized + close 1008, or HTTP failure; never VAULT_READY");
			t.check("ticket has payload.signature shape", dot > 0 && dot < good.length - 1, { dotIndex: dot > 0, length: good.length });
			await ticketCase(ctx, t, "tampered signature", v.vaultId, tamperedSig);
			await ticketCase(ctx, t, "tampered payload", v.vaultId, tamperedPayload);
			await ticketCase(ctx, t, "garbage", v.vaultId, "abc.def");
			await ticketCase(ctx, t, "missing", v.vaultId, null);
		},
	},
];
