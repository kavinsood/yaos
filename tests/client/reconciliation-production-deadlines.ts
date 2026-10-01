import VaultCrdtSyncPlugin from "../../src/main";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import { createMarkdownConflictArtifact } from "../../src/runtime/reconcile/markdownConflictArtifact";
import type { MarkdownAdmissionIntent } from "../../src/runtime/markdownAdmissionScheduler";
import { MarkdownAdmissionScheduler } from "../../src/runtime/markdownAdmissionScheduler";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { type App, MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationBackpressureError, ReconciliationIoTimeoutError, ReconciliationWorker, reconciliationRetainedBytes } from "../../src/runtime/reconciliationWorker";
import { BodyCoordinator } from "../../src/sync/bodyCoordinator";
import type { LoadedBody } from "../../src/sync/bodyManager";
import { ConflictEpisodes } from "../../src/sync/conflictEpisodes";
import { contentBaselineHash, setCurrentContentHash, type DiskIndex } from "../../src/sync/diskIndex";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { VaultSync } from "../../src/sync/vaultSync";
import { suite, until, withTempDir } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("reconciliation-production-deadlines");

type DiskFile = TFile & { content: string };

function probeObject(target: object, property: string): object {
	const value: unknown = Reflect.get(target, property);
	assert.ok(typeof value === "object" && value !== null, `${property} must be an object`);
	return value;
}

function probeCollectionSize(target: object, property: string): number {
	const value = probeObject(target, property);
	assert.ok(value instanceof Map || value instanceof Set, `${property} must be a collection`);
	return value.size;
}

function callProbeMethod(target: object, property: string, ...args: unknown[]): unknown {
	const method: unknown = Reflect.get(target, property);
	assert.ok(typeof method === "function", `${property} must be callable`);
	return Reflect.apply(method, target, args);
}

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
	const processReservations: number[] = [];
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
		workspace: { getActiveViewOfType: () => null, iterateAllLeaves: () => {} },
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
				process: async (file: TFile, transform: (content: string) => string, options?: Parameters<App["vault"]["process"]>[2] & { retainedBytes?: number }) => {
					if (options?.retainedBytes !== undefined) processReservations.push(options.retainedBytes);
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
		mirror, app, runtime, files, bindings, documents, coordinator, hooks, writes, reads, callbacks, renames, editorMoves, pending, pendingBodies, processReservations,
		settle: (path = "A.md") => mirror.settleBody({
			path, bodyId: bindings.get(path)!, generation: 1, content: `remote ${path}`,
		}),
		close: async () => {
			const worker = mirror.getReconciliationWorker();
			await until(() => worker.diagnostics().active === 0 && worker.health().pendingIo === 0, { message: "fixture I/O settles" });
			worker.reset();
			await bounded(worker.whenIdle());
			mirror.destroy();
			coordinator.dispose();
			for (const document of documents.values()) document.destroy();
		},
	};
}


tests.test("near-limit 5 MiB settlement retains two texts without rejecting a valid note", async () => {
	const base = "b".repeat(5 * 1024 * 1024);
	const content = "r".repeat(5 * 1024 * 1024);
	const state = await fixture({ raw: base });
	const worker = state.mirror.getReconciliationWorker();
	const held = gate();
	try {
		const body = state.documents.get("body-1")!.getText("body");
		body.delete(0, body.length);
		body.insert(0, content);
		const blocker = worker.run(() => held.promise);
		const settlement = state.mirror.settleBody({ path: "A.md", bodyId: "body-1", generation: 1, content, baseContent: base });
		assert.equal(worker.health().retainedBytes, reconciliationRetainedBytes(content, base));
		assert.equal(worker.diagnostics().queued, 1);
		held.release();
		await blocker;
		assert.equal(await settlement, "settled");
		assert.equal(state.files.get("A.md")!.content, content);
		assert.deepEqual(state.callbacks, ["A.md"]);
		assert.deepEqual(state.processReservations, [reconciliationRetainedBytes(base, content)]);
	} finally { held.release(); await state.close(); }
});

tests.test("near-limit projection uses the declared process budget on the default 32 MiB Node host", async () => {
	await withTempDir("yaos-production-process-budget-", async (root) => {
		const loader = createJiti(import.meta.url, { alias: {
			obsidian: fileURLToPath(new URL("../../packages/cli/src/obsidian-shim.ts", import.meta.url)),
			"@shared": fileURLToPath(new URL("../../server/src/shared", import.meta.url)),
		} });
		const { NodeApp } = await loader.import<typeof import("../../packages/cli/src/nodeApp")>(fileURLToPath(new URL("../../packages/cli/src/nodeApp.ts", import.meta.url)));
		const { TFile: HostFile } = await loader.import<typeof import("obsidian")>(fileURLToPath(new URL("../../packages/cli/src/obsidian-shim.ts", import.meta.url)));
		const base = "b".repeat(5 * 1024 * 1024);
		const content = "r".repeat(5 * 1024 * 1024);
		await fs.writeFile(join(root, "A.md"), base);
		const host = await NodeApp.create(root);
		const hostFile = host.vault.getAbstractFileByPath("A.md");
		assert.ok(hostFile instanceof HostFile);
		const mirrorFile = Object.assign(new TFile(), { path: "A.md", stat: hostFile.stat });
		const state = await fixture();
		const body = state.documents.get("body-1")!.getText("body");
		body.delete(0, body.length);
		body.insert(0, content);
		const app = partialOf<App>({ workspace: { getActiveViewOfType: () => null }, vault: {
			getAbstractFileByPath: (path) => path === "A.md" ? mirrorFile : null,
			read: () => host.vault.read(hostFile),
			process: (_file, transform, options) => host.vault.process(hostFile, transform, options as { retainedBytes?: number }),
		} });
		const mirror = new DiskMirror(app, state.runtime, partialOf<EditorBindingManager>({ isBound: () => false, getLastEditorActivityForPath: () => null }), false);
		const baselineHash = await contentBaselineHash(base);
		mirror.configureSettlement({ getBaseline: () => ({ contentHash: baselineHash }), commitLocalBody: async () => { assert.fail("projection must not import disk"); } });
		try {
			assert.equal(await mirror.settleBody({ path: "A.md", bodyId: "body-1", generation: 1, content, baseContent: base }), "settled");
			assert.equal(await fs.readFile(join(root, "A.md"), "utf8"), content);
		} finally { await mirror.getReconciliationWorker().whenIdle(); mirror.destroy(); await state.close(); }
	});
});

tests.test("oversized settlement refuses admission without disk reads, writes, or baseline acknowledgement", async () => {
	const state = await fixture();
	try {
		const oversized = "x".repeat(9 * 1024 * 1024);
		await assert.rejects(state.mirror.settleBody({ path: "A.md", bodyId: "body-1", generation: 1, content: oversized, baseContent: oversized }), ReconciliationBackpressureError);
		assert.deepEqual(state.reads, []);
		assert.deepEqual(state.writes, []);
		assert.deepEqual(state.callbacks, []);
		assert.equal(state.files.get("A.md")!.content, "before A.md");
		assert.equal(state.mirror.getReconciliationWorker().health().retainedBytes, 0);
	} finally { await state.close(); }
});

tests.test("timed-out Vault.process cannot apply its late synchronous callback", async () => {
	const state = await fixture();
	const worker = new ReconciliationWorker({ ioTimeoutMs: 40 });
	state.mirror.setReconciliationWorker(worker);
	const held = gate();
	const entered = gate();
	let stalls = 0;
	worker.setStallHandler(() => { stalls++; });
	state.hooks.process = async () => { entered.release(); await held.promise; };
	try {
		const settlement = state.settle();
		const rejected = assert.rejects(settlement, ReconciliationIoTimeoutError);
		await entered.promise;
		await rejected;
		assert.equal(stalls, 1);
		assert.equal(worker.health().pendingIo, 1);
		worker.reset();
		assert.equal(worker.isOperational, false);
		assert.equal(state.files.get("A.md")!.content, "before A.md");
		held.release();
		await until(() => worker.health().pendingIo === 0 && worker.diagnostics().active === 0, { message: "underlying process settles" });
		assert.equal(worker.isOperational, false);
		assert.deepEqual(state.writes, []);
		assert.deepEqual(state.callbacks, []);
		worker.reset();
		assert.equal(worker.isOperational, true);
	} finally { held.release(); await state.close(); }
});

tests.test("rename collision reads are sequential before deleting an exact duplicate", async () => {
	const state = await fixture({ raw: "same" });
	try {
		state.bindings.delete("A.md");
		state.bindings.set("B.md", "body-1");
		state.coordinator.replacePathBindings(state.bindings);
		assert.equal(await state.mirror.settleRename({ from: "A.md", to: "B.md", bodyId: "body-1", currentContent: "same" }), "source-deleted");
		assert.deepEqual(state.reads, ["A.md", "B.md"]);
		assert.equal(state.files.has("A.md"), false);
	} finally { await state.close(); }
});

tests.test("rediscoverable projection producers cap timers and notify reconciliation of overflow", async () => {
	const state = await fixture();
	try {
		const rediscovered: string[] = [];
		state.mirror.setDiskMovedBeforeWriteHandler((path) => { rediscovered.push(path); });
		for (let index = 0; index < 1000; index++) state.mirror.scheduleWrite(`Note-${index}.md`);
		const snapshot = state.mirror.getDebugSnapshot();
		assert.equal(snapshot.debounceCount + snapshot.openDebounceCount + snapshot.queuedWrites.length, 64);
		assert.equal(rediscovered.length, 936);
		state.mirror.scheduleWrite("Note-0.md");
		assert.equal(state.mirror.getDebugSnapshot().debounceCount, 64);
	} finally { state.mirror.destroy(); await state.close(); }
});

tests.test("shared conflict helper deadlines cover create and suppress late success tracing", async () => {
	const worker = new ReconciliationWorker({ ioTimeoutMs: 30 });
	const held = gate();
	let traced = 0;
	const app = partialOf<App>({ vault: {
		getAbstractFileByPath: () => null,
		create: async () => { await held.promise; return new TFile(); },
	} });
	const artifact = worker.run(() => createMarkdownConflictArtifact(app, "Note.md", "unique disk input", {
		deviceName: "Test", reason: "deadline-test",
		executeHost: (operation, execute) => worker.io(operation, execute),
		trace: () => { traced++; },
	}));
	await assert.rejects(artifact, ReconciliationIoTimeoutError);
	assert.equal(worker.health().pendingIo, 1);
	held.release();
	await until(() => worker.health().pendingIo === 0 && worker.diagnostics().active === 0, { message: "late artifact create settles" });
	assert.equal(traced, 0);
	worker.reset();
});

tests.test("captured oversized conflict input remains retryable instead of acknowledging import", async () => {
	const state = await fixture({ raw: "d".repeat(9 * 1024 * 1024) });
	const content = "r".repeat(9 * 1024 * 1024);
	const body = state.documents.get("body-1")!.getText("body");
	body.delete(0, body.length);
	body.insert(0, content);
	let preserved = 0;
	let indexWrites = 0;
	const episodes = partialOf<ConflictEpisodes>({
		get: () => ({ bodyId: "body-1", path: "A.md" }) as never,
		preserve: async () => { preserved++; return {} as never; },
	});
	const controller = new ReconciliationController({
		app: state.app, reconciliationWorker: state.mirror.getReconciliationWorker(),
		getConflictEpisodes: () => episodes, getSettings: () => ({ deviceName: "Test" }) as never,
		getRuntimeConfig: () => ({ externalEditPolicy: "always", maxFileSizeBytes: 0 }) as never,
		getVaultSync: () => state.runtime, getDiskMirror: () => state.mirror, getBlobSync: () => null,
		getEditorBindings: () => null, getDiskIndex: () => ({}), setDiskIndex: () => { indexWrites++; },
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {}, validateOpenEditorBindings: () => {}, onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false, setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {}, refreshStatusBar: () => {}, trace: () => {}, scheduleTraceStateSnapshot: () => {}, log: () => {},
	});
	try {
		const intent: MarkdownAdmissionIntent = { path: "A.md", reason: "modify", bodyId: "body-1", candidateId: "candidate-1", revision: 1, coalescedOpIds: [] };
		const outcome = await callProbeMethod(controller, "processMarkdownAdmission", intent, () => true);
		assert.ok(typeof outcome === "object" && outcome !== null && "kind" in outcome);
		assert.equal(outcome.kind, "retryable_failure");
		assert.equal(preserved, 0);
		assert.equal(indexWrites, 0);
		assert.deepEqual(state.callbacks, []);
		assert.equal(state.files.get("A.md")!.content, "d".repeat(9 * 1024 * 1024));
	} finally { callProbeMethod(probeObject(controller, "markdownAdmission"), "stop"); controller.reset(); await state.close(); }
});

interface PluginProbe {
	queueConflictLifecycleUpdate(bodyId: string): void;
	updateStatusBar(state: { kind: "online"; generation: number }): void;
	getSettingsStatusSummary(): { label: string };
	collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>>;
}

tests.test("repeated status refresh coalesces lifecycle persistence and keeps stall status visible", async () => {
	const worker = new ReconciliationWorker({ ioTimeoutMs: 30 });
	const held = gate();
	let renames = 0;
	let label = "";
	const episode = { bodyId: "body-1", path: "Old.md" };
	const plugin = Object.assign(Object.create(VaultCrdtSyncPlugin.prototype) as PluginProbe, {
		reconciliationWorker: worker, conflictLifecycleUpdates: new Set<string>(), reconciliationStallNotice: null,
		vaultSync: { pathToId: new Map([["New.md", "body-1"]]), provider: { synced: true }, getServerReceiptSnapshot: () => null },
		conflictEpisodes: { get: () => episode, list: () => [episode], rename: async () => { renames++; await held.promise; }, close: async () => {} },
		statusBarEl: { setText: (text: string) => { label = text; }, setAttr: () => {}, setAttribute: () => {} },
		connectionStateLatch: { resolve: (state: unknown) => state }, getBlobSync: () => null,
		pendingRecoveryState: {},
		getOperationalResourceSnapshot: () => null, noticeServerPersistenceHealth: () => {}, log: () => {},
	});
	try {
		for (let index = 0; index < 100; index++) plugin.updateStatusBar({ kind: "online", generation: 1 });
		await until(() => renames === 1, { message: "one lifecycle update begins" });
		assert.equal(worker.diagnostics().queued, 0);
		await until(() => worker.health().stopped, { message: "blocked lifecycle persistence times out" });
		worker.reset();
		for (let index = 0; index < 100; index++) plugin.updateStatusBar({ kind: "online", generation: 1 });
		assert.equal(renames, 1);
		assert.match(label, /sync paused/);
		assert.match(plugin.getSettingsStatusSummary().label, /sync paused/);
	} finally {
		held.release();
		await until(() => worker.diagnostics().active === 0, { message: "lifecycle update settles" });
		worker.reset();
	}
});

tests.test("public disk evidence and suppression reads cannot steal an active worker slot", async () => {
	const state = await fixture();
	const worker = state.mirror.getReconciliationWorker();
	const held = gate();
	const entered = gate();
	try {
		const active = worker.run(() => worker.io("active-host-operation", async () => { entered.release(); await held.promise; }));
		await entered.promise;
		const evidence = state.mirror.readCanonicalDiskEvidence("A.md");
		const suppression = state.mirror.shouldSuppressModify(state.files.get("A.md")!);
		assert.equal(worker.health().pendingIo, 1);
		assert.equal(worker.diagnostics().queued, 2);
		assert.deepEqual(state.reads, []);
		held.release();
		await active;
		assert.equal((await evidence)?.content, "before A.md");
		assert.equal(await suppression, false);
		assert.equal(worker.health().stopped, false);
	} finally { held.release(); await state.close(); }
});

tests.test("structural batch metadata is accounted and refusal leaves both source files intact", async () => {
	const state = await fixture();
	const worker = new ReconciliationWorker({ maximumRetainedBytes: 64 });
	state.mirror.setReconciliationWorker(worker);
	try {
		await assert.rejects(state.mirror.moveBodies([
			{ from: "A.md", to: "B.md", bodyId: "body-1" },
			{ from: "B.md", to: "A.md", bodyId: "body-2" },
		]), ReconciliationBackpressureError);
		assert.deepEqual(state.reads, []);
		assert.deepEqual(state.renames, []);
		assert.equal(state.files.get("A.md")!.content, "before A.md");
		assert.equal(state.files.get("B.md")!.content, "before B.md");
	} finally { await state.close(); }
});

tests.test("diagnostic disk reads queue behind an active filesystem operation", async () => {
	const worker = new ReconciliationWorker({ ioTimeoutMs: 1000 });
	const held = gate();
	const entered = gate();
	const file = Object.assign(new TFile(), { path: "Note.md" });
	const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, { file, leaf: { id: "test-leaf" }, editor: { getValue: () => "body" } });
	let diagnosticReads = 0;
	const plugin = Object.assign(Object.create(VaultCrdtSyncPlugin.prototype) as PluginProbe, {
		reconciliationWorker: worker, vaultSync: { getTextForPath: () => null },
		app: { workspace: { iterateAllLeaves: (visit: (leaf: { view: MarkdownView }) => void) => visit({ view }) }, vault: { read: async () => { diagnosticReads++; return "body"; } } },
		editorBindings: null, hashIfPresent: async () => null, describeContentDiff: () => null,
	});
	const active = worker.run(() => worker.io("active-host-operation", async () => { entered.release(); await held.promise; }));
	await entered.promise;
	const diagnostic = plugin.collectOpenFileTraceState();
	assert.equal(worker.health().pendingIo, 1);
	assert.equal(worker.diagnostics().queued, 1);
	assert.equal(diagnosticReads, 0);
	held.release();
	await active;
	await diagnostic;
	assert.equal(diagnosticReads, 1);
	assert.equal(worker.health().stopped, false);
});


tests.test("structural count and text refusals fence the vault before durable planning", async () => {
	const state = await fixture({ raw: "x".repeat(5 * 1024 * 1024) });
	let planned = 0;
	state.mirror.setStructuralRenamePlanPort({ prepare: async () => { planned++; }, staged: async () => {}, complete: async () => {} });
	try {
		await assert.rejects(state.mirror.moveBodies([
			{ from: "A.md", to: "B.md", bodyId: "body-1" },
			{ from: "B.md", to: "A.md", bodyId: "body-2" },
		]), /16 MiB/);
		assert.equal(state.mirror.isStructuralAdmissionBlocked, true);
		assert.equal(state.mirror.isStructuralPathPending("Unrelated.md"), true);
		assert.deepEqual(state.reads, []);
		assert.deepEqual(state.renames, []);
		assert.equal(planned, 0);
	} finally { await state.close(); }
	const countState = await fixture();
	try {
		await assert.rejects(countState.mirror.moveBodies(Array.from({ length: 65 }, (_, index) => ({ from: `old-${index}.md`, to: `new-${index}.md`, bodyId: `body-${index}` }))), /64 moves/);
		assert.equal(countState.mirror.isStructuralPathPending("old-64.md"), true);
		assert.equal(countState.mirror.isStructuralPathPending("new-64.md"), true);
		assert.deepEqual(countState.reads, []);
	} finally { await countState.close(); }
});

tests.test("structural source growth aborts before the next read or any durable plan", async () => {
	const state = await fixture();
	let planned = 0;
	state.mirror.setStructuralRenamePlanPort({ prepare: async () => { planned++; }, staged: async () => {}, complete: async () => {} });
	const source = state.files.get("A.md")!;
	source.content = "unique large source".repeat(1024 * 1024);
	source.stat.size = 0;
	try {
		await assert.rejects(state.mirror.moveBodies([
			{ from: "A.md", to: "B.md", bodyId: "body-1" },
			{ from: "B.md", to: "A.md", bodyId: "body-2" },
		]), ReconciliationBackpressureError);
		assert.deepEqual(state.reads, ["A.md"]);
		assert.deepEqual(state.renames, []);
		assert.equal(planned, 0);
		assert.equal(state.files.get("A.md"), source);
		assert.equal(state.mirror.isStructuralAdmissionBlocked, true);
	} finally { await state.close(); }
});

tests.test("fresh reviewed evidence cannot bypass an oversized structural refusal", async () => {
	const state = await fixture();
	try {
		await assert.rejects(state.mirror.moveBodies(Array.from({ length: 65 }, (_, index) => ({ from: `old-${index}.md`, to: `new-${index}.md`, bodyId: `body-${index}` }))), /64 moves/);
		const evidence = await state.mirror.readCanonicalDiskEvidence("A.md");
		assert.ok(evidence);
		assert.equal(await state.mirror.projectReviewedContent({ path: "A.md", bodyId: "body-1", content: "remote A.md", expectedDisk: evidence }), "failed");
		assert.deepEqual(state.writes, []);
		assert.deepEqual(state.callbacks, []);
		assert.equal(state.files.get("A.md")!.content, "before A.md");
	} finally { await state.close(); }
});

tests.test("a structural refusal during reviewed projection fences the synchronous process callback", async () => {
	const state = await fixture();
	try {
		const evidence = await state.mirror.readCanonicalDiskEvidence("A.md");
		assert.ok(evidence);
		state.hooks.process = async () => {
			await assert.rejects(state.mirror.moveBodies(Array.from({ length: 65 }, (_, index) => ({ from: `old-${index}.md`, to: `new-${index}.md`, bodyId: `body-${index}` }))), /64 moves/);
		};
		assert.equal(await state.mirror.projectReviewedContent({ path: "A.md", bodyId: "body-1", content: "remote A.md", expectedDisk: evidence }), "moved");
		assert.deepEqual(state.callbacks, []);
		assert.equal(state.files.get("A.md")!.content, "before A.md");
	} finally { await state.close(); }
});

tests.test("closed divergence retry metadata caps distinct paths and requests inventory rediscovery", async () => {
	const state = await fixture();
	state.mirror.settleBody = async () => "replan";
	const controller = new ReconciliationController({
		app: state.app, reconciliationWorker: state.mirror.getReconciliationWorker(),
		getSettings: () => ({ deviceName: "Test" }) as never,
		getRuntimeConfig: () => ({ externalEditPolicy: "always", maxFileSizeBytes: 0 }) as never,
		getVaultSync: () => state.runtime, getDiskMirror: () => state.mirror, getBlobSync: () => null,
		getEditorBindings: () => null, getDiskIndex: () => ({}), setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {}, validateOpenEditorBindings: () => {}, onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false, setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {}, refreshStatusBar: () => {}, trace: () => {}, scheduleTraceStateSnapshot: () => {}, log: () => {},
	});
	try {
		for (let index = 0; index < 1001; index++) {
			const path = `Retry-${index}.md`;
			const file = Object.assign(new TFile(), { path, content: "unique disk input", stat: { ctime: 1, mtime: 1, size: 17 } });
			state.files.set(path, file);
			await callProbeMethod(controller, "reconcileClosedDivergence", file, file.content, "remote input", "body-1", "remote-materialization");
			assert.ok(probeCollectionSize(controller, "materializeReplans") <= 64);
			assert.ok(probeCollectionSize(controller, "remoteMaterializeTimers") <= 64);
		}
		assert.equal(probeCollectionSize(controller, "materializeReplans"), 64);
		const sweepPending: unknown = Reflect.get(controller, "markdownInventorySweepPending");
		assert.equal(sweepPending, true);
		assert.equal(state.files.size, 1003);
		assert.deepEqual(state.writes, []);
	} finally { callProbeMethod(probeObject(controller, "markdownAdmission"), "stop"); controller.reset(); await state.close(); }
});

tests.test("Markdown producer admission caps distinct pending signals and requests rediscovery", async () => {
	let overflow = 0;
	const scheduler = new MarkdownAdmissionScheduler({ process: async () => ({ kind: "completed", value: undefined }), onError: (error) => { assert.fail(String(error)); }, onOverflow: () => { overflow++; } });
	try {
		for (let index = 0; index < 1001; index++) scheduler.queue({ path: `Unique-${index}.md`, reason: "create" });
		assert.equal(probeCollectionSize(scheduler, "current"), 64);
		assert.equal(probeCollectionSize(scheduler, "retainedKeys"), 64);
		const stored = await callProbeMethod(probeObject(scheduler, "store"), "list");
		assert.ok(Array.isArray(stored));
		assert.equal(stored.length, 64);
		assert.equal(overflow, 937);
	} finally { scheduler.stop(); }
});

tests.test("1001 production remote updates retain bounded producers and eventually project every body", async () => {
	const state = await fixture();
	for (const document of state.documents.values()) document.destroy();
	state.documents.clear();
	state.files.clear();
	state.bindings.clear();
	const base = "before\n";
	const bodyContent = "remote\n";
	const baseHash = await contentBaselineHash(base);
	const diskIndex: DiskIndex = {};
	for (let index = 0; index < 1001; index++) {
		const path = `Flood-${index}.md`;
		const bodyId = `flood-body-${index}`;
		state.files.set(path, Object.assign(new TFile(), { path, content: base, stat: { ctime: 1, mtime: 1, size: base.length } }));
		state.bindings.set(path, bodyId);
		const document = new Y.Doc({ guid: bodyId });
		document.getText("body").insert(0, bodyContent);
		state.documents.set(bodyId, document);
		state.coordinator.ensure(bodyId);
		state.coordinator.setResidency(bodyId, "warm");
		diskIndex[path] = { mtime: 1, size: base.length, contentHash: baseHash };
		setCurrentContentHash(diskIndex[path], baseHash);
	}
	state.coordinator.replacePathBindings(state.bindings);
	Object.assign(state.runtime, { pathToId: state.bindings });
	state.mirror.configureSettlement({ getBaseline: () => ({ contentHash: baseHash }), commitLocalBody: async () => { assert.fail("remote projection must never import disk"); } });
	const controller = new ReconciliationController({
		app: state.app, reconciliationWorker: state.mirror.getReconciliationWorker(),
		getSettings: () => ({ deviceName: "Test" }) as never,
		getRuntimeConfig: () => ({ externalEditPolicy: "always", maxFileSizeBytes: 0 }) as never,
		getVaultSync: () => state.runtime, getDiskMirror: () => state.mirror, getBlobSync: () => null,
		getEditorBindings: () => null, getDiskIndex: () => diskIndex, setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {}, validateOpenEditorBindings: () => {}, onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false, setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {}, refreshStatusBar: () => {}, trace: () => {}, scheduleTraceStateSnapshot: () => {}, log: () => {},
	});
	state.mirror.setDiskMovedBeforeWriteHandler((path) => controller.handleDiskMovedBeforeWrite(path));
	try {
		for (const path of state.bindings.keys()) controller.scheduleRemoteBodyMaterialization(path);
		assert.equal(probeCollectionSize(controller, "remoteMaterializeTimers"), 64);
		const sweepPending: unknown = Reflect.get(controller, "remoteMaterializeSweepPending");
		assert.equal(sweepPending, true);
		await until(() => {
			const timerCount = probeCollectionSize(controller, "remoteMaterializeTimers");
			const activeCount = probeCollectionSize(controller, "remoteMaterializeActive");
			assert.ok(timerCount + activeCount <= 64);
			assert.ok(activeCount <= 1);
			const snapshot = state.mirror.getDebugSnapshot();
			assert.ok(snapshot.debounceCount + snapshot.openDebounceCount + snapshot.queuedWrites.length <= 64);
			assert.ok(state.mirror.getReconciliationWorker().diagnostics().queued <= 64);
			return new Set(state.writes).size === 1001;
		}, { timeoutMs: 25_000, intervalMs: 20, message: "every bounded remote projection progresses" });
		assert.ok([...state.files.values()].every((file) => file.content === bodyContent));
	} finally { callProbeMethod(probeObject(controller, "markdownAdmission"), "stop"); controller.reset(); await state.close(); }
});

await tests.done();
