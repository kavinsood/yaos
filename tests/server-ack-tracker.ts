/**
 * FU-8 — ServerAckTracker candidate lifecycle tests.
 *
 * Tests the full candidate lifecycle: capture, persist, reconnect, echo
 * confirmation, startup validation, scope mismatch, persistence failure.
 *
 * All tests are Yjs-level only — no Obsidian, no sockets, no provider.
 * The InMemoryCandidateStore simulates persistence.
 */

import * as Y from "yjs";
import { ServerAckTracker } from "../src/sync/serverAckTracker";
import { InMemoryCandidateStore, type ScopeKey, type ScopeMetadata } from "../src/sync/candidateStore";
import { isStateVectorGe } from "../src/sync/stateVectorAck";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

const BASE_SCOPE: ScopeKey & ScopeMetadata = {
	vaultIdHash: "aabbcc",
	serverHostHash: "ddeeff",
	localDeviceId: "uuid-device-1",
	roomName: "room-vault-1",
	docSchemaVersion: 2,
	pluginVersion: "0.5.0",
	ackStoreVersion: 1,
};

function makeDoc(clientId?: number): Y.Doc {
	const doc = new Y.Doc({ gc: false });
	if (clientId !== undefined) {
		(doc as unknown as { clientID: number }).clientID = clientId;
	}
	return doc;
}

function attachTracker(
	tracker: ServerAckTracker,
	doc: Y.Doc,
	provider: unknown,
	persistence: unknown,
): void {
	tracker.attach(
		doc,
		() => Y.encodeStateVector(doc),
		provider,
		persistence,
	);
}

async function startupTracker(
	tracker: ServerAckTracker,
	doc: Y.Doc,
	store: InMemoryCandidateStore,
	scope = BASE_SCOPE,
): Promise<void> {
	await tracker.onStartup(store, scope);
}

// Flush pending microtasks (lets async store.save() in _persistAsync complete).
// With the serialized persistence chain, we need enough microtask ticks for
// the chain .then() handler to settle and for the store.save() to complete.
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

// ── Test 1: local update while connected captures candidate, state=false ───────

console.log("\n--- Test 1: local update while connected ---");
{
	const doc = makeDoc(101);
	const provider = { __type: "provider" };
	const store = new InMemoryCandidateStore();
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	doc.getText("t").insert(0, "hello");

	await flushMicrotasks();

	assert(tracker.serverAppliedLocalState === false, "state=false after local update");
	assert(tracker.lastServerReceiptEchoAt === null, "no echo yet — lastServerReceiptEchoAt null");
	const persisted = store.rawStored;
	assert(persisted !== null, "candidate was persisted");
	assert(persisted?.candidateSvBase64 !== null, "candidateSvBase64 is set");
}

// ── Test 2: local update while disconnected ───────────────────────────────────

console.log("\n--- Test 2: local update while disconnected (no provider active) ---");
{
	const doc = makeDoc(102);
	const provider = { __type: "provider" };
	const store = new InMemoryCandidateStore();
	const tracker = new ServerAckTracker();
	// Attach and startup WITHOUT calling connect — simulates offline
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	// Edit while "offline" (provider object is present but no live socket — irrelevant to tracker)
	doc.getText("t").insert(0, "offline edit");

	await flushMicrotasks();

	assert(tracker.serverAppliedLocalState === false, "offline edit: state=false");
	assert(store.rawStored?.candidateSvBase64 !== null, "offline edit: candidate persisted");
}

// ── Test 3: echo dominating candidate sets state=true ─────────────────────────

console.log("\n--- Test 3: dominating echo sets serverAppliedLocalState=true ---");
{
	const doc = makeDoc(103);
	const provider = { __type: "provider" };
	const store = new InMemoryCandidateStore();
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	doc.getText("t").insert(0, "some edit");
	await flushMicrotasks();

	assert(tracker.serverAppliedLocalState === false, "before echo: false");

	// Server SV that dominates the local doc SV (same state)
	const serverSv = Y.encodeStateVector(doc);
	tracker.recordServerSvEcho(serverSv);

	assert(tracker.serverAppliedLocalState === true, "after dominating echo: true");
	assert(tracker.lastServerReceiptEchoAt !== null, "lastServerReceiptEchoAt set");
	assert(tracker.lastKnownServerReceiptEchoAt !== null, "lastKnownServerReceiptEchoAt set");

	await flushMicrotasks();
	assert(store.rawStored?.lastKnownServerReceiptEchoAt !== null, "lastKnownServerReceiptEchoAt persisted");
}

// ── Test 4: echo NOT dominating candidate keeps state=false ───────────────────

console.log("\n--- Test 4: non-dominating echo stays false ---");
{
	const doc = makeDoc(104);
	const provider = { __type: "provider" };
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	doc.getText("t").insert(0, "edit 1");
	doc.getText("t").insert(0, "edit 2");

	// Server SV is behind — empty (no ops)
	const emptyServerSv = Y.encodeStateVector(new Y.Doc());
	tracker.recordServerSvEcho(emptyServerSv);

	assert(tracker.serverAppliedLocalState === false, "non-dominating echo: stays false");
}

// ── Test 5: echo with no candidate updates timestamp but leaves state null ─────

console.log("\n--- Test 5: echo with no candidate — lastServerReceiptEchoAt updates, state stays null ---");
{
	const doc = makeDoc(105);
	const tracker = new ServerAckTracker();
	const provider = {};
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	// No local updates — no candidate
	const serverSv = Y.encodeStateVector(doc);
	tracker.recordServerSvEcho(serverSv);

	assert(tracker.serverAppliedLocalState === null, "no candidate: state stays null");
	assert(tracker.lastServerReceiptEchoAt !== null, "echo received: lastServerReceiptEchoAt set");
}

// ── Test 6: candidate retained across disconnect ───────────────────────────────

console.log("\n--- Test 6: disconnect retains candidate ---");
{
	const doc = makeDoc(106);
	const provider = {};
	const store = new InMemoryCandidateStore();
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	doc.getText("t").insert(0, "edit before disconnect");
	await flushMicrotasks();

	assert(tracker.serverAppliedLocalState === false, "before disconnect: false");

	// Simulate disconnect: tracker has no disconnect event — state is retained in memory.
	// Re-attach is not required; state persists passively.
	assert(tracker.serverAppliedLocalState === false, "after disconnect: candidate retained, still false");
	assert(store.rawStored?.candidateSvBase64 !== null, "persisted candidate still present");
}

// ── Test 7: offline-edit confirmed after reconnect (current session) ───────────
// NON-NEGOTIABLE TEST

console.log("\n--- Test 7: offline-edit confirmed after reconnect (current session) ---");
{
	const doc = makeDoc(107);
	const provider = {};
	const store = new InMemoryCandidateStore();
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	// Edit while offline (provider connected or not is irrelevant to tracker)
	doc.getText("t").insert(0, "offline edit");
	await flushMicrotasks();
	assert(tracker.serverAppliedLocalState === false, "offline edit: state=false");

	// Simulate reconnect + server applies the edit.
	// Server SV now includes the offline edit.
	const serverSv = Y.encodeStateVector(doc);
	tracker.recordServerSvEcho(serverSv);

	assert(tracker.serverAppliedLocalState === true, "[NON-NEGOTIABLE] offline edit confirmed after reconnect");
}

// ── Test 8: offline-edit confirmed after plugin restart ───────────────────────
// NON-NEGOTIABLE TEST

console.log("\n--- Test 8: offline-edit confirmed after plugin restart ---");
{
	const store = new InMemoryCandidateStore();

	// Session 1: make an offline edit and persist the candidate.
	{
		const doc = makeDoc(108);
		const provider = {};
		const tracker = new ServerAckTracker();
		attachTracker(tracker, doc, provider, null);
		await tracker.onStartup(store, BASE_SCOPE);
		doc.getText("t").insert(0, "offline edit session 1");
		await flushMicrotasks();
		assert(store.rawStored?.candidateSvBase64 !== null, "session 1: candidate persisted");
	}

	// Session 2: plugin restarts. Doc is rebuilt from IDB (same state as session 1 ended).
	{
		const doc = makeDoc(108); // same clientId
		(doc as unknown as { clientID: number }).clientID = 108;
		const text = doc.getText("t");
		text.insert(0, "offline edit session 1"); // same content reconstructed

		const provider = {};
		const tracker2 = new ServerAckTracker();
		attachTracker(tracker2, doc, provider, null);
		await tracker2.onStartup(store, BASE_SCOPE);

		assert(tracker2.serverAppliedLocalState === null, "restart: active state is null (not restored from persisted true/false)");

		// Server applies the edit and sends fresh echo.
		const serverSv = Y.encodeStateVector(doc);
		tracker2.recordServerSvEcho(serverSv);

		assert(tracker2.serverAppliedLocalState === true, "[NON-NEGOTIABLE] offline edit confirmed after restart");
	}
}

// ── Test 9: confirmed then new local update resets to false ───────────────────

console.log("\n--- Test 9: new local update after confirmed state resets to false ---");
{
	const doc = makeDoc(109);
	const provider = {};
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	doc.getText("t").insert(0, "edit 1");
	const serverSv1 = Y.encodeStateVector(doc);
	tracker.recordServerSvEcho(serverSv1);
	assert(tracker.serverAppliedLocalState === true, "confirmed: true");
	const confirmedAt = tracker.lastServerReceiptEchoAt;
	assert(confirmedAt !== null, "confirmed: lastServerReceiptEchoAt set");

	doc.getText("t").insert(0, "edit 2"); // new local update
	assert(tracker.serverAppliedLocalState === false, "new edit: state reset to false");
	assert(tracker.lastServerReceiptEchoAt === confirmedAt, "new edit: lastServerReceiptEchoAt remains historical, not current receipt");
}

// ── Test 10: confirmed then offline local update also resets to false ──────────

console.log("\n--- Test 10: new offline local update after confirmed state resets to false ---");
{
	const doc = makeDoc(110);
	const provider = {};
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	doc.getText("t").insert(0, "confirmed edit");
	tracker.recordServerSvEcho(Y.encodeStateVector(doc));
	assert(tracker.serverAppliedLocalState === true, "confirmed");

	// Offline local update
	doc.getText("t").insert(0, "offline edit 2");
	assert(tracker.serverAppliedLocalState === false, "offline edit after confirm: false");
}

// ── Test 11: remote provider update does NOT create candidate ──────────────────

console.log("\n--- Test 11: remote provider update does not create candidate ---");
{
	const doc = makeDoc(111);
	const provider = { __type: "provider" };
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	// Simulate a remote update from the provider
	const remoteDoc = makeDoc(999);
	remoteDoc.getText("t").insert(0, "remote");
	const update = Y.encodeStateAsUpdate(remoteDoc);
	Y.applyUpdate(doc, update, provider); // provider as origin

	assert(tracker.serverAppliedLocalState === null, "provider update: state stays null");
}

// ── Test 11b: remote provider update does NOT replace retained local candidate ─

console.log("\n--- Test 11b: remote provider update does not replace retained local candidate ---");
{
	const doc = makeDoc(121);
	const provider = { __type: "provider" };
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	doc.getText("t").insert(0, "local candidate");
	const candidateSv = Y.encodeStateVector(doc);
	assert(tracker.serverAppliedLocalState === false, "local candidate captured");

	const remoteDoc = makeDoc(999);
	remoteDoc.getText("remote").insert(0, "remote-only");
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc), provider);
	assert(tracker.serverAppliedLocalState === false, "remote update leaves local candidate pending");

	tracker.recordServerSvEcho(candidateSv);
	assert(tracker.serverAppliedLocalState === true, "echo for original local candidate still confirms");
}

// ── Test 12: IDB persistence load does NOT create candidate ───────────────────

console.log("\n--- Test 12: IDB persistence load does not create candidate ---");
{
	const doc = makeDoc(112);
	const provider = {};
	const persistence = { __type: "idb" };
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, persistence);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	// Simulate IDB persistence replay
	const idbDoc = makeDoc(112);
	idbDoc.getText("t").insert(0, "idb load");
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(idbDoc), persistence);

	assert(tracker.serverAppliedLocalState === null, "IDB load: state stays null");
}

// ── Test 13: persisted true NOT restored as active truth after restart ─────────

console.log("\n--- Test 13: persisted serverAppliedLocalState=true not restored after restart ---");
{
	const store = new InMemoryCandidateStore();

	// Session 1: get confirmed state persisted
	{
		const doc = makeDoc(113);
		const provider = {};
		const tracker = new ServerAckTracker();
		attachTracker(tracker, doc, provider, null);
		await tracker.onStartup(store, BASE_SCOPE);
		doc.getText("t").insert(0, "session 1 edit");
		tracker.recordServerSvEcho(Y.encodeStateVector(doc));
		assert(tracker.serverAppliedLocalState === true, "session 1: confirmed");
		await flushMicrotasks();
		assert(store.rawStored?.lastKnownServerReceiptEchoAt !== null, "session 1: lastKnownServerReceiptEchoAt persisted");
	}

	// Session 2: restart — active state must be null, not true
	{
		const doc = makeDoc(113);
		doc.getText("t").insert(0, "session 1 edit"); // same content
		const provider = {};
		const tracker2 = new ServerAckTracker();
		attachTracker(tracker2, doc, provider, null);
		await tracker2.onStartup(store, BASE_SCOPE);

		assert(tracker2.serverAppliedLocalState === null, "restart: active state null (never restored from persisted true)");
		assert(tracker2.lastKnownServerReceiptEchoAt !== null, "restart: historical timestamp retained");
	}
}

// ── Test 14: scope mismatch discards candidate ────────────────────────────────

console.log("\n--- Test 14: scope mismatch discards persisted candidate ---");
{
	const wrongVaultScope = { ...BASE_SCOPE, vaultIdHash: "different-vault" };
	const wrongHostScope = { ...BASE_SCOPE, serverHostHash: "different-host" };
	const wrongDeviceScope = { ...BASE_SCOPE, localDeviceId: "different-device" };
	const wrongRoomScope = { ...BASE_SCOPE, roomName: "different-room" };
	const wrongSchemaScope = { ...BASE_SCOPE, docSchemaVersion: 99 };

	for (const [wrongScope, label] of [
		[wrongVaultScope, "different vaultIdHash"],
		[wrongHostScope, "different serverHostHash"],
		[wrongDeviceScope, "different localDeviceId"],
		[wrongRoomScope, "different roomName"],
		[wrongSchemaScope, "different docSchemaVersion"],
	] as [typeof BASE_SCOPE, string][]) {
		// Write candidate under BASE_SCOPE
		const store = new InMemoryCandidateStore();
		{
			const doc = makeDoc(114);
			const provider = {};
			const tracker = new ServerAckTracker();
			attachTracker(tracker, doc, provider, null);
			await tracker.onStartup(store, BASE_SCOPE);
			doc.getText("t").insert(0, "edit");
			await flushMicrotasks();
		}

		// Load under wrong scope
		const doc2 = makeDoc(114);
		doc2.getText("t").insert(0, "edit");
		const provider = {};
		const tracker2 = new ServerAckTracker();
		attachTracker(tracker2, doc2, provider, null);
		await tracker2.onStartup(store, wrongScope);
		assert(tracker2.serverAppliedLocalState === null, `scope mismatch (${label}): state null`);
	}
}

// ── Test 15: candidate ahead of doc on startup — discard ──────────────────────

console.log("\n--- Test 15: candidate ahead of local doc on startup (fail closed) ---");
{
	const store = new InMemoryCandidateStore();

	// Write a candidate that claims higher clocks than the doc we'll load.
	{
		const advancedDoc = makeDoc(115);
		const provider = {};
		const tracker = new ServerAckTracker();
		attachTracker(tracker, advancedDoc, provider, null);
		await tracker.onStartup(store, BASE_SCOPE);
		advancedDoc.getText("t").insert(0, "advanced edit 1");
		advancedDoc.getText("t").insert(0, "advanced edit 2");
		await flushMicrotasks();
		assert(store.rawStored?.candidateSvBase64 !== null, "advanced candidate persisted");
	}

	// Restart with a doc that is BEHIND the stored candidate SV (simulates IDB corruption/gap).
	const behindDoc = makeDoc(115);
	// Only one insert instead of two — behind the persisted candidate
	behindDoc.getText("t").insert(0, "advanced edit 1");

	const provider = {};
	const tracker2 = new ServerAckTracker();
	attachTracker(tracker2, behindDoc, provider, null);
	await tracker2.onStartup(store, BASE_SCOPE);

	assert(tracker2.serverAppliedLocalState === null, "candidate ahead of doc: discarded, state null");
	await flushMicrotasks();
	assert(store.rawStored?.candidateSvBase64 === null, "discarded candidate: null in store");
}

// ── Test 16: doc ahead of candidate on startup — replace ──────────────────────

console.log("\n--- Test 16: doc ahead of candidate on startup — replace with current SV ---");
{
	const store = new InMemoryCandidateStore();

	// Write a small candidate
	{
		const doc = makeDoc(116);
		const provider = {};
		const tracker = new ServerAckTracker();
		attachTracker(tracker, doc, provider, null);
		await tracker.onStartup(store, BASE_SCOPE);
		doc.getText("t").insert(0, "small edit");
		await flushMicrotasks();
	}

	// Restart with a doc that is AHEAD of the stored candidate (e.g. IDB had more data).
	const aheadDoc = makeDoc(116);
	aheadDoc.getText("t").insert(0, "small edit");
	aheadDoc.getText("t").insert(0, "extra edit after candidate was captured"); // ahead

	const provider = {};
	const tracker2 = new ServerAckTracker();
	attachTracker(tracker2, aheadDoc, provider, null);
	await tracker2.onStartup(store, BASE_SCOPE);

	// State should be false (replaced with current doc SV, marked unconfirmed)
	assert(tracker2.serverAppliedLocalState === false, "doc ahead of candidate: state=false (replaced)");

	// A dominating echo should now confirm it
	const serverSv = Y.encodeStateVector(aheadDoc);
	tracker2.recordServerSvEcho(serverSv);
	assert(tracker2.serverAppliedLocalState === true, "doc-ahead case: fresh echo confirms replaced candidate");
}

// ── Test 17: equal candidate and doc on startup — retain, wait for echo ────────

console.log("\n--- Test 17: equal candidate and doc on startup ---");
{
	const store = new InMemoryCandidateStore();

	{
		const doc = makeDoc(117);
		const provider = {};
		const tracker = new ServerAckTracker();
		attachTracker(tracker, doc, provider, null);
		await tracker.onStartup(store, BASE_SCOPE);
		doc.getText("t").insert(0, "equal edit");
		await flushMicrotasks();
	}

	// Restart with exactly the same doc state
	const sameDoc = makeDoc(117);
	sameDoc.getText("t").insert(0, "equal edit"); // same content, same clientId

	const provider = {};
	const tracker2 = new ServerAckTracker();
	attachTracker(tracker2, sameDoc, provider, null);
	await tracker2.onStartup(store, BASE_SCOPE);

	assert(tracker2.serverAppliedLocalState === null, "equal: state null (waiting for fresh echo)");

	// Fresh echo confirms it
	const serverSv = Y.encodeStateVector(sameDoc);
	tracker2.recordServerSvEcho(serverSv);
	assert(tracker2.serverAppliedLocalState === true, "equal: fresh echo confirms candidate");
}

// ── Test 18: persistence write failure degrades gracefully ────────────────────

console.log("\n--- Test 18: persistence write failure — in-memory state continues ---");
{
	const store = new InMemoryCandidateStore();
	store.simulateWriteFailure = true;

	const doc = makeDoc(118);
	const provider = {};
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	doc.getText("t").insert(0, "edit during failure");
	await flushMicrotasks();

	assert(tracker.serverAppliedLocalState === false, "write failure: in-memory state still works");
	assert(!tracker.candidatePersistenceHealthy, "write failure: health flag set");
	assert(tracker.candidatePersistenceFailureCount > 0, "write failure: failure count incremented");
}

// ── Test 19: persistence health recovers after successful write ───────────────

console.log("\n--- Test 19: persistence health recovers after successful write ---");
{
	const store = new InMemoryCandidateStore();
	store.simulateWriteFailure = true;

	const doc = makeDoc(119);
	const provider = {};
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	doc.getText("t").insert(0, "edit 1");
	await flushMicrotasks();
	assert(!tracker.candidatePersistenceHealthy, "health false after first failure");

	store.simulateWriteFailure = false;
	doc.getText("t").insert(0, "edit 2");
	await flushMicrotasks();

	assert(tracker.candidatePersistenceHealthy, "health restored after successful write");
}

// ── Test 20: confirmed then disconnect+reconnect — baseline echo re-confirms ───

console.log("\n--- Test 20: confirmed → disconnect → reconnect → baseline echo re-confirms ---");
{
	const doc = makeDoc(120);
	const provider = {};
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	doc.getText("t").insert(0, "edit");
	const serverSv = Y.encodeStateVector(doc);
	tracker.recordServerSvEcho(serverSv);
	assert(tracker.serverAppliedLocalState === true, "confirmed before disconnect");

	// Disconnect: no state change (tracker has no disconnect event)
	// Reconnect: server sends baseline echo with same SV
	tracker.recordServerSvEcho(serverSv);
	assert(tracker.serverAppliedLocalState === true, "baseline echo after reconnect: still confirmed");
}

// ── Test 21: startup load does not overwrite already-captured live candidate ──

console.log("\n--- Test 21: onStartup does not overwrite live candidate captured before load resolves ---");
{
	const store = new InMemoryCandidateStore();

	// Persist an older candidate.
	{
		const oldDoc = makeDoc(121);
		const provider = {};
		const tracker = new ServerAckTracker();
		attachTracker(tracker, oldDoc, provider, null);
		await tracker.onStartup(store, BASE_SCOPE);
		oldDoc.getText("t").insert(0, "old");
		await flushMicrotasks();
		assert(store.rawStored?.candidateSvBase64 !== null, "old persisted candidate exists");
	}

	const liveDoc = makeDoc(121);
	liveDoc.getText("t").insert(0, "old");
	const provider = {};
	const liveTracker = new ServerAckTracker();
	attachTracker(liveTracker, liveDoc, provider, null);
	liveDoc.getText("t").insert(0, " live");
	const liveCandidateSv = Y.encodeStateVector(liveDoc);

	await liveTracker.onStartup(store, BASE_SCOPE);
	assert(liveTracker.serverAppliedLocalState === false, "live candidate remains pending after startup load");
	liveTracker.recordServerSvEcho(liveCandidateSv);
	assert(liveTracker.serverAppliedLocalState === true, "live candidate, not stale persisted candidate, is confirmed");
}

// ── Test 22: baseline behind then postApply dominating confirms candidate ─────

console.log("\n--- Test 22: baseline behind then postApply dominating confirms candidate ---");
{
	const clientDoc = makeDoc(122);
	const serverDoc = makeDoc(922);
	const provider = {};
	const store = new InMemoryCandidateStore();
	const tracker = new ServerAckTracker();
	attachTracker(tracker, clientDoc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	clientDoc.getText("t").insert(0, "offline candidate");
	await flushMicrotasks();
	assert(tracker.serverAppliedLocalState === false, "candidate starts pending");

	const baselineServerSv = Y.encodeStateVector(serverDoc);
	assert(!isStateVectorGe(baselineServerSv, Y.encodeStateVector(clientDoc)), "baseline server SV is behind candidate");
	tracker.recordServerSvEcho(baselineServerSv);
	assert(tracker.serverAppliedLocalState === false, "behind baseline echo does not confirm candidate");

	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(clientDoc));
	const postApplyServerSv = Y.encodeStateVector(serverDoc);
	assert(isStateVectorGe(postApplyServerSv, Y.encodeStateVector(clientDoc)), "postApply server SV dominates candidate");
	tracker.recordServerSvEcho(postApplyServerSv);
	assert(tracker.serverAppliedLocalState === true, "dominating postApply echo confirms candidate");
}

// ── Test 23: slow save racing clear — clear wins ─────────────────────────────

console.log("\n--- Test 23: slow save racing clear — clear wins ---");
{
	let saveResolve: (() => void) | null = null;
	let clearCalled = false;
	const slowStore = {
		async load() { return null; },
		async save(_state: unknown) {
			// Artificially delay save so clear can race ahead
			await new Promise<void>((resolve) => { saveResolve = resolve; });
		},
		async clear() {
			clearCalled = true;
		},
	};

	const doc = makeDoc(123);
	const provider = {};
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(slowStore, BASE_SCOPE);

	// Trigger a candidate capture (enqueues a slow save)
	doc.getText("t").insert(0, "candidate before clear");

	// Let the chain start executing (the save will block on our promise)
	await Promise.resolve();
	await Promise.resolve();

	// Now call clearLocalReceiptState — it enqueues clear after the slow save
	const clearPromise = tracker.clearLocalReceiptState();

	// Give the chain a tick so clear is queued but blocked behind save
	await Promise.resolve();

	// Let the slow save finish — clear should execute after it
	assert(saveResolve !== null, "slow save is in flight");
	saveResolve!();

	// Wait for clear to complete
	await clearPromise;

	assert(clearCalled, "clear was called after slow save finished");
	assert(tracker.serverAppliedLocalState === null, "state is null after clear");
	assert(tracker.candidatePersistenceFailureCount === 0, "clear resets failure count");
	assert(tracker.candidatePersistenceHealthy === true, "persistence healthy after successful clear");
}

// ── Test 24: clearLocalReceiptState resets failure count ──────────────────────

console.log("\n--- Test 24: clearLocalReceiptState resets failure count ---");
{
	const store = new InMemoryCandidateStore();
	store.simulateWriteFailure = true;

	const doc = makeDoc(124);
	const provider = {};
	const tracker = new ServerAckTracker();
	attachTracker(tracker, doc, provider, null);
	await tracker.onStartup(store, BASE_SCOPE);

	doc.getText("t").insert(0, "edit");
	await flushMicrotasks();
	assert(tracker.candidatePersistenceFailureCount > 0, "failure count incremented after write failure");

	store.simulateWriteFailure = false;
	await tracker.clearLocalReceiptState();
	assert(tracker.candidatePersistenceFailureCount === 0, "clear resets failure count to 0");
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
