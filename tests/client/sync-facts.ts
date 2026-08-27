// Connection-fact derivation stays independent of the schema-4 root/body
// transport. Candidate durability is represented by explicit receipt facts.
//   Drive the pure fact-derivation function with synthetic snapshots.
//   Verify the three key honesty invariants:
//     1. serverReachable is null when neither connected nor auth error received.
//     2. authAccepted is false for explicit server rejections.
//     3. pendingLocalCount stays null even when connected; socket-open is not server receipt.

import { deriveSyncFacts, type SyncFactsSnapshot, type SyncFacts } from "../../src/runtime/connectionFacts";
import { suite } from "../harness.ts";

const s = suite("sync-facts");


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

s.section("Test 6: connected → authAccepted=true, serverReachable=true, websocketOpen=true");
{
	const facts = deriveSyncFacts(makeSnapshot({ connected: true }), "online");
	s.check(facts.websocketOpen === true, "websocketOpen is true");
	s.check(facts.authAccepted === true, "authAccepted is true when connected");
	s.check(facts.serverReachable === true, "serverReachable is true when connected");
	// pendingLocalCount is ALWAYS null — "connected" does not prove pending = 0.
	s.check(facts.pendingLocalCount === null, "pendingLocalCount is null even when connected (no server ack)");
	s.check(facts.headlineState === "online", "headlineState matches input");
}

s.section("Test 7: fatal auth unauthorized → authAccepted=false, serverReachable=true");
{
	const facts = deriveSyncFacts(
		makeSnapshot({ fatalAuthError: true, fatalAuthCode: "unauthorized" }),
		"auth_failed",
	);
	s.check(facts.websocketOpen === false, "websocketOpen is false");
	s.check(facts.authAccepted === false, "authAccepted is false for explicit rejection");
	s.check(facts.serverReachable === true, "serverReachable is true (server responded with rejection)");
	s.check(facts.lastAuthRejectCode === "unauthorized", "lastAuthRejectCode captured");
	s.check(facts.pendingLocalCount === null, "pendingLocalCount is null (not connected)");
}

s.section("Test 8: not connected, no auth error → serverReachable=null, authAccepted=null");
{
	const facts = deriveSyncFacts(makeSnapshot(), "offline");
	s.check(facts.serverReachable === null, "serverReachable is null (unknown — no connection, no auth error)");
	s.check(facts.authAccepted === null, "authAccepted is null (unknown)");
	s.check(facts.websocketOpen === false, "websocketOpen is false");
	s.check(facts.pendingLocalCount === null, "pendingLocalCount is null");
}

s.section("Test 9: auth server_misconfigured → authAccepted=false, serverReachable=true");
{
	const facts = deriveSyncFacts(
		makeSnapshot({ fatalAuthError: true, fatalAuthCode: "server_misconfigured" }),
		"auth_failed",
	);
	s.check(facts.authAccepted === false, "authAccepted false for server_misconfigured");
	s.check(facts.serverReachable === true, "serverReachable true — server did respond");
}

s.section("Test 10: update_required → authAccepted=true (auth passed, schema blocked)");
{
	// update_required means the server checked credentials first, then rejected the
	// connection for schema/version reasons. Auth itself was accepted. This is a
	// useful distinction: "your credentials work but your client is too old" vs
	// "your credentials are wrong." authAccepted should be true, not null.
	const facts = deriveSyncFacts(
		makeSnapshot({ fatalAuthError: true, fatalAuthCode: "update_required" }),
		"server_update_required",
	);
	s.check(facts.authAccepted === true, "authAccepted is true for update_required (auth passed, schema blocked)");
	s.check(facts.serverReachable === true, "serverReachable true — server did respond");
	s.check(facts.lastAuthRejectCode === "update_required", "reject code is captured");
}

s.section("Test 10b: server_format_unsupported is an explicit auth/config rejection");
{
	const facts = deriveSyncFacts(
		makeSnapshot({ fatalAuthError: true, fatalAuthCode: "server_format_unsupported" }),
		"auth_failed",
	);
	s.check(facts.authAccepted === false, "unsupported server configuration cannot authenticate");
	s.check(facts.serverReachable === true, "unsupported server did respond");
	s.check(facts.lastAuthRejectCode === "server_format_unsupported", "unsupported format code is retained");
}

s.section("Test 11: update timestamps flow through deriveSyncFacts");
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
	s.check(facts.lastLocalUpdateAt === now - 5000, "lastLocalUpdateAt passed through");
	s.check(facts.lastLocalUpdateWhileConnectedAt === now - 5000, "lastLocalUpdateWhileConnectedAt passed through");
	s.check(facts.lastRemoteUpdateAt === now - 3000, "lastRemoteUpdateAt passed through");
	s.check(facts.pendingLocalCount === null, "pendingLocalCount is null (no server ack mechanism)");
}

s.section("Test 12: pendingBlobUploads flows through deriveSyncFacts");
{
	const facts = deriveSyncFacts(makeSnapshot({ pendingBlobUploads: 3 }), "offline");
	s.check(facts.pendingBlobUploads === 3, "pendingBlobUploads passed through");
}
await s.done();
