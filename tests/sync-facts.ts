// Regression tests for Phase 1.4 — connection fact derivation and update tracking.
//
// These modules are Obsidian-free, so both can be imported directly under jiti.
//
// UpdateTracker tests:
//   Exercise the Y.Doc "update" event hook with a real Y.Doc and fake provider.
//   Verify that local updates set lastLocalUpdateAt, remote updates set
//   lastRemoteUpdateAt, and lastLocalUpdateWhileConnectedAt only updates when
//   the tracker believes the WebSocket is open.
//
// deriveSyncFacts tests:
//   Drive the pure fact-derivation function with synthetic snapshots.
//   Verify the three key honesty invariants:
//     1. serverReachable is null when neither connected nor auth error received.
//     2. authAccepted is false for explicit server rejections.
//     3. pendingLocalCount stays null even when connected; socket-open is not server receipt.

import * as Y from "yjs";
import { UpdateTracker } from "../src/sync/updateTracker";
import { deriveSyncFacts, type SyncFactsSnapshot, type SyncFacts } from "../src/runtime/connectionFacts";

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

// ── UpdateTracker ─────────────────────────────────────────────────────────────

console.log("\n--- Test 1: local update while connected sets lastLocalUpdateAt and lastLocalUpdateWhileConnectedAt ---");
{
	const doc = new Y.Doc();
	const fakeProvider = { __sentinel: "provider" };
	const tracker = new UpdateTracker();
	let connected = true;

	tracker.attach(doc, () => connected, fakeProvider as object);

	const text = doc.getText("content");
	doc.transact(() => {
		text.insert(0, "hello");
	}, "local-origin");

	assert(tracker.lastLocalUpdateAt !== null, "lastLocalUpdateAt set after local update");
	assert(tracker.lastLocalUpdateWhileConnectedAt !== null, "lastLocalUpdateWhileConnectedAt set when connected");
	assert(tracker.lastRemoteUpdateAt === null, "lastRemoteUpdateAt not set");
	assert(
		tracker.lastLocalUpdateAt === tracker.lastLocalUpdateWhileConnectedAt,
		"lastLocalUpdateWhileConnectedAt equals lastLocalUpdateAt when connected",
	);
}

console.log("\n--- Test 2: local update while offline sets lastLocalUpdateAt but NOT lastLocalUpdateWhileConnectedAt ---");
{
	const doc = new Y.Doc();
	const fakeProvider = { __sentinel: "provider" };
	const tracker = new UpdateTracker();
	let connected = false;

	tracker.attach(doc, () => connected, fakeProvider as object);

	const text = doc.getText("content");
	doc.transact(() => {
		text.insert(0, "offline edit");
	}, "local-origin");

	assert(tracker.lastLocalUpdateAt !== null, "lastLocalUpdateAt set after offline edit");
	assert(tracker.lastLocalUpdateWhileConnectedAt === null, "lastLocalUpdateWhileConnectedAt null when offline");
}

console.log("\n--- Test 3: remote update (provider origin) sets lastRemoteUpdateAt only ---");
{
	const doc = new Y.Doc();
	const fakeProvider = { __sentinel: "provider" };
	const tracker = new UpdateTracker();

	tracker.attach(doc, () => false, fakeProvider as object);

	// Simulate a remote update: create a delta from another doc, apply with provider as origin
	const remoteDoc = new Y.Doc();
	const remoteText = remoteDoc.getText("content");
	remoteDoc.transact(() => {
		remoteText.insert(0, "remote content");
	});
	const update = Y.encodeStateAsUpdate(remoteDoc);

	Y.applyUpdate(doc, update, fakeProvider);

	assert(tracker.lastRemoteUpdateAt !== null, "lastRemoteUpdateAt set after remote update");
	assert(tracker.lastLocalUpdateAt === null, "lastLocalUpdateAt not set for remote update");
	assert(tracker.lastLocalUpdateWhileConnectedAt === null, "lastLocalUpdateWhileConnectedAt not set for remote update");
}

console.log("\n--- Test 4: persistence-origin updates are ignored ---");
{
	const doc = new Y.Doc();
	const fakeProvider = { __sentinel: "provider" };
	const fakePersistence = { __sentinel: "persistence" };
	const tracker = new UpdateTracker();

	tracker.attach(doc, () => true, fakeProvider as object, fakePersistence as object);

	// Simulate IDB cache load: apply update with persistence as origin
	const cacheDoc = new Y.Doc();
	const cacheText = cacheDoc.getText("content");
	cacheDoc.transact(() => {
		cacheText.insert(0, "cached content");
	});
	const update = Y.encodeStateAsUpdate(cacheDoc);

	Y.applyUpdate(doc, update, fakePersistence);

	assert(tracker.lastLocalUpdateAt === null, "IDB cache load does not set lastLocalUpdateAt");
	assert(tracker.lastLocalUpdateWhileConnectedAt === null, "IDB cache load does not set lastLocalUpdateWhileConnectedAt");
	assert(tracker.lastRemoteUpdateAt === null, "IDB cache load does not set lastRemoteUpdateAt");
}

console.log("\n--- Test 5: lastLocalUpdateWhileConnectedAt only updates when connected at update time ---");
{
	const doc = new Y.Doc();
	const fakeProvider = { __sentinel: "provider" };
	const tracker = new UpdateTracker();
	let connected = false;

	tracker.attach(doc, () => connected, fakeProvider as object);

	const text = doc.getText("content");

	// Offline edit
	doc.transact(() => { text.insert(0, "offline"); }, "edit-1");
	assert(tracker.lastLocalUpdateWhileConnectedAt === null, "no lastLocalUpdateWhileConnectedAt after offline edit");

	// Go online, make another edit
	connected = true;
	doc.transact(() => { text.insert(7, " online"); }, "edit-2");
	assert(tracker.lastLocalUpdateWhileConnectedAt !== null, "lastLocalUpdateWhileConnectedAt set after online edit");
	assert(tracker.lastLocalUpdateAt! >= tracker.lastLocalUpdateWhileConnectedAt!, "lastLocalUpdateAt >= lastLocalUpdateWhileConnectedAt");
}

// ── deriveSyncFacts ────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<SyncFactsSnapshot> = {}): SyncFactsSnapshot {
	return {
		connected: false,
		fatalAuthError: false,
		fatalAuthCode: null,
		lastLocalUpdateAt: null,
		lastLocalUpdateWhileConnectedAt: null,
		lastRemoteUpdateAt: null,
		pendingBlobUploads: 0,
		...overrides,
	};
}

console.log("\n--- Test 6: connected → authAccepted=true, serverReachable=true, websocketOpen=true ---");
{
	const facts = deriveSyncFacts(makeSnapshot({ connected: true }), "online");
	assert(facts.websocketOpen === true, "websocketOpen is true");
	assert(facts.authAccepted === true, "authAccepted is true when connected");
	assert(facts.serverReachable === true, "serverReachable is true when connected");
	// pendingLocalCount is ALWAYS null — "connected" does not prove pending = 0.
	assert(facts.pendingLocalCount === null, "pendingLocalCount is null even when connected (no server ack)");
	assert(facts.headlineState === "online", "headlineState matches input");
}

console.log("\n--- Test 7: fatal auth unauthorized → authAccepted=false, serverReachable=true ---");
{
	const facts = deriveSyncFacts(
		makeSnapshot({ fatalAuthError: true, fatalAuthCode: "unauthorized" }),
		"auth_failed",
	);
	assert(facts.websocketOpen === false, "websocketOpen is false");
	assert(facts.authAccepted === false, "authAccepted is false for explicit rejection");
	assert(facts.serverReachable === true, "serverReachable is true (server responded with rejection)");
	assert(facts.lastAuthRejectCode === "unauthorized", "lastAuthRejectCode captured");
	assert(facts.pendingLocalCount === null, "pendingLocalCount is null (not connected)");
}

console.log("\n--- Test 8: not connected, no auth error → serverReachable=null, authAccepted=null ---");
{
	const facts = deriveSyncFacts(makeSnapshot(), "offline");
	assert(facts.serverReachable === null, "serverReachable is null (unknown — no connection, no auth error)");
	assert(facts.authAccepted === null, "authAccepted is null (unknown)");
	assert(facts.websocketOpen === false, "websocketOpen is false");
	assert(facts.pendingLocalCount === null, "pendingLocalCount is null");
}

console.log("\n--- Test 9: auth server_misconfigured → authAccepted=false, serverReachable=true ---");
{
	const facts = deriveSyncFacts(
		makeSnapshot({ fatalAuthError: true, fatalAuthCode: "server_misconfigured" }),
		"auth_failed",
	);
	assert(facts.authAccepted === false, "authAccepted false for server_misconfigured");
	assert(facts.serverReachable === true, "serverReachable true — server did respond");
}

console.log("\n--- Test 10: update_required → authAccepted=true (auth passed, schema blocked) ---");
{
	// update_required means the server checked credentials first, then rejected the
	// connection for schema/version reasons. Auth itself was accepted. This is a
	// useful distinction: "your credentials work but your client is too old" vs
	// "your credentials are wrong." authAccepted should be true, not null.
	const facts = deriveSyncFacts(
		makeSnapshot({ fatalAuthError: true, fatalAuthCode: "update_required" }),
		"server_update_required",
	);
	assert(facts.authAccepted === true, "authAccepted is true for update_required (auth passed, schema blocked)");
	assert(facts.serverReachable === true, "serverReachable true — server did respond");
	assert(facts.lastAuthRejectCode === "update_required", "reject code is captured");
}

console.log("\n--- Test 11: update timestamps flow through deriveSyncFacts ---");
{
	const now = Date.now();
	const facts = deriveSyncFacts(
		makeSnapshot({
			connected: true,
			lastLocalUpdateAt: now - 5000,
			lastLocalUpdateWhileConnectedAt: now - 5000,
			lastRemoteUpdateAt: now - 3000,
		}),
		"online",
	);
	assert(facts.lastLocalUpdateAt === now - 5000, "lastLocalUpdateAt passed through");
	assert(facts.lastLocalUpdateWhileConnectedAt === now - 5000, "lastLocalUpdateWhileConnectedAt passed through");
	assert(facts.lastRemoteUpdateAt === now - 3000, "lastRemoteUpdateAt passed through");
	assert(facts.pendingLocalCount === null, "pendingLocalCount is null (no server ack mechanism)");
}

console.log("\n--- Test 12: pendingBlobUploads flows through deriveSyncFacts ---");
{
	const facts = deriveSyncFacts(makeSnapshot({ pendingBlobUploads: 3 }), "offline");
	assert(facts.pendingBlobUploads === 3, "pendingBlobUploads passed through");
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
