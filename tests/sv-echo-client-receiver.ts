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
} from "../src/sync/svEchoMessage";
import { ServerAckTracker } from "../src/sync/serverAckTracker";
import { InMemoryCandidateStore, type ScopeKey, type ScopeMetadata } from "../src/sync/candidateStore";

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

console.log("\n--- Test 1: custom-message receiver counters and tracker path ---");
{
	const doc = new Y.Doc({ gc: false });
	const serverDoc = new Y.Doc({ gc: false });
	const provider = {};
	const tracker = new ServerAckTracker();
	const counters = createSvEchoCounters();
	tracker.attach(doc, () => Y.encodeStateVector(doc), provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), SCOPE);

	doc.getText("t").insert(0, "local candidate");
	await flushMicrotasks();
	assert(tracker.serverAppliedLocalState === false, "local candidate starts pending");

	handleSvEchoCustomMessage(JSON.stringify({ type: "other/message", schema: 1 }), counters, (sv) => {
		tracker.recordServerSvEcho(sv);
	});
	assert(counters.customMessageSeenCount === 1, "unrelated custom message counted as custom-message seen");
	assert(counters.svEchoSeenCount === 0, "unrelated custom message does not count as sv-echo seen");
	assert(counters.rejectedCount === 0, "unrelated custom message does not count as rejected sv-echo");
	assert(tracker.serverAppliedLocalState === false, "unrelated custom message leaves tracker unchanged");

	handleSvEchoCustomMessage(JSON.stringify({ type: "yaos/sv-echo", schema: 2, sv: "AA==" }), counters, (sv) => {
		tracker.recordServerSvEcho(sv);
	});
	assert(counters.svEchoSeenCount === 1, "invalid typed echo counts as sv-echo seen");
	assert(counters.rejectedCount === 1, "invalid typed echo increments rejected count");
	assert(counters.rejectedInvalidCount === 1, "invalid typed echo increments invalid count");
	assert(tracker.serverAppliedLocalState === false, "invalid typed echo leaves tracker unchanged");

	handleSvEchoCustomMessage(makeSvEchoMessage(Y.encodeStateVector(serverDoc)), counters, (sv) => {
		tracker.recordServerSvEcho(sv);
	});
	assert(counters.acceptedCount === 1, "valid non-dominating echo accepted");
	assert(tracker.serverAppliedLocalState === false, "valid non-dominating echo leaves candidate pending");

	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(doc));
	handleSvEchoCustomMessage(makeSvEchoMessage(Y.encodeStateVector(serverDoc)), counters, (sv) => {
		tracker.recordServerSvEcho(sv);
	});
	assert(counters.acceptedCount === 2, "valid dominating echo accepted");
	assert(tracker.serverAppliedLocalState === true, "valid dominating echo confirms candidate");

	doc.destroy();
	serverDoc.destroy();
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
