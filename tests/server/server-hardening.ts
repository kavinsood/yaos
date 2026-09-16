import { runSingleFlight } from "../../server/src/asyncConcurrency";
import { MAX_BLOB_UPLOAD_BYTES, MAX_DURABLE_UPDATE_BYTES } from "../../server/src/contracts";
import { CONFIG_FORMAT } from "../../server/src/identity";
import {
	getAuthStateCached,
	getCapabilities,
	invalidateStoredServerConfigCache,
} from "../../server/src/routes/auth";
import type { Env } from "../../server/src/routes/types";
import { partitionDurableUpdateBatches } from "../../server/src/server";
import { FakeObjectStore, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";
import * as Y from "yjs";

const s = suite("server-hardening");

s.section("Test 1: runSingleFlight shares one in-flight cold-start load");
{
	let loadCalls = 0;
	let releaseLoad!: () => void;
	const loadGate = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});

	const gate = { inFlight: null as Promise<void> | null };
	const loadRoom = () =>
		runSingleFlight(gate, async () => {
			loadCalls++;
			await loadGate;
		});

	const pending = Promise.all([loadRoom(), loadRoom(), loadRoom()]);
	releaseLoad();
	await pending;

	s.check(loadCalls === 1, "concurrent cold-start callers share one load task");
	s.check(gate.inFlight === null, "single-flight gate clears after a successful load");
}

s.section("Test 2: runSingleFlight clears after a failed load so the next call can retry");
{
	let loadCalls = 0;
	let shouldFail = true;
	const gate = { inFlight: null as Promise<void> | null };
	const loadRoom = () =>
		runSingleFlight(gate, async () => {
			loadCalls++;
			if (shouldFail) {
				throw new Error("boom");
			}
		});

	let sawFailure = false;
	try {
		await loadRoom();
	} catch {
		sawFailure = true;
	}

	s.check(sawFailure, "failed single-flight load surfaces the original error");
	s.check(gate.inFlight === null, "single-flight gate clears after a failed load");

	shouldFail = false;
	await loadRoom();
	s.check(loadCalls === 2, "single-flight load can retry after a failure");
	s.check(gate.inFlight === null, "single-flight gate clears after the retry succeeds");
}


s.section("Test 8: public capabilities do not expose private update metadata");
{
	const env = makeEnv({ YAOS_BUCKET: new FakeObjectStore() });
	const auth = {
		mode: "claim",
		claimed: true,
		operatorRecoveryHash: "operator-hash",
		ticketSigningKey: "ticket-signing-key",
	} as const;
	const config = {
		configFormat: 2,
		claimed: true,
		operatorRecoveryHash: "operator-hash",
		ticketSigningKey: "ticket-signing-key",
		updateProvider: "github" as const,
		updateRepoUrl: "https://github.com/private/fork",
		updateRepoBranch: "secret-branch",
	};
	const publicCaps = getCapabilities(auth, env, config);
	s.check(publicCaps.maxBlobUploadBytes === MAX_BLOB_UPLOAD_BYTES, "capabilities expose the server blob upload cap");
	s.check(publicCaps.updateProvider === null, "public capabilities hide update provider");
	s.check(publicCaps.updateRepoUrl === null, "public capabilities hide update repo URL");
	s.check(publicCaps.updateRepoBranch === null, "public capabilities hide update repo branch");

	const privateCaps = getCapabilities(auth, env, config, { includePrivateUpdateMetadata: true });
	s.check(privateCaps.updateProvider === "github", "authenticated capabilities include update provider");
	s.check(privateCaps.updateRepoUrl === "https://github.com/private/fork", "authenticated capabilities include update repo URL");
	s.check(privateCaps.updateRepoBranch === "secret-branch", "authenticated capabilities include update repo branch");
}

s.section("Test 9: capabilities expose one final identity-neutral shape");
{
	const env = makeEnv({ YAOS_BUCKET: new FakeObjectStore() });
	const auth = {
		mode: "claim",
		claimed: true,
		operatorRecoveryHash: "operator-hash",
		ticketSigningKey: "ticket-signing-key",
	} as const;
	const caps = getCapabilities(auth, env);
	s.check(caps.settingsSync === true, "capabilities advertise the settings SQL sidecar");
	s.check(caps.settingsFormatVersion === 2, "capabilities pin settings format version 2");
	s.check(
		JSON.stringify(Object.keys(caps).sort()) === JSON.stringify([
			"attachments",
			"claimed",
			"maxBlobUploadBytes",
			"protocolVersion",
			"recoveryJobs",
			"schemaVersion",
			"semanticCanvas",
			"serverVersion",
			"settingsFormatVersion",
			"settingsSync",
			"snapshotFormatVersion",
			"snapshots",
			"storageFormatVersion",
			"updateProvider",
			"updateRepoBranch",
			"updateRepoUrl",
		]),
		"capabilities expose the exact current contract",
	);
	s.check(caps.claimed === true, "capabilities preserve claimed state");
}

s.test("an unclaimed config is not retained across the one-way claim transition", async () => {
	let claimed = false;
	let reads = 0;
	const env = {
		YAOS_CONFIG: {
			call: async () => {
				reads++;
				return Response.json({
					configFormat: claimed ? CONFIG_FORMAT : null,
					claimed,
					operatorRecoveryHash: claimed ? "operator-hash" : null,
					ticketSigningKey: claimed ? "ticket-signing-key" : null,
					updateProvider: null,
					updateRepoUrl: null,
					updateRepoBranch: null,
				});
			},
		},
	} as unknown as Env;

	invalidateStoredServerConfigCache();
	try {
		const before = await getAuthStateCached(env);
		s.check(!before.claimed && reads === 1, "the first read observes the fresh unclaimed deployment");

		// Model /claim being handled by another warm Worker isolate. This
		// isolate receives no direct cache invalidation signal.
		claimed = true;
		const after = await getAuthStateCached(env);
		s.check(after.mode === "claim" && reads === 2,
			"the next request re-reads ServerConfig instead of serving stale unclaimed state");

		await getAuthStateCached(env);
		s.check(reads === 2, "the stable claimed state retains the normal bounded cache");
	} finally {
		invalidateStoredServerConfigCache();
	}
});

s.section("Debounced persistence never merges a batch beyond one durable row");
{
	const document = new Y.Doc();
	const text = document.getText("body");
	const updates: Array<{ bytes: Uint8Array }> = [];
	for (const character of ["a", "b"]) {
		const before = Y.encodeStateVector(document);
		text.insert(text.length, character.repeat(900_000));
		updates.push({ bytes: Y.encodeStateAsUpdate(document, before) });
	}
	const unbounded = Y.mergeUpdates(updates.map((entry) => entry.bytes));
	s.check(updates.every((entry) => entry.bytes.byteLength < MAX_DURABLE_UPDATE_BYTES),
		"fixture updates are individually durable");
	s.check(unbounded.byteLength > MAX_DURABLE_UPDATE_BYTES,
		"fixture reproduces the oversized merged-update failure");
	const batches = partitionDurableUpdateBatches(updates);
	s.check(batches.length === 2 && batches.flat().length === updates.length,
		"oversized pending work is split without loss");
	s.check(batches.every((batch) => Y.mergeUpdates(batch.map((entry) => entry.bytes)).byteLength <= MAX_DURABLE_UPDATE_BYTES),
		"every persistence batch fits one SQLite-safe row");
	document.destroy();
}

await s.done();
