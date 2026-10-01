import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NodeVaultDatabase, type NodeVaultDatabaseIdentity } from "../../packages/cli/src/nodeVaultDatabase";
import { exactMarkdownDiskFingerprint } from "../../server/src/shared/markdownCodec";
import {
	cloneStructuralIntent,
	StructuralIntentRecovery,
	type StoredStructuralIntent,
	type StructuralIntentDiskHost,
	type StructuralIntentScope,
	type StructuralIntentStore,
	type StructuralLocation,
	type StructuralMoveInput,
	type StructuralRecoveryResult,
} from "../../src/sync/structuralIntent";
import { PendingWorkError } from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness";

const scope: StructuralIntentScope = {
	vaultId: "cli-vault", vaultGeneration: "cli-generation", accountId: "cli-account", folderKey: "cli-folder",
};
const contents = ["alpha\r\nexact bytes 🪐\r\n", "beta\nexact bytes\n"];
const sourcePaths = ["alpha.md", "beta.md"];
const destinationPaths = ["beta.md", "alpha.md"];
const operationId = "cli-swap";
const root = fileURLToPath(new URL("../../", import.meta.url));

function identity(directory: string): NodeVaultDatabaseIdentity {
	return {
		host: "https://cli.invalid", realVaultPath: join(directory, "vault"), vaultId: scope.vaultId,
		vaultGeneration: scope.vaultGeneration, deviceId: "cli-device", folderKey: scope.folderKey,
	};
}

function databaseAt(directory: string): NodeVaultDatabase {
	return new NodeVaultDatabase(join(directory, "vault.sqlite"), identity(directory));
}

async function intent(id = operationId, createdAt = 1): Promise<StoredStructuralIntent> {
	return {
		format: 1, kind: "rename-batch", phase: "staging", operationId: id, scope: { ...scope }, createdAt,
		moves: await Promise.all(contents.map(async (expectedContent, index) => ({
			bodyId: `body-${index}`, from: sourcePaths[index]!, staging: `.rename-${index}.md`,
			to: destinationPaths[index]!, expectedContent, fingerprint: await exactMarkdownDiskFingerprint(expectedContent),
		}))),
	};
}

function store(database: NodeVaultDatabase, authority = scope): StructuralIntentStore {
	return {
		get: (id) => database.getStructuralIntent(authority, id),
		list: () => database.listStructuralIntents(authority),
		put: (value) => database.putStructuralIntent(value),
		delete: (id) => database.deleteStructuralIntent(authority, id),
	};
}

async function withDatabase(work: (database: NodeVaultDatabase, directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-cli-intents-"));
	const database = databaseAt(directory);
	try { await work(database, directory); }
	finally {
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function runRecoveryChild(directory: string, mode: string, haltAt: string): Promise<void> {
	const database = databaseAt(directory);
	let moves = 0;
	async function checkpoint(name: string): Promise<void> {
		if (name !== haltAt) return;
		process.send?.({ kind: "checkpoint", name });
		setInterval(() => {}, 1000);
		await new Promise<void>(() => {});
	}
	const durableStore = store(database);
	const tracedStore: StructuralIntentStore = {
		...durableStore,
		put: async (value) => {
			await durableStore.put(value);
			await checkpoint(`${value.phase}-persisted`);
		},
		delete: async (id) => {
			assert.deepEqual(await database.listMaterializedPaths(), (await intent()).moves.map((move) => ({
				bodyId: move.bodyId, path: move.to,
			})));
			await checkpoint("before-delete");
			await durableStore.delete(id);
		},
	};
	const file = (path: string): string => join(directory, "vault", path);
	const host: StructuralIntentDiskHost = {
		inspect: async (path): Promise<StructuralLocation> => {
			try {
				const metadata = await lstat(file(path));
				if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: "other" };
				return { kind: "file", content: await readFile(file(path), "utf8") };
			} catch (error) { if (isMissing(error)) return { kind: "missing" }; throw error; }
		},
		moveIfMatches: async (input: StructuralMoveInput): Promise<boolean> => {
			if (mode === "start" && moves === 0) {
				const observer = databaseAt(directory);
				try {
					assert.deepEqual(await observer.getStructuralIntent(scope, operationId), await intent());
					assert.deepEqual((await readdir(join(directory, "vault"))).sort(), sourcePaths);
					assert.equal(await readFile(file(sourcePaths[0]!), "utf8"), contents[0]);
					assert.equal(await readFile(file(sourcePaths[1]!), "utf8"), contents[1]);
				} finally { await observer.close(); }
				await checkpoint("writer-before-first-move");
			}
			const source = await host.inspect(input.from);
			if (source.kind !== "file" || source.content !== input.expectedContent) return false;
			assert.deepEqual(await exactMarkdownDiskFingerprint(source.content), input.fingerprint);
			await mkdir(dirname(file(input.to)), { recursive: true });
			try { await link(file(input.from), file(input.to)); }
			catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
				throw error;
			}
			await syncDirectory(dirname(file(input.to)));
			await unlink(file(input.from));
			await syncDirectory(dirname(file(input.from)));
			await checkpoint(`move-${++moves}`);
			return true;
		},
		completeBookkeeping: async (value) => {
			await checkpoint("before-bookkeeping");
			await database.setMaterializedPaths(value.moves.map((move) => ({ bodyId: move.bodyId, path: move.to })));
			await checkpoint("bookkeeping-persisted");
		},
	};
	try {
		const recovery = new StructuralIntentRecovery(scope, tracedStore, host);
		if (mode === "start") await recovery.prepare(await intent());
		const results = await recovery.recoverAll();
		process.send?.({ kind: "result", results });
	} finally { await database.close(); }
}

async function child(directory: string, mode: "start" | "recover", haltAt = ""): Promise<StructuralRecoveryResult[]> {
	return new Promise((resolve, reject) => {
		const processChild = spawn(process.execPath, ["tests/run-typescript.mjs", "--test-aliases",
			"tests/client/cli-structural-intents.ts", "--child", directory, mode, haltAt], {
			cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let output = "";
		let killed = false;
		let results: StructuralRecoveryResult[] | null = null;
		const timer = setTimeout(() => {
			processChild.kill("SIGKILL");
			reject(new Error(`SQLite child timed out at ${haltAt || mode}: ${output}`));
		}, 20000);
		processChild.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		processChild.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		processChild.on("error", (error) => { clearTimeout(timer); reject(error); });
		processChild.on("message", (message: unknown) => {
			if (!message || typeof message !== "object" || !("kind" in message)) return;
			if (message.kind === "checkpoint" && "name" in message && message.name === haltAt) {
				killed = processChild.kill("SIGKILL");
			} else if (message.kind === "result" && "results" in message) {
				results = message.results as StructuralRecoveryResult[];
			}
		});
		processChild.on("exit", (code, signal) => {
			clearTimeout(timer);
			try {
				if (haltAt) {
					assert.equal(killed, true, `Checkpoint not reached: ${haltAt}; ${output}`);
					assert.equal(signal, "SIGKILL");
					resolve([]);
				} else {
					assert.equal(code, 0, output);
					assert.ok(results, "Restarted SQLite child must report production recovery results");
					resolve(results);
				}
			} catch (error) { reject(error); }
		});
	});
}

async function diskFixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-cli-intents-sigkill-"));
	await mkdir(join(directory, "vault"));
	for (const [index, path] of sourcePaths.entries()) await writeFile(join(directory, "vault", path), contents[index]!);
	return directory;
}

if (process.argv[2] === "--child") {
	await runRecoveryChild(process.argv[3]!, process.argv[4]!, process.argv[5] ?? "");
} else {
	const tests = suite("cli-structural-intents-real-sqlite");
	tests.test("real SQLite reopen retains exact plan, clones ownership, and sorts deterministically", async () => {
		await withDatabase(async (database, directory) => {
			const original = await intent();
			await database.putStructuralIntent(original);
			original.moves[0]!.expectedContent = "mutated input";
			original.moves[0]!.fingerprint.hash = "f".repeat(64);
			original.scope.accountId = "mutated account";
			const loaded = (await database.getStructuralIntent(scope, operationId))!;
			assert.deepEqual(loaded, await intent());
			loaded.moves[0]!.to = "mutated output.md";
			await database.putStructuralIntent(await intent("later", 2));
			await database.putStructuralIntent(await intent("aaa", 1));
			const listed = await database.listStructuralIntents(scope);
			assert.deepEqual(listed.map((value) => value.operationId), ["aaa", operationId, "later"]);
			listed[1]!.moves[0]!.fingerprint.bytes = 999;
			await database.close();
			const reopened = new NodeVaultDatabase(join(directory, "vault.sqlite"));
			try {
				assert.deepEqual(await reopened.getStructuralIntent(scope, operationId), await intent());
				assert.equal((await reopened.listStructuralIntents(scope)).length, 3);
				assert.equal((await reopened.getPendingWorkSummary()).activeRecoveryOperations, 3);
			} finally { await reopened.close(); }
		});
	});
	tests.test("bound vault/generation/folder and principal scopes guard every CRUD operation", async () => {
		await withDatabase(async (database) => {
			await database.putStructuralIntent(await intent());
			for (const field of ["vaultId", "vaultGeneration", "folderKey", "accountId"] as const) {
				const invalidScope = { ...scope, [field]: field === "accountId" ? " " : "another" };
				await assert.rejects(database.getStructuralIntent(invalidScope, operationId), /scope/);
				await assert.rejects(database.listStructuralIntents(invalidScope), /scope/);
				await assert.rejects(database.deleteStructuralIntent(invalidScope, operationId), /scope/);
				await assert.rejects(database.putStructuralIntent({ ...await intent(), scope: invalidScope }));
			}
			const otherAccount = { ...scope, accountId: "another-account" };
			assert.equal(await database.getStructuralIntent(otherAccount, operationId), null);
			assert.deepEqual(await database.listStructuralIntents(otherAccount), []);
			await assert.rejects(database.deleteStructuralIntent(otherAccount, operationId), /another account/);
			await assert.rejects(database.putStructuralIntent({ ...await intent(), scope: otherAccount }), /different plan/);
			await database.putStructuralIntent({ ...await intent("other-account-operation"), scope: otherAccount });
			assert.equal((await database.listStructuralIntents(otherAccount)).length, 1);
			assert.equal((await database.listStructuralIntents(scope)).length, 1);
			assert.equal((await database.getPendingWorkSummary()).activeRecoveryOperations, 2);
			await database.deleteStructuralIntent(otherAccount, "absent");
			await database.deleteStructuralIntent(otherAccount, "other-account-operation");
			assert.deepEqual(await database.listStructuralIntents(otherAccount), []);
		});
	});
	tests.test("unbound database cannot accept structural plans without vault identity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "yaos-cli-unbound-"));
		const database = new NodeVaultDatabase(join(directory, "vault.sqlite"));
		try { await assert.rejects(database.putStructuralIntent(await intent()), /scope/); }
		finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
	});
	tests.test("operation ID is immutable and phase progression is monotonic across SQLite handles", async () => {
		await withDatabase(async (database, directory) => {
			const original = await intent();
			await database.putStructuralIntent(original);
			await database.putStructuralIntent(cloneStructuralIntent(original));
			const mutations: Array<(value: StoredStructuralIntent) => void> = [
				(value) => { value.createdAt++; },
				(value) => { value.moves.reverse(); },
				(value) => { value.moves[0]!.bodyId = "other-body"; },
				(value) => { value.moves[0]!.from = "other-source.md"; },
				(value) => { value.moves[0]!.staging = "other-staging.md"; },
				(value) => { value.moves[0]!.to = "other-target.md"; },
				(value) => { value.moves[0]!.expectedContent = "other bytes"; },
				(value) => { value.moves[0]!.fingerprint.hash = "f".repeat(64); },
				(value) => { value.moves[0]!.fingerprint.bytes++; },
			];
			for (const mutate of mutations) {
				const changed = cloneStructuralIntent(original);
				mutate(changed);
				await assert.rejects(database.putStructuralIntent(changed), /different plan/);
			}
			const other = databaseAt(directory);
			try {
				await other.putStructuralIntent({ ...original, phase: "placing" });
				await assert.rejects(database.putStructuralIntent(original), /later phase/);
				await database.putStructuralIntent({ ...original, phase: "placing" });
				assert.equal((await other.getStructuralIntent(scope, operationId))?.phase, "placing");
			} finally { await other.close(); }
		});
	});
	tests.test("invalid format, paths, duplicate IDs and fingerprints never enter the dedicated table", async () => {
		await withDatabase(async (database) => {
			const mutations: Array<(value: StoredStructuralIntent) => void> = [
				(value) => { value.operationId = " "; },
				(value) => { value.createdAt = NaN; },
				(value) => { value.format = 2 as 1; },
				(value) => { value.phase = "unknown" as "staging"; },
				(value) => { value.moves = []; },
				(value) => { value.moves[0]!.from = "../outside.md"; },
				(value) => { value.moves[0]!.to = "/absolute.md"; },
				(value) => { value.moves[0]!.staging = value.moves[1]!.to; },
				(value) => { value.moves[1]!.bodyId = value.moves[0]!.bodyId; },
				(value) => { value.moves[0]!.fingerprint.hash = "invalid"; },
				(value) => { value.moves[0]!.fingerprint.bytes = -1; },
			];
			for (const mutate of mutations) {
				const value = await intent();
				mutate(value);
				await assert.rejects(database.putStructuralIntent(value));
			}
			assert.deepEqual(await database.listStructuralIntents(scope), []);
		});
	});
	tests.test("pending reset guard retains staging mappings; explicit discard is the only bypass", async () => {
		await withDatabase(async (database, directory) => {
			const other = databaseAt(directory);
			try { await other.putStructuralIntent(await intent()); } finally { await other.close(); }
			await database.setMaterializedPaths([{ bodyId: "body-0", path: "alpha.md" }]);
			await database.putRecoveryState({ activeCaptureId: "capture", activeRestore: {} });
			assert.equal((await database.getPendingWorkSummary()).activeRecoveryOperations, 3);
			assert.equal(await database.hasPendingWork(), true);
			await assert.rejects(database.clearLocalCache(), PendingWorkError);
			assert.deepEqual(await database.getStructuralIntent(scope, operationId), await intent());
			assert.equal(await database.getMaterializedPath("body-0"), "alpha.md");
			const summary = await database.clearLocalCache({ discardPendingWork: true });
			assert.equal(summary.activeRecoveryOperations, 3);
			assert.equal(await database.hasPendingWork(), false);
			assert.deepEqual(await database.listStructuralIntents(scope), []);
			assert.deepEqual(await database.listMaterializedPaths(), []);
			await database.putStructuralIntent(await intent());
			await database.deleteStructuralIntent(scope, operationId);
			await database.clearLocalCache();
		});
	});
	tests.test("dedicated strict table reuses host WAL and FULL synchronous durability", async () => {
		await withDatabase(async (database, directory) => {
			await database.putStructuralIntent(await intent());
			const raw = new DatabaseSync(join(directory, "vault.sqlite"));
			try {
				assert.equal(raw.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
				assert.equal(raw.prepare("PRAGMA synchronous").get()?.synchronous, 2);
				assert.equal(raw.prepare("SELECT strict FROM pragma_table_list WHERE name = 'structural_intents'").get()?.strict, 1);
				assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM structural_intents").get()?.count, 1);
			} finally { raw.close(); }
		});
	});
	for (const checkpoint of ["staging-persisted", "writer-before-first-move", "move-1", "move-2", "placing-persisted",
		"move-3", "before-bookkeeping", "bookkeeping-persisted", "before-delete"]) {
		tests.test(`actual SIGKILL at ${checkpoint}; fresh process resumes production recovery from SQLite`, async () => {
			const directory = await diskFixture();
			try {
				await child(directory, "start", checkpoint);
				const reopened = databaseAt(directory);
				try {
					const pending = (await reopened.getStructuralIntent(scope, operationId))!;
					assert.ok(pending);
					assert.deepEqual(pending.moves, (await intent()).moves);
					assert.equal((await reopened.getPendingWorkSummary()).activeRecoveryOperations, 1);
					await assert.rejects(reopened.clearLocalCache(), PendingWorkError);
					if (checkpoint === "writer-before-first-move" || checkpoint === "staging-persisted") {
						assert.deepEqual((await readdir(join(directory, "vault"))).sort(), sourcePaths);
					}
					if (checkpoint === "bookkeeping-persisted" || checkpoint === "before-delete") {
						assert.deepEqual(await reopened.listMaterializedPaths(), pending.moves.map((move) => ({
							bodyId: move.bodyId, path: move.to,
						})));
					}
				} finally { await reopened.close(); }
				assert.deepEqual(await child(directory, "recover"), [{ status: "completed", operationId }]);
				assert.deepEqual(await child(directory, "recover"), []);
				const completed = databaseAt(directory);
				try {
					assert.equal(await completed.getStructuralIntent(scope, operationId), null);
					assert.equal(await completed.hasPendingWork(), false);
					assert.deepEqual(await completed.listMaterializedPaths(), (await intent()).moves.map((move) => ({
						bodyId: move.bodyId, path: move.to,
					})));
				} finally { await completed.close(); }
				assert.deepEqual((await readdir(join(directory, "vault"))).sort(), sourcePaths);
				for (const [index, path] of destinationPaths.entries()) {
					assert.equal(await readFile(join(directory, "vault", path), "utf8"), contents[index]);
				}
			} finally { await rm(directory, { recursive: true, force: true }); }
		});
	}
	tests.test("changed or unexpectedly occupied files after SIGKILL block and preserve the SQLite intent", async () => {
		for (const occupiedPath of ["beta.md", ".rename-1.md"]) {
			const directory = await diskFixture();
			try {
				await child(directory, "start", "placing-persisted");
				await writeFile(join(directory, "vault", occupiedPath), "unknown user file\r\n");
				const results = await child(directory, "recover");
				assert.equal(results.length, 1);
				assert.equal(results[0]?.status, "blocked");
				if (results[0]?.status === "blocked") {
					assert.equal(results[0].path, occupiedPath);
					assert.ok(results[0].reason);
				}
				assert.equal(await readFile(join(directory, "vault", occupiedPath), "utf8"), "unknown user file\r\n");
				assert.equal(await readFile(join(directory, "vault", ".rename-0.md"), "utf8"), contents[0]);
				const reopened = databaseAt(directory);
				try {
					assert.equal((await reopened.getStructuralIntent(scope, operationId))?.phase, "placing");
					assert.deepEqual(await reopened.listMaterializedPaths(), []);
					await assert.rejects(reopened.clearLocalCache(), PendingWorkError);
				} finally { await reopened.close(); }
			} finally { await rm(directory, { recursive: true, force: true }); }
		}
	});
	await tests.done();
}
