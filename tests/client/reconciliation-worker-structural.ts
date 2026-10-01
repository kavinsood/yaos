import { strict as assert } from "node:assert";
import { type App, TFile, type TFolder } from "obsidian";
import { canonicalizeVaultPath } from "../../src/paths/canonicalPath";
import { exactMarkdownDiskFingerprint } from "@shared/markdownCodec";
import { BodyCoordinator } from "../../src/sync/bodyCoordinator";
import { contentBaselineHash } from "../../src/sync/diskIndex";
import { DiskMirror } from "../../src/sync/diskMirror";
import { cloneStructuralIntent, sameStructuralPlan, validateStructuralIntent, type StoredStructuralIntent, type StructuralIntentStore } from "../../src/sync/structuralIntent";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("reconciliation-worker-structural");

type DiskFile = TFile & { content: string };
type Move = { from: string; to: string; bodyId: string };

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
				timer = setTimeout(() => reject(new Error("structural operation timed out")), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function diskFile(path: string, content = path): DiskFile {
	return Object.assign(new TFile(), {
		path,
		content,
		stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).length },
	});
}

async function fixture(options: { paths?: string[]; atomic?: boolean } = {}) {
	const paths = options.paths ?? ["A.md", "B.md", "C.md"];
	const files = new Map(paths.map((path) => [path, diskFile(path)]));
	const originals = new Map(files);
	const handles = new WeakMap<TFile, DiskFile>([...files.values()].map((file) => [file, file]));
	const bindings = new Map(paths.map((path, index) => [path, `body-${index + 1}`]));
	const folders = new Map<string, TFolder>();
	for (const path of paths) {
		const slash = path.lastIndexOf("/");
		if (slash >= 0) {
			const parent = path.slice(0, slash);
			folders.set(parent, partialOf<TFolder>({ path: parent, children: [] }));
		}
	}
	const coordinator = new BodyCoordinator();
	for (const bodyId of bindings.values()) {
		coordinator.ensure(bodyId);
		coordinator.setResidency(bodyId, "warm");
	}
	coordinator.replacePathBindings(bindings);
	const reads = new Map<string, number>();
	const renames: Array<{ from: string; to: string; file: TFile }> = [];
	const writes: string[] = [];
	const callbacks: string[] = [];
	const editorMoves: Array<Map<string, string>> = [];
	const pending = new Map<string, string>();
	const materializedPaths = new Map(bindings);
	const intents = new Map<string, StoredStructuralIntent>();
	const intentStore: StructuralIntentStore = {
		get: async (operationId) => {
			const intent = intents.get(operationId);
			return intent ? cloneStructuralIntent(intent) : null;
		},
		list: async () => [...intents.values()].map(cloneStructuralIntent),
		put: async (intent) => {
			validateStructuralIntent(intent);
			const existing = intents.get(intent.operationId);
			if (existing && !sameStructuralPlan(existing, intent)) throw new Error("Structural operation ID already has a different plan");
			if (existing?.phase === "placing" && intent.phase === "staging") throw new Error("Structural intent phase cannot regress");
			intents.set(intent.operationId, cloneStructuralIntent(intent));
		},
		delete: async (operationId) => { intents.delete(operationId); },
	};
	const hooks: {
		read?: (file: TFile, ordinal: number) => void | Promise<void>;
		rename?: (file: TFile, to: string, ordinal: number) => void | Promise<void>;
		process?: (file: TFile) => void | Promise<void>;
		bookkeeping?: () => void | Promise<void>;
	} = {};
	const stored = (file: TFile): DiskFile => {
		const entry = handles.get(file) ?? files.get(file.path);
		assert.equal(entry, file);
		assert.ok(entry);
		return entry;
	};
	const app = partialOf<App>({
		vault: {
			getAbstractFileByPath: (path) => files.get(path) ?? folders.get(path) ?? null,
			read: async (file) => {
				const ordinal = (reads.get(file.path) ?? 0) + 1;
				reads.set(file.path, ordinal);
				await hooks.read?.(file, ordinal);
				return stored(file).content;
			},
			modify: async (file, content) => {
				stored(file).content = content;
				writes.push(content);
			},
			...(options.atomic === false ? {} : {
				process: async (file: TFile, transform: (content: string) => string) => {
					await hooks.process?.(file);
					const content = transform(stored(file).content);
					stored(file).content = content;
					writes.push(content);
					return content;
				},
			}),
			createFolder: async (path) => {
				assert.equal(files.has(path) || folders.has(path), false);
				const folder = partialOf<TFolder>({ path, children: [] });
				folders.set(path, folder);
				return folder;
			},
		},
		fileManager: {
			renameFile: async (file, to) => {
				assert.ok(file instanceof TFile);
				const intent = (await intentStore.list()).find((entry) => entry.moves.some((move) => move.staging === file.path || move.staging === to));
				if (to.includes(".yaos-moving-")) assert.equal(intent?.phase, "staging", "intent is durable before source staging");
				if (file.path.includes(".yaos-moving-")) assert.equal(intent?.phase, "placing", "placing phase is durable before any final move");
				renames.push({ from: file.path, to, file });
				await hooks.rename?.(file, to, renames.length);
				assert.equal(files.has(to) || folders.has(to), false, `rename would overwrite ${to}`);
				const entry = stored(file);
				files.delete(file.path);
				file.path = to;
				files.set(to, entry);
			},
			trashFile: async (file) => {
				assert.ok(file instanceof TFile);
				stored(file);
				files.delete(file.path);
			},
		},
	});
	const runtime = partialOf<VaultSync>({
		getFileId: (path) => bindings.get(path),
		markPendingRenameTarget: (path, bodyId) => { pending.set(path, bodyId); },
		clearPendingRenameTarget: (path, bodyId) => {
			if (pending.get(path) === bodyId) pending.delete(path);
		},
		bodies: { coordinator, captureRevision: (bodyId) => coordinator.capture(bodyId) },
	});
	const mirror = new DiskMirror(app, runtime, partialOf<EditorBindingManager>({
		isBound: () => false,
		updatePathsAfterRename: (moves) => { editorMoves.push(new Map(moves)); },
	}), false);
	mirror.setStructuralRenamePlanPort({
		prepare: async (plan) => {
			await intentStore.put({
				operationId: plan.id,
				scope: { vaultId: "vault-1", vaultGeneration: "generation-1", accountId: "account-1", folderKey: "folder-1" },
				createdAt: Date.now(), format: 1, kind: "rename-batch", phase: "staging",
				moves: await Promise.all(plan.moves.map(async (move) => ({
					bodyId: move.bodyId, from: move.from, staging: move.temporaryPath, to: move.to,
					expectedContent: move.expectedContent, fingerprint: await exactMarkdownDiskFingerprint(move.expectedContent),
				}))),
			});
		},
		staged: async (plan) => {
			const intent = await intentStore.get(plan.id);
			assert.ok(intent);
			assert.equal(intent.phase, "staging");
			for (const move of plan.moves) {
				assert.equal(files.get(move.temporaryPath), originals.get(move.from));
				assert.equal(files.get(move.temporaryPath)!.content, move.expectedContent);
			}
			await intentStore.put({ ...intent, phase: "placing" });
		},
		complete: async (plan) => {
			assert.equal((await intentStore.get(plan.id))?.phase, "placing", "durable plan exists until all moves and bookkeeping finish");
			await hooks.bookkeeping?.();
			for (const move of plan.moves) {
				materializedPaths.delete(move.from);
			}
			for (const move of plan.moves) materializedPaths.set(move.to, move.bodyId);
			await intentStore.delete(plan.id);
		},
	});
	const baselineHash = await contentBaselineHash(paths[0]!);
	mirror.configureSettlement({
		getBaseline: () => ({ contentHash: baselineHash }),
		commitLocalBody: async () => { assert.fail("projection must not import disk into the body"); },
	});
	mirror.setDiskWriteCallback((_path, _hash, content) => { callbacks.push(content); });
	const worker = mirror.getReconciliationWorker();
	const reset = () => {
		mirror.resetReconciliationScope();
		worker.reset();
	};
	return {
		mirror, worker, reset, files, originals, bindings, reads, renames, writes, callbacks, editorMoves, pending, hooks, intentStore, materializedPaths,
		settle: () => mirror.settleBody({ path: paths[0]!, bodyId: bindings.get(paths[0]!)!, generation: 1, content: "remote content" }),
		close: async () => {
			worker.reset();
			await bounded(worker.whenIdle());
			mirror.destroy();
			coordinator.dispose();
		},
	};
}

async function withFixture(
	run: (state: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
	options: Parameters<typeof fixture>[0] = {},
): Promise<void> {
	const state = await fixture(options);
	try {
		await run(state);
	} finally {
		await state.close();
	}
}

function moveExternally(state: Awaited<ReturnType<typeof fixture>>, file: TFile, to: string): void {
	const entry = state.files.get(file.path);
	assert.equal(entry, file);
	assert.ok(entry);
	assert.equal(state.files.has(to), false);
	state.files.delete(file.path);
	file.path = to;
	state.files.set(to, entry);
}

const cycle: Move[] = [
	{ from: "A.md", to: "B.md", bodyId: "body-1" },
	{ from: "B.md", to: "C.md", bodyId: "body-2" },
	{ from: "C.md", to: "A.md", bodyId: "body-3" },
];
const single: Move[] = [{ from: "A.md", to: "D.md", bodyId: "body-1" }];
const stagedBatch: Move[] = [...single, { from: "B.md", to: "E.md", bodyId: "body-2" }];

tests.test("cyclic rename succeeds with occupied destinations and preserves every input", () => withFixture(async (state) => {
	await bounded(state.mirror.moveBodies(cycle));
	for (const move of cycle) assert.equal(state.files.get(move.to), state.originals.get(move.from));
	assert.equal(state.files.size, 3);
	assert.equal(state.renames.length, 6);
	assert.deepEqual(state.editorMoves, [new Map(cycle.map((move) => [move.from, move.to]))]);
	assert.equal(state.pending.size, 0);
	assert.deepEqual(await state.intentStore.list(), []);
	assert.deepEqual(state.materializedPaths, new Map(cycle.map((move) => [move.to, move.bodyId])));
}));

tests.test("durable placing intent remains until materialized-path bookkeeping finishes", () => withFixture(async (state) => {
	const entered = gate();
	const release = gate();
	state.hooks.bookkeeping = async () => {
		entered.release();
		await bounded(release.promise);
	};
	const moved = bounded(state.mirror.moveBodies(cycle));
	try {
		await bounded(entered.promise);
		for (const move of cycle) assert.equal(state.files.get(move.to), state.originals.get(move.from));
		assert.equal((await state.intentStore.list())[0]?.phase, "placing");
		assert.deepEqual(state.materializedPaths, state.bindings);
		release.release();
		await moved;
		assert.deepEqual(await state.intentStore.list(), []);
		assert.deepEqual(state.materializedPaths, new Map(cycle.map((move) => [move.to, move.bodyId])));
	} finally {
		release.release();
		await moved;
	}
}));

tests.test("partially completed cyclic rename retains every input and its durable recovery plan", () => withFixture(async (state) => {
	state.hooks.rename = (_file, _to, ordinal) => {
		if (ordinal === 6) throw new Error("injected rename failure");
	};
	await assert.rejects(bounded(state.mirror.moveBodies(cycle)), /injected rename failure/);
	for (const [path, original] of state.originals) {
		assert.equal(state.files.get(original.path), original);
		assert.equal(original.content, path);
	}
	assert.equal(state.files.size, 3);
	assert.deepEqual(state.editorMoves, []);
	assert.equal(state.pending.size, 0);
	const intents = await state.intentStore.list();
	assert.equal(intents.length, 1);
	assert.equal(intents[0]!.moves.length, 3);
	for (const original of state.originals.values()) assert.equal(state.mirror.isPreservedUnresolved(original.path), true);
}));

tests.test("worker reset during the source read prevents all rename effects", () => withFixture(async (state) => {
	state.hooks.read = () => { state.reset(); };
	await assert.rejects(bounded(state.mirror.moveBodies(single)));
	assert.equal(state.renames.length, 0);
	assert.deepEqual(state.files, state.originals);
	assert.equal(state.pending.size, 0);
}));

tests.test("reset after staging preserves inputs and never rolls back over a foreign source", () => withFixture(async (state) => {
	const entered = gate();
	const release = gate();
	state.hooks.read = async (file) => {
		if (!file.path.includes(".yaos-moving-")) return;
		entered.release();
		await bounded(release.promise);
	};
	const rejected = assert.rejects(bounded(state.mirror.moveBodies(stagedBatch)));
	void rejected.catch(() => {});
	try {
		await bounded(entered.promise);
		const original = state.originals.get("A.md")!;
		const stagedPath = original.path;
		assert.notEqual(stagedPath, "A.md");
		const foreign = diskFile("A.md", "foreign source");
		state.files.set("A.md", foreign);
		state.reset();
		release.release();
		await bounded(rejected);
		assert.equal(state.files.get(stagedPath), original);
		assert.equal(original.content, "A.md");
		assert.equal(state.files.get("A.md"), foreign);
		assert.equal(foreign.content, "foreign source");
		assert.equal(state.files.has("D.md"), false);
		assert.equal(state.renames.length, 2);
		for (const path of ["A.md", "D.md", stagedPath]) assert.equal(state.mirror.isPreservedUnresolved(path), true);
		assert.equal(state.pending.size, 0);
		assert.equal((await state.intentStore.list()).length, 1);
	} finally {
		release.release();
		await bounded(rejected);
	}
}));

tests.test("a failed placement preserves a foreign source and every staged input", () => withFixture(async (state) => {
	const foreign = diskFile("A.md", "foreign rollback destination");
	state.hooks.rename = (_file, _to, ordinal) => {
		if (ordinal !== 3) return;
		state.files.set("A.md", foreign);
		throw new Error("injected rename failure");
	};
	await assert.rejects(bounded(state.mirror.moveBodies(stagedBatch)), /injected rename failure/);
	const original = state.originals.get("A.md")!;
	assert.equal(state.files.get("A.md"), foreign);
	assert.equal(foreign.content, "foreign rollback destination");
	assert.equal(state.files.get(original.path), original);
	assert.equal(original.content, "A.md");
	assert.notEqual(original.path, "A.md");
	assert.equal(state.renames.length, 3);
	assert.equal(state.mirror.isPreservedUnresolved(original.path), true);
	assert.equal(state.pending.size, 0);
	assert.equal((await state.intentStore.list()).length, 1);
	for (const preserved of state.originals.values()) assert.equal(state.files.get(preserved.path), preserved);
}));

tests.test("a foreign final destination appearing after staging is not overwritten", () => withFixture(async (state) => {
	const foreign = diskFile("D.md", "foreign final destination");
	state.hooks.read = (file) => {
		if (file.path.includes(".yaos-moving-")) state.files.set("D.md", foreign);
	};
	await assert.rejects(bounded(state.mirror.moveBodies(stagedBatch)), /Move destination already exists: D.md/);
	assert.equal(state.files.get("D.md"), foreign);
	assert.equal(foreign.content, "foreign final destination");
	for (const [path, original] of state.originals) {
		assert.equal(state.files.get(original.path), original);
		assert.equal(original.content, path);
	}
	assert.equal(state.files.size, 4);
	assert.equal(state.pending.size, 0);
	assert.equal((await state.intentStore.list()).length, 1);
}));

tests.test("placement rechecks a foreign destination appearing during its asynchronous source read", () => withFixture(async (state) => {
	const foreign = diskFile("D.md", "late foreign destination");
	const entered = gate();
	const release = gate();
	const original = state.originals.get("A.md")!;
	state.hooks.read = async (file) => {
		if (file !== original || !file.path.includes(".yaos-moving-")) return;
		entered.release();
		await bounded(release.promise);
	};
	const rejected = assert.rejects(bounded(state.mirror.moveBodies(stagedBatch)), /Move destination already exists: D.md/);
	void rejected.catch(() => {});
	try {
		await bounded(entered.promise);
		state.files.set("D.md", foreign);
		release.release();
		await rejected;
		assert.equal(state.files.get("D.md"), foreign);
		assert.equal(foreign.content, "late foreign destination");
		assert.equal(state.files.get(original.path), original);
		assert.equal(original.content, "A.md");
		assert.notEqual(original.path, "A.md");
		assert.equal(state.renames.length, 2);
		assert.equal(state.mirror.isPreservedUnresolved(original.path), true);
		assert.equal(state.pending.size, 0);
		assert.equal((await state.intentStore.list()).length, 1);
	} finally {
		release.release();
		await rejected;
	}
}));

tests.test("an externally edited staged input survives failed placement with its durable original plan", () => withFixture(async (state) => {
	const original = state.originals.get("A.md")!;
	state.hooks.read = (file) => {
		if (file === original && file.path.includes(".yaos-moving-")) original.content = "external staged edit";
	};
	await assert.rejects(bounded(state.mirror.moveBodies(stagedBatch)), /disk content changed before the write/);
	assert.equal(state.files.get(original.path), original);
	assert.equal(original.content, "external staged edit");
	assert.equal(state.files.has("D.md"), false);
	assert.equal(state.files.has("E.md"), false);
	assert.equal(state.files.size, 3);
	assert.deepEqual(state.editorMoves, []);
	assert.equal(state.pending.size, 0);
	const intents = await state.intentStore.list();
	assert.equal(intents.length, 1);
	assert.equal(intents[0]!.moves.find((move) => move.bodyId === "body-1")!.expectedContent, "A.md");
	assert.equal(state.mirror.isPreservedUnresolved(original.path), true);
}));

tests.test("identity rename is non-destructive and traversal fails before reservation", () => withFixture(async (state) => {
	assert.equal(await bounded(state.mirror.settleRename({ from: "A.md", to: "A.md", bodyId: "body-1", currentContent: "A.md" })), "moved");
	await assert.rejects(bounded(state.mirror.moveBodies([{ from: "A.md", to: "../D.md", bodyId: "body-1" }])), /unsafe path/);
	assert.deepEqual(state.files, state.originals);
	assert.equal(state.reads.size, 0);
	assert.equal(state.renames.length, 0);
	assert.deepEqual(state.worker.diagnostics(), { active: 0, queued: 0 });
}));

tests.test("canonical rename waits in the shared FIFO while normalized aliases fail closed", () => withFixture(async (state) => {
	const from = "Notes/Caf\u00e9.md";
	const to = "Notes/Renamed.md";
	const entered = gate();
	const release = gate();
	const held = state.worker.run(async () => {
		entered.release();
		await bounded(release.promise);
	});
	try {
		await bounded(entered.promise);
		for (const alias of ["./Notes/Caf\u00e9.md", "Notes//Caf\u00e9.md", "Notes\\Caf\u00e9.md", "Notes/Cafe\u0301.md"]) {
			assert.equal(canonicalizeVaultPath(alias).canonicalKey, from);
			await assert.rejects(bounded(state.mirror.moveBodies([{ from: alias, to, bodyId: "body-1" }])), /unsafe path/);
		}
		await assert.rejects(bounded(state.mirror.moveBodies([{ from, to: "./Notes/Renamed.md", bodyId: "body-1" }])), /unsafe path/);
		assert.equal(state.worker.diagnostics().queued, 0);
		assert.equal(state.reads.size, 0);
		const rename = state.mirror.moveBodies([{ from, to, bodyId: "body-1" }]);
		assert.equal(state.worker.diagnostics().queued, 1);
		assert.equal(state.renames.length, 0);
		release.release();
		await bounded(Promise.all([held, rename]));
		assert.equal(state.files.get(to), state.originals.get(from));
		await bounded(state.worker.whenIdle());
		assert.deepEqual(state.worker.diagnostics(), { active: 0, queued: 0 });
	} finally {
		release.release();
		await bounded(held);
	}
}, { paths: ["Notes/Caf\u00e9.md"] }));

for (const boundary of ["initial-read", "write-boundary"] as const) {
	tests.test(`atomic CAS rejects a mutable file renamed during ${boundary} before catalog update`, () => withFixture(async (state) => {
		const move = (file: TFile) => { moveExternally(state, file, "Externally-renamed.md"); };
		if (boundary === "write-boundary") state.hooks.process = move;
		else state.hooks.read = move;
		assert.equal(await bounded(state.settle()), "replan");
		assert.equal(state.bindings.get("A.md"), "body-1");
		assert.equal(state.bindings.has("Externally-renamed.md"), false);
		assert.equal(state.files.get("Externally-renamed.md"), state.originals.get("A.md"));
		assert.equal(state.files.get("Externally-renamed.md")!.content, "A.md");
		assert.equal(state.files.has("A.md"), false);
		assert.deepEqual(state.writes, []);
		assert.deepEqual(state.callbacks, []);
	}));
}

tests.test("atomic CAS rejects a replaced path target even when captured file.path is unchanged", () => withFixture(async (state) => {
	const original = state.originals.get("A.md")!;
	const replacement = diskFile("A.md", "A.md");
	state.hooks.process = () => { state.files.set("A.md", replacement); };
	assert.equal(await bounded(state.settle()), "replan");
	assert.equal(original.path, "A.md");
	assert.equal(original.content, "A.md");
	assert.equal(state.files.get("A.md"), replacement);
	assert.equal(replacement.content, "A.md");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("atomic CAS fences reset at the actual write boundary", () => withFixture(async (state) => {
	const entered = gate();
	const release = gate();
	state.hooks.process = async () => {
		entered.release();
		await bounded(release.promise);
	};
	const settlement = bounded(state.settle());
	try {
		await bounded(entered.promise);
		state.reset();
		release.release();
		assert.equal(await settlement, "replan");
		assert.equal(state.files.get("A.md")!.content, "A.md");
		assert.deepEqual(state.writes, []);
		assert.deepEqual(state.callbacks, []);
		assert.deepEqual(state.mirror.getPreservedUnresolvedEntries(), []);
	} finally {
		release.release();
		await settlement;
	}
}));

tests.test("atomic CAS retains an intervening disk edit without reset", () => withFixture(async (state) => {
	state.hooks.process = () => { state.files.get("A.md")!.content = "external disk edit"; };
	assert.equal(await bounded(state.settle()), "replan");
	assert.equal(state.files.get("A.md")!.content, "external disk edit");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}));

tests.test("without atomic Vault.process settlement fails safe without writing or publishing agreement", () => withFixture(async (state) => {
	assert.equal(await bounded(state.settle()), "preserved-unresolved");
	assert.deepEqual(state.files, state.originals);
	assert.equal(state.files.get("A.md")!.content, "A.md");
	assert.deepEqual(state.writes, []);
	assert.deepEqual(state.callbacks, []);
}, { atomic: false }));

for (const operation of ["discard", "delete"] as const) {
	tests.test(`${operation} retains a file renamed during its read before catalog update`, () => withFixture(async (state) => {
		const original = state.originals.get("A.md")!;
		state.hooks.read = (file) => { moveExternally(state, file, "Externally-renamed.md"); };
		const result = operation === "discard"
			? await bounded(state.mirror.discardStaleBody({ path: "A.md", bodyId: "body-1", expectedContent: "A.md" }))
			: await bounded(state.mirror.deleteBody({ path: "A.md", bodyId: "body-1", generation: 1, baselineContent: "A.md" }));
		assert.equal(result, operation === "discard" ? false : "preserved-unresolved");
		assert.equal(state.bindings.get("A.md"), "body-1");
		assert.equal(state.files.get("Externally-renamed.md"), original);
		assert.equal(original.content, "A.md");
		assert.equal(state.files.size, 3);
		assert.deepEqual(state.callbacks, []);
	}));
}

tests.test("rename rejects a moved source handle before catalog update", () => withFixture(async (state) => {
	state.hooks.read = (file) => { moveExternally(state, file, "Externally-renamed.md"); };
	await assert.rejects(bounded(state.mirror.moveBodies(single)));
	assert.equal(state.bindings.get("A.md"), "body-1");
	assert.equal(state.files.get("Externally-renamed.md"), state.originals.get("A.md"));
	assert.equal(state.files.get("Externally-renamed.md")!.content, "A.md");
	assert.equal(state.files.has("D.md"), false);
	assert.equal(state.renames.length, 0);
	assert.equal(state.pending.size, 0);
}));

await tests.done();
