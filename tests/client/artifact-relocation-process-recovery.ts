import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConflictEpisode, ConflictEpisodeState } from "../../src/sync/conflictEpisodes";
import { suite } from "../harness.ts";

const tests = suite("artifact-relocation-real-sigkill");
const root = fileURLToPath(new URL("../../", import.meta.url));
interface ProcessResult { state: ConflictEpisodeState; episode: ConflictEpisode }

async function runChild(directory: string, mode: "start" | "recover" | "resolve", haltAt = ""): Promise<ProcessResult | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["tests/run-typescript.mjs", "--test-aliases",
			"tests/fixtures/artifact-relocation-process-child.ts", directory, mode, haltAt], {
			cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let output = "";
		let killed = false;
		let result: ProcessResult | null = null;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Artifact child timed out at ${haltAt || mode}: ${output}`));
		}, 20000);
		child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("message", (message: unknown) => {
			if (typeof message !== "object" || message === null || !("kind" in message)) return;
			if (message.kind === "checkpoint" && "name" in message && message.name === haltAt) killed = child.kill("SIGKILL");
			if (message.kind === "result" && "state" in message && "episode" in message) result = message as ProcessResult;
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			try {
				if (haltAt) {
					assert.equal(killed, true, `Checkpoint not reached: ${haltAt}; ${output}`);
					assert.equal(signal, "SIGKILL");
				} else {
					assert.equal(code, 0, output);
					assert.ok(result, "fresh child must verify all recovered versions");
				}
				resolve(result);
			} catch (error) { reject(error); }
		});
	});
}

async function savedState(directory: string): Promise<ConflictEpisodeState> {
	return JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as ConflictEpisodeState;
}

async function metadata(directory: string): Promise<{ initial: ConflictEpisode; texts: string[] }> {
	return JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as { initial: ConflictEpisode; texts: string[] };
}

for (const boundary of ["selected", "before-write", "after-write", "committed"]) {
	tests.test(`real SIGKILL at ${boundary} restarts with one episode and full linked history`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "yaos-artifact-relocation-"));
		try {
			await runChild(directory, "start", boundary);
			const initial = (await metadata(directory)).initial;
			const killedState = await savedState(directory);
			const selected = killedState.episodes[initial.bodyId]!.parts[0]!;
			assert.notEqual(selected, initial.parts[0]);
			const foreign = await readFile(join(directory, "vault", initial.parts[0]!));
			assert.deepEqual(foreign, Buffer.from([0xff, 0x00, 0xfe, 0x0d, 0x0a, 0x61]));
			const recovered = (await runChild(directory, "recover"))!;
			assert.equal(recovered.episode.id, initial.id);
			assert.equal(recovered.episode.parts[0], selected);
			assert.equal(recovered.episode.pendingAppend, undefined);
			assert.equal(recovered.state.artifacts[initial.parts[0]!], undefined);
			assert.deepEqual(await readFile(join(directory, "vault", initial.parts[0]!)), foreign);
			const beforeRetry = await readdir(join(directory, "vault"));
			assert.deepEqual((await runChild(directory, "recover"))!.episode, recovered.episode);
			assert.deepEqual(await readdir(join(directory, "vault")), beforeRetry);
			const resolved = (await runChild(directory, "resolve"))!;
			assert.deepEqual(resolved.state.episodes, {});
			assert.deepEqual(resolved.state.artifacts, recovered.state.artifacts);
			assert.deepEqual(await readFile(join(directory, "vault", initial.parts[0]!)), foreign);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}

tests.test("five consecutive SIGKILLs with two obstructed replacements preserve bytes and remap exactly once", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-artifact-relocation-repeat-"));
	try {
		await runChild(directory, "start", "selected");
		const initial = (await metadata(directory)).initial;
		const occupants = new Map<string, Buffer>();
		occupants.set(initial.parts[0]!, await readFile(join(directory, "vault", initial.parts[0]!)));
		for (let attempt = 0; attempt < 2; attempt++) {
			const selected = (await savedState(directory)).episodes[initial.bodyId]!.parts[0]!;
			const occupant = Buffer.from(`\uFEFFreplacement occupant ${attempt}\r\n`);
			await writeFile(join(directory, "vault", selected), occupant);
			occupants.set(selected, occupant);
			await runChild(directory, "recover", "selected");
		}
		const selected = (await savedState(directory)).episodes[initial.bodyId]!.parts[0]!;
		await runChild(directory, "recover", "after-write");
		await runChild(directory, "recover", "committed");
		const recovered = (await runChild(directory, "recover"))!;
		assert.equal(recovered.episode.id, initial.id);
		assert.equal(recovered.episode.parts[0], selected);
		assert.ok(selected.endsWith("part 1 3).md"));
		assert.equal(recovered.episode.versions.length, 5);
		assert.equal((await readdir(join(directory, "vault"))).length, occupants.size + recovered.episode.parts.length);
		for (const [path, bytes] of occupants) {
			assert.deepEqual(await readFile(join(directory, "vault", path)), bytes);
			assert.equal(recovered.state.artifacts[path], undefined);
			assert.ok(recovered.episode.obstructions?.includes(path));
		}
		assert.deepEqual((await runChild(directory, "recover"))!.episode, recovered.episode);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

tests.test("SIGKILL after artifact write followed by replacement obstruction leaves the sibling bytes untouched", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-artifact-relocation-linked-"));
	try {
		await runChild(directory, "start", "after-write");
		const planned = await savedState(directory);
		const previous = planned.episodes["process-body"]!;
		const occupied = previous.parts[0]!;
		const sibling = previous.parts[1]!;
		const siblingBytes = await readFile(join(directory, "vault", sibling));
		await writeFile(join(directory, "vault", occupied), "foreign selected destination");
		await runChild(directory, "recover", "after-write");
		const result = (await runChild(directory, "recover"))!;
		assert.equal(result.episode.parts[1], sibling);
		assert.notEqual(result.episode.parts[0], occupied);
		assert.ok(result.episode.parts[0]!.endsWith("part 1 2).md"));
		assert.equal(await readFile(join(directory, "vault", occupied), "utf8"), "foreign selected destination");
		assert.deepEqual(await readFile(join(directory, "vault", sibling)), siblingBytes);
		assert.equal(result.episode.relocations?.[occupied], result.episode.parts[0]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

await tests.done();
