import { test } from "node:test";
import assert from "node:assert/strict";
import {
	base64Url, buildSetupLink, DEVICE_ID_RE, DEVICE_TOKEN_RE, ENROLLMENT_REQUEST_ID_RE, enroll, fetchCapabilities,
	FENCE_RETRY_DELAYS_MS, generateDeviceId, generateDeviceToken, generateEnrollmentRequestId, normalizeHost,
	normalizePairingCode, PairingError, parseSetupLink, prepareEnrollment, requestPairingCode, runEnrollment,
	attemptMatches, pairDevice, retireDeviceEnrollment, RETIRE_FAILED_MESSAGE, scrubSecrets,
	type HttpRequest, type HttpResponse, type PairingDeps,
} from "./pairing";
import type { PairedIdentity } from "./api";
import { BAD_VAULT_IDS, testVaultId } from "../keys/testkit/vaultIds";

const CODE = "pc_ABCDEFGHIJKLMNOPQRSTUVWX";
const VAULT = testVaultId("vaultOne");

function counterBytes(): (n: number) => Uint8Array {
	let k = 0;
	return (n) => {
		const b = new Uint8Array(n);
		for (let i = 0; i < n; i++) b[i] = (k++ * 37 + 11) & 255;
		return b;
	};
}

interface Fake {
	readonly calls: HttpRequest[];
	readonly sleeps: number[];
	readonly progress: string[];
	readonly deps: PairingDeps;
}

function fake(responses: readonly (HttpResponse | Error | ((req: HttpRequest) => HttpResponse))[]): Fake {
	const calls: HttpRequest[] = [];
	const sleeps: number[] = [];
	const progress: string[] = [];
	let i = 0;
	return {
		calls,
		sleeps,
		progress,
		deps: {
			request: async (req) => {
				calls.push(req);
				const r = responses[Math.min(i++, responses.length - 1)];
				if (r === undefined) throw new Error("no response scripted");
				if (r instanceof Error) throw r;
				return typeof r === "function" ? r(req) : r;
			},
			sleep: async (ms) => { sleeps.push(ms); },
			randomBytes: counterBytes(),
			onProgress: (t) => progress.push(t),
		},
	};
}

function okEnroll(req: HttpRequest): HttpResponse {
	const b = JSON.parse(req.body ?? "{}") as Record<string, string>;
	return {
		status: 200,
		json: {
			host: "https://sync.example.com", deviceToken: b.deviceToken, vaultId: VAULT, deviceId: b.deviceId,
			deviceName: b.deviceName ?? "Unnamed", vaultGeneration: "gen-7", originImport: false, principalId: "p1",
			role: "owner", membershipRevision: 1, deviceCredentialRevision: 1, capabilities: [],
		},
	};
}

test("base64Url matches the standard encoder without padding", () => {
	for (const len of [0, 1, 2, 3, 4, 5, 16, 32, 33]) {
		const bytes = counterBytes()(len);
		let bin = "";
		for (const x of bytes) bin += String.fromCharCode(x);
		const expected = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		assert.equal(base64Url(bytes), expected, `len ${len}`);
	}
});

test("generated ids satisfy relay-wire §2.4 formats (real crypto)", () => {
	for (let i = 0; i < 50; i++) {
		const id = generateDeviceId();
		const token = generateDeviceToken();
		const rid = generateEnrollmentRequestId();
		assert.match(id, DEVICE_ID_RE);
		assert.equal(id.length, 22);
		assert.match(token, DEVICE_TOKEN_RE);
		assert.equal(token.length, 43);
		assert.match(rid, ENROLLMENT_REQUEST_ID_RE);
	}
	assert.notEqual(generateDeviceToken(), generateDeviceToken());
});

test("normalizeHost", () => {
	assert.equal(normalizeHost(" https://Sync.Example.com/ "), "https://sync.example.com");
	assert.equal(normalizeHost("sync.example.com"), "https://sync.example.com");
	assert.equal(normalizeHost("https://sync.example.com/some/path?x=1#y"), "https://sync.example.com");
	assert.equal(normalizeHost("https://sync.example.com:8443"), "https://sync.example.com:8443");
	assert.equal(normalizeHost("http://localhost:8787"), "http://localhost:8787");
	assert.equal(normalizeHost("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
	for (const bad of ["", "   ", "http://sync.example.com", "ftp://x.com", "https://user:pw@x.com", "https://"]) {
		assert.throws(() => normalizeHost(bad), (e: unknown) => e instanceof PairingError && e.code === "bad_host", bad);
	}
});

test("normalizePairingCode", () => {
	assert.equal(normalizePairingCode(`  ${CODE}\n`), CODE);
	assert.throws(() => normalizePairingCode("short"), PairingError);
	assert.throws(() => normalizePairingCode("has space inside"), PairingError);
	assert.throws(() => normalizePairingCode(""), PairingError);
});

test("enroll: 200 posts the §2.4 body without auth and returns the identity", async () => {
	const f = fake([okEnroll]);
	const id = await enroll({ host: "sync.example.com/", pairingCode: ` ${CODE} `, deviceName: "  My   Mac " }, f.deps);
	assert.equal(f.calls.length, 1);
	const call = f.calls[0]!;
	assert.equal(call.url, "https://sync.example.com/enroll");
	assert.equal(call.method, "POST");
	assert.equal(call.headers?.["Content-Type"], "application/json");
	assert.equal(call.headers?.Authorization, undefined, "enroll must not send a bearer token");
	const body = JSON.parse(call.body ?? "") as Record<string, unknown>;
	assert.deepEqual(Object.keys(body).sort(), ["deviceId", "deviceName", "deviceToken", "enrollmentRequestId", "pairingCode"]);
	assert.equal(body.pairingCode, CODE);
	assert.equal(body.deviceName, "My Mac");
	assert.match(String(body.deviceId), DEVICE_ID_RE);
	assert.match(String(body.deviceToken), DEVICE_TOKEN_RE);
	assert.match(String(body.enrollmentRequestId), ENROLLMENT_REQUEST_ID_RE);
	assert.notEqual(body.deviceId, body.enrollmentRequestId);
	assert.deepEqual(id, {
		host: "https://sync.example.com", vaultId: VAULT, deviceId: body.deviceId, deviceToken: body.deviceToken,
		deviceName: "My Mac", vaultGeneration: "gen-7",
	});
});

test("enroll: empty device name is omitted from the body", async () => {
	const f = fake([okEnroll]);
	await enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "   " }, f.deps);
	const body = JSON.parse(f.calls[0]!.body ?? "") as Record<string, unknown>;
	assert.equal("deviceName" in body, false);
});

test("enroll: 202 authorization_fence_pending retries the identical request with backoff", async () => {
	const pending: HttpResponse = { status: 202, json: { error: "authorization_fence_pending" } };
	const f = fake([pending, pending, okEnroll]);
	const id = await enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, f.deps);
	assert.equal(f.calls.length, 3);
	assert.equal(f.calls[1]!.body, f.calls[0]!.body);
	assert.equal(f.calls[2]!.body, f.calls[0]!.body);
	assert.deepEqual(f.sleeps, [1000, 2000]);
	assert.equal(id.vaultId, VAULT);
	assert.ok(f.progress.some((p) => p.includes("authorize")));
});

test("enroll: 202 forever gives up with a retryable error after the backoff schedule", async () => {
	const f = fake([{ status: 202, json: { error: "authorization_fence_pending" } }]);
	await assert.rejects(
		enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, f.deps),
		(e: unknown) => e instanceof PairingError && e.code === "authorization_fence_pending",
	);
	assert.equal(f.calls.length, FENCE_RETRY_DELAYS_MS.length + 1);
	assert.deepEqual(f.sleeps, [...FENCE_RETRY_DELAYS_MS]);
});

test("enroll: re-running the same attempt reuses the ids (server-side idempotency)", async () => {
	const f = fake([{ status: 202, json: { error: "authorization_fence_pending" } }]);
	const input = { host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" };
	const attempt = prepareEnrollment(input, counterBytes());
	await assert.rejects(runEnrollment(attempt, { ...f.deps, sleep: async () => {} }));
	const g = fake([okEnroll]);
	assert.equal(attemptMatches(attempt, { ...input, pairingCode: ` ${CODE}` }), true);
	assert.equal(attemptMatches(attempt, { ...input, pairingCode: `${CODE}x` }), false);
	assert.equal(attemptMatches(null, input), false);
	const id = await runEnrollment(attempt, g.deps);
	assert.equal(g.calls[0]!.body, f.calls[0]!.body);
	assert.equal(id.deviceToken, attempt.deviceToken);
});

test("enroll: network errors retry twice, then fail with a scrubbed message", async () => {
	const input = { host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" };
	const attempt = prepareEnrollment(input, counterBytes());
	const leaky = new Error(`socket hang up while sending ${attempt.deviceToken} / ${attempt.pairingCode}`);
	const f = fake([leaky]);
	await assert.rejects(runEnrollment(attempt, f.deps), (e: unknown) => {
		assert.ok(e instanceof PairingError);
		assert.equal(e.code, "network");
		assert.equal(e.message.includes(attempt.deviceToken), false);
		assert.equal(e.message.includes(attempt.pairingCode), false);
		assert.ok(e.message.includes("[redacted]"));
		return true;
	});
	assert.equal(f.calls.length, 3);
	assert.deepEqual(f.sleeps, [1000, 2000]);
	const g = fake([new Error("offline"), okEnroll]);
	assert.equal((await runEnrollment(attempt, g.deps)).vaultId, VAULT);
});

test("enroll: error mapping", async () => {
	const cases: [HttpResponse, string, RegExp][] = [
		[{ status: 410, json: { error: "expired_code", message: "x" } }, "expired_code", /expired/],
		[{ status: 409, json: { error: "used_code" } }, "used_code", /already used/],
		[{ status: 404, json: { error: "unknown_code" } }, "unknown_code", /not recognized/],
		[{ status: 400, json: { error: "invalid enrollment request" } }, "invalid_request", /rejected/],
		[{ status: 404, json: null }, "not_found", /No YAOS enrollment endpoint/],
		[{ status: 429, json: {} }, "rate_limited", /Too many/],
		[{ status: 503, json: { error: "cf_daily_limit", resetAt: 1 } }, "cf_daily_limit", /daily/],
		[{ status: 500, json: "oops" }, "server_error", /HTTP 500/],
		[{ status: 418, json: { error: "<script>alert(1)</script>" } }, "http_error", /HTTP 418\)/],
	];
	for (const [res, code, re] of cases) {
		const f = fake([res]);
		await assert.rejects(
			enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, f.deps),
			(e: unknown) => {
				assert.ok(e instanceof PairingError, `${res.status}`);
				assert.equal(e.code, code);
				assert.match(e.message, re);
				assert.equal(e.message.includes("<script>"), false);
				assert.equal(e.message.includes(CODE), false);
				return true;
			},
		);
	}
});

test("enroll: 503 vault_draining is retried", async () => {
	const f = fake([{ status: 503, json: { error: "vault_draining" } }, okEnroll]);
	const id = await enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, f.deps);
	assert.equal(id.vaultId, VAULT);
	assert.equal(f.calls.length, 2);
});

test("enroll: rejects mismatched or incomplete 200 responses", async () => {
	const bad: ((req: HttpRequest) => HttpResponse)[] = [
		(req) => ({ ...okEnroll(req), json: { ...(okEnroll(req).json as object), vaultId: "" } }),
		(req) => ({ ...okEnroll(req), json: { ...(okEnroll(req).json as object), deviceId: "someone-elses-device" } }),
		(req) => ({ ...okEnroll(req), json: { ...(okEnroll(req).json as object), deviceToken: "x".repeat(43) } }),
		(req) => ({ ...okEnroll(req), json: { ...(okEnroll(req).json as object), host: "https://evil.example.com" } }),
		() => ({ status: 200, json: null }),
	];
	for (const respond of bad) {
		const f = fake([respond]);
		await assert.rejects(enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, f.deps), PairingError);
	}
});

test("enroll: a 200 whose vaultId is not exactly 22-char canonical base64url is incomplete (the server's word is not enough)", async () => {
	for (const vaultId of [...BAD_VAULT_IDS, 7, null]) {
		const f = fake([(req) => ({ ...okEnroll(req), json: { ...(okEnroll(req).json as object), vaultId } })]);
		await assert.rejects(
			enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, f.deps),
			(e: unknown) => e instanceof PairingError && e.code === "enroll_response_invalid",
			JSON.stringify(vaultId),
		);
	}
});

test("enroll: missing vaultGeneration is null", async () => {
	const f = fake([(req) => {
		const j = { ...(okEnroll(req).json as Record<string, unknown>) };
		delete j.vaultGeneration;
		return { status: 200, json: j };
	}]);
	const id = await enroll({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, f.deps);
	assert.equal(id.vaultGeneration, null);
});

test("fetchCapabilities requires streams === 1 and a claimed server", async () => {
	const ok = fake([{ status: 200, json: { claimed: true, streams: 1, attachments: true, maxBlobUploadBytes: 10485760, serverVersion: "1.0.0" } }]);
	const caps = await fetchCapabilities("https://sync.example.com/", ok.deps);
	assert.equal(ok.calls[0]!.url, "https://sync.example.com/api/capabilities");
	assert.equal(ok.calls[0]!.method, "GET");
	assert.equal(ok.calls[0]!.headers?.Authorization, undefined);
	assert.deepEqual(caps, { claimed: true, streams: 1, attachments: true, maxBlobUploadBytes: 10485760, serverVersion: "1.0.0" });

	const legacy = fake([{ status: 200, json: { claimed: true, attachments: false } }]);
	await assert.rejects(fetchCapabilities("https://sync.example.com", legacy.deps), (e: unknown) => e instanceof PairingError && e.code === "no_streams");
	const v2 = fake([{ status: 200, json: { claimed: true, streams: 2 } }]);
	await assert.rejects(fetchCapabilities("https://sync.example.com", v2.deps), (e: unknown) => e instanceof PairingError && e.code === "no_streams");
	const unclaimed = fake([{ status: 200, json: { claimed: false, streams: 1 } }]);
	await assert.rejects(fetchCapabilities("https://sync.example.com", unclaimed.deps), (e: unknown) => e instanceof PairingError && e.code === "unclaimed");
	const nf = fake([{ status: 404, json: null }]);
	await assert.rejects(fetchCapabilities("https://sync.example.com", nf.deps), (e: unknown) => e instanceof PairingError && e.code === "not_found");
});

test("pairDevice checks capabilities before enrolling", async () => {
	const f = fake([{ status: 200, json: { claimed: true, streams: 1 } }, okEnroll]);
	const attempt = prepareEnrollment({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }, counterBytes());
	await pairDevice(attempt, f.deps);
	assert.deepEqual(f.calls.map((c) => c.url), ["https://sync.example.com/api/capabilities", "https://sync.example.com/enroll"]);
	const g = fake([{ status: 200, json: { claimed: true } }, okEnroll]);
	await assert.rejects(pairDevice(attempt, g.deps), PairingError);
	assert.equal(g.calls.length, 1, "no enroll call when the server lacks streams");
});

const IDENTITY: PairedIdentity = {
	host: "https://sync.example.com",
	vaultId: VAULT,
	deviceId: "dev_AAAAAAAAAAAAAAAA",
	deviceToken: "tok_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	deviceName: "Mac",
	vaultGeneration: "gen-7",
};

test("requestPairingCode sends Bearer + purpose device and builds the setup link", async () => {
	const f = fake([{ status: 200, json: { codeId: "c1", pairingCode: CODE, expiresAt: 1_700_000_900_000, purpose: "device-link", mobileSetupUrl: `https://sync.example.com/mobile-setup#x` } }]);
	const grant = await requestPairingCode(IDENTITY, f.deps);
	const call = f.calls[0]!;
	assert.equal(call.url, `https://sync.example.com/vault/${VAULT}/auth/pairing-code`);
	assert.equal(call.method, "POST");
	assert.equal(call.headers?.Authorization, `Bearer ${IDENTITY.deviceToken}`);
	assert.deepEqual(JSON.parse(call.body ?? ""), { purpose: "device" });
	assert.equal(grant.pairingCode, CODE);
	assert.equal(grant.expiresAt, 1_700_000_900_000);
	assert.equal(grant.mobileSetupUrl, "https://sync.example.com/mobile-setup#x");
	assert.equal(grant.setupLink, `obsidian://yaos?action=setup&host=https%3A%2F%2Fsync.example.com&pairingCode=${CODE}`);
	const parsed = parseSetupLink(Object.fromEntries(new URL(grant.setupLink).searchParams));
	assert.deepEqual(parsed, { ok: true, host: "https://sync.example.com", pairingCode: CODE });
});

test("requestPairingCode: missing expiry defaults to 15 min, foreign mobile URL dropped", async () => {
	const f = fake([{ status: 200, json: { pairingCode: CODE, mobileSetupUrl: "https://evil.example.com/x" } }]);
	const grant = await requestPairingCode(IDENTITY, { ...f.deps, nowMs: () => 1000 });
	assert.equal(grant.expiresAt, 1000 + 15 * 60 * 1000);
	assert.equal(grant.mobileSetupUrl, null);
});

test("requestPairingCode: error mapping never echoes the token", async () => {
	for (const [status, code] of [[401, "unauthorized"], [403, "capability_denied"], [404, "unknown_vault"], [409, "vault_destroyed"], [500, "x"]] as const) {
		const f = fake([{ status, json: { error: code } }]);
		await assert.rejects(requestPairingCode(IDENTITY, f.deps), (e: unknown) => {
			assert.ok(e instanceof PairingError);
			assert.equal(e.status, status);
			assert.equal(e.message.includes(IDENTITY.deviceToken), false);
			return true;
		});
	}
	const f = fake([{ status: 200, json: { pairingCode: "x" } }]);
	await assert.rejects(requestPairingCode(IDENTITY, f.deps), (e: unknown) => e instanceof PairingError && e.code === "code_response_invalid");
});

test("retireDeviceEnrollment: DELETE auth/device with the old Bearer token; 200 and 401 are done", async () => {
	for (const status of [200, 401]) {
		const f = fake([{ status, json: status === 200 ? { ok: true, pending: false } : { error: "unauthorized" } }]);
		await retireDeviceEnrollment(IDENTITY, f.deps);
		assert.equal(f.calls.length, 1);
		const call = f.calls[0]!;
		assert.equal(call.url, `https://sync.example.com/vault/${VAULT}/auth/device`);
		assert.equal(call.method, "DELETE");
		assert.deepEqual(call.headers, { Authorization: `Bearer ${IDENTITY.deviceToken}` });
		assert.equal(call.body, undefined);
	}
});

test("retireDeviceEnrollment: other statuses and network errors give the console hint and never echo the token", async () => {
	const cases: [HttpResponse | Error, string, number | null][] = [
		[{ status: 500, json: { error: "internal" } }, "internal", 500],
		[{ status: 202, json: { error: "authorization_fence_pending", pending: true } }, "authorization_fence_pending", 202],
		[{ status: 404, json: null }, "http_error", 404],
		[new Error(`connect ECONNREFUSED (Bearer ${IDENTITY.deviceToken})`), "network", null],
	];
	for (const [response, code, status] of cases) {
		const f = fake([response]);
		await assert.rejects(retireDeviceEnrollment(IDENTITY, f.deps), (e: unknown) => {
			assert.ok(e instanceof PairingError);
			assert.equal(e.message, RETIRE_FAILED_MESSAGE);
			assert.equal(e.code, code);
			assert.equal(e.status, status);
			assert.equal(`${e.message} ${e.code} ${String(e.stack)}`.includes(IDENTITY.deviceToken), false);
			return true;
		});
	}
	const bad = fake([{ status: 200, json: null }]);
	await assert.rejects(retireDeviceEnrollment({ ...IDENTITY, host: "http://example.com" }, bad.deps), (e: unknown) => e instanceof PairingError && e.code === "bad_host");
	assert.equal(bad.calls.length, 0, "no request to a non-https host");
});

test("parseSetupLink accepts host + pairing code only", () => {
	assert.deepEqual(parseSetupLink({ action: "yaos", host: "https://sync.example.com/", pairingCode: CODE }), { ok: true, host: "https://sync.example.com", pairingCode: CODE });
	assert.deepEqual(parseSetupLink({ action: "setup", host: "sync.example.com", pairingCode: CODE, vault: "Notes" }), { ok: true, host: "https://sync.example.com", pairingCode: CODE });
	const rejects: Record<string, string>[] = [
		{ action: "yaos", host: "https://sync.example.com" },
		{ action: "yaos", pairingCode: CODE },
		{ action: "yaos", host: "https://sync.example.com", pairingCode: CODE, deviceToken: "t".repeat(43) },
		{ action: "yaos", host: "https://sync.example.com", pairingCode: CODE, vaultId: VAULT }, // even a well-formed vaultId: the link never names the vault
		{ action: "other", host: "https://sync.example.com", pairingCode: CODE },
		{ action: "yaos", host: "http://sync.example.com", pairingCode: CODE },
		{ action: "yaos", host: "https://sync.example.com", pairingCode: "short" },
	];
	for (const p of rejects) {
		const r = parseSetupLink(p);
		assert.equal(r.ok, false, JSON.stringify(Object.keys(p)));
		if (!r.ok) assert.equal(r.reason.includes(CODE), false);
	}
});

test("buildSetupLink matches the server's link shape", () => {
	assert.equal(buildSetupLink("https://sync.example.com/", "a+b/c=d_12"), "obsidian://yaos?action=setup&host=https%3A%2F%2Fsync.example.com&pairingCode=a%2Bb%2Fc%3Dd_12");
});

test("scrubSecrets", () => {
	assert.equal(scrubSecrets("a SECRET b SECRET", ["SECRET"]), "a [redacted] b [redacted]");
	assert.equal(scrubSecrets("abc", ["", "ab"]), "abc", "secrets shorter than 4 chars are ignored");
});
