import { strict as assert } from "node:assert";
import { exactMarkdownDiskFingerprint } from "../../server/src/shared/markdownCodec";
import {
	StructuralIntentRecovery,
	VaultIndexedDbStructuralIntentStore,
	type StoredStructuralIntent,
	type StructuralIntentDiskHost,
	type StructuralIntentScope,
	type StructuralLocation,
	type StructuralMoveInput,
	type StructuralRenamePlan,
} from "../../src/sync/structuralIntent";
import { VaultIndexedDb } from "../../src/sync/vaultIndexedDb";
import { FakeIndexedDb, FakeOpenDbRequest, FakeRequest } from "../mocks/indexedDb";
import { suite } from "../harness";

const tests = suite("structural-intent-recovery");
const scope: StructuralIntentScope = {
	vaultId: "structural-vault", vaultGeneration: "generation", accountId: "account", folderKey: "folder",
};

class StructuralTestIndexedDb extends FakeIndexedDb {
	readonly structuralWriteDurability: Array<IDBTransactionDurability | undefined> = [];

	open(name: string, version = 1): FakeOpenDbRequest {
		const original = super.open(name, version);
		const request = new FakeOpenDbRequest();
		original.onupgradeneeded = () => { request.result = original.result; request.upgrade(version); };
		original.onerror = () => request.fail(original.error ?? new DOMException("open failed"));
		original.onsuccess = () => request.succeed(new Proxy(original.result, {
			get: (database, property, receiver) => {
				if (property !== "transaction") return Reflect.get(database, property, receiver);
				return (names: string | string[], mode: IDBTransactionMode = "readonly", options?: IDBTransactionOptions) => {
					const shouldAbort = this.abortNextWriteTransaction;
					const transaction = database.transaction(names, mode);
					let completeHandler: IDBTransaction["oncomplete"] = null;
					transaction.oncomplete = (event) => { setTimeout(() => completeHandler?.call(transaction, event), 0); };
					if (mode === "readonly") this.abortNextWriteTransaction = shouldAbort;
					if (names === "structural-intents" && mode === "readwrite") this.structuralWriteDurability.push(options?.durability);
					return new Proxy(transaction, {
						set: (target, member, value: unknown) => {
							if (member === "oncomplete") {
								completeHandler = value as IDBTransaction["oncomplete"];
								return true;
							}
							return Reflect.set(target, member, value);
						},
						get: (target, member, transactionReceiver) => {
							if (member === "abort") return () => {};
							if (member !== "objectStore") return Reflect.get(target, member, transactionReceiver);
							return (storeName: string) => new Proxy(target.objectStore(storeName), {
								get: (store, storeMember, storeReceiver) => {
									if (storeMember === "count") return () => {
										const counted = new FakeRequest<number>(transaction);
										const all = store.getAll();
										all.onsuccess = () => counted.succeed(all.result.length);
										all.onerror = () => counted.fail(all.error ?? new DOMException("count failed"));
										return counted;
									};
									if (storeMember === "clear") return () => {
										const cleared = new FakeRequest<undefined>(transaction);
										const all = store.getAll();
										all.onsuccess = () => {
											for (const value of all.result as Array<Record<string, unknown>>) {
												assert.equal(typeof store.keyPath, "string");
												const key = value[store.keyPath as string];
												assert.equal(typeof key, "string");
												store.delete(key as string);
											}
											cleared.succeed(undefined);
										};
										return cleared;
									};
									return Reflect.get(store, storeMember, storeReceiver);
								},
							});
						},
					});
				};
			},
		}));
		return request;
	}
}

async function plan(contents = ["\uFEFFalpha\r\n", "βeta\n"], destinations = ["beta.md", "alpha.md"]): Promise<StructuralRenamePlan> {
	return { operationId: "rename-1", scope: { ...scope }, createdAt: 1, moves: await Promise.all(
		contents.map(async (expectedContent, index) => ({
			bodyId: `body-${index}`, from: ["alpha.md", "beta.md"][index]!,
			staging: `.yaos-rename-${index}.md`, to: destinations[index]!,
			expectedContent, fingerprint: await exactMarkdownDiskFingerprint(expectedContent),
		})),
	) };
}

class MemoryDisk implements StructuralIntentDiskHost {
	readonly files = new Map<string, StructuralLocation>();
	readonly moves: StructuralMoveInput[] = [];
	bookkeeping = 0;
	failAtMove = 0;
	failBookkeeping = false;
	afterMove: (() => void) | null = null;
	beforeMove: ((input: StructuralMoveInput) => void) | null = null;

	constructor(input: StructuralRenamePlan) {
		for (const move of input.moves) this.files.set(move.from, { kind: "file", content: move.expectedContent });
	}

	inspect(path: string): Promise<StructuralLocation> {
		return Promise.resolve(this.files.get(path) ?? { kind: "missing" });
	}

	moveIfMatches(input: StructuralMoveInput): Promise<boolean> {
		if (this.moves.length + 1 === this.failAtMove) return Promise.reject(new Error("host move failed"));
		this.beforeMove?.(input);
		const file = this.files.get(input.from);
		if (file?.kind !== "file" || file.content !== input.expectedContent || this.files.has(input.to)) {
			return Promise.resolve(false);
		}
		this.files.set(input.to, file);
		this.files.delete(input.from);
		this.moves.push(input);
		this.afterMove?.();
		return Promise.resolve(true);
	}

	completeBookkeeping(): Promise<void> {
		if (this.failBookkeeping) return Promise.reject(new Error("bookkeeping failed"));
		this.bookkeeping++;
		return Promise.resolve();
	}
}

function setup(input: StructuralRenamePlan, indexedDb = new StructuralTestIndexedDb()) {
	const database = new VaultIndexedDb(scope.vaultId, scope.vaultGeneration, scope.folderKey, indexedDb);
	const store = new VaultIndexedDbStructuralIntentStore(database, scope);
	const host = new MemoryDisk(input);
	return { database, store, host, recovery: new StructuralIntentRecovery(scope, store, host), indexedDb };
}

tests.test("full exact-input plan persists before a destructive move; swap bookkeeping closes intent", async () => {
	const input = await plan();
	const { database, store, host, recovery, indexedDb } = setup(input);
	const saved = await recovery.prepare(input);
	assert.deepEqual(saved.moves, input.moves);
	assert.equal(saved.phase, "staging");
	assert.equal(host.moves.length, 0);
	assert.equal((await database.getPendingWorkSummary()).activeRecoveryOperations, 1);
	assert.deepEqual(await recovery.recover(input.operationId), { status: "completed", operationId: input.operationId });
	assert.equal(host.moves.length, 4);
	for (const move of input.moves) assert.deepEqual(await host.inspect(move.to), { kind: "file", content: move.expectedContent });
	assert.equal(host.bookkeeping, 1);
	assert.deepEqual(indexedDb.structuralWriteDurability, ["strict", "strict", "strict"]);
	assert.equal(await store.get(input.operationId), null);
	assert.equal((await database.getPendingWorkSummary()).activeRecoveryOperations, 0);
	assert.equal((await recovery.recover(input.operationId)).status, "absent");
	await database.close();
});

tests.test("same-factory simulated IDB connection reopen resumes each move boundary, including identical-content cycles", async () => {
	for (const contents of [["alpha", "beta"], ["same", "same"], ["", ""]]) {
		for (const failAt of [1, 2, 3, 4]) {
			const input = await plan(contents);
			const { database, store, host, recovery, indexedDb } = setup(input);
			await recovery.prepare(input);
			host.failAtMove = failAt;
			await assert.rejects(recovery.recover(input.operationId), /host move failed/);
			assert.ok(await store.get(input.operationId));
			await database.close();
			const reopened = new VaultIndexedDb(scope.vaultId, scope.vaultGeneration, scope.folderKey, indexedDb);
			const reopenedStore = new VaultIndexedDbStructuralIntentStore(reopened, scope);
			host.failAtMove = 0;
			assert.equal((await new StructuralIntentRecovery(scope, reopenedStore, host).recover(input.operationId)).status, "completed");
			assert.equal(host.moves.length, 4);
			assert.equal(host.bookkeeping, 1);
			await reopened.close();
		}
	}
});

tests.test("source, staging, destination, directory, and missing-file obstructions preserve all files", async () => {
	for (const obstruction of ["source", "stage", "destination", "directory", "missing", "duplicate"]) {
		const input = await plan(["alpha", "beta"], ["new-alpha.md", "new-beta.md"]);
		const { database, store, host, recovery } = setup(input);
		await recovery.prepare(input);
		if (obstruction === "source") host.files.set("alpha.md", { kind: "file", content: "changed" });
		if (obstruction === "stage") host.files.set(".yaos-rename-0.md", { kind: "file", content: "unknown stage" });
		if (obstruction === "destination") host.files.set("new-beta.md", { kind: "file", content: "unknown destination" });
		if (obstruction === "directory") host.files.set("new-alpha.md", { kind: "other" });
		if (obstruction === "missing") host.files.delete("alpha.md");
		if (obstruction === "duplicate") host.files.set(".yaos-rename-0.md", { kind: "file", content: "alpha" });
		const before = [...host.files];
		const result = await recovery.recover(input.operationId);
		assert.equal(result.status, "blocked", obstruction);
		if (result.status === "blocked") assert.match(result.reason, /preserve/);
		assert.deepEqual([...host.files], before);
		assert.equal(host.moves.length, 0);
		assert.ok(await store.get(input.operationId));
		await database.close();
	}
});

tests.test("partial placement rechecks unexpected source occupants and staged changes without rollback", async () => {
	for (const changedPath of [".yaos-rename-1.md", "alpha.md", "new-beta.md", "new-alpha.md"]) {
		const input = await plan(["alpha", "beta"], ["new-alpha.md", "new-beta.md"]);
		const { database, store, host, recovery } = setup(input);
		await recovery.prepare(input);
		host.failAtMove = 4;
		await assert.rejects(recovery.recover(input.operationId));
		host.failAtMove = 0;
		host.files.set(changedPath, { kind: "file", content: "unknown" });
		const before = [...host.files];
		assert.equal((await recovery.recover(input.operationId)).status, "blocked");
		assert.deepEqual([...host.files], before);
		assert.equal(host.moves.length, 3);
		assert.equal((await store.get(input.operationId))?.phase, "placing");
		await database.close();
	}
});

tests.test("host no-replace guard catches late occupancy and retains retryable intent", async () => {
	const input = await plan();
	const { database, host, recovery, store } = setup(input);
	await recovery.prepare(input);
	host.beforeMove = (move) => host.files.set(move.to, { kind: "file", content: "late unknown" });
	assert.equal((await recovery.recover(input.operationId)).status, "blocked");
	assert.equal(host.moves.length, 0);
	assert.deepEqual(await host.inspect("alpha.md"), { kind: "file", content: input.moves[0]!.expectedContent });
	assert.deepEqual(await host.inspect(".yaos-rename-0.md"), { kind: "file", content: "late unknown" });
	assert.ok(await store.get(input.operationId));
	await database.close();
});

tests.test("failed bookkeeping leaves placing intent; retry performs bookkeeping without repeating moves", async () => {
	const input = await plan();
	const { database, store, host, recovery } = setup(input);
	await recovery.prepare(input);
	host.failBookkeeping = true;
	await assert.rejects(recovery.recover(input.operationId), /bookkeeping failed/);
	assert.equal((await store.get(input.operationId))?.phase, "placing");
	assert.equal(host.moves.length, 4);
	host.failBookkeeping = false;
	assert.equal((await recovery.recover(input.operationId)).status, "completed");
	assert.equal(host.moves.length, 4);
	await database.close();
});

tests.test("IDB CRUD owns nested values, fences accounts/generations/folders, and rejects plan replacement or phase regression", async () => {
	const input = await plan();
	const { database, store, recovery, indexedDb } = setup(input);
	const saved = await recovery.prepare(input);
	const original = await store.get(input.operationId);
	saved.moves[0]!.fingerprint.hash = "0".repeat(64);
	saved.scope.accountId = "mutated";
	assert.deepEqual(await store.get(input.operationId), original);
	const read = await store.get(input.operationId);
	read!.moves[0]!.expectedContent = "mutated";
	assert.deepEqual(await store.get(input.operationId), original);
	const otherScope = { ...scope, accountId: "other-account" };
	assert.equal(await database.getStructuralIntent(otherScope, input.operationId), null);
	assert.deepEqual(await database.listStructuralIntents(otherScope), []);
	await assert.rejects(database.deleteStructuralIntent(otherScope, input.operationId), /another account/);
	await assert.rejects(database.putStructuralIntent({ ...original!, scope: otherScope }), /different plan/);
	await assert.rejects(database.getStructuralIntent({ ...scope, vaultId: "other-vault" }, input.operationId), /scope/);
	for (const identity of [{ ...scope, vaultGeneration: "other-generation" }, { ...scope, folderKey: "other-folder" }]) {
		const isolated = new VaultIndexedDb(identity.vaultId, identity.vaultGeneration, identity.folderKey, indexedDb);
		assert.deepEqual(await isolated.listStructuralIntents(identity), []);
		await isolated.close();
	}
	await assert.rejects(store.put({ ...original!, moves: original!.moves.map((move) => ({ ...move, to: `different-${move.to}` })) }), /different plan/);
	await store.put({ ...original!, phase: "placing" });
	await assert.rejects(store.put(original!), /later phase/);
	assert.equal((await store.get(input.operationId))?.phase, "placing");
	await database.close();
});

tests.test("exact CRLF/BOM fingerprints, valid disjoint plans, and scope are required before persistence", async () => {
	const input = await plan();
	const { database, host, store, recovery } = setup(input);
	const canonicalHash = await exactMarkdownDiskFingerprint("alpha\n");
	await assert.rejects(recovery.prepare({ ...input, moves: input.moves.map((move, index) => index === 0 ? { ...move, fingerprint: canonicalHash } : move) }), /fingerprint/);
	await assert.rejects(recovery.prepare({ ...input, scope: { ...scope, accountId: "other" } }), /scope/);
	for (const changed of [
		{ ...input.moves[0]!, from: "../alpha.md" },
		{ ...input.moves[0]!, staging: "beta.md" },
		{ ...input.moves[0]!, to: "alpha.md" },
		{ ...input.moves[0]!, to: input.moves[1]!.to },
	]) await assert.rejects(recovery.prepare({ ...input, moves: [changed, input.moves[1]!] }), /Invalid|disjoint/);
	assert.deepEqual(await store.list(), []);
	assert.equal(host.moves.length, 0);
	await database.close();
});

tests.test("failed durable prepare and failed placing-phase write permit no following destructive move", async () => {
	for (const failure of ["prepare", "placing"]) {
		const input = await plan();
		const { database, host, store, recovery, indexedDb } = setup(input);
		if (failure === "prepare") {
			indexedDb.abortNextWriteTransaction = true;
			await assert.rejects(recovery.prepare(input), /aborted/);
			assert.equal(host.moves.length, 0);
		} else {
			await recovery.prepare(input);
			host.afterMove = () => { if (host.moves.length === 2) indexedDb.abortNextWriteTransaction = true; };
			await assert.rejects(recovery.recover(input.operationId), /aborted/);
			assert.equal(host.moves.length, 2);
			assert.ok(await store.get(input.operationId));
		}
		await database.close();
	}
});

tests.test("ordinary cache reset and deletion refuse pending structural work; explicit discard clears it", async () => {
	const input = await plan();
	const { database, recovery, store } = setup(input);
	await recovery.prepare(input);
	await assert.rejects(database.deleteDatabase(), /pending work/);
	await assert.rejects(database.clearLocalCache(), /pending work/);
	assert.equal(await database.hasPendingWork(), true);
	const summary = await database.clearLocalCache({ discardPendingWork: true });
	assert.equal(summary.activeRecoveryOperations, 1);
	assert.deepEqual(await store.list(), []);
	await database.close();
});

tests.test("prepare retry retains placing progress and recoverAll invokes the scoped persisted plan", async () => {
	const input = await plan();
	const { database, host, recovery } = setup(input);
	await recovery.prepare(input);
	host.failAtMove = 3;
	await assert.rejects(recovery.recover(input.operationId));
	const saved: StoredStructuralIntent = await recovery.prepare(input);
	assert.equal(saved.phase, "placing");
	host.failAtMove = 0;
	assert.deepEqual(await recovery.recoverAll(), [{ status: "completed", operationId: input.operationId }]);
	await database.close();
});

await tests.done();
