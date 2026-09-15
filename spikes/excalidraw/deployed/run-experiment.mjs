import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const baseUrl = process.argv[2]?.replace(/\/$/, "");
if (!baseUrl) throw new Error("usage: node run-experiment.mjs <worker-base-url>");

const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const vaultId = `vault-${suffix}`;
const roomId = `room-${suffix}`;
const actorId = `actor-${suffix}`;
const url = (path) => `${baseUrl}${path}`;

const request = async (path, options = {}) => {
	const response = await fetch(url(path), {
		...options,
		headers: { "content-type": "application/json", ...(options.headers ?? {}) },
	});
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status} ${response.headers.get("content-type")}: ${text.slice(0, 500)}`);
	}
	return { status: response.status, body };
};

const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body) });
const operation = (operationId, elements, extra = {}) => ({
	vaultId,
	operationId,
	actorId,
	actorRevision: 1,
	elements,
	...extra,
});
const element = (id, version, versionNonce, extra = {}) => ({
	id,
	type: "rectangle",
	version,
	versionNonce,
	index: "a0",
	isDeleted: false,
	x: 0,
	y: 0,
	width: 100,
	height: 100,
	...extra,
});

const results = { baseUrl, vaultId, roomId, checks: {}, timingsMs: {} };

assert.equal((await request("/health")).status, 200);
assert.equal((await post(`/authorities/${vaultId}/reset`, { actorId })).status, 200);

const first = await post(`/rooms/${roomId}/apply`, operation("op-first", [element("same", 1, 10, { x: 10 })]));
assert.equal(first.status, 200);
assert.equal(first.body.sequence, 1);

const equalHigherNonce = await post(`/rooms/${roomId}/apply`, operation("op-equal-higher", [element("same", 1, 20, { x: 20 })]));
assert.equal(equalHigherNonce.body.sequence, 1);
assert.equal(equalHigherNonce.body.accepted.length, 0);

const equalLowerNonce = await post(`/rooms/${roomId}/apply`, operation("op-equal-lower", [element("same", 1, 5, { x: 5 })]));
assert.equal(equalLowerNonce.body.sequence, 2);
assert.equal(equalLowerNonce.body.accepted[0].x, 5);
results.checks.equalVersionNonce = "pinned upstream rule converged on lower nonce; higher nonce rejected";

const replayedReceipt = await post(`/rooms/${roomId}/apply`, operation("op-equal-lower", [element("same", 99, 99)]));
assert.equal(replayedReceipt.body.sequence, 2);
assert.equal(replayedReceipt.body.receiptReplay, true);
results.checks.operationReceipt = "same operation ID replayed original outcome";

const deleted = await post(`/rooms/${roomId}/apply`, operation("op-delete", [element("same", 2, 1, { isDeleted: true })]));
assert.equal(deleted.body.sequence, 3);
const snapshotAfterDelete = await request(`/rooms/${roomId}/snapshot`);
assert.equal(snapshotAfterDelete.body.elements[0].isDeleted, true);
results.checks.tombstone = "deleted element retained in canonical snapshot";

const injected = await post(`/rooms/${roomId}/apply`, operation("op-reserved-before-fence", [element("reserved", 1, 1)], { injectFailureAfterReserve: true }));
assert.equal(injected.status, 503);
const fence = await post(`/authorities/${vaultId}/fence`, { actorId });
assert.equal(fence.status, 200);
const reservedRetry = await post(`/rooms/${roomId}/apply`, operation("op-reserved-before-fence", [element("reserved", 1, 1)], { injectFailureAfterReserve: true }));
assert.equal(reservedRetry.status, 200);
assert.equal(reservedRetry.body.accepted.length, 1);
const staleAfterFence = await post(`/rooms/${roomId}/apply`, operation("op-after-fence", [element("late", 1, 1)]));
assert.equal(staleAfterFence.status, 403);
assert.equal(staleAfterFence.body.error, "actor_revoked");
results.checks.revocationOrdering = "reservation before fence remained recoverable; later operation rejected";

const replay = await request(`/rooms/${roomId}/replay?after=2`);
assert.equal(replay.status, 200);
assert.ok(replay.body.changes.some((change) => change.elementId === "reserved"));
results.checks.monotonicReplay = `${replay.body.changes.length} changes after cursor 2`;

const loadVault = `load-vault-${suffix}`;
const loadRoom = `load-room-${suffix}`;
const loadActor = `load-actor-${suffix}`;
await post(`/authorities/${loadVault}/reset`, { actorId: loadActor });
const batchSize = 250;
const totalElements = 10_000;
const started = performance.now();
let finalSequence = 0;
for (let offset = 0; offset < totalElements; offset += batchSize) {
	const elements = Array.from({ length: batchSize }, (_, index) => element(
		`load-${offset + index}`,
		1,
		offset + index + 1,
		{ index: `a${String(offset + index).padStart(6, "0")}`, x: offset + index },
	));
	const response = await post(`/rooms/${loadRoom}/apply`, {
		vaultId: loadVault,
		operationId: `load-op-${offset}`,
		actorId: loadActor,
		actorRevision: 1,
		elements,
	});
	assert.equal(response.status, 200);
	finalSequence = response.body.sequence;
}
results.timingsMs.apply10k = Math.round((performance.now() - started) * 100) / 100;
assert.equal(finalSequence, totalElements / batchSize);
const snapshotStarted = performance.now();
const loadSnapshot = await request(`/rooms/${loadRoom}/snapshot`);
results.timingsMs.snapshot10k = Math.round((performance.now() - snapshotStarted) * 100) / 100;
assert.equal(loadSnapshot.body.elements.length, totalElements);
results.checks.load = `${totalElements} elements in ${finalSequence} transactional batches`;

const wsBase = baseUrl.replace(/^http/, "ws");
const socketA = new WebSocket(`${wsBase}/rooms/${roomId}/ws?sessionId=session-a&actorId=${actorId}&displayName=Alice`);
const socketB = new WebSocket(`${wsBase}/rooms/${roomId}/ws?sessionId=session-b&actorId=${actorId}&displayName=Alice-device-2`);
await Promise.all([
	new Promise((resolve, reject) => { socketA.addEventListener("open", resolve, { once: true }); socketA.addEventListener("error", reject, { once: true }); }),
	new Promise((resolve, reject) => { socketB.addEventListener("open", resolve, { once: true }); socketB.addEventListener("error", reject, { once: true }); }),
]);
const presence = new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("presence timeout")), 5_000);
	socketB.addEventListener("message", (event) => { clearTimeout(timeout); resolve(JSON.parse(event.data)); }, { once: true });
});
socketA.send(JSON.stringify({ type: "presence", sessionId: "spoofed", actorId: "spoofed", x: 12, y: 34, tool: "laser" }));
const observedPresence = await presence;
assert.equal(observedPresence.sessionId, "session-a");
assert.equal(observedPresence.actorId, actorId);
results.checks.presence = "two sessions for one actor remained distinct; spoofed identity overwritten";
socketA.close();
socketB.close();

console.log(JSON.stringify(results, null, 2));
