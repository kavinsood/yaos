import { strict as assert } from "node:assert";
import { type App, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationWorker } from "../../src/runtime/reconciliationWorker";
import { BodyCoordinator } from "../../src/sync/bodyCoordinator";
import type { LoadedBody } from "../../src/sync/bodyManager";
import { ConflictEpisodes } from "../../src/sync/conflictEpisodes";
import { contentBaselineHash } from "../../src/sync/diskIndex";
import { DiskMirror, type DiskStructuralRenamePlan } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { VaultSync } from "../../src/sync/vaultSync";
import { cloneStructuralIntent, type StoredStructuralIntent, type StructuralIntentStore } from "../../src/sync/structuralIntent";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("disk-worker-replacement");

type DiskFile = TFile & { content: string };

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

async function bounded<Result>(promise: Promise<Result>): Promise<Result> {
	let timer!: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("disk operation timed out")), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function fixture(options: { atomic?: boolean; raw?: string; hideDotfiles?: boolean } = {}) {
	const files = new Map<string, DiskFile>();
	const bindings = new Map<string, string>();
	const documents = new Map<string, Y.Doc>();
	const coordinator = new BodyCoordinator();
	for (const [index, path] of ["A.md", "B.md"].entries()) {
		const content = options.raw ?? `before ${path}`;
		files.set(path, Object.assign(new TFile(), {
			path, content, stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).length },
		}));
		const bodyId = `body-${index + 1}`;
		bindings.set(path, bodyId);
		const document = new Y.Doc({ guid: bodyId });
		document.getText("body").insert(0, `remote ${path}`);
		documents.set(bodyId, document);
		coordinator.ensure(bodyId);
		coordinator.setResidency(bodyId, "warm");
	}
	coordinator.replacePathBindings(bindings);
	const writes: string[] = [];
	const reads: string[] = [];
	const callbacks: string[] = [];
	const renames: Array<{ from: string; to: string }> = [];
	const editorMoves: Array<Map<string, string>> = [];
	const pending = new Map<string, string>();
	const pendingBodies = new Set<string>();
	const hooks: {
		read?: (file: DiskFile) => Promise<void> | void;
		process?: (file: DiskFile) => Promise<void> | void;
		create?: (file: DiskFile) => Promise<void> | void;
		rename?: (file: DiskFile, to: string) => Promise<void> | void;
	} = {};
	const stored = (file: TFile): DiskFile => {
		const entry = files.get(file.path);
		assert.equal(entry, file);
		assert.ok(entry);
		return entry;
	};
	const app = partialOf<App>({
		workspace: { getActiveViewOfType: () => null },
		vault: {
			getAbstractFileByPath: (path) => options.hideDotfiles && path.split("/").some((part) => part.startsWith("."))
				? null : files.get(path) ?? null,
			read: async (file) => {
				const entry = stored(file);
				const content = entry.content;
				reads.push(file.path);
				await hooks.read?.(entry);
				return content;
			},
			modify: async () => { assert.fail("read/modify replacement must never run"); },
			...(options.atomic === false ? {} : {
				process: async (file: TFile, transform: (content: string) => string) => {
					const entry = stored(file);
					await hooks.process?.(entry);
					const content = transform(entry.content);
					assert.equal(typeof content, "string");
					entry.content = content;
					writes.push(file.path);
					return content;
				},
			}),
			create: async (path, content) => {
				assert.equal(files.has(path), false);
				const file = Object.assign(new TFile(), {
					path, content, stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).length },
				});
				files.set(path, file);
				writes.push(path);
				await hooks.create?.(file);
				return file;
			},
		},
		fileManager: {
			renameFile: async (file, to) => {
				assert.ok(file instanceof TFile);
				const entry = stored(file);
				await hooks.rename?.(entry, to);
				assert.equal(files.has(to), false);
				renames.push({ from: file.path, to });
				files.delete(file.path);
				file.path = to;
				files.set(to, entry);
			},
			trashFile: async (file) => { files.delete(file.path); },
		},
	});
	const runtime = partialOf<VaultSync>({
		getFileId: (path) => bindings.get(path),
		getTextForPath: (path) => documents.get(bindings.get(path) ?? "")?.getText("body") ?? null,
		markPendingRenameTarget: (path, bodyId) => { pending.set(path, bodyId); },
		clearPendingRenameTarget: (path, bodyId) => {
			if (pending.get(path) === bodyId) pending.delete(path);
		},
		bodies: {
			coordinator, captureRevision: (bodyId) => coordinator.capture(bodyId),
			get: (bodyId) => pendingBodies.has(bodyId)
				? partialOf<LoadedBody>({ dirty: true, unsettled: 1, pendingLocalUpdates: 0 }) : null,
		},
	});
	const mirror = new DiskMirror(app, runtime, partialOf<EditorBindingManager>({
		isBound: () => false,
		getLastEditorActivityForPath: () => null,
		updatePathsAfterRename: (moves) => { editorMoves.push(new Map(moves)); },
		unbindByPath: () => {},
	}), false);
	const baselines = new Map<string, string>();
	for (const [path, file] of files) baselines.set(path, await contentBaselineHash(file.content));
	mirror.configureSettlement({
		getBaseline: (path) => ({ contentHash: baselines.get(path) ?? null }),
		commitLocalBody: async () => { assert.fail("projection must not import disk"); },
	});
	mirror.setDiskWriteCallback((path) => { callbacks.push(path); });
	return {
		mirror, files, bindings, documents, coordinator, hooks, writes, reads, callbacks, renames, editorMoves, pending, pendingBodies,
		settle: (path = "A.md") => mirror.settleBody({
			path, bodyId: bindings.get(path)!, generation: 1, content: `remote ${path}`,
		}),
		close: async () => {
			await bounded(mirror.getReconciliationWorker().whenIdle());
			mirror.destroy();
			coordinator.dispose();
			for (const document of documents.values()) document.destroy();
		},
	};
}

async function withFixture(run: (state: Awaited<ReturnType<typeof fixture>>) => Promise<void>, options: Parameters<typeof fixture>[0] = {}) {
	const state = await fixture(options);
	try {
		await run(state);
	} finally {
		await state.close();
	}
}

function configureProductionRecovery(state: Awaited<ReturnType<typeof fixture>>, isPathAllowed: (path: string) => boolean = () => true) {
	const intents = new Map<string, StoredStructuralIntent>();
	const materializedPaths = new Map<string, string>();
	const hooks: { persist?: () => Promise<void>; delete?: () => Promise<void>; sourceCurrent?: () => boolean } = {};
	const store: StructuralIntentStore = {
		get: async (operationId) => {
			const intent = intents.get(operationId);
			return intent ? cloneStructuralIntent(intent) : null;
		},
		list: async () => [...intents.values()].map(cloneStructuralIntent),
		put: async (intent) => { intents.set(intent.operationId, cloneStructuralIntent(intent)); },
		delete: async (operationId) => { await hooks.delete?.(); intents.delete(operationId); },
	};
	state.mirror.configureStructuralRecovery({
		scope: { vaultId: "vault-1", vaultGeneration: "generation-1", accountId: "account-1", folderKey: "folder-1" },
		store,
		isSourceCurrent: () => hooks.sourceCurrent?.() ?? true,
		isPathAllowed,
		persistMaterializedPaths: async (moves) => {
			await hooks.persist?.();
			for (const move of moves) materializedPaths.set(move.bodyId, move.path);
		},
	});
	return { intents, materializedPaths, hooks };
}

const cycle = [
	{ from: "A.md", to: "B.md", bodyId: "body-1" },
	{ from: "B.md", to: "A.md", bodyId: "body-2" },
];

tests.test("one worker serializes filesystem operations across different paths", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	state.hooks.read = async (file) => {
		if (file.path !== "A.md") return;
		entered.release();
		await blocked.promise;
	};
	const first = state.settle();
	await bounded(entered.promise);
	const second = state.settle("B.md");
	try {
		await Promise.resolve();
		assert.deepEqual(state.reads, ["A.md"]);
		assert.deepEqual(state.mirror.getReconciliationWorker().diagnostics(), { active: 1, queued: 1 });
	} finally {
		blocked.release();
	}
	assert.deepEqual(await bounded(Promise.all([first, second])), ["settled", "settled"]);
	assert.deepEqual(state.writes, ["A.md", "B.md"]);
}));

tests.test("scope reset rejects a captured disk read without publishing a baseline", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	state.hooks.read = async () => { entered.release(); await blocked.promise; };
	const settlement = state.settle();
	await bounded(entered.promise);
	state.mirror.resetReconciliationScope();
	state.mirror.getReconciliationWorker().reset();
	assert.equal(state.mirror.getReconciliationWorker().diagnostics().active, 1);
	blocked.release();
	assert.equal(await bounded(settlement), "replan");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("reset during an active effect retains the filesystem writer until completion", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	state.hooks.process = async (file) => {
		if (file.path !== "A.md") return;
		entered.release();
		await blocked.promise;
	};
	const first = state.settle();
	await bounded(entered.promise);
	state.mirror.resetReconciliationScope();
	state.mirror.getReconciliationWorker().reset();
	const second = state.settle("B.md");
	try {
		await Promise.resolve();
		assert.deepEqual(state.reads, ["A.md"]);
		assert.deepEqual(state.mirror.getReconciliationWorker().diagnostics(), { active: 1, queued: 1 });
	} finally {
		blocked.release();
	}
	assert.deepEqual(await bounded(Promise.all([first, second])), ["replan", "settled"]);
	assert.deepEqual(state.writes, ["B.md"]);
	assert.deepEqual(state.callbacks, ["B.md"]);
}));

tests.test("Vault.process compares exact disk strings rather than canonical equivalents", () => withFixture(async (state) => {
	state.hooks.process = (file) => { file.content = "before A.md\n"; };
	assert.equal(await bounded(state.settle()), "replan");
	assert.equal(state.files.get("A.md")!.content, "before A.md\n");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("an unchanged noncanonical snapshot remains safely replaceable", () => withFixture(async (state) => {
	assert.equal(await bounded(state.settle()), "settled");
	assert.equal(state.files.get("A.md")!.content, "remote A.md");
	assert.deepEqual(state.callbacks, ["A.md"]);
}, { raw: "before A.md\r\n" }));

tests.test("missing Vault.process fails safe instead of performing read/modify", () => withFixture(async (state) => {
	assert.equal(await bounded(state.settle()), "preserved-unresolved");
	assert.equal(state.files.get("A.md")!.content, "before A.md");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}, { atomic: false }));

tests.test("flushWrite also rejects canonical-equivalent changes inside Vault.process", () => withFixture(async (state) => {
	state.hooks.process = (file) => { file.content = "before A.md\n"; };
	await bounded(state.mirror.flushWrite("A.md"));
	assert.equal(state.files.get("A.md")!.content, "before A.md\n");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("body revision changes at the synchronous replacement boundary prevent writes", () => withFixture(async (state) => {
	state.hooks.process = () => { state.coordinator.advanceContent("body-1"); };
	assert.equal(await bounded(state.settle()), "replan");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("nested settleRename executes privately without queue reentry or temporary staging", () => withFixture(async (state) => {
	assert.equal(await bounded(state.mirror.settleRename({
		from: "A.md", to: "Renamed.md", bodyId: "body-1", currentContent: "before A.md",
	})), "moved");
	assert.deepEqual(state.renames, [{ from: "A.md", to: "Renamed.md" }]);
	assert.equal(state.files.get("Renamed.md")!.content, "before A.md");
	assert.equal(state.pending.size, 0);
}));

tests.test("multi-step renames refuse effects without durable plan storage", () => withFixture(async (state) => {
	await assert.rejects(bounded(state.mirror.moveBodies([
		{ from: "A.md", to: "B.md", bodyId: "body-1" },
		{ from: "B.md", to: "A.md", bodyId: "body-2" },
	])), /durable structural plan storage/);
	assert.deepEqual(state.renames, []);
	assert.equal(state.files.get("A.md")!.content, "before A.md");
}));

tests.test("durable plan is complete before the first effect and completed only after verification", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	let prepared: DiskStructuralRenamePlan | null = null;
	let completed = false;
	state.mirror.setStructuralRenamePlanPort({
		prepare: async (plan) => { prepared = plan; entered.release(); await blocked.promise; },
		staged: async (plan) => {
			assert.equal(state.renames.length, 2);
			assert.ok(plan.moves.every((move) => state.files.get(move.temporaryPath)?.content === move.expectedContent));
		},
		complete: async (plan) => {
			assert.equal(plan, prepared);
			assert.equal(state.files.get("A.md")!.content, "before B.md");
			assert.equal(state.files.get("B.md")!.content, "before A.md");
			assert.ok(plan.moves.every((move) => !state.files.has(move.temporaryPath)));
			completed = true;
		},
	});
	const moving = state.mirror.moveBodies([
		{ from: "A.md", to: "B.md", bodyId: "body-1" },
		{ from: "B.md", to: "A.md", bodyId: "body-2" },
	]);
	await bounded(entered.promise);
	try {
		assert.deepEqual(state.renames, []);
		assert.ok(prepared);
		const plan = prepared as DiskStructuralRenamePlan;
		assert.equal(new Set(plan.moves.map((move) => move.temporaryPath)).size, 2);
		assert.deepEqual(plan.moves.map((move) => move.expectedContent), ["before A.md", "before B.md"]);
	} finally {
		blocked.release();
	}
	await bounded(moving);
	assert.equal(completed, true);
	assert.equal(state.renames.length, 4);
	assert.equal(state.pending.size, 0);
}));

tests.test("failed plan persistence leaves every source untouched", () => withFixture(async (state) => {
	state.mirror.setStructuralRenamePlanPort({
		prepare: async () => { throw new Error("durability failed"); },
		staged: async () => { assert.fail("failed preparation cannot stage"); },
		complete: async () => { assert.fail("failed preparation cannot complete"); },
	});
	await assert.rejects(bounded(state.mirror.moveBodies([
		{ from: "A.md", to: "B.md", bodyId: "body-1" },
		{ from: "B.md", to: "A.md", bodyId: "body-2" },
	])), /durability failed/);
	assert.deepEqual(state.renames, []);
	assert.equal(state.files.size, 2);
}));

tests.test("interrupted staging keeps its durable mapping for restart recovery", () => withFixture(async (state) => {
	const durable = new Map<string, DiskStructuralRenamePlan>();
	state.mirror.setStructuralRenamePlanPort({
		prepare: async (plan) => { durable.set(plan.id, plan); },
		staged: async () => {},
		complete: async (plan) => { durable.delete(plan.id); },
	});
	state.hooks.rename = () => {
		if (state.renames.length === 1) throw new Error("interrupted staging");
	};
	await assert.rejects(bounded(state.mirror.moveBodies([
		{ from: "A.md", to: "B.md", bodyId: "body-1" },
		{ from: "B.md", to: "A.md", bodyId: "body-2" },
	])), /interrupted staging/);
	assert.equal(durable.size, 1);
	const plan = [...durable.values()][0]!;
	assert.equal(state.files.get(plan.moves[0]!.temporaryPath)!.content, plan.moves[0]!.expectedContent);
	assert.equal(state.files.get("B.md")!.content, "before B.md");
	assert.equal(state.pending.size, 0);
}));

tests.test("worker replacement is rejected while filesystem work remains active", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	state.hooks.read = async () => { entered.release(); await blocked.promise; };
	const settlement = state.settle();
	await bounded(entered.promise);
	try {
		assert.throws(() => state.mirror.setReconciliationWorker(new ReconciliationWorker()), /active reconciliation worker/);
	} finally {
		blocked.release();
	}
	await bounded(settlement);
}));

tests.test("pending durable body data does not establish a trusted disk agreement", () => withFixture(async (state) => {
	state.files.get("A.md")!.content = "remote A.md";
	state.pendingBodies.add("body-1");
	assert.equal(await bounded(state.settle()), "replan");
	assert.deepEqual(state.callbacks, []);
	await bounded(state.mirror.getReconciliationWorker().run(async () => {}));
	state.pendingBodies.clear();
	assert.equal(await bounded(state.settle()), "settled");
	assert.deepEqual(state.callbacks, ["A.md"]);
}));

tests.test("local work beginning at the replacement boundary defers disk agreement", () => withFixture(async (state) => {
	state.hooks.process = () => { state.pendingBodies.add("body-1"); };
	assert.equal(await bounded(state.settle()), "replan");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("stale body cleanup cannot delete a replacement body at the same path", () => withFixture(async (state) => {
	assert.equal(await bounded(state.mirror.discardStaleBody({
		path: "A.md", bodyId: "replaced-body", expectedContent: "before A.md",
	})), false);
	assert.equal(await bounded(state.mirror.deleteBody({
		path: "A.md", bodyId: "replaced-body", generation: 1, baselineContent: "before A.md",
	})), "preserved-unresolved");
	assert.equal(state.files.get("A.md")!.content, "before A.md");
}));

tests.test("rename settlement cannot consume a target bound to another body", () => withFixture(async (state) => {
	assert.equal(await bounded(state.mirror.settleRename({
		from: "A.md", to: "B.md", bodyId: "body-1", currentContent: "before A.md",
	})), "preserved-unresolved");
	assert.equal(state.files.get("A.md")!.content, "before A.md");
	assert.deepEqual(state.renames, []);
}));

tests.test("a body update while projection waits in the queue expires its captured input", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	const holding = state.mirror.getReconciliationWorker().run(async () => {
		entered.release();
		await blocked.promise;
	});
	await bounded(entered.promise);
	const settlement = state.settle();
	const text = state.documents.get("body-1")!.getText("body");
	text.insert(text.length, " newer remote paragraph");
	state.coordinator.advanceContent("body-1");
	blocked.release();
	await bounded(holding);
	assert.equal(await bounded(settlement), "replan");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("a replaced newly created file cannot publish the original file's agreement", () => withFixture(async (state) => {
	state.files.delete("A.md");
	state.hooks.create = (file) => {
		state.files.set(file.path, Object.assign(new TFile(), {
			path: file.path, content: "external replacement after create", stat: file.stat,
		}));
	};
	assert.equal(await bounded(state.settle()), "replan");
	assert.equal(state.files.get("A.md")!.content, "external replacement after create");
	assert.deepEqual(state.callbacks, []);
}));

tests.test("configured production recovery fences ordinary disk mutations until bootstrap recovery", () => withFixture(async (state) => {
	configureProductionRecovery(state);
	assert.equal(await bounded(state.settle()), "preserved-unresolved");
	await bounded(state.mirror.flushWrite("A.md"));
	assert.deepEqual(state.writes, []);
	assert.deepEqual(await bounded(state.mirror.recoverStructuralIntents()), []);
	assert.equal(await bounded(state.settle()), "settled");
}));

tests.test("production rename persists placement phase and path ledger before retiring its intent", () => withFixture(async (state) => {
	const recovery = configureProductionRecovery(state);
	await bounded(state.mirror.recoverStructuralIntents());
	const entered = gate();
	const blocked = gate();
	recovery.hooks.persist = async () => { entered.release(); await blocked.promise; };
	state.hooks.rename = (_file, to) => {
		if (to === "A.md" || to === "B.md") assert.equal([...recovery.intents.values()][0]!.phase, "placing");
	};
	const moving = state.mirror.moveBodies(cycle);
	await bounded(entered.promise);
	try {
		assert.equal(recovery.intents.size, 1);
		assert.equal(state.renames.length, 4);
		assert.equal(recovery.materializedPaths.size, 0);
	} finally {
		blocked.release();
	}
	await bounded(moving);
	assert.equal(recovery.intents.size, 0);
	assert.deepEqual([...recovery.materializedPaths], [["body-1", "B.md"], ["body-2", "A.md"]]);
	assert.equal(state.mirror.isStructuralPathPending("A.md"), false);
}));

tests.test("production recovery resumes interrupted placement rather than rolling back or guessing", () => withFixture(async (state) => {
	const recovery = configureProductionRecovery(state);
	await bounded(state.mirror.recoverStructuralIntents());
	state.hooks.rename = (_file, to) => { if (to === "A.md") throw new Error("placement interrupted"); };
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)), /placement interrupted/);
	assert.equal([...recovery.intents.values()][0]!.phase, "placing");
	assert.equal(state.mirror.isStructuralPathPending("A.md"), true);
	assert.equal(state.mirror.isPreservedUnresolved("A.md"), true);
	const writesBefore = state.writes.length;
	await bounded(state.mirror.flushWrite("A.md"));
	assert.equal(await bounded(state.mirror.deleteBody({ path: "B.md", bodyId: "body-2", generation: 1, baselineContent: "before A.md" })), "preserved-unresolved");
	assert.equal(state.writes.length, writesBefore);
	state.hooks.rename = undefined;
	const results = await bounded(state.mirror.recoverStructuralIntents());
	assert.equal(results[0]!.status, "completed");
	assert.equal(state.files.get("A.md")!.content, "before B.md");
	assert.equal(state.files.get("B.md")!.content, "before A.md");
	assert.equal(recovery.intents.size, 0);
	assert.equal(state.mirror.isPreservedUnresolved("A.md"), false);
}));

tests.test("production bookkeeping failure retains a verified intent for durable retry", () => withFixture(async (state) => {
	const recovery = configureProductionRecovery(state);
	await bounded(state.mirror.recoverStructuralIntents());
	recovery.hooks.persist = async () => { throw new Error("path ledger durability failed"); };
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)), /path ledger durability failed/);
	assert.equal(recovery.intents.size, 1);
	assert.equal(state.editorMoves.length, 0);
	assert.equal(state.files.get("A.md")!.content, "before B.md");
	recovery.hooks.persist = undefined;
	assert.equal((await bounded(state.mirror.recoverStructuralIntents()))[0]!.status, "completed");
	assert.equal(recovery.intents.size, 0);
	assert.equal(state.editorMoves.length, 1);
}));

tests.test("production intent retirement retries without applying session rename bookkeeping twice", () => withFixture(async (state) => {
	const recovery = configureProductionRecovery(state);
	await bounded(state.mirror.recoverStructuralIntents());
	recovery.hooks.delete = async () => { throw new Error("intent retirement failed"); };
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)), /intent retirement failed/);
	assert.equal(recovery.intents.size, 1);
	assert.equal(state.editorMoves.length, 1);
	recovery.hooks.delete = undefined;
	assert.equal((await bounded(state.mirror.recoverStructuralIntents()))[0]!.status, "completed");
	assert.equal(state.editorMoves.length, 1);
}));

tests.test("production recovery preserves foreign blockers and fences every pending plan path", () => withFixture(async (state) => {
	const recovery = configureProductionRecovery(state);
	await bounded(state.mirror.recoverStructuralIntents());
	state.hooks.rename = (_file, to) => { if (to === "A.md") throw new Error("placement interrupted"); };
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)), /placement interrupted/);
	state.hooks.rename = undefined;
	state.files.set("A.md", Object.assign(new TFile(), {
		path: "A.md", content: "foreign local input", stat: { ctime: 1, mtime: 1, size: 19 },
	}));
	const results = await bounded(state.mirror.recoverStructuralIntents());
	assert.equal(results[0]!.status, "blocked");
	assert.equal(recovery.intents.size, 1);
	assert.equal(state.files.get("A.md")!.content, "foreign local input");
	assert.equal(state.mirror.isStructuralPathPending("B.md"), true);
	assert.equal(await bounded(state.settle()), "preserved-unresolved");
}));

tests.test("runtime revocation during durable bookkeeping cannot retire the recovery intent", () => withFixture(async (state) => {
	const recovery = configureProductionRecovery(state);
	await bounded(state.mirror.recoverStructuralIntents());
	recovery.hooks.persist = async () => { recovery.hooks.sourceCurrent = () => false; };
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)));
	assert.equal(recovery.intents.size, 1);
	assert.equal(state.editorMoves.length, 0);
	assert.equal(state.mirror.isStructuralPathPending("A.md"), true);
}));

tests.test("recovery uses visible reserved staging files when the host does not index dotfiles", () => withFixture(async (state) => {
	const recovery = configureProductionRecovery(state);
	await bounded(state.mirror.recoverStructuralIntents());
	state.hooks.rename = (_file, to) => { if (to === "A.md") throw new Error("placement interrupted"); };
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)), /placement interrupted/);
	const intent = [...recovery.intents.values()][0]!;
	assert.ok(intent.moves.every((move) => move.staging.startsWith("YAOS.yaos-moving-")));
	assert.ok(intent.moves.every((move) => state.mirror.isStructuralPathPending(move.staging)));
	state.hooks.rename = undefined;
	assert.equal((await bounded(state.mirror.recoverStructuralIntents()))[0]!.status, "completed");
	assert.equal(state.files.get("A.md")!.content, "before B.md");
}, { hideDotfiles: true }));

tests.test("reserved staging paths stay fenced even before structural storage is configured", () => withFixture(async (state) => {
	assert.equal(state.mirror.isStructuralPathPending("Notes/YAOS.yaos-moving-12345678-1234-abcd-1234-123456789abc.md"), true);
	assert.equal(state.mirror.isPreservedUnresolved("Notes/YAOS.yaos-moving-12345678-1234-abcd-1234-123456789abc.md"), true);
	assert.equal(state.mirror.isStructuralPathPending("Notes/ordinary-note.md"), false);
}));

tests.test("recovery bypasses its own pending fence but still obeys the independent exclusion policy", () => withFixture(async (state) => {
	let allowed = true;
	const recovery = configureProductionRecovery(state, () => allowed);
	await bounded(state.mirror.recoverStructuralIntents());
	state.mirror.configureSettlement({
		getBaseline: () => null, commitLocalBody: async () => {},
		isPathAllowed: (path) => !state.mirror.isStructuralPathPending(path),
	});
	state.hooks.rename = (_file, to) => { if (to === "A.md") throw new Error("placement interrupted"); };
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)), /placement interrupted/);
	state.hooks.rename = undefined;
	allowed = false;
	assert.equal((await bounded(state.mirror.recoverStructuralIntents()))[0]!.status, "blocked");
	assert.equal(recovery.intents.size, 1);
	allowed = true;
	assert.equal((await bounded(state.mirror.recoverStructuralIntents()))[0]!.status, "completed");
}));

tests.test("network catchup after closing a file never holds the filesystem worker", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	const baseline = await contentBaselineHash(state.files.get("B.md")!.content);
	state.mirror.configureSettlement({
		getBaseline: () => ({ contentHash: baseline, trustedWhole: true }),
		commitLocalBody: async () => { assert.fail("disk projection must not import"); },
		settleClosedBody: async () => { entered.release(); await blocked.promise; },
	});
	state.mirror.notifyFileClosed("A.md");
	await bounded(entered.promise);
	try {
		assert.equal(await bounded(state.settle("B.md")), "settled");
		await bounded(state.mirror.getReconciliationWorker().whenIdle());
	} finally {
		blocked.release();
	}
}));

tests.test("delete revival network planning never holds the filesystem worker", () => withFixture(async (state) => {
	const entered = gate();
	const blocked = gate();
	const baseline = await contentBaselineHash(state.files.get("B.md")!.content);
	state.mirror.configureSettlement({
		getBaseline: () => ({ contentHash: baseline, trustedWhole: true }),
		commitLocalBody: async () => { entered.release(); await blocked.promise; return "completed"; },
	});
	const deleting = state.mirror.deleteBody({ path: "A.md", bodyId: "body-1", generation: 1, baselineContent: "older agreement" });
	await bounded(entered.promise);
	try {
		assert.equal(await bounded(state.settle("B.md")), "settled");
		await bounded(state.mirror.getReconciliationWorker().whenIdle());
	} finally {
		blocked.release();
	}
	assert.equal(await bounded(deleting), "revived");
	assert.equal(state.files.get("A.md")!.content, "before A.md");
}));

for (const policy of ["open", "missing-baseline", "divergent", "deleted", "absent"] as const) {
	tests.test(`delete episode closes only after definitive disk deletion (${policy})`, () => withFixture(async (state) => {
		const closures: string[] = [];
		let revived = false;
		state.mirror.configureSettlement({
			getBaseline: () => null,
			conflictEpisodes: partialOf<ConflictEpisodes>({
				close: async (bodyId) => {
					assert.equal(state.files.has("A.md"), false);
					closures.push(bodyId);
				},
			}),
			commitLocalBody: async () => { revived = true; return "completed"; },
			isBodyLive: () => policy === "open",
		});
		if (policy === "absent") state.files.delete("A.md");
		const result = await bounded(state.mirror.deleteBody({
			path: "A.md", bodyId: "body-1", generation: 1,
			baselineContent: policy === "missing-baseline" ? null : policy === "divergent" ? "older agreement" : "before A.md",
		}));
		if (policy === "deleted" || policy === "absent") {
			assert.equal(result, "deleted");
			assert.deepEqual(closures, ["body-1"]);
		} else {
			assert.equal(result, policy === "divergent" ? "revived" : "preserved-unresolved");
			assert.deepEqual(closures, []);
			assert.equal(state.files.get("A.md")!.content, "before A.md");
		}
		assert.equal(revived, policy === "divergent");
	}));
}

for (const withCommonBase of [false, true]) {
	tests.test(`raw A-to-B-to-C disk replacement preserves committed body text (${withCommonBase ? "common base" : "hash baseline"})`, () => withFixture(async (state) => {
		assert.equal(await bounded(state.settle()), "settled");
		const bodyContent = state.files.get("A.md")!.content;
		const bodyHash = await contentBaselineHash(bodyContent);
		let commits = 0;
		state.mirror.configureSettlement({
			getBaseline: () => ({ contentHash: bodyHash, trustedWhole: true }),
			commitLocalBody: async () => { commits++; return "completed"; },
			...(withCommonBase ? {
				getCommonBase: async () => ({ kind: "missing" as const }),
				commitMergedBody: async () => { commits++; return "completed" as const; },
			} : {}),
		});
		state.files.get("A.md")!.content = "external C retained from before remote B";
		state.callbacks.length = 0;
		const outcome = await bounded(state.mirror.settleBody({
			path: "A.md", bodyId: "body-1", generation: 1, content: bodyContent,
			...(withCommonBase ? { baseContent: bodyContent } : {}),
		}));
		assert.equal(outcome, "preserved-unresolved");
		assert.equal(commits, 0);
		assert.equal(state.documents.get("body-1")!.getText("body").toString(), bodyContent);
		assert.equal(state.files.get("A.md")!.content, "external C retained from before remote B");
		assert.deepEqual(state.callbacks, []);
		assert.ok([...state.files.values()].some((file) => file.path !== "A.md"
			&& file.content.includes("external C retained from before remote B")));
	}));

	tests.test(`additive raw disk input uses its trusted body hash even without stored ancestry (${withCommonBase ? "common base API" : "hash baseline"})`, () => withFixture(async (state) => {
		assert.equal(await bounded(state.settle()), "settled");
		const bodyContent = state.files.get("A.md")!.content;
		const bodyHash = await contentBaselineHash(bodyContent);
		let commits = 0;
		state.mirror.configureSettlement({
			getBaseline: () => ({ contentHash: bodyHash, trustedWhole: true }),
			commitLocalBody: async (input) => {
				commits++;
				const text = state.documents.get(input.bodyId)!.getText("body");
				text.delete(0, text.length);
				text.insert(0, input.content);
				state.coordinator.advanceContent(input.bodyId);
				return "completed";
			},
			...(withCommonBase ? {
				getCommonBase: async () => ({ kind: "missing" as const }),
				commitMergedBody: async () => { assert.fail("hash-trusted additive input does not need a merge candidate"); },
			} : {}),
		});
		state.files.get("A.md")!.content = `${bodyContent}\nadditive external paragraph`;
		assert.equal(await bounded(state.settle()), "settled");
		assert.equal(commits, 1);
		assert.equal(state.documents.get("body-1")!.getText("body").toString(), state.files.get("A.md")!.content);
	}));
}

tests.test("explicit synchronized-version review cannot reopen its episode after a no-op candidate", () => withFixture(async (state) => {
	const path = "A.md";
	const bodyId = "body-1";
	const document = state.documents.get(bodyId)!;
	const synchronized = document.getText("body").toString();
	const destructiveDisk = "destructive external replacement C";
	const bodyHash = await contentBaselineHash(synchronized);
	state.files.get(path)!.content = destructiveDisk;
	const artifacts = new Map<string, string>();
	const closingEntered = gate();
	const closingReleased = gate();
	let holdClosing = false;
	let imports = 0;
	const episodes = new ConflictEpisodes({ episodes: {}, artifacts: {} }, {
		read: async (artifactPath) => artifacts.get(artifactPath) ?? null,
		write: async (artifactPath, content, expected) => {
			assert.equal(artifacts.get(artifactPath) ?? null, expected);
			artifacts.set(artifactPath, content);
		},
		persist: async (snapshot) => {
			if (holdClosing && !snapshot.episodes[bodyId]) {
				closingEntered.release();
				await closingReleased.promise;
			}
		},
		changed: () => {}, notify: () => {},
	});
	await episodes.preserve({ bodyId, path, disk: destructiveDisk, body: synchronized, device: "test-device" });
	const reviewedEpisodeId = episodes.get(bodyId)!.id;
	state.mirror.configureSettlement({
		conflictEpisodes: episodes,
		getBaseline: () => ({ contentHash: bodyHash, trustedWhole: true }),
		getCommonBase: async () => ({ kind: "missing" }),
		commitLocalBody: async () => { imports++; return "completed"; },
		commitMergedBody: async () => { imports++; return "completed"; },
	});
	state.mirror.recordPreservedUnresolved(path, "body-settlement-failed");
	const candidateRuntime = partialOf<VaultSync>({
		bodies: {
			get: (identity) => identity === bodyId ? partialOf<LoadedBody>({ bodyId, doc: document }) : null,
			acquireLease: (identity) => state.coordinator.acquireLease(identity),
			captureRevision: (identity) => state.coordinator.capture(identity),
			coordinator: state.coordinator,
		},
	});
	holdClosing = true;
	const acceptedReview = state.mirror.getReconciliationWorker().run(async () => {
		const plannedDisk = await state.mirror.readCanonicalDiskEvidenceUnqueued(path);
		assert.ok(plannedDisk);
		const outcome = await VaultSync.prototype.commitBodyCandidateIfCurrent.call(candidateRuntime, {
			bodyId, path, expectedContent: synchronized, content: synchronized,
			candidateId: crypto.randomUUID(), reason: "three-way-merge", waitForReceipt: false,
		});
		assert.deepEqual(outcome, { kind: "completed", receipt: null, unchanged: true });
		assert.deepEqual(await state.mirror.readCanonicalDiskEvidenceUnqueued(path), plannedDisk);
		assert.equal(await state.mirror.projectReviewedContentUnqueued({
			path, bodyId, content: synchronized, expectedDisk: plannedDisk,
		}), "written");
		assert.equal(episodes.get(bodyId)!.id, reviewedEpisodeId);
		assert.equal(state.mirror.isPreservedUnresolved(path), true);
		await episodes.close(bodyId);
		state.coordinator.setDivergence(bodyId, "none");
		state.mirror.clearPreservedUnresolved(path);
		state.mirror.scheduleWrite(path);
	});
	await bounded(closingEntered.promise);
	const queuedSettlement = state.mirror.settleBody({ path, bodyId, generation: 1, content: synchronized });
	closingReleased.release();
	await bounded(acceptedReview);
	const result = await bounded(queuedSettlement);
	await bounded(state.mirror.flushWrite(path));
	const recreated = episodes.get(bodyId);
	assert.equal(imports, 0);
	assert.equal(document.getText("body").toString(), synchronized);
	assert.equal(recreated ?? null, null,
		`explicit synchronized selection reopened its episode before scheduled projection: settlement=${result}; `
		+ `reviewedEpisode=${reviewedEpisodeId}; currentEpisode=${recreated?.id ?? "none"}; `
		+ `disk=${JSON.stringify(state.files.get(path)!.content)}; `
		+ `unresolved=${state.mirror.isPreservedUnresolved(path)}; writes=${JSON.stringify(state.writes)}`);
	assert.equal(state.files.get(path)!.content, synchronized);
}));

async function preserveReviewedEpisode(state: Awaited<ReturnType<typeof fixture>>) {
	const artifacts = new Map<string, string>();
	const episodes = new ConflictEpisodes({ episodes: {}, artifacts: {} }, {
		read: async (path) => artifacts.get(path) ?? null,
		write: async (path, content, expected) => {
			assert.equal(artifacts.get(path) ?? null, expected);
			artifacts.set(path, content);
		},
		persist: async () => {}, changed: () => {}, notify: () => {},
	});
	await episodes.preserve({
		bodyId: "body-1", path: "A.md", disk: state.files.get("A.md")!.content,
		body: state.documents.get("body-1")!.getText("body").toString(), device: "test-device",
	});
	state.mirror.configureSettlement({
		conflictEpisodes: episodes, getBaseline: () => null,
		commitLocalBody: async () => { assert.fail("review projection must not import disk"); },
	});
	state.mirror.recordPreservedUnresolved("A.md", "body-settlement-failed");
	return episodes;
}

for (const change of ["disk", "revision", "body", "identity", "path", "scope", "failure"] as const) {
	tests.test(`review projection retains its episode when ${change} changes at the write boundary`, () => withFixture(async (state) => {
		const episodes = await preserveReviewedEpisode(state);
		const episode = episodes.get("body-1");
		const expectedDisk = await state.mirror.readCanonicalDiskEvidence("A.md");
		assert.ok(expectedDisk);
		state.hooks.process = (file) => {
			if (change === "disk") file.content += "\r\n";
			if (change === "revision") state.coordinator.advanceContent("body-1");
			if (change === "body") state.documents.get("body-1")!.getText("body").insert(0, "new ");
			if (change === "identity") state.files.set("A.md", Object.assign(new TFile(), { path: "A.md", content: file.content }));
			if (change === "path") state.bindings.set("A.md", "body-2");
			if (change === "scope") state.mirror.invalidateDiskScope();
			if (change === "failure") throw new Error("host write failed");
		};
		const result = await bounded(state.mirror.getReconciliationWorker().run(() => state.mirror.projectReviewedContentUnqueued({
			path: "A.md", bodyId: "body-1", content: "remote A.md", expectedDisk,
		})));
		assert.equal(result, change === "failure" ? "failed" : "moved");
		assert.equal(episodes.get("body-1"), episode);
		assert.equal(state.mirror.isPreservedUnresolved("A.md"), true);
		assert.deepEqual(state.writes, []);
		assert.deepEqual(state.callbacks, []);
	}));
}

tests.test("review projection fails safe without Vault.process and retains its episode", () => withFixture(async (state) => {
	const episodes = await preserveReviewedEpisode(state);
	const episode = episodes.get("body-1");
	const expectedDisk = await state.mirror.readCanonicalDiskEvidence("A.md");
	assert.ok(expectedDisk);
	assert.equal(await state.mirror.projectReviewedContent({ path: "A.md", bodyId: "body-1", content: "remote A.md", expectedDisk }), "failed");
	assert.equal(episodes.get("body-1"), episode);
	assert.equal(state.mirror.isPreservedUnresolved("A.md"), true);
	assert.deepEqual(state.writes, []);
}, { atomic: false }));

tests.test("review projects pending durable content without publishing trusted agreement", () => withFixture(async (state) => {
	const episodes = await preserveReviewedEpisode(state);
	const episode = episodes.get("body-1");
	const expectedDisk = await state.mirror.readCanonicalDiskEvidence("A.md");
	assert.ok(expectedDisk);
	state.pendingBodies.add("body-1");
	assert.equal(await state.mirror.projectReviewedContent({ path: "A.md", bodyId: "body-1", content: "remote A.md", expectedDisk }), "written");
	assert.equal(state.files.get("A.md")!.content, "remote A.md");
	assert.equal(episodes.get("body-1"), episode);
	assert.equal(state.mirror.isPreservedUnresolved("A.md"), true);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("review never resolves through a partial frontmatter write", () => withFixture(async (state) => {
	const document = state.documents.get("body-1")!;
	const chosen = "---\ntags: [broken\n---\nreviewed body";
	document.getText("body").delete(0, document.getText("body").length);
	document.getText("body").insert(0, chosen);
	const episodes = await preserveReviewedEpisode(state);
	const episode = episodes.get("body-1");
	const expectedDisk = await state.mirror.readCanonicalDiskEvidence("A.md");
	assert.ok(expectedDisk);
	assert.equal(await state.mirror.projectReviewedContent({ path: "A.md", bodyId: "body-1", content: chosen, expectedDisk }), "failed");
	assert.equal(episodes.get("body-1"), episode);
	assert.equal(state.mirror.isPreservedUnresolved("A.md"), true);
	assert.equal(state.files.get("A.md")!.content, expectedDisk.rawContent);
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("review verifies full host output before reporting completion", () => withFixture(async (state) => {
	const episodes = await preserveReviewedEpisode(state);
	const episode = episodes.get("body-1");
	const expectedDisk = await state.mirror.readCanonicalDiskEvidence("A.md");
	assert.ok(expectedDisk);
	state.hooks.process = (file) => {
		Object.defineProperty(file, "content", {
			configurable: true, get: () => "before A.md", set: () => {},
		});
	};
	assert.equal(await state.mirror.projectReviewedContent({ path: "A.md", bodyId: "body-1", content: "remote A.md", expectedDisk }), "moved");
	assert.equal(episodes.get("body-1"), episode);
	assert.equal(state.mirror.isPreservedUnresolved("A.md"), true);
	assert.deepEqual(state.callbacks, []);
}));

await tests.done();
