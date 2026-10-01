import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuralRecoveryResult, StoredStructuralIntent } from "../../src/sync/structuralIntent";
import { suite } from "../harness";

const tests = suite("structural-intent-process-recovery-real-disk-not-browser-idb");
const root = new URL("../../", import.meta.url).pathname;

async function runChild(directory: string, mode: "start" | "recover", haltAt = ""): Promise<StructuralRecoveryResult[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["tests/run-typescript.mjs", "--test-aliases",
			"tests/fixtures/structural-intent-process-child.ts", directory, mode, haltAt], {
			cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let output = "";
		let killed = false;
		let results: StructuralRecoveryResult[] | null = null;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Child timed out at ${haltAt || mode}: ${output}`));
		}, 20000);
		child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("message", (message: unknown) => {
			if (typeof message !== "object" || message === null || !("kind" in message)) return;
			if (message.kind === "checkpoint" && "name" in message && message.name === haltAt) {
				killed = child.kill("SIGKILL");
			} else if (message.kind === "result" && "results" in message) {
				results = message.results as StructuralRecoveryResult[];
			}
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			try {
				if (haltAt) {
					assert.equal(killed, true, `Checkpoint not reached: ${haltAt}; ${output}`);
					assert.equal(signal, "SIGKILL");
					resolve([]);
				} else {
					assert.equal(code, 0, output);
					assert.ok(results, "Restarted child must return production recovery results");
					resolve(results);
				}
			} catch (error) { reject(error); }
		});
	});
}

async function fixture(contents: string[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-structural-sigkill-"));
	await mkdir(join(directory, "vault"));
	await writeFile(join(directory, "contents.json"), JSON.stringify(contents));
	await writeFile(join(directory, "vault", "alpha.md"), contents[0]!);
	await writeFile(join(directory, "vault", "beta.md"), contents[1]!);
	return directory;
}

async function readIntent(directory: string): Promise<StoredStructuralIntent> {
	return JSON.parse(await readFile(join(directory, "intents", "process-rename.json"), "utf8")) as StoredStructuralIntent;
}

for (const haltAt of ["prepared", "move-1", "move-2", "placing-persisted", "move-3", "move-4",
	"before-bookkeeping", "bookkeeping-completed", "before-delete"]) {
	tests.test(`SIGKILL at ${haltAt}: fresh process reads fsynced plan and resumes idempotently`, async () => {
		const contents = ["\uFEFFαlpha\r\n", "βeta\n"];
		const directory = await fixture(contents);
		try {
			await runChild(directory, "start", haltAt);
			const saved = await readIntent(directory);
			assert.equal(saved.operationId, "process-rename");
			assert.deepEqual(saved.moves.map((move) => move.expectedContent), contents);
			assert.equal(saved.phase, ["prepared", "move-1", "move-2"].includes(haltAt) ? "staging" : "placing");
			assert.deepEqual(await runChild(directory, "recover"), [{ status: "completed", operationId: "process-rename" }]);
			assert.equal(await readFile(join(directory, "vault", "beta.md"), "utf8"), contents[0]);
			assert.equal(await readFile(join(directory, "vault", "alpha.md"), "utf8"), contents[1]);
			assert.deepEqual((await readdir(join(directory, "vault"))).sort(), ["alpha.md", "beta.md"]);
			assert.deepEqual(await readdir(join(directory, "intents")), []);
			const bookkeeping = JSON.parse(await readFile(join(directory, "bookkeeping.json"), "utf8")) as { operationId: string };
			assert.equal(bookkeeping.operationId, "process-rename");
			assert.deepEqual(await runChild(directory, "recover"), []);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}

tests.test("SIGKILL with identical-content swap retains phase identity across actual process restart", async () => {
	const directory = await fixture(["same", "same"]);
	try {
		await runChild(directory, "start", "move-3");
		assert.deepEqual(await runChild(directory, "recover"), [{ status: "completed", operationId: "process-rename" }]);
		assert.deepEqual((await readdir(join(directory, "vault"))).sort(), ["alpha.md", "beta.md"]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

tests.test("unknown destination added after SIGKILL is preserved; durable blocked intent resumes after human resolution", async () => {
	const directory = await fixture(["alpha", "beta"]);
	try {
		await runChild(directory, "start", "move-2");
		await writeFile(join(directory, "vault", "beta.md"), "unknown external file");
		const results = await runChild(directory, "recover");
		assert.equal(results[0]?.status, "blocked");
		assert.equal(await readFile(join(directory, "vault", "beta.md"), "utf8"), "unknown external file");
		assert.equal(await readFile(join(directory, "vault", ".rename-0.md"), "utf8"), "alpha");
		assert.equal(await readFile(join(directory, "vault", ".rename-1.md"), "utf8"), "beta");
		assert.ok(await readIntent(directory));
		await assert.rejects(readFile(join(directory, "bookkeeping.json")));
		await rm(join(directory, "vault", "beta.md"));
		assert.deepEqual(await runChild(directory, "recover"), [{ status: "completed", operationId: "process-rename" }]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

tests.test("staged content edited after SIGKILL blocks without touching remaining real disk files", async () => {
	const directory = await fixture(["alpha", "beta"]);
	try {
		await runChild(directory, "start", "move-1");
		await writeFile(join(directory, "vault", ".rename-0.md"), "externally edited stage");
		assert.equal((await runChild(directory, "recover"))[0]?.status, "blocked");
		assert.equal(await readFile(join(directory, "vault", ".rename-0.md"), "utf8"), "externally edited stage");
		assert.equal(await readFile(join(directory, "vault", "beta.md"), "utf8"), "beta");
		assert.equal((await readIntent(directory)).phase, "staging");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

await tests.done();
