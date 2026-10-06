import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyPairedIdentity, clearIdentity, enrollmentFailureIsFinal, formatCountdown, PairingSession, resumePendingEnrollment,
	setPendingEnrollment, withoutPendingEnrollment,
} from "./pairFlow";
import { PairingError, prepareEnrollment, type HttpRequest, type HttpResponse, type PairingDeps } from "./pairing";
import { defaultPluginData, sanitizePluginData, type PairedIdentity, type YaosPluginData } from "./api";

const CODE = "pc_ABCDEFGHIJKLMNOPQRSTUVWX";
const CAPS: HttpResponse = { status: 200, json: { claimed: true, streams: 1 } };

function okEnroll(req: HttpRequest): HttpResponse {
	const b = JSON.parse(req.body ?? "{}") as Record<string, string>;
	return { status: 200, json: { host: "https://sync.example.com", deviceToken: b.deviceToken, vaultId: "vault-1", deviceId: b.deviceId, deviceName: b.deviceName ?? "", vaultGeneration: "g1" } };
}

function scripted(responses: (HttpResponse | Error | ((r: HttpRequest) => HttpResponse))[]) {
	const calls: HttpRequest[] = [];
	let i = 0;
	const deps: PairingDeps = {
		request: async (req) => {
			calls.push(req);
			const r = responses[Math.min(i++, responses.length - 1)];
			if (!r) throw new Error("unscripted");
			if (r instanceof Error) throw r;
			return typeof r === "function" ? r(req) : r;
		},
		sleep: async () => {},
	};
	return { calls, deps };
}

const enrollBodies = (calls: HttpRequest[]) => calls.filter((c) => c.url.endsWith("/enroll")).map((c) => JSON.parse(c.body ?? "{}") as Record<string, string>);

test("PairingSession reuses the attempt for a retry of the same input, and drops it on success", async () => {
	const s = scripted([CAPS, { status: 500, json: { error: "internal" } }, CAPS, okEnroll]);
	const session = new PairingSession(s.deps);
	const input = { host: "sync.example.com", pairingCode: CODE, deviceName: "Mac" };
	await assert.rejects(session.submit(input), PairingError);
	assert.equal(session.hasPendingAttempt, true);
	const identity = await session.submit({ ...input, host: "https://sync.example.com/" });
	assert.equal(session.hasPendingAttempt, false);
	const [first, second] = enrollBodies(s.calls);
	assert.ok(first && second);
	assert.equal(first.enrollmentRequestId, second.enrollmentRequestId);
	assert.equal(first.deviceToken, second.deviceToken);
	assert.equal(identity.deviceToken, second.deviceToken);
	assert.equal(identity.vaultId, "vault-1");
});

test("PairingSession uses a fresh attempt when the input changes or after clear()", async () => {
	const s = scripted([CAPS, { status: 404, json: { error: "unknown_code" } }, CAPS, { status: 404, json: { error: "unknown_code" } }, CAPS, { status: 404, json: { error: "unknown_code" } }]);
	const session = new PairingSession(s.deps);
	const input = { host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" };
	await assert.rejects(session.submit(input));
	await assert.rejects(session.submit({ ...input, pairingCode: `${CODE}X` }));
	session.clear();
	assert.equal(session.hasPendingAttempt, false);
	await assert.rejects(session.submit({ ...input, pairingCode: `${CODE}X` }));
	const ids = enrollBodies(s.calls).map((b) => b.enrollmentRequestId);
	assert.equal(new Set(ids).size, 3);
});

test("PairingSession is single-flight and rejects bad input before any request", async () => {
	let release: (r: HttpResponse) => void = () => {};
	const calls: HttpRequest[] = [];
	const session = new PairingSession({
		request: (req) => { calls.push(req); return new Promise<HttpResponse>((r) => { release = r; }); },
		sleep: async () => {},
	});
	const first = session.submit({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "" });
	assert.equal(session.busy, true);
	await assert.rejects(session.submit({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "" }), (e: unknown) => e instanceof PairingError && e.code === "busy");
	release({ status: 200, json: { claimed: true, streams: 0 } });
	await assert.rejects(first);
	assert.equal(session.busy, false);
	await assert.rejects(session.submit({ host: "http://evil.example.com", pairingCode: CODE, deviceName: "" }), (e: unknown) => e instanceof PairingError && e.code === "bad_host");
	await assert.rejects(session.submit({ host: "https://sync.example.com", pairingCode: "short", deviceName: "" }), (e: unknown) => e instanceof PairingError && e.code === "bad_code");
	assert.equal(calls.length, 1);
});

test("applyPairedIdentity / clearIdentity", () => {
	const identity: PairedIdentity = { host: "https://h.example", vaultId: "v", deviceId: "dev_AAAAAAAAAAAAAAAA", deviceToken: "t".repeat(43), deviceName: "Work laptop", vaultGeneration: null };
	const d = defaultPluginData("Mac");
	const paired = applyPairedIdentity(d, identity);
	assert.equal(paired.identity, identity);
	assert.equal(paired.deviceLabel, "Work laptop");
	assert.equal(applyPairedIdentity(d, { ...identity, deviceName: "" }).deviceLabel, "Mac");
	assert.equal(clearIdentity(paired).identity, null);
	assert.equal(clearIdentity(paired).deviceLabel, "Work laptop");
	assert.equal(clearIdentity(d), d);
});

test("formatCountdown", () => {
	assert.equal(formatCountdown(15 * 60_000), "15:00");
	assert.equal(formatCountdown(61_001), "1:02");
	assert.equal(formatCountdown(999), "0:01");
	assert.equal(formatCountdown(-5), "0:00");
	assert.equal(formatCountdown(Number.NaN), "0:00");
});

function memHost(initial: YaosPluginData) {
	let d = initial;
	return { data: () => d, updateData: async (m: (x: YaosPluginData) => YaosPluginData) => { d = m(d); } };
}
const pendingData = () => setPendingEnrollment(defaultPluginData("Mac"), prepareEnrollment({ host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" }));

test("PairingSession stores the attempt before /enroll, keeps it when the server is unreachable, drops it on a definitive refusal", async () => {
	const h = memHost(defaultPluginData("Mac"));
	const off = new Error("offline");
	const s = scripted([CAPS, off, off, off, CAPS, { status: 409, json: { error: "used_code" } }]);
	const persist = (a: Parameters<typeof setPendingEnrollment>[1] | null) => h.updateData((d) => (a ? setPendingEnrollment(d, a) : withoutPendingEnrollment(d)));
	const session = new PairingSession({ ...s.deps, persist });
	const input = { host: "https://sync.example.com", pairingCode: CODE, deviceName: "Mac" };
	await assert.rejects(session.submit(input), (e: unknown) => e instanceof PairingError && e.code === "network");
	const kept = h.data().pendingEnrollment;
	assert.ok(kept);
	assert.equal(kept.enrollmentRequestId, enrollBodies(s.calls)[0]?.enrollmentRequestId);
	assert.deepEqual(sanitizePluginData(JSON.parse(JSON.stringify(h.data())), "Mac").pendingEnrollment, kept, "survives save + load");
	assert.equal(sanitizePluginData({ pendingEnrollment: { ...kept, deviceToken: "short" } }, "Mac").pendingEnrollment, undefined, "malformed: dropped on load");
	await assert.rejects(session.submit(input), (e: unknown) => e instanceof PairingError && e.status === 409);
	assert.equal(h.data().pendingEnrollment, undefined);
});

test("resumePendingEnrollment sends the stored attempt once with the identical ids; success stores the identity and drops it", async () => {
	const h = memHost(pendingData());
	const attempt = h.data().pendingEnrollment;
	assert.ok(attempt);
	const s = scripted([okEnroll]);
	const r = await resumePendingEnrollment(h, s.deps);
	assert.equal(r?.ok, true);
	assert.deepEqual(s.calls.map((c) => c.url), ["https://sync.example.com/enroll"]);
	const body = enrollBodies(s.calls)[0];
	assert.deepEqual([body?.enrollmentRequestId, body?.deviceId, body?.deviceToken], [attempt.enrollmentRequestId, attempt.deviceId, attempt.deviceToken]);
	assert.equal(h.data().identity?.deviceToken, attempt.deviceToken);
	assert.equal(h.data().pendingEnrollment, undefined);
});

test("resumePendingEnrollment keeps the attempt on a server error, drops it on a refusal; nothing pending sends nothing", async () => {
	const none = scripted([]);
	assert.equal(await resumePendingEnrollment(memHost(defaultPluginData("Mac")), none.deps), null);
	assert.equal(none.calls.length, 0);
	const h = memHost(pendingData());
	const busy = await resumePendingEnrollment(h, scripted([{ status: 500, json: { error: "internal" } }]).deps);
	assert.equal(busy !== null && !busy.ok && busy.final, false);
	assert.ok(h.data().pendingEnrollment, "kept for the next load");
	const gone = await resumePendingEnrollment(h, scripted([{ status: 410, json: { error: "expired_code" } }]).deps);
	assert.equal(gone !== null && !gone.ok && gone.final, true);
	assert.equal(h.data().pendingEnrollment, undefined);
});

test("enrollmentFailureIsFinal; pairing and unpairing drop the pending attempt", () => {
	const err = (code: string, status: number | null) => new PairingError("x", code, status);
	assert.deepEqual(
		[err("network", null), err("authorization_fence_pending", 202), err("rate_limited", 429), err("server_error", 503), new Error("x")].map(enrollmentFailureIsFinal),
		[false, false, false, false, false],
	);
	assert.deepEqual([err("used_code", 409), err("expired_code", 410), err("forbidden", 403), err("host_mismatch", 200), err("bad_host", null)].map(enrollmentFailureIsFinal), [true, true, true, true, true]);
	const d = pendingData();
	const p = d.pendingEnrollment;
	assert.ok(p);
	const identity: PairedIdentity = { host: p.host, vaultId: "v", deviceId: p.deviceId, deviceToken: p.deviceToken, deviceName: "Mac", vaultGeneration: null };
	assert.equal(applyPairedIdentity(d, identity).pendingEnrollment, undefined);
	assert.equal(applyPairedIdentity(d, { ...identity, deviceId: "dev_BBBBBBBBBBBBBBBB" }).pendingEnrollment, p, "another device's attempt stays");
	assert.equal(clearIdentity(d).pendingEnrollment, undefined);
	assert.equal(withoutPendingEnrollment(d, "other-request-id"), d);
});
