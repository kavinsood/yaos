import { test } from "node:test";
import assert from "node:assert/strict";
import {
	base64Url, buildSetupLink, DEVICE_ID_RE, DEVICE_TOKEN_RE, ENROLLMENT_REQUEST_ID_RE, enroll, fetchCapabilities,
	FENCE_RETRY_DELAYS_MS, generateDeviceId, generateDeviceToken, generateEnrollmentRequestId, normalizeHost,
	normalizePairingCode, PairingError, parseSetupLink, prepareEnrollment, requestPairingCode, runEnrollment,
	attemptMatches, pairDevice, retireDeviceEnrollment, RETIRE_FAILED_MESSAGE, scrubSecrets,
	buildRekeyLink, claimServer, decodeKeyParam, encodeKeyParam, generateOperatorKey, normalizeOperatorKey, operatorCreateVault,
	operatorLogin, operatorLogout, pairingCodeVaultId,
	type HttpRequest, type HttpResponse, type LinkKey, type PairingDeps,
} from "./pairing";
import type { PairedIdentity } from "./api";
import { BAD_VAULT_IDS, testVaultId } from "../keys/testkit/vaultIds";

const CODE = "pc_ABCDEFGHIJKLMNOPQRSTUVWX";
const VAULT = testVaultId("vaultOne");
/** A code as the server mints it, `<vaultId>.<secret>` (DECISIONS D3). */
const VCODE = `${VAULT}.pcSecretPcSecretPcSecret01`;

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
	// Only "Create a new vault" accepts an unclaimed server (§15.1 step 1 claims it).
	const unclaimedOk = fake([{ status: 200, json: { claimed: false, streams: 1 } }]);
	assert.equal((await fetchCapabilities("https://sync.example.com", unclaimedOk.deps, { allowUnclaimed: true })).claimed, false);
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

test("requestPairingCode sends Bearer + purpose device; the grant is the code and its expiry only (no server-drawn page)", async () => {
	const f = fake([{ status: 200, json: { codeId: "c1", pairingCode: VCODE, expiresAt: 1_700_000_900_000, purpose: "device-link", mobileSetupUrl: `https://sync.example.com/mobile-setup#x` } }]);
	const grant = await requestPairingCode(IDENTITY, f.deps);
	const call = f.calls[0]!;
	assert.equal(call.url, `https://sync.example.com/vault/${VAULT}/auth/pairing-code`);
	assert.equal(call.method, "POST");
	assert.equal(call.headers?.Authorization, `Bearer ${IDENTITY.deviceToken}`);
	assert.deepEqual(JSON.parse(call.body ?? ""), { purpose: "device" });
	// §12.1: the server's mobileSetupUrl is dropped; the plugin draws its own QR with the key.
	assert.deepEqual(grant, { pairingCode: VCODE, expiresAt: 1_700_000_900_000 });
});

test("requestPairingCode: missing expiry defaults to 15 min", async () => {
	const f = fake([{ status: 200, json: { pairingCode: VCODE, mobileSetupUrl: "https://evil.example.com/x" } }]);
	const grant = await requestPairingCode(IDENTITY, { ...f.deps, nowMs: () => 1000 });
	assert.deepEqual(grant, { pairingCode: VCODE, expiresAt: 1000 + 15 * 60 * 1000 });
});

test("requestPairingCode: a code that names another vault, or none, is refused (D3)", async () => {
	for (const code of [`${testVaultId("other")}.pcSecretPcSecretPcSecret01`, CODE]) {
		const f = fake([{ status: 200, json: { pairingCode: code } }]);
		await assert.rejects(requestPairingCode(IDENTITY, f.deps), (e: unknown) => {
			assert.ok(e instanceof PairingError && e.code === "code_response_invalid");
			assert.ok(!e.message.includes(code));
			return true;
		});
	}
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

test("parseSetupLink accepts host + pairing code, with at most one of key and suite=0", () => {
	assert.deepEqual(parseSetupLink({ action: "yaos", host: "https://sync.example.com/", pairingCode: CODE }), { ok: true, kind: "setup", host: "https://sync.example.com", pairingCode: CODE, e2ee: null });
	assert.deepEqual(parseSetupLink({ action: "setup", host: "sync.example.com", pairingCode: CODE, vault: "Notes" }), { ok: true, kind: "setup", host: "https://sync.example.com", pairingCode: CODE, e2ee: null });
	assert.deepEqual(parseSetupLink({ action: "setup", host: "https://sync.example.com", pairingCode: CODE, suite: "0" }), { ok: true, kind: "setup", host: "https://sync.example.com", pairingCode: CODE, e2ee: { suite: 0 } });
	const withKey = parseSetupLink({ action: "setup", host: "https://sync.example.com", pairingCode: CODE, key: GOLDEN_KEY_PARAM });
	assert.ok(withKey.ok && withKey.kind === "setup" && withKey.e2ee?.suite === 1);
	assert.equal(withKey.e2ee.key.e, 1);
	assert.deepEqual([...withKey.e2ee.key.k], [...GOLDEN_K]);
	const rejects: Record<string, string>[] = [
		{ action: "yaos", host: "https://sync.example.com" },
		{ action: "yaos", pairingCode: CODE },
		{ action: "yaos", host: "https://sync.example.com", pairingCode: CODE, deviceToken: "t".repeat(43) },
		{ action: "yaos", host: "https://sync.example.com", pairingCode: CODE, vaultId: VAULT }, // even a well-formed vaultId: the link never names the vault
		{ action: "other", host: "https://sync.example.com", pairingCode: CODE },
		{ action: "yaos", host: "http://sync.example.com", pairingCode: CODE },
		{ action: "yaos", host: "https://sync.example.com", pairingCode: "short" },
		// §12.4: key or suite=0, never both, and no other suite value.
		{ action: "setup", host: "https://sync.example.com", pairingCode: CODE, key: GOLDEN_KEY_PARAM, suite: "0" },
		{ action: "setup", host: "https://sync.example.com", pairingCode: CODE, suite: "1" },
		{ action: "setup", host: "https://sync.example.com", pairingCode: CODE, suite: "2" },
		{ action: "setup", host: "https://sync.example.com", pairingCode: CODE, suite: "" },
		{ action: "setup", host: "https://sync.example.com", pairingCode: CODE, suite: " 0" },
		{ action: "setup", host: "https://sync.example.com", pairingCode: CODE, key: GOLDEN_KEY_PARAM.slice(0, -1) },
		{ action: "setup", host: "https://sync.example.com", pairingCode: CODE, key: "" },
		// A re-key link carries only the key.
		{ action: "rekey", host: "https://sync.example.com", key: GOLDEN_KEY_PARAM },
		{ action: "rekey", pairingCode: CODE, key: GOLDEN_KEY_PARAM },
		{ action: "rekey", key: GOLDEN_KEY_PARAM, suite: "0" },
		{ action: "rekey" },
	];
	for (const p of rejects) {
		const r = parseSetupLink(p);
		assert.equal(r.ok, false, JSON.stringify(p).replace(GOLDEN_KEY_PARAM, "<key>"));
		if (!r.ok) {
			assert.equal(r.reason.includes(CODE), false);
			assert.equal(r.reason.includes(GOLDEN_KEY_PARAM.slice(0, 12)), false);
		}
	}
});

test("parseSetupLink: a re-key link carries only the key", () => {
	for (const params of [{ action: "rekey", key: GOLDEN_KEY_PARAM }, { action: "yaos", key: GOLDEN_KEY_PARAM }]) {
		const r = parseSetupLink(params);
		assert.ok(r.ok && r.kind === "rekey");
		assert.equal(r.key.e, 1);
		assert.deepEqual([...r.key.k], [...GOLDEN_K]);
	}
});

test("buildSetupLink matches the server's link shape", () => {
	assert.equal(buildSetupLink("https://sync.example.com/", "a+b/c=d_12"), "obsidian://yaos?action=setup&host=https%3A%2F%2Fsync.example.com&pairingCode=a%2Bb%2Fc%3Dd_12");
});

// §20.1 golden vector: K = 00..1f, e = 1. A fixture key, not a secret.
const GOLDEN_K = Uint8Array.from({ length: 32 }, (_, i) => i);
const GOLDEN_KEY_PARAM = "AQEAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw";
const GOLDEN_CODE = `${testVaultId("golden")}.goldenSecret0123456789`;

test("setup link golden vector (§20.1): key = b64url(u8 1 ‖ varuint e ‖ K_e)", () => {
	const key = (e: number): LinkKey => ({ e, k: GOLDEN_K.slice() });
	assert.equal(encodeKeyParam(key(1)), GOLDEN_KEY_PARAM);
	assert.equal(encodeKeyParam(key(300)), "AawCAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
	assert.equal(
		buildSetupLink("https://sync.example.com", GOLDEN_CODE, { suite: 1, key: key(1) }),
		"obsidian://yaos?action=setup&host=https%3A%2F%2Fsync.example.com&pairingCode=goldenAAAAAAAAAAAAAAAA.goldenSecret0123456789&key=AQEAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw",
	);
	assert.equal(
		buildSetupLink("https://sync.example.com", GOLDEN_CODE, { suite: 0 }),
		"obsidian://yaos?action=setup&host=https%3A%2F%2Fsync.example.com&pairingCode=goldenAAAAAAAAAAAAAAAA.goldenSecret0123456789&suite=0",
	);
	assert.equal(buildRekeyLink(key(1)), "obsidian://yaos?action=rekey&key=AQEAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw");
	// Round trip through Obsidian's param shape.
	const link = buildSetupLink("https://sync.example.com", GOLDEN_CODE, { suite: 1, key: key(1) });
	const parsed = parseSetupLink(Object.fromEntries(new URL(link).searchParams));
	assert.ok(parsed.ok && parsed.kind === "setup" && parsed.e2ee?.suite === 1);
	assert.equal(parsed.pairingCode, GOLDEN_CODE);
	assert.equal(pairingCodeVaultId(parsed.pairingCode), testVaultId("golden"));
	assert.deepEqual([...parsed.e2ee.key.k], [...GOLDEN_K]);
});

test("decodeKeyParam is strict: version 1, epoch >= 1 (minimal), exactly 32 key bytes, canonical base64url", () => {
	const big = encodeKeyParam({ e: Number.MAX_SAFE_INTEGER, k: GOLDEN_K.slice() });
	assert.equal(decodeKeyParam(big)?.e, Number.MAX_SAFE_INTEGER);
	const b64 = (bytes: number[]) => base64Url(Uint8Array.from(bytes));
	const k = [...GOLDEN_K];
	assert.equal(decodeKeyParam(b64([1, 1, ...k]))?.e, 1);
	for (const bad of [
		b64([2, 1, ...k]), // version 2
		b64([1, 0, ...k]), // epoch 0
		b64([1, 0x81, 0x00, ...k]), // non-minimal varuint
		b64([1, 1, ...k.slice(1)]), // 31 key bytes
		b64([1, 1, ...k, 0]), // trailing byte
		`${GOLDEN_KEY_PARAM}=`, // padded
		GOLDEN_KEY_PARAM.replace(/^A/, "+"), // standard alphabet
		GOLDEN_KEY_PARAM.slice(0, -1) + "x", // non-canonical last char
		"A".repeat(57),
	]) assert.equal(decodeKeyParam(bad), null, bad.slice(0, 8));
	assert.throws(() => encodeKeyParam({ e: 0, k: GOLDEN_K.slice() }), PairingError);
	assert.throws(() => encodeKeyParam({ e: 1, k: new Uint8Array(31) }), PairingError);
});

test("pairingCodeVaultId reads the vaultId half of <vaultId>.<secret> and nothing else", () => {
	assert.equal(pairingCodeVaultId(VCODE), VAULT);
	assert.equal(pairingCodeVaultId(` ${VCODE} `), VAULT);
	assert.equal(pairingCodeVaultId(CODE), null);
	assert.equal(pairingCodeVaultId(`.${VAULT}`), null);
	// The code is trimmed as a whole, so only ids without surrounding whitespace test the vaultId rule itself.
	for (const bad of BAD_VAULT_IDS.filter((b) => b !== "" && b.trim() === b)) assert.equal(pairingCodeVaultId(`${bad}.secret`), null, bad);
});

test("enroll from a link with a key: the /enroll body carries only the code, never the key (§12.1)", async () => {
	const link = buildSetupLink("https://sync.example.com", VCODE, { suite: 1, key: { e: 1, k: GOLDEN_K.slice() } });
	const parsed = parseSetupLink(Object.fromEntries(new URL(link).searchParams));
	assert.ok(parsed.ok && parsed.kind === "setup");
	const f = fake([okEnroll]);
	await enroll({ host: parsed.host, pairingCode: parsed.pairingCode, deviceName: "Mac" }, f.deps);
	assert.equal(f.calls.length, 1);
	const call = f.calls[0]!;
	assert.equal(call.url, "https://sync.example.com/enroll");
	const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
	assert.deepEqual(Object.keys(body).sort(), ["deviceId", "deviceName", "deviceToken", "enrollmentRequestId", "pairingCode"]);
	assert.equal(body.pairingCode, VCODE);
	const wire = `${call.url} ${call.body} ${JSON.stringify(call.headers ?? {})}`;
	for (const leak of [GOLDEN_KEY_PARAM, "key=", "suite", Buffer.from(GOLDEN_K).toString("hex"), Buffer.from(GOLDEN_K).toString("base64")]) assert.ok(!wire.includes(leak), leak);
});

// ---------------------------------------------------------------------------
// Operator routes (§15.1 step 1)
// ---------------------------------------------------------------------------

const OP_KEY = "opkey-" + "q".repeat(40);
const SESSION_TOKEN = "S".repeat(43);
const OP_HOST = "https://sync.example.com";

function claimOk(vaultId: string, cookie: string | readonly string[] = `yaos_op=${SESSION_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict`): HttpResponse {
	return {
		status: 200,
		json: { ok: true, host: OP_HOST, vaultId, vaultName: "Personal", pairingCode: `${vaultId}.ownerSecretOwnerSecret01`, obsidianUrl: "obsidian://yaos?action=setup", capabilities: {} },
		headers: { "set-cookie": cookie },
	};
}

test("operator keys: generated as 32 random bytes hex; normalized by trimming; short ones refused", () => {
	const k = generateOperatorKey(counterBytes());
	assert.match(k, /^[0-9a-f]{64}$/);
	assert.notEqual(generateOperatorKey(), generateOperatorKey());
	assert.equal(normalizeOperatorKey(`  ${OP_KEY}\n`), OP_KEY);
	assert.throws(() => normalizeOperatorKey("x".repeat(31)), (e: unknown) => e instanceof PairingError && e.code === "bad_operator_key" && !e.message.includes("x".repeat(31)));
});

test("claimServer: JSON + explicit Origin, the key only in the body; the session cookie from an array or a joined string", async () => {
	const vaultId = testVaultId("claimed");
	for (const cookie of [[`other=1; Path=/`, `yaos_op=${SESSION_TOKEN}; Path=/; HttpOnly`], `other=1; Path=/, yaos_op=${SESSION_TOKEN}; Path=/; HttpOnly`]) {
		const f = fake([claimOk(vaultId, cookie)]);
		const { vault, session } = await claimServer("sync.example.com/", OP_KEY, f.deps);
		assert.deepEqual(vault, { host: OP_HOST, vaultId, pairingCode: `${vaultId}.ownerSecretOwnerSecret01` });
		assert.deepEqual(session, { host: OP_HOST, token: SESSION_TOKEN });
		const call = f.calls[0]!;
		assert.equal(call.url, `${OP_HOST}/claim`);
		assert.equal(call.method, "POST");
		assert.deepEqual(call.headers, { "Content-Type": "application/json", Origin: OP_HOST });
		assert.deepEqual(JSON.parse(call.body ?? ""), { operatorRecoveryKey: OP_KEY });
	}
	// No (or a malformed) cookie is fine for a claim: the session is not needed.
	const f = fake([claimOk(vaultId, "yaos_op=short")]);
	assert.equal((await claimServer(OP_HOST, OP_KEY, f.deps)).session, null);
});

test("operator routes: error mapping never echoes the operator key or the session", async () => {
	const cases: [HttpResponse, string][] = [
		[{ status: 403, json: { error: "forbidden_origin" } }, "forbidden_origin"],
		[{ status: 415, json: { error: "unsupported_media_type" } }, "unsupported_media_type"],
		[{ status: 401, json: { error: "unauthorized" } }, "unauthorized"],
		[{ status: 409, json: { error: "already_claimed" } }, "already_claimed"],
		[{ status: 503, json: { error: "claim_incomplete" }, headers: { "set-cookie": `yaos_op=${SESSION_TOKEN}` } }, "claim_incomplete"],
		[{ status: 400, json: { error: "invalid operatorRecoveryKey" } }, "bad_operator_key"],
		[{ status: 429, json: { error: "too_many_attempts" }, headers: { "retry-after": "42" } }, "too_many_attempts"],
		[{ status: 500, json: { error: "internal" } }, "internal"],
	];
	for (const [res, code] of cases) {
		const f = fake([res, { status: 200, json: { ok: true } }]);
		await assert.rejects(claimServer(OP_HOST, OP_KEY, f.deps), (e: unknown) => {
			assert.ok(e instanceof PairingError, code);
			assert.equal(e.code, code);
			assert.ok(!`${e.message} ${String(e.stack)}`.includes(OP_KEY) && !e.message.includes(SESSION_TOKEN));
			if (code === "too_many_attempts") assert.match(e.message, /42 s/);
			return true;
		});
		// A failed claim that still set a session ends it.
		if (code === "claim_incomplete") assert.equal(f.calls[1]?.url, `${OP_HOST}/operator/logout`);
	}
	const net = fake([new Error(`ECONNRESET while sending ${OP_KEY}`)]);
	await assert.rejects(operatorLogin(OP_HOST, OP_KEY, net.deps), (e: unknown) => e instanceof PairingError && e.code === "network" && !e.message.includes(OP_KEY));
});

test("operatorLogin needs the session cookie; operatorCreateVault sends it with Origin, then mints the owner code; logout never throws", async () => {
	const noCookie = fake([{ status: 200, json: { ok: true } }]);
	await assert.rejects(operatorLogin(OP_HOST, OP_KEY, noCookie.deps), (e: unknown) => e instanceof PairingError && e.code === "no_session");

	const vaultId = testVaultId("created");
	const f = fake([
		{ status: 200, json: { ok: true }, headers: { "set-cookie": [`yaos_op=${SESSION_TOKEN}; Path=/; HttpOnly`] } },
		{ status: 200, json: { ok: true, vault: { vaultId, name: "Notes" } } },
		{ status: 200, json: { ok: true, pairingCode: `${vaultId}.ownerSecretOwnerSecret01` } },
	]);
	const session = await operatorLogin(OP_HOST, OP_KEY, f.deps);
	const vault = await operatorCreateVault(session, "  My   notes ", f.deps);
	assert.deepEqual(vault, { host: OP_HOST, vaultId, pairingCode: `${vaultId}.ownerSecretOwnerSecret01` });
	assert.deepEqual(f.calls.map((c) => c.url), [`${OP_HOST}/operator/login`, `${OP_HOST}/operator/vaults`, `${OP_HOST}/operator/vaults/${vaultId}/owner-code`]);
	for (const c of f.calls.slice(1)) assert.deepEqual(c.headers, { "Content-Type": "application/json", Origin: OP_HOST, Cookie: `yaos_op=${SESSION_TOKEN}` });
	assert.deepEqual(JSON.parse(f.calls[1]!.body ?? ""), { name: "My notes" });
	assert.deepEqual(JSON.parse(f.calls[2]!.body ?? ""), { purpose: "owner-bootstrap" });
	assert.ok(f.calls.slice(1).every((c) => !(c.body ?? "").includes(OP_KEY)), "the key goes only to login");

	const down = fake([new Error("offline")]);
	await operatorLogout(session, down.deps);
	assert.equal(down.calls[0]!.url, `${OP_HOST}/operator/logout`);
	assert.equal(down.calls[0]!.headers?.Cookie, `yaos_op=${SESSION_TOKEN}`);
	assert.equal(down.calls[0]!.headers?.Origin, OP_HOST);
});

test("scrubSecrets", () => {
	assert.equal(scrubSecrets("a SECRET b SECRET", ["SECRET"]), "a [redacted] b [redacted]");
	assert.equal(scrubSecrets("abc", ["", "ab"]), "abc", "secrets shorter than 4 chars are ignored");
});
