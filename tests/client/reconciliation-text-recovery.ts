import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentBaselineHash } from "../../src/sync/diskIndex";
import { suite, until } from "../harness.ts";
import { artifactContents, BODY_ID, decodeText, durableWrite, editDisk, openRecovery, readDisk, readRemote, readState, seedRecovery } from "../fixtures/reconciliation-recovery/fixture.ts";

const tests = suite("reconciliation-text-recovery");
const expectedText = "retained expected input\n";
const remoteText = "durable remote winner\n";
const independentText = "unique independent disk input 🦋\n";

async function withRecovery(input: { disk: string; base?: string | null; raceDisk?: string }, execute: (fixture: Awaited<ReturnType<typeof openRecovery>>, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "yaos-text-recovery-"));
	let fixture: Awaited<ReturnType<typeof openRecovery>> | undefined;
	try {
		await seedRecovery(root, { body: remoteText, disk: input.disk, base: input.base === undefined ? expectedText : input.base });
		fixture = await openRecovery(root, { raceDisk: input.raceDisk });
		await execute(fixture, root);
	} finally {
		await fixture?.close();
		await rm(root, { recursive: true, force: true });
	}
}

tests.test("disk equals durable remote: only agreement bookkeeping, no projection or candidate", async () => {
	await withRecovery({ disk: remoteText }, async (fixture, root) => {
		assert.equal(await fixture.reconcile(), "settled");
		assert.deepEqual(fixture.counts(), { processCalls: 0, modifyCalls: 0 });
		assert.equal(readDisk(root), remoteText);
		assert.equal(readState(root).settlements[BODY_ID]!.content, remoteText);
		assert.deepEqual(readRemote(root).attempts, []);
		assert.deepEqual(artifactContents(root), []);
	});
});

tests.test("disk equals retained expected: conditionally project the durable remote through Vault.process", async () => {
	await withRecovery({ disk: expectedText }, async (fixture, root) => {
		assert.equal(await fixture.reconcile(), "settled");
		assert.deepEqual(fixture.counts(), { processCalls: 1, modifyCalls: 0 });
		assert.equal(readDisk(root), remoteText);
		assert.equal(readState(root).settlements[BODY_ID]!.content, remoteText);
		assert.deepEqual(readRemote(root).attempts, []);
	});
});

tests.test("neither side matches retained expected: preserve unique inputs, do not replay into CRDT", async () => {
	await withRecovery({ disk: independentText }, async (fixture, root) => {
		assert.equal(await fixture.reconcile(), "preserved-unresolved");
		const episode = fixture.episodes.get(BODY_ID)!;
		assert.ok(episode);
		for (const input of [independentText, remoteText, expectedText]) {
			const hash = await contentBaselineHash(input);
			assert.equal(await fixture.episodes.readVersion(BODY_ID, hash), input);
		}
		assert.deepEqual(readRemote(root).attempts, []);
		assert.deepEqual(Object.keys(readState(root).candidates), []);
		assert.equal(decodeText(readState(root).documents[BODY_ID]!.encodedState), remoteText);
	});
});

tests.test("missing ancestry preserves disk without guessing an expected value", async () => {
	await withRecovery({ disk: independentText, base: null }, async (fixture, root) => {
		assert.equal(await fixture.reconcile(), "preserved-unresolved");
		assert.equal(readDisk(root), independentText);
		assert.deepEqual(fixture.counts(), { processCalls: 0, modifyCalls: 0 });
		assert.deepEqual(readRemote(root).attempts, []);
	});
});

for (const racedText of [independentText, expectedText.replace(/\n/g, "\r\n")]) {
	tests.test(`actual projection callback refuses exact disk movement ${JSON.stringify(racedText)}`, async () => {
		await withRecovery({ disk: expectedText, raceDisk: racedText }, async (fixture, root) => {
			assert.equal(await fixture.reconcile(), "replan");
			assert.equal(readDisk(root), racedText);
			assert.deepEqual(fixture.counts(), { processCalls: 1, modifyCalls: 0 });
			assert.equal(readState(root).settlements[BODY_ID]!.content, expectedText);
			assert.deepEqual(readRemote(root).attempts, []);
		});
	});
}

tests.test("durable episode deduplicates identical inputs and keeps every new disk input", async () => {
	await withRecovery({ disk: independentText }, async (fixture, root) => {
		await fixture.reconcile();
		const original = fixture.episodes.snapshot().episodes[BODY_ID]!;
		editDisk(root, independentText);
		await fixture.reconcile();
		assert.equal(fixture.episodes.get(BODY_ID)!.id, original.id);
		assert.equal(fixture.episodes.get(BODY_ID)!.versions.length, original.versions.length);
		const secondInput = "second unique disk episode input 🐚\n";
		editDisk(root, secondInput);
		await fixture.reconcile();
		const current = readState(root).episodes.episodes[BODY_ID]!;
		assert.equal(current.id, original.id);
		assert.equal(current.versions.length, original.versions.length + 1);
		assert.ok(artifactContents(root).some((content) => content.includes(secondInput)));
		assert.deepEqual(readRemote(root).attempts, []);
	});
});

async function testMaterializedExternalSave(ingestion: "settlement" | "controller"): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "yaos-text-stale-editor-"));
	const originalText = "# Shared note\n\nExternal editor retained paragraph A.\n";
	const remoteParagraph = "Remote-only paragraph B 🛰️ must survive.\n";
	const materializedText = `${originalText}\n${remoteParagraph}`;
	const externalSave = "# Shared note\n\nExternal editor unique replacement C 🐚.\n";
	let fixture: Awaited<ReturnType<typeof openRecovery>> | undefined;
	try {
		await seedRecovery(root, { body: materializedText, disk: originalText, base: originalText });
		fixture = await openRecovery(root);
		assert.equal(await fixture.reconcile(), "settled");
		assert.equal(readDisk(root), materializedText);
		assert.equal(readState(root).settlements[BODY_ID]!.content, materializedText);
		assert.deepEqual(readRemote(root).attempts, []);
		editDisk(root, externalSave);
		if (ingestion === "controller") await fixture.ingest();
		else await fixture.reconcile();
		const recoveredBody = decodeText(readState(root).documents[BODY_ID]!.encodedState);
		assert.ok(recoveredBody.includes(remoteParagraph), `post-materialization disk import deleted B's remote paragraph: ${JSON.stringify(recoveredBody)}`);
		const retained = [readDisk(root), recoveredBody, ...artifactContents(root)];
		assert.ok(retained.some((content) => content.includes("External editor unique replacement C 🐚.")), "unique external save C must remain recoverable");
		assert.ok(decodeText(readRemote(root).encodedState).includes(remoteParagraph), "server state must not lose B's remote paragraph");
	} finally {
		await fixture?.close();
		await rm(root, { recursive: true, force: true });
	}
}

for (const ingestion of ["settlement", "controller"] as const) {
	tests.test(`A→B→C ${ingestion} after completed materialization preserves B's remote paragraph and C's unique disk text`, () => testMaterializedExternalSave(ingestion));
}

tests.test("production cold-body ingestion leaves the filesystem worker available while currentHead is stalled", async () => {
	const root = await mkdtemp(join(tmpdir(), "yaos-text-planning-wait-"));
	const updatedText = `${expectedText}\nInsert-only external edit while loading the cold body 🪸.\n`;
	let releaseHead!: () => void;
	let headEntered = false;
	let headReleased = false;
	let ingestionCompleted = false;
	let ingestionFailure: unknown;
	const headGate = new Promise<void>((resolve) => { releaseHead = () => { headReleased = true; resolve(); }; });
	let fixture: Awaited<ReturnType<typeof openRecovery>> | undefined;
	let ingestion: Promise<void> | undefined;
	let following: Promise<void> | undefined;
	try {
		await seedRecovery(root, { body: expectedText, disk: expectedText, base: expectedText });
		fixture = await openRecovery(root, { checkpoint: async (name) => {
			if (name === "before-current-head") { headEntered = true; await headGate; }
		} });
		assert.equal(await fixture.runtime.bodies.evict(BODY_ID), true);
		assert.equal(fixture.runtime.isBodyLoaded(BODY_ID), false);
		editDisk(root, updatedText);
		ingestion = fixture.ingest().then(() => { ingestionCompleted = true; }, (error: unknown) => { ingestionFailure = error; });
		await until(() => headEntered, { message: "production ingestion reached the stalled remote-head fetch" });
		assert.equal(ingestionCompleted, false);
		assert.equal(ingestionFailure, undefined);
		let followingRan = false;
		following = fixture.worker.run(async () => {
			assert.equal(headReleased, false, "filesystem job must run before the head fetch is released");
			durableWrite(join(root, "worker-probe.txt"), "filesystem job completed during the stalled head fetch\n");
			followingRan = true;
		});
		await until(() => followingRan, { message: "filesystem job ran while production ingestion awaited currentHead" });
		await following;
		assert.equal(headReleased, false);
		assert.equal(ingestionCompleted, false);
		releaseHead(); await ingestion;
		if (ingestionFailure !== undefined) throw ingestionFailure;
		assert.equal(ingestionCompleted, true);
		assert.equal(decodeText(readState(root).documents[BODY_ID]!.encodedState), updatedText);
		assert.equal(readDisk(root), updatedText);
	} finally {
		releaseHead();
		await ingestion;
		await following?.catch(() => undefined);
		await fixture?.close(); await rm(root, { recursive: true, force: true });
	}
});

tests.test("waitForReceipt:false accepts a resident candidate without a hidden currentHead fetch", async () => {
	const root = await mkdtemp(join(tmpdir(), "yaos-text-resident-acceptance-"));
	let fixture: Awaited<ReturnType<typeof openRecovery>> | undefined;
	try {
		await seedRecovery(root, { body: remoteText, disk: remoteText, base: remoteText });
		fixture = await openRecovery(root, { checkpoint: async (name) => {
			if (name === "before-current-head") throw new Error("resident local acceptance must not fetch the remote head");
		} });
		assert.equal(await fixture.worker.run(() => fixture!.commit(independentText, remoteText, false)), "completed");
		assert.equal(decodeText(readState(root).documents[BODY_ID]!.encodedState), independentText);
		assert.equal((await fixture.runtime.commitBodyCandidateIfCurrent({ bodyId: "not-resident", expectedContent: "", content: independentText,
			candidateId: crypto.randomUUID(), reason: "recovery-test", waitForReceipt: false })).kind, "superseded");
	} finally {
		await fixture?.close(); await rm(root, { recursive: true, force: true });
	}
});

await tests.done();
