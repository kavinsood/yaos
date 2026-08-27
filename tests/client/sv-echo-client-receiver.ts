/**
 * FU-8 client custom-message receiver tests.
 *
 * Exercises the same helper VaultSync uses for provider "custom-message"
 * payloads, without constructing the full Obsidian runtime.
 */

import * as Y from "yjs";
import {
	createSvEchoCounters,
	handleSvEchoCustomMessage,
	makeSvEchoMessage,
} from "../../src/sync/svEchoMessage";
import { ServerAckTracker } from "../../src/sync/serverAckTracker";
import type { ScopeKey, ScopeMetadata } from "../../src/sync/candidateStore";
import { InMemoryCandidateStore } from "./helpers/inMemoryCandidateStore";
import { suite } from "../harness.ts";

const s = suite("sv-echo-client-receiver");

const SCOPE: ScopeKey & ScopeMetadata = {
	vaultIdHash: "aa",
	serverHostHash: "bb",
	localDeviceId: "device",
	roomName: "room",
	docSchemaVersion: 2,
	pluginVersion: "test",
	ackStoreVersion: 1,
};

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

s.section("Test 1: custom-message receiver counters and tracker path");
{
	const doc = new Y.Doc({ gc: false });
	const serverDoc = new Y.Doc({ gc: false });
	const provider = {};
	const tracker = new ServerAckTracker();
	const counters = createSvEchoCounters();
	let acceptedReceiptChangeNotifications = 0;
	const recordAcceptedEcho = (sv: Uint8Array) => {
		tracker.recordServerSvEcho(sv);
		acceptedReceiptChangeNotifications++;
	};
	tracker.attach(doc, () => Y.encodeStateVector(doc), provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), SCOPE);

	doc.getText("t").insert(0, "local candidate");
	await flushMicrotasks();
	s.check(tracker.serverAppliedLocalState === false, "local candidate starts pending");

	handleSvEchoCustomMessage(JSON.stringify({ type: "other/message", schema: 1 }), counters, recordAcceptedEcho);
	s.check(counters.customMessageSeenCount === 1, "unrelated custom message counted as custom-message seen");
	s.check(counters.svEchoSeenCount === 0, "unrelated custom message does not count as sv-echo seen");
	s.check(counters.rejectedCount === 0, "unrelated custom message does not count as rejected sv-echo");
	s.check(acceptedReceiptChangeNotifications === 0, "unrelated custom message does not request a receipt-status refresh");
	s.check(tracker.serverAppliedLocalState === false, "unrelated custom message leaves tracker unchanged");

	handleSvEchoCustomMessage(JSON.stringify({ type: "yaos/sv-echo", schema: 2, sv: "AA==" }), counters, recordAcceptedEcho);
	s.check(counters.svEchoSeenCount === 1, "invalid typed echo counts as sv-echo seen");
	s.check(counters.rejectedCount === 1, "invalid typed echo increments rejected count");
	s.check(counters.rejectedInvalidCount === 1, "invalid typed echo increments invalid count");
	s.check(acceptedReceiptChangeNotifications === 0, "invalid typed echo does not request a receipt-status refresh");
	s.check(tracker.serverAppliedLocalState === false, "invalid typed echo leaves tracker unchanged");

	handleSvEchoCustomMessage(makeSvEchoMessage(Y.encodeStateVector(serverDoc)), counters, recordAcceptedEcho);
	s.check(counters.acceptedCount === 1, "valid non-dominating echo accepted");
	s.check(acceptedReceiptChangeNotifications === 1, "valid non-dominating echo requests a receipt-status refresh");
	s.check(tracker.serverAppliedLocalState === false, "valid non-dominating echo leaves candidate pending");

	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(doc));
	handleSvEchoCustomMessage(makeSvEchoMessage(Y.encodeStateVector(serverDoc)), counters, recordAcceptedEcho);
	s.check(counters.acceptedCount === 2, "valid dominating echo accepted");
	s.check(acceptedReceiptChangeNotifications === 2, "each accepted echo requests one receipt-status refresh");
	s.check(tracker.serverAppliedLocalState === true, "valid dominating echo confirms candidate");

	doc.destroy();
	serverDoc.destroy();
}
await s.done();
