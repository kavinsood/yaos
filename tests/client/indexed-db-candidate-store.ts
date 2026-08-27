/**
 * FU-8 — IndexedDbCandidateStore tests.
 *
 * Uses the shared cast-free fake IndexedDB (tests/mocks/indexedDb.ts) so the
 * production store can be tested under Node without a browser/mock dependency.
 */

import * as Y from "yjs";
import {
	IndexedDbCandidateStore,
	buildCandidateStoreKey,
	getOrCreateLocalDeviceId,
} from "../../src/sync/indexedDbCandidateStore";
import { sha256BytesHex, sha256TextHex } from "../../src/utils/sha256";
import { encodeBytesBase64, MAX_SV_ECHO_BASE64_BYTES } from "../../src/sync/svEchoMessage";
import type { PersistedCandidateState, ScopeKey, ScopeMetadata } from "../../src/sync/candidateStore";
import { suite } from "../harness.ts";
import { FakeIndexedDb } from "../mocks/indexedDb";

const s = suite("indexed-db-candidate-store");

const BASE_SCOPE: ScopeKey & ScopeMetadata = {
	vaultIdHash: "a".repeat(64),
	serverHostHash: "b".repeat(64),
	localDeviceId: "local-device",
	roomName: "room-1",
	docSchemaVersion: 2,
	pluginVersion: "1.6.1",
	ackStoreVersion: 1,
};

function makeState(scope = BASE_SCOPE): PersistedCandidateState {
	const doc = new Y.Doc();
	doc.getText("t").insert(0, "candidate");
	const candidateSvBase64 = encodeBytesBase64(Y.encodeStateVector(doc));
	doc.destroy();
	return {
		schema: 1,
		...scope,
		candidateSvBase64,
		candidateCapturedAt: 123,
		lastKnownServerReceiptEchoAt: 456,
	};
}

function sameState(a: PersistedCandidateState | null, b: PersistedCandidateState): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

s.section("Test 1: key shape and hash helper");
{
	s.check(
		buildCandidateStoreKey(BASE_SCOPE) === `yaos-ack-v1:${"b".repeat(64)}:${"a".repeat(64)}:local-device`,
		"candidate key uses serverHostHash, vaultIdHash, localDeviceId",
	);
	const textHash = await sha256TextHex("YAOS");
	const byteHash = await sha256BytesHex(new TextEncoder().encode("YAOS"));
	s.check(/^[0-9a-f]{64}$/.test(textHash), "sha256TextHex returns lowercase 64-char hex");
	s.check(byteHash === textHash, "byte and text SHA-256 helpers use the same UTF-8 digest");
}

s.section("Test 2: save/load survives store re-instantiation");
{
	const fake = new FakeIndexedDb();
	const store1 = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-1");
	const state = makeState();
	await store1.save(state);

	const store2 = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-1");
	const loaded = await store2.load(BASE_SCOPE);
	s.check(sameState(loaded, state), "saved state loads from a new store instance");
}

s.section("Test 3: scope mismatch fails closed");
{
	const fake = new FakeIndexedDb();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-2");
	await store.save(makeState());

	const wrongScope = { ...BASE_SCOPE, roomName: "room-2" };
	const loaded = await store.load(wrongScope);
	s.check(loaded === null, "wrong roomName returns null");
}

s.section("Test 4: clear deletes candidate state");
{
	const fake = new FakeIndexedDb();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-3");
	await store.save(makeState());
	await store.clear();
	const loaded = await store.load(BASE_SCOPE);
	s.check(loaded === null, "clear removes stored candidate");
}

s.section("Test 5: corrupt records fail closed");
{
	const fake = new FakeIndexedDb();
	const key = buildCandidateStoreKey(BASE_SCOPE);

	fake.putRaw("ack-test-4", "candidateStates", key, { ...makeState(), schema: 2 });
	const schemaStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-4");
	s.check(await schemaStore.load(BASE_SCOPE) === null, "wrong schema returns null");

	fake.putRaw("ack-test-5", "candidateStates", key, { ...makeState(), candidateSvBase64: encodeBytesBase64(new Uint8Array(0)) });
	const corruptSvStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-5");
	s.check(await corruptSvStore.load(BASE_SCOPE) === null, "invalid candidate SV returns null");

	fake.putRaw("ack-test-5b", "candidateStates", key, { ...makeState(), ackStoreVersion: 2 });
	const versionStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-5b");
	s.check(await versionStore.load(BASE_SCOPE) === null, "unsupported ackStoreVersion returns null");

	fake.putRaw("ack-test-5c", "candidateStates", key, { ...makeState(), candidateSvBase64: "A".repeat(MAX_SV_ECHO_BASE64_BYTES + 1) });
	const oversizedStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-5c");
	s.check(await oversizedStore.load(BASE_SCOPE) === null, "oversized candidate SV returns null");

	fake.putRaw("ack-test-5d", "candidateStates", key, { ...makeState(), candidateCapturedAt: Number.NaN });
	const nanStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-5d");
	s.check(await nanStore.load(BASE_SCOPE) === null, "NaN timestamp returns null");

	fake.putRaw("ack-test-5e", "candidateStates", key, { ...makeState(), candidateSvBase64: null, candidateCapturedAt: 123 });
	const nullCandidateWithCaptureStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-5e");
	s.check(await nullCandidateWithCaptureStore.load(BASE_SCOPE) === null, "null candidate with capturedAt returns null");

	fake.putRaw("ack-test-5f", "candidateStates", key, { ...makeState(), candidateCapturedAt: null });
	const candidateWithoutCaptureStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-5f");
	s.check(await candidateWithoutCaptureStore.load(BASE_SCOPE) === null, "candidate without capturedAt returns null");

	fake.putRaw("ack-test-5g", "candidateStates", key, { ...makeState(), candidateSvBase64: null, candidateCapturedAt: null });
	const nullCandidateWithHistoryStore = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-5g");
	s.check(await nullCandidateWithHistoryStore.load(BASE_SCOPE) !== null, "null candidate with historical receipt is allowed");
}

s.section("Test 6: open failures fail closed on load and reject save");
{
	const fake = new FakeIndexedDb();
	fake.failOpen = true;
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-6");
	s.check(await store.load(BASE_SCOPE) === null, "load open failure returns null");
	try {
		await store.save(makeState());
		s.check(false, "save open failure rejects");
	} catch {
		s.check(true, "save open failure rejects");
	}
}

s.section("Test 7: localDeviceId is stable once created");
{
	const fake = new FakeIndexedDb();
	let created = 0;
	const randomUuid = () => {
		created++;
		return `uuid-${created}`;
	};
	const first = await getOrCreateLocalDeviceId(fake, randomUuid, "ack-test-7");
	const second = await getOrCreateLocalDeviceId(fake, randomUuid, "ack-test-7");
	s.check(first === "uuid-1", "first localDeviceId is generated");
	s.check(second === first, "second localDeviceId reuses stored value");
	s.check(created === 1, "random UUID called only once");
}

s.section("Test 8: save rejects mismatched or invalid scope");
{
	const fake = new FakeIndexedDb();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-8");
	try {
		await store.save(makeState({ ...BASE_SCOPE, roomName: "other-room" }));
		s.check(false, "mismatched save rejects");
	} catch {
		s.check(true, "mismatched save rejects");
	}
	try {
		await store.save(makeState({ ...BASE_SCOPE, vaultIdHash: "not-a-hash" }));
		s.check(false, "invalid persisted state rejects");
	} catch {
		s.check(true, "invalid persisted state rejects");
	}
}

s.section("Test 9: writes resolve only after transaction completion");
{
	const fake = new FakeIndexedDb();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-9");
	let resolved = false;
	const savePromise = store.save(makeState()).then(() => { resolved = true; });
	await Promise.resolve();
	s.check(!resolved, "save not resolved at request success tick");
	await savePromise;
	s.check(resolved, "save resolves after transaction completion");
}

s.section("Test 10: transaction abort after request success rejects save/delete");
{
	const fake = new FakeIndexedDb();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake, "ack-test-10");
	fake.abortNextWriteTransaction = true;
	try {
		await store.save(makeState());
		s.check(false, "save abort rejects");
	} catch {
		s.check(true, "save abort rejects");
	}

	await store.save(makeState());
	fake.abortNextWriteTransaction = true;
	try {
		await store.clear();
		s.check(false, "clear abort rejects");
	} catch {
		s.check(true, "clear abort rejects");
	}
}

s.section("Test 11: concurrent localDeviceId creation converges");
{
	const fake = new FakeIndexedDb();
	let created = 0;
	const randomUuid = () => {
		created++;
		return `uuid-${created}`;
	};
	const [first, second] = await Promise.all([
		getOrCreateLocalDeviceId(fake, randomUuid, "ack-test-11"),
		getOrCreateLocalDeviceId(fake, randomUuid, "ack-test-11"),
	]);
	s.check(first === second, "concurrent callers return the same localDeviceId");
	s.check(created === 1, "concurrent callers generate one UUID");
}
await s.done();
