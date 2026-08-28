import { runSingleFlight } from "../../server/src/asyncConcurrency";
import { MAX_BLOB_UPLOAD_BYTES } from "../../server/src/contracts";
import { getCapabilities } from "../../server/src/routes/auth";
import { FakeR2Bucket, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

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
	const env = makeEnv({ YAOS_BUCKET: new FakeR2Bucket() });
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
	const env = makeEnv({ YAOS_BUCKET: new FakeR2Bucket() });
	const auth = {
		mode: "claim",
		claimed: true,
		operatorRecoveryHash: "operator-hash",
		ticketSigningKey: "ticket-signing-key",
	} as const;
	const caps = getCapabilities(auth, env);
	s.check(caps.settingsSync === true, "capabilities advertise the settings SQL sidecar");
	s.check(caps.settingsFormatVersion === 1, "capabilities pin settings format version 1");
	s.check(
		JSON.stringify(Object.keys(caps).sort()) === JSON.stringify([
			"attachments",
			"claimed",
			"maxBlobUploadBytes",
			"protocolVersion",
			"recoveryJobs",
			"schemaVersion",
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

await s.done();
