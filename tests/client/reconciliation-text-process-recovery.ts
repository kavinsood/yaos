import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentBaselineHash } from "../../src/sync/diskIndex";
import { suite } from "../harness.ts";
import { artifactContents, BODY_ID, decodeText, durableWrite, editDisk, readDisk, readRemote, readState, RECOVERY_AUTHORITY, seedRecovery } from "../fixtures/reconciliation-recovery/fixture.ts";

const tests = suite("reconciliation-text-process-recovery");
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const expectedText = "retained expected process input\n";
const remoteText = "durable remote process winner\n";
const independentText = "unique disk edit while process is dead 🦋\n";
const acceptedText = "accepted disk candidate payload 🐚\n";

interface Report {
	outcome: string;
	pid: number;
	counts: { processCalls: number; modifyCalls: number };
	disk: string;
	storedBody: string;
}

async function runChild(root: string, operation: string, target = "", content = ""): Promise<{ pid: number; signal: NodeJS.Signals | null }> {
	const child = spawn(process.execPath, [resolve(repositoryRoot, "tests/run-typescript.mjs"), "--test-aliases",
		"tests/fixtures/reconciliation-recovery/child.ts", root, operation, target, content],
	{ cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	let errors = "";
	let reached = false;
	return new Promise((resolveChild, reject) => {
		const watchdog = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timeout at ${target}: ${output}\n${errors}`)); }, 30_000);
		child.on("error", (error) => { clearTimeout(watchdog); reject(error); });
		child.stdout.on("data", (bytes: Buffer) => {
			output += bytes.toString();
			if (target && !reached && output.includes(`CHECKPOINT ${target} ${child.pid}\n`)) {
				reached = true;
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (bytes: Buffer) => { errors += bytes.toString(); });
		child.on("close", (code, signal) => {
			clearTimeout(watchdog);
			if (target ? !reached || signal !== "SIGKILL" : code !== 0) {
				reject(new Error(`child failed at ${target || operation}: code=${code}, signal=${signal}\n${output}\n${errors}`));
				return;
			}
			resolveChild({ pid: child.pid!, signal });
		});
	});
}

async function withDirectory(execute: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "yaos-text-process-recovery-"));
	try { await execute(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function report(root: string): Report {
	return JSON.parse(readFileSync(join(root, "report.json"), "utf8")) as Report;
}

function retainsInput(root: string, input: string): boolean {
	return [readDisk(root), decodeText(readState(root).documents[BODY_ID]!.encodedState), ...artifactContents(root)]
		.some((content) => content.includes(input));
}

for (const boundary of ["before-disk-effect", "after-disk-effect", "before-agreement", "after-agreement"]) {
	for (const deadDisk of ["remote", "expected", "independent"] as const) {
		tests.test(`SIGKILL ${boundary}; disk edited while dead to ${deadDisk}; fresh recovery`, async () => {
			await withDirectory(async (root) => {
				await seedRecovery(root, { body: remoteText, disk: expectedText, base: expectedText });
				const killed = await runChild(root, "project", boundary);
				const persisted = readState(root);
				assert.equal(readDisk(root), boundary === "before-disk-effect" ? expectedText : remoteText);
				assert.equal(persisted.settlements[BODY_ID]!.content, boundary === "after-agreement" ? remoteText : expectedText);
				const deadInput = deadDisk === "remote" ? remoteText : deadDisk === "expected" ? expectedText : independentText;
				editDisk(root, deadInput);
				const recovered = await runChild(root, "recover");
				assert.notEqual(recovered.pid, killed.pid);
				const evidence = report(root);
				assert.equal(evidence.counts.modifyCalls, 0);
				assert.equal(evidence.storedBody, remoteText);
				assert.deepEqual(readRemote(root).attempts, []);
				assert.deepEqual(Object.keys(readState(root).candidates), []);
				if (deadDisk === "remote") {
					assert.equal(evidence.outcome, "settled");
					assert.equal(evidence.counts.processCalls, 0);
				} else if (deadDisk === "expected" && boundary !== "after-agreement") {
					assert.equal(evidence.outcome, "settled");
					assert.equal(evidence.counts.processCalls, 1);
				} else {
					assert.equal(evidence.outcome, "preserved-unresolved");
					assert.ok(retainsInput(root, deadInput));
				}
			});
		});
	}
}

for (const boundary of ["after-candidate-persistence", "before-body-persistence", "after-body-persistence", "before-remote-effect", "after-remote-effect", "before-candidate-removal", "after-candidate-removal"]) {
	tests.test(`SIGKILL ${boundary}; durable candidate/CRDT survives a new disk edit`, async () => {
		await withDirectory(async (root) => {
			await seedRecovery(root, { body: expectedText, disk: acceptedText, base: expectedText });
			const killed = await runChild(root, "commit", boundary, acceptedText);
			const priorCandidates = Object.keys(readState(root).candidates);
			assert.equal(decodeText(readState(root).documents[BODY_ID]!.encodedState),
				boundary === "after-candidate-persistence" || boundary === "before-body-persistence" ? expectedText : acceptedText);
			assert.equal(priorCandidates.length, boundary === "after-candidate-removal" ? 0 : 1);
			if (priorCandidates.length) {
				assert.equal(readState(root).candidates[priorCandidates[0]!]!.pendingMarkdown, acceptedText);
				assert.deepEqual(readState(root).candidates[priorCandidates[0]!]!.authority, RECOVERY_AUTHORITY);
			}
			editDisk(root, independentText);
			const recovered = await runChild(root, "recover");
			assert.notEqual(recovered.pid, killed.pid);
			assert.equal(decodeText(readRemote(root).encodedState), acceptedText);
			assert.equal(report(root).storedBody, acceptedText);
			assert.deepEqual(Object.keys(readState(root).candidates), []);
			assert.ok(retainsInput(root, independentText));
			const remote = readRemote(root);
			assert.equal(Object.keys(remote.receipts).length, 1);
			assert.equal(new Set(remote.attempts).size, 1);
			if (priorCandidates.length) assert.equal(remote.attempts.at(-1), priorCandidates[0]);
		});
	});
}

tests.test("SIGKILL before candidate persistence is not durable acceptance and cannot publish an orphan dirty body", async () => {
	await withDirectory(async (root) => {
		await seedRecovery(root, { body: expectedText, disk: acceptedText, base: expectedText });
		await runChild(root, "commit", "before-candidate-persistence", acceptedText);
		assert.equal(decodeText(readState(root).documents[BODY_ID]!.encodedState), expectedText);
		assert.deepEqual(Object.keys(readState(root).candidates), []);
		editDisk(root, expectedText);
		await runChild(root, "recover");
		assert.equal(report(root).storedBody, expectedText);
		assert.equal(decodeText(readRemote(root).encodedState), expectedText);
		assert.deepEqual(readRemote(root).attempts, []);
	});
});

tests.test("SIGKILL after durable waitForReceipt:false acceptance with remote ACK stalled; candidate recovers", async () => {
	await withDirectory(async (root) => {
		await seedRecovery(root, { body: expectedText, disk: acceptedText, base: expectedText });
		await runChild(root, "accept", "after-local-acceptance", acceptedText);
		const candidateIds = Object.keys(readState(root).candidates);
		assert.equal(candidateIds.length, 1);
		assert.deepEqual(readRemote(root).attempts, []);
		editDisk(root, independentText);
		await runChild(root, "recover");
		assert.equal(decodeText(readRemote(root).encodedState), acceptedText);
		assert.equal(report(root).storedBody, acceptedText);
		assert.ok(retainsInput(root, independentText));
		assert.deepEqual(readRemote(root).attempts, candidateIds);
	});
});

for (const boundary of ["after-candidate-persistence", "before-body-persistence", "after-body-persistence"]) {
	tests.test(`editor observer candidate-first durability: SIGKILL ${boundary} retains and replays editor input`, async () => {
		await withDirectory(async (root) => {
			await seedRecovery(root, { body: expectedText, disk: expectedText, base: expectedText });
			await runChild(root, "editor", boundary, acceptedText);
			const persisted = readState(root).documents[BODY_ID]!;
			assert.equal(decodeText(persisted.encodedState), boundary === "after-body-persistence" ? acceptedText : expectedText);
			const candidates = Object.values(readState(root).candidates);
			assert.equal(candidates.length, 1);
			assert.equal(candidates[0]!.pendingMarkdown, acceptedText);
			assert.deepEqual(candidates[0]!.authority, RECOVERY_AUTHORITY);
			editDisk(root, independentText);
			await runChild(root, "recover");
			assert.equal(report(root).storedBody, acceptedText);
			assert.equal(decodeText(readRemote(root).encodedState), acceptedText);
			assert.equal(new Set(readRemote(root).attempts).size, 1);
			assert.ok(retainsInput(root, independentText));
			assert.deepEqual(Object.keys(readState(root).candidates), []);
		});
	});
}

tests.test("editor crash before candidate persistence has no durable acceptance", async () => {
	await withDirectory(async (root) => {
		await seedRecovery(root, { body: expectedText, disk: expectedText, base: expectedText });
		await runChild(root, "editor", "before-candidate-persistence", acceptedText);
		assert.deepEqual(Object.keys(readState(root).candidates), []);
		assert.equal(decodeText(readState(root).documents[BODY_ID]!.encodedState), expectedText);
		await runChild(root, "recover");
		assert.equal(report(root).storedBody, expectedText);
		assert.equal(decodeText(readRemote(root).encodedState), expectedText);
		assert.deepEqual(readRemote(root).attempts, []);
	});
});

tests.test("concurrent editor update during earlier candidate persistence cannot orphan newer persisted input", async () => {
	await withDirectory(async (root) => {
		await seedRecovery(root, { body: expectedText, disk: expectedText, base: expectedText });
		await runChild(root, "editor-concurrent", "after-body-persistence", acceptedText);
		const newestText = `${acceptedText}Newer concurrent editor input 🪸.\n`;
		const persisted = readState(root);
		assert.equal(decodeText(persisted.documents[BODY_ID]!.encodedState), newestText, "checkpoint observes the dirty write after the second editor update");
		const firstCandidates = Object.values(persisted.candidates);
		assert.equal(firstCandidates.length, 1);
		assert.equal(firstCandidates[0]!.pendingMarkdown, acceptedText, "the earlier candidate snapshot must not claim the newer editor update");
		editDisk(root, independentText);
		await runChild(root, "recover", "after-candidate-persistence");
		const reconstructed = Object.values(readState(root).candidates).filter((candidate) => candidate.candidateId !== firstCandidates[0]!.candidateId);
		assert.equal(reconstructed.length, 1, "recovery must persist exactly one retained full update before replay");
		assert.deepEqual(reconstructed[0]!.authority, firstCandidates[0]!.authority);
		assert.equal(reconstructed[0]!.pendingMarkdown, newestText);
		assert.equal(decodeText(reconstructed[0]!.encodedUpdate), newestText, "retained recovery bytes must reconstruct the full newer text");
		assert.deepEqual(readRemote(root).attempts, [], "retained update must be durable before either candidate is sent");
		await runChild(root, "recover");
		assert.equal(report(root).storedBody, newestText, "newer CRDT bytes must remain locally recoverable");
		const recoveredDocument = readState(root).documents[BODY_ID]!;
		assert.equal(recoveredDocument.kind, "body");
		assert.equal(decodeText(readRemote(root).encodedState), newestText,
			`newer input persisted during older capture must have a replayable durable update; dirty=${recoveredDocument.dirty}`);
		assert.ok(retainsInput(root, independentText));
	});
});

tests.test("retained concurrent editor text cannot be recaptured or replayed under a changed candidate authority", async () => {
	await withDirectory(async (root) => {
		await seedRecovery(root, { body: expectedText, disk: expectedText, base: expectedText });
		await runChild(root, "editor-concurrent", "after-body-persistence", acceptedText);
		const priorCandidates = Object.keys(readState(root).candidates);
		assert.equal(priorCandidates.length, 1);
		editDisk(root, independentText);
		await runChild(root, "recover-authority-changed");
		assert.deepEqual(Object.keys(readState(root).candidates), priorCandidates, "authority change must not manufacture a retained-state candidate");
		assert.deepEqual(readState(root).candidates[priorCandidates[0]!]!.authority, RECOVERY_AUTHORITY);
		assert.equal(report(root).storedBody, `${acceptedText}Newer concurrent editor input 🪸.\n`);
		assert.deepEqual(readRemote(root).attempts, []);
		assert.equal(decodeText(readRemote(root).encodedState), expectedText);
		assert.ok(retainsInput(root, independentText));
	});
});

tests.test("A→B→C after materialization and agreement, SIGKILL, then stale external save retains remote paragraph", async () => {
	await withDirectory(async (root) => {
		const originalText = "# Shared note\n\nExternal editor retained paragraph A.\n";
		const remoteParagraph = "Remote-only paragraph B 🛰️ must survive.\n";
		const materializedText = `${originalText}\n${remoteParagraph}`;
		const externalSave = "# Shared note\n\nExternal editor unique replacement C 🐚.\n";
		await seedRecovery(root, { body: materializedText, disk: originalText, base: originalText });
		await runChild(root, "project", "after-agreement");
		assert.equal(readDisk(root), materializedText);
		assert.equal(readState(root).settlements[BODY_ID]!.content, materializedText);
		editDisk(root, externalSave);
		await runChild(root, "recover");
		assert.ok(report(root).storedBody.includes(remoteParagraph), "stale C must not delete B's remote-only paragraph after restart");
		assert.ok(decodeText(readRemote(root).encodedState).includes(remoteParagraph));
		assert.ok([readDisk(root), report(root).storedBody, ...artifactContents(root)].some((content) => content.includes("External editor unique replacement C 🐚.")));
	});
});

for (const boundary of ["before-artifact-effect", "after-artifact-effect", "before-episode-persistence", "after-episode-persistence"]) {
	tests.test(`SIGKILL ${boundary}; pending conflict append recovers the same episode and part`, async () => {
		await withDirectory(async (root) => {
			await seedRecovery(root, { body: remoteText, disk: acceptedText, base: expectedText });
			await runChild(root, "episode");
			const original = readState(root).episodes.episodes[BODY_ID]!;
			assert.ok(original);
			assert.equal(original.parts.length, 1);
			const priorArtifact = artifactContents(root)[0]!;
			editDisk(root, independentText);
			await runChild(root, "episode", boundary);
			const beforeArtifacts = artifactContents(root);
			const interrupted = readState(root).episodes.episodes[BODY_ID]!;
			assert.equal(interrupted.bodyId, BODY_ID);
			assert.equal(interrupted.id, original.id);
			if (boundary !== "before-episode-persistence") {
				assert.ok(interrupted.pendingAppend, "append intent must be durable before the artifact effect");
				assert.equal(interrupted.pendingAppend.expected, priorArtifact);
				assert.equal(interrupted.pendingAppend.version.part, original.parts[0]);
				assert.equal(interrupted.pendingAppend.version.hash, await contentBaselineHash(independentText));
			}
			if (boundary === "after-artifact-effect") assert.ok(beforeArtifacts[0]!.includes(independentText));
			else assert.equal(beforeArtifacts[0], priorArtifact, "artifact effect must follow durable pending-append persistence");
			const newestDisk = "new unique disk edit while pending append is dead 🪸\n";
			editDisk(root, newestDisk);
			await runChild(root, "recover");
			const current = readState(root).episodes.episodes[BODY_ID]!;
			assert.ok(current);
			assert.equal(current.id, original.id);
			assert.equal(current.bodyId, BODY_ID);
			assert.equal(current.pendingAppend, undefined, "successful recovery must retire the indexed append intent");
			assert.deepEqual(current.parts, original.parts, "unfinished append must not invent another conflict part");
			const artifacts = artifactContents(root);
			assert.equal(artifacts.length, 1, "restart must retain exactly one artifact for this bounded episode");
			const requiredVersions = [remoteText, acceptedText, newestDisk];
			if (boundary !== "before-episode-persistence") requiredVersions.push(independentText);
			for (const input of requiredVersions) {
				const hash = await contentBaselineHash(input);
				const version = current.versions.find((candidate) => candidate.hash === hash);
				assert.ok(version, `input must remain indexed in the same episode: ${JSON.stringify(input)}`);
				assert.equal(version.part, original.parts[0]);
				assert.equal(artifacts[0]!.slice(version.offset, version.offset + version.length), input);
			}
			for (const priorContent of beforeArtifacts) assert.ok(artifacts.some((content) => content.startsWith(priorContent)));
			assert.deepEqual(readRemote(root).attempts, []);
			await runChild(root, "recover");
			assert.equal(readState(root).episodes.episodes[BODY_ID]!.id, current.id);
			assert.equal(readState(root).episodes.episodes[BODY_ID]!.versions.length, current.versions.length, "completed restart must deduplicate preserved inputs");
		});
	});
}

tests.test("pending artifact changed while dead: retain occupant and relocate within the same episode", async () => {
	await withDirectory(async (root) => {
		await seedRecovery(root, { body: remoteText, disk: acceptedText, base: expectedText });
		await runChild(root, "episode");
		const original = readState(root).episodes.episodes[BODY_ID]!;
		editDisk(root, independentText);
		await runChild(root, "episode", "before-artifact-effect");
		const changedArtifact = `${artifactContents(root)[0]!}\nUser changed pending artifact while process was dead 🦋.\n`;
		const artifactPath = original.parts[0]!;
		durableWrite(join(root, "vault", artifactPath), changedArtifact);
		await runChild(root, "recover");
		const current = readState(root).episodes.episodes[BODY_ID]!;
		assert.equal(current.id, original.id);
		assert.equal(current.parts.length, 1);
		assert.notEqual(current.parts[0], artifactPath);
		assert.equal(current.relocations?.[artifactPath], current.parts[0]);
		assert.ok(current.obstructions?.includes(artifactPath));
		assert.equal(current.pendingAppend, undefined);
		assert.equal(current.error, null);
		const replacement = readFileSync(join(root, "vault", current.parts[0]!), "utf8");
		for (const input of [acceptedText, independentText]) {
			const hash = await contentBaselineHash(input);
			const version = current.versions.find((entry) => entry.hash === hash);
			assert.ok(version);
			assert.equal(replacement.slice(version.offset, version.offset + version.length), input);
		}
		assert.equal(artifactContents(root).length, 2);
		assert.equal(readFileSync(join(root, "vault", artifactPath), "utf8"), changedArtifact);
		assert.equal(readDisk(root), remoteText, "successful durable preservation permits the existing remote projection policy");
		assert.deepEqual(readRemote(root).attempts, []);
		await runChild(root, "recover");
		assert.deepEqual(readState(root).episodes.episodes[BODY_ID]!.parts, current.parts);
		assert.equal(artifactContents(root).length, 2);
	});
});

for (const boundary of ["before-artifact-effect", "after-artifact-effect", "after-episode-persistence"]) {
	tests.test(`first artifact SIGKILL ${boundary}: durable pending intent retains the original episode and exactly one part`, async () => {
		await withDirectory(async (root) => {
			await seedRecovery(root, { body: remoteText, disk: acceptedText, base: expectedText });
			await runChild(root, "episode", boundary);
			const planned = readState(root).episodes.episodes[BODY_ID]!;
			assert.ok(planned.pendingAppend);
			assert.equal(planned.bodyId, BODY_ID);
			assert.equal(planned.pendingAppend.expected, null);
			assert.equal(planned.pendingAppend.version.hash, await contentBaselineHash(acceptedText));
			assert.equal(planned.versions.length, 0, "kill precedes finishing the first version index");
			const plannedPart = planned.pendingAppend.version.part;
			assert.deepEqual(planned.parts, [plannedPart]);
			editDisk(root, independentText);
			await runChild(root, "recover");
			const recovered = readState(root).episodes.episodes[BODY_ID]!;
			assert.equal(recovered.id, planned.id);
			assert.equal(recovered.bodyId, BODY_ID);
			assert.deepEqual(recovered.parts, [plannedPart]);
			assert.equal(recovered.pendingAppend, undefined);
			const artifacts = artifactContents(root);
			assert.equal(artifacts.length, 1);
			for (const input of [acceptedText, independentText, remoteText]) {
				const hash = await contentBaselineHash(input);
				const retained = recovered.versions.find((candidate) => candidate.hash === hash);
				assert.ok(retained, `first unfinished preservation must retain ${JSON.stringify(input)}`);
				assert.equal(retained.part, plannedPart);
				assert.equal(artifacts[0]!.slice(retained.offset, retained.offset + retained.length), input);
			}
			assert.deepEqual(readRemote(root).attempts, []);
		});
	});
}

await tests.done();
