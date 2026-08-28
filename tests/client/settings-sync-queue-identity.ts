import {
	loadApplyQueue,
	loadEnvironmentAcceptance,
	markEnvironmentAccepted,
	persistApplyQueue,
	retireApplyQueue,
	type ApplyQueueScope,
} from "../../src/sync/settingsSync/applyQueue";
import { suite } from "../harness.ts";
import { FakeIndexedDb } from "../mocks/indexedDb";

const s = suite("settings-sync-queue-identity");
const indexedDb = new FakeIndexedDb();
const base = {
	hostHash: "h".repeat(64),
	vaultId: "vault-a",
	vaultGeneration: "generation-a",
	folderKey: "folder-a",
	deviceId: "device-a",
	configDirKey: ".obsidian",
	indexedDb,
} satisfies ApplyQueueScope;

async function store(scope: ApplyQueueScope, marker: string): Promise<void> {
	await persistApplyQueue(scope, {
		version: 1,
		identity: {
			hostHash: scope.hostHash,
			vaultId: scope.vaultId,
			vaultGeneration: scope.vaultGeneration,
			folderKey: scope.folderKey,
			deviceId: scope.deviceId,
			configDirKey: scope.configDirKey,
		},
		steps: [{ kind: "file", path: `${marker}.json`, body: "{}" }],
		nextIndex: 0,
	});
}

s.test("generation device and folder fences reject foreign queues", async () => {
	await store(base, "current");
	for (const foreign of [
		{ ...base, vaultGeneration: "generation-old" },
		{ ...base, deviceId: "device-old" },
		{ ...base, folderKey: "folder-old" },
	]) {
		s.check(await loadApplyQueue(foreign) === null, "foreign identity does not resume");
	}
	s.check((await loadApplyQueue(base))?.steps.length === 1, "exact identity resumes");
});
s.test("environment acceptance is fenced by the complete identity", async () => {
	await markEnvironmentAccepted(base);
	s.check(await loadEnvironmentAcceptance(base), "exact identity loads acceptance");
	for (const foreign of [
		{ ...base, vaultGeneration: "generation-foreign" },
		{ ...base, deviceId: "device-foreign" },
		{ ...base, folderKey: "folder-foreign" },
	]) {
		s.check(!await loadEnvironmentAcceptance(foreign), "foreign identity is not accepted");
	}
});


s.test("retire clears only the exact identity", async () => {
	const sibling = { ...base, deviceId: "device-b" };
	await store(base, "a");
	await store(sibling, "b");
	await markEnvironmentAccepted(base);
	await markEnvironmentAccepted(sibling);
	await retireApplyQueue(base);
	s.check(await loadApplyQueue(base) === null, "retired queue is cleared");
	s.check(await loadApplyQueue(sibling) !== null, "sibling enrollment queue remains");
	s.check(!await loadEnvironmentAcceptance(base), "retired acceptance is cleared");
	s.check(await loadEnvironmentAcceptance(sibling), "sibling acceptance remains");
});

await s.done();
