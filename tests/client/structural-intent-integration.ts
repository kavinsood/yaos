import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import WebSocket from "ws";
import type * as StructuralApi from "../../src/sync/structuralIntent";
import type { VaultIndexedDb, schema8VaultIdbName } from "../../src/sync/vaultIndexedDb";
import type { exactMarkdownDiskFingerprint } from "../../server/src/shared/markdownCodec";
import type { DiskMirror } from "../../src/sync/diskMirror";
import type { App, TFile } from "obsidian";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { suite } from "../harness";

const tests = suite("structural-intent-integration");
const root = new URL("../../", import.meta.url).pathname;

async function nativeScenario(api: {
	VaultIndexedDb: typeof VaultIndexedDb;
	schema8VaultIdbName: typeof schema8VaultIdbName;
	StructuralIntentRecovery: typeof StructuralApi.StructuralIntentRecovery;
	VaultIndexedDbStructuralIntentStore: typeof StructuralApi.VaultIndexedDbStructuralIntentStore;
	exactMarkdownDiskFingerprint: typeof exactMarkdownDiskFingerprint;
	DiskMirror: typeof DiskMirror;
	TFile: typeof TFile;
}): Promise<string[]> {
	const checked: string[] = [];
	const check = (condition: boolean, label: string) => { if (!condition) throw new Error(label); };
	const requestValue = <Value>(request: IDBRequest<Value>) => new Promise<Value>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const scope = { vaultId: "native-vault", vaultGeneration: "native-generation", accountId: "native-account", folderKey: "native-folder" };
	const name = api.schema8VaultIdbName(scope.vaultId, scope.vaultGeneration, scope.folderKey);
	const seed = indexedDB.open(name, 7);
	seed.onupgradeneeded = () => {
		for (const [store, keyPath] of [
			["documents", "documentId"], ["pendingCandidates", "candidateId"], ["lifecycleOperations", "operationId"],
			["outstanding", "bodyId"], ["bootstrapProgress", ""], ["feedCursor", ""], ["paths", ""],
			["recoveryState", ""], ["attachmentOperations", "mutation.operationId"], ["attachmentSequence", ""],
			["bodySettlements", "bodyId"], ["canvasCandidates", "candidateId"], ["canvasSettlements", "documentId"],
			["canvasLifecycle", "operationId"],
		]) seed.result.createObjectStore(store!, keyPath ? { keyPath } : undefined);
		seed.transaction!.objectStore("pendingCandidates").put({ candidateId: "preserved-candidate", payload: "must survive local schema bump" });
	};
	(await requestValue(seed)).close();
	let database = new api.VaultIndexedDb(scope.vaultId, scope.vaultGeneration, scope.folderKey, indexedDB);
	let store = new api.VaultIndexedDbStructuralIntentStore(database, scope);
	check((await store.list()).length === 0, "native store upgrade failed");
	const inspectDb = await requestValue(indexedDB.open(name));
	check(inspectDb.version === 8 && inspectDb.objectStoreNames.contains("structural-intents"), "minimal native schema upgrade failed");
	const candidate = await requestValue(inspectDb.transaction("pendingCandidates").objectStore("pendingCandidates").get("preserved-candidate")) as { payload: string };
	check(candidate.payload === "must survive local schema bump", "namespace/schema bump erased pending candidates");
	inspectDb.close();
	checked.push("native IDB version 7→8 preserves candidates and namespace");
	const contents = ["\uFEFFalpha\r\n", "βeta\n"];
	const plan: StructuralApi.StructuralRenamePlan = { operationId: "native-rename", scope, createdAt: 1,
		moves: await Promise.all(contents.map(async (expectedContent, index) => ({
			bodyId: `body-${index}`, from: ["alpha.md", "beta.md"][index]!, to: ["beta.md", "alpha.md"][index]!,
			staging: `.stage-${index}.md`, expectedContent, fingerprint: await api.exactMarkdownDiskFingerprint(expectedContent),
		}))),
	};
	await database.setMaterializedPaths(plan.moves.map((move) => ({ bodyId: move.bodyId, path: move.from })));
	const disk = new Map(plan.moves.map((move) => [move.from, move.expectedContent]));
	let moves = 0;
	let abortLedger = true;
	const mappingDurability: IDBTransactionDurability[] = [];
	const originalTransaction = IDBDatabase.prototype.transaction;
	IDBDatabase.prototype.transaction = function(this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
		const transaction = originalTransaction.apply(this, args);
		if (args[0] === "paths" && args[1] === "readwrite") {
			mappingDurability.push(transaction.durability);
			if (abortLedger) {
				const objectStore = transaction.objectStore.bind(transaction);
				let aborted = false;
				transaction.objectStore = (storeName) => {
					const target = objectStore(storeName);
					const put = target.put.bind(target);
					target.put = (...putArgs) => {
						const request = put(...putArgs);
						request.onsuccess = () => { if (!aborted) { aborted = true; transaction.abort(); } };
						return request;
					};
					return target;
				};
			}
		}
		return transaction;
	};
	const host: StructuralApi.StructuralIntentDiskHost = {
		inspect: async (path) => disk.has(path) ? { kind: "file", content: disk.get(path)! } : { kind: "missing" },
		moveIfMatches: async (input) => {
			const saved = await store.get(input.operationId);
			check(saved?.phase === (moves < 2 ? "staging" : "placing"), "placement began before native IDB phase commit");
			if (disk.get(input.from) !== input.expectedContent || disk.has(input.to)) return false;
			disk.set(input.to, input.expectedContent);
			disk.delete(input.from);
			moves++;
			return true;
		},
		completeBookkeeping: async (intent) => {
			await database.setMaterializedPaths(intent.moves.map((move) => ({ bodyId: move.bodyId, path: move.to })));
		},
	};
	const port: StructuralApi.StructuralIntentStore = {
		get: (operationId) => store.get(operationId), list: () => store.list(), put: (intent) => store.put(intent),
		delete: async (operationId) => {
			for (const move of plan.moves) check(await database.getMaterializedPath(move.bodyId) === move.to, "intent retired before durable path mapping");
			await store.delete(operationId);
		},
	};
	let recovery = new api.StructuralIntentRecovery(scope, port, host);
	try {
		await recovery.prepare(plan);
		check((await database.getPendingWorkSummary()).activeRecoveryOperations === 1, "pending structural work omitted from native summary");
		check(await database.getStructuralIntent({ ...scope, accountId: "other-account" }, plan.operationId) === null, "account scope leaked intent");
		let deletionRefused = false;
		try { await database.deleteDatabase(); } catch { deletionRefused = true; }
		check(deletionRefused, "native cache deletion erased pending work");
		checked.push("native IDB scoped CRUD and pending-work deletion fence");
		let ledgerRejected = false;
		try { await recovery.recover(plan.operationId); } catch { ledgerRejected = true; }
		check(ledgerRejected && moves === 4, "native aborted path ledger was not surfaced after safe placement");
		check((await store.get(plan.operationId))?.phase === "placing", "native aborted ledger retired intent");
		for (const move of plan.moves) check(await database.getMaterializedPath(move.bodyId) === move.from, "aborted native mapping transaction partially committed");
		checked.push("native phase commit precedes placement; aborted mapping transaction preserves intent and old ledger");
		await database.close();
		database = new api.VaultIndexedDb(scope.vaultId, scope.vaultGeneration, scope.folderKey, indexedDB);
		store = new api.VaultIndexedDbStructuralIntentStore(database, scope);
		check((await store.get(plan.operationId))?.phase === "placing", "native IDB handle reopen lost plan");
		checked.push("native IDB connection close/reopen retains full plan; not a process-crash claim");
		abortLedger = false;
		recovery = new api.StructuralIntentRecovery(scope, port, host);
		check((await recovery.recover(plan.operationId)).status === "completed" && moves === 4, "native ledger retry repeated moves or failed");
		check(mappingDurability.length === 2 && mappingDurability.every((durability) => durability === "strict"), "materialized mappings did not use strict durability");
		check(await store.get(plan.operationId) === null, "native completed intent remained");
		checked.push("strict native mapping commit precedes intent retirement; retry repeats no moves");
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		await database.close();
	}
	for (const variant of ["complete", "late-file", "revoked", "excluded"]) {
		database = new api.VaultIndexedDb(scope.vaultId, scope.vaultGeneration, scope.folderKey, indexedDB);
		store = new api.VaultIndexedDbStructuralIntentStore(database, scope);
		const files = new Map<string, { file: TFile; content: string }>();
		for (const move of plan.moves) files.set(move.from, {
			file: Object.assign(new api.TFile(), { path: move.from, extension: "md", stat: { mtime: 1, ctime: 1, size: move.fingerprint.bytes } }),
			content: move.expectedContent,
		});
		let renameCount = 0;
		let emittedFullPlan = false;
		let authorized = true;
		let injected = false;
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
				read: async (file: TFile) => {
					if (variant === "revoked") authorized = false;
					if (variant === "late-file" && renameCount === 2 && !injected) {
						injected = true;
						files.set("beta.md", { file: Object.assign(new api.TFile(), { path: "beta.md" }), content: "unknown external contents" });
					}
					const current = files.get(file.path);
					check(current?.file === file, "production host used stale file identity");
					return current!.content;
				},
			},
			fileManager: {
				renameFile: async (file: TFile, to: string) => {
					check(authorized && !files.has(to), "production host renamed over unknown file or after revocation");
					const saved = (await store.list())[0];
					check(saved?.phase === (renameCount < 2 ? "staging" : "placing"), "DiskMirror placement preceded durable intent phase");
					if (renameCount === 0) {
						if (!saved) throw new Error("normal writer moved before native IDB intent committed");
						check(saved.operationId !== plan.operationId && saved.moves.length === plan.moves.length,
							"normal writer relied on seeded intent instead of emitting its own full plan");
						check(JSON.stringify(saved.scope) === JSON.stringify(scope), "normal writer persisted the wrong account/vault scope");
						const stagingPaths = new Set(saved.moves.map((move) => move.staging));
						check(stagingPaths.size === plan.moves.length, "normal writer persisted duplicate staging paths");
						for (const move of saved.moves) {
							const expected = plan.moves.find((original) => original.bodyId === move.bodyId);
							check(expected !== undefined && move.from === expected.from && move.to === expected.to
								&& move.expectedContent === expected.expectedContent
								&& move.fingerprint.bytes === expected.fingerprint.bytes && move.fingerprint.hash === expected.fingerprint.hash,
								"normal writer persisted incorrect body/source/destination/exact-input mapping");
							check(plan.moves.every((original) => original.from !== move.staging && original.to !== move.staging),
								"normal writer staging path overlaps a source or destination");
							check(files.get(move.from)?.content === move.expectedContent,
								"a source was destructively moved before complete native IDB plan verification");
						}
						emittedFullPlan = true;
					}
					const entry = files.get(file.path)!;
					files.delete(file.path);
					file.path = to;
					files.set(to, entry);
					renameCount++;
				},
			},
		} as unknown as App;
		const runtime = {
			getFileId: (path: string) => plan.moves.find((move) => move.to === path)?.bodyId,
			markPendingRenameTarget: () => {}, clearPendingRenameTarget: () => {},
		} as unknown as VaultSync;
		const mirror = new api.DiskMirror(app, runtime, { isBound: () => false, updatePathsAfterRename: () => {} } as unknown as EditorBindingManager, false);
		mirror.configureStructuralRecovery({ scope, store, isSourceCurrent: () => authorized,
			isPathAllowed: (path) => variant !== "excluded" || path !== "beta.md",
			persistMaterializedPaths: (paths) => database.setMaterializedPaths(paths) });
		mirror.configureSettlement({
			getBaseline: () => ({ contentHash: null }),
			commitLocalBody: async () => {},
			isPathAllowed: (path) => !mirror.isStructuralPathPending(path),
		});
		try {
			check(mirror.isStructuralPathPending("alpha.md") && mirror.isStructuralPathPending("beta.md")
				&& mirror.isStructuralPathPending(".stage-0.md"), "pre-hydration recovery barrier omitted planned paths");
			check(await mirror.settleBody({ path: "beta.md", bodyId: "body-0", generation: 1, content: contents[0]! }) === "preserved-unresolved",
				"ordinary body settlement bypassed the pre-bootstrap recovery fence");
			check(renameCount === 0, "ordinary settlement moved files before recovery hydration");
			check((await store.list()).length === 0, "normal writer fixture already contained a seeded intent");
			if (variant === "revoked" || variant === "excluded") await store.put({ ...plan, operationId: `native-${variant}`, format: 1, kind: "rename-batch", phase: "staging" });
			let rejected = false;
			let results: StructuralApi.StructuralRecoveryResult[] = [];
			try {
				results = await mirror.recoverStructuralIntents();
				if (variant === "complete" || variant === "late-file") await mirror.moveBodies(plan.moves.map((move) => ({ bodyId: move.bodyId, from: move.from, to: move.to })));
			} catch { rejected = true; }
			if (variant === "complete") {
				check(!rejected && emittedFullPlan && renameCount === 4 && (await store.list()).length === 0, "production DiskMirror durable completion failed");
				for (const move of plan.moves) check(await database.getMaterializedPath(move.bodyId) === move.to, "production bookkeeping remained session-only");
			} else {
				check((rejected || results[0]?.status === "blocked") && (await store.list()).length === 1, "production host retired failed/revoked/excluded intent");
				check(mirror.isStructuralPathPending("alpha.md") && mirror.isStructuralPathPending("beta.md"), "blocked production paths were not fenced");
				for (const intent of await store.list()) {
					for (const move of intent.moves) check([move.from, move.staging, move.to].every((path) => mirror.isStructuralPathPending(path)),
						"restored durable plan omitted a source/staging/destination fence");
				}
				if (variant === "excluded") check(!mirror.isStructuralPathPending("unrelated.md"),
					"blocked replay never restored scoped path fences after hydration");
				if (variant === "late-file") check(files.get("beta.md")?.content === "unknown external contents" && renameCount === 2, "production host overwrote late unknown contents");
				else check(renameCount === 0 && files.get("alpha.md")?.content === contents[0], "revoked recovery moved old files");
				for (const intent of await store.list()) await store.delete(intent.operationId);
			}
		} finally { await database.close(); }
	}
	checked.push("normal DiskMirror writer emits its complete native IDB body/source/staging/destination plan before the first destructive move; no seeded writer intent");
	checked.push("pre-bootstrap hydration blocks ordinary settlement; blocked replay restores every stored source/staging/destination fence");
	checked.push("production DiskMirror with native IDB: durable completion, late-file preservation, authority revocation, and exclusion guards without pending-path self-fencing");
	return checked;
}

async function runNativeBrowser(executable: string): Promise<string[]> {
	const bundled = await build({
		stdin: { contents: `import {VaultIndexedDb,schema8VaultIdbName} from './src/sync/vaultIndexedDb';
import {StructuralIntentRecovery,VaultIndexedDbStructuralIntentStore} from './src/sync/structuralIntent';
import {exactMarkdownDiskFingerprint} from './server/src/shared/markdownCodec';
import {DiskMirror} from './src/sync/diskMirror';
import {TFile} from './tests/mocks/obsidian';
globalThis.nativeRun=(${nativeScenario.toString()})({VaultIndexedDb,schema8VaultIdbName,StructuralIntentRecovery,VaultIndexedDbStructuralIntentStore,exactMarkdownDiskFingerprint,DiskMirror,TFile});`,
			resolveDir: root, loader: "js" },
		bundle: true, write: false, platform: "browser", format: "iife",
		alias: { "@shared": join(root, "server/src/shared"), obsidian: join(root, "tests/mocks/obsidian.ts") },
	});
	const source = bundled.outputFiles[0]!.text;
	const server = createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(`<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const profile = await mkdtemp(join(tmpdir(), "yaos-native-idb-"));
	const browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
		"--disable-background-networking", "--disable-sync", "--remote-debugging-port=0", `--user-data-dir=${profile}`],
	{ stdio: ["ignore", "ignore", "pipe"] });
	let socket: WebSocket | null = null;
	try {
		const endpoint = await new Promise<string>((resolve, reject) => {
			let logs = "";
			const deadline = setTimeout(() => reject(new Error(`Native browser startup timed out: ${logs}`)), 15000);
			browser.once("error", (error) => { clearTimeout(deadline); reject(error); });
			browser.stderr!.on("data", (data: Buffer) => {
				logs += data.toString();
				const matched = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);
				if (matched) { clearTimeout(deadline); resolve(matched[1]!); }
			});
		});
		const debuggerOrigin = new URL(endpoint).origin.replace("ws:", "http:");
		const target = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
		socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
		const results = await new Promise<string[]>((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error("Native IDB integration test timed out")), 20000);
			socket!.on("message", (bytes) => {
				const response = JSON.parse(bytes.toString()) as {
					id?: number; method?: string; error?: unknown;
					result?: { exceptionDetails?: unknown; result?: { value?: string[]; description?: string } };
				};
				if (response.id === 100) socket!.send(JSON.stringify({ id: 101, method: "Page.navigate", params: { url: `http://127.0.0.1:${address.port}` } }));
				if (response.method === "Page.loadEventFired") socket!.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
					expression: "new Promise(resolve => { const awaitRun = () => globalThis.nativeRun ? resolve(globalThis.nativeRun) : setTimeout(awaitRun, 10); awaitRun(); })",
					awaitPromise: true, returnByValue: true,
				} }));
				if (response.id !== 1) return;
				clearTimeout(deadline);
				if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)));
				else if (response.result?.result?.value) resolve(response.result.result.value);
				else reject(new Error(`Missing native IDB result: ${JSON.stringify(response)}`));
			});
			socket!.send(JSON.stringify({ id: 100, method: "Page.enable" }));
		});
		return results;
	} finally {
		socket?.close();
		if (browser.exitCode === null && browser.signalCode === null) {
			await new Promise<void>((resolve) => {
				const deadline = setTimeout(() => browser.kill("SIGKILL"), 3000);
				browser.once("exit", () => { clearTimeout(deadline); resolve(); });
				browser.kill("SIGTERM");
			});
		}
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(profile, { recursive: true, force: true });
	}
}

const executable = process.env.YAOS_STRUCTURAL_NATIVE_IDB_BROWSER;
tests.test("path ledger uses strict transaction completion and recovery retires only after bookkeeping", async () => {
	const database = await readFile(join(root, "src/sync/vaultIndexedDb.ts"), "utf8");
	const mapping = database.slice(database.indexOf("async setMaterializedPaths("), database.indexOf("async listMaterializedPaths("));
	assert.match(mapping, /db\.transaction\(PATHS, "readwrite", \{ durability: "strict" \}\)/);
	assert.ok(mapping.indexOf("transactionDone(transaction)") < mapping.indexOf("store.put("));
	assert.ok(mapping.indexOf("await done") > mapping.indexOf("store.put("));
	const recovery = await readFile(join(root, "src/sync/structuralIntent.ts"), "utf8");
	assert.ok(recovery.indexOf("await this.host.completeBookkeeping(") < recovery.indexOf("await this.store.delete(operationId)"));
	const disk = await readFile(join(root, "src/sync/diskMirror.ts"), "utf8");
	const staged = disk.indexOf("await port!.staged(plan)");
	assert.ok(staged >= 0 && staged < disk.indexOf("move.temporaryPath, move.to, move.expectedContent"));
});
tests.test("production main installs exact current-authority guard and recovers before bootstrap settlement", async () => {
	const main = await readFile(join(root, "src/main.ts"), "utf8");
	const configure = main.indexOf("this.diskMirror.configureStructuralRecovery({");
	const recover = main.indexOf("await this.diskMirror.recoverStructuralIntents()");
	const bootstrap = main.indexOf("await bootstrap.run()");
	assert.ok(configure >= 0 && configure < recover && recover < bootstrap);
	const adapter = main.slice(configure, main.indexOf("this.diskMirror.configureSettlement({", configure));
	assert.match(adapter, /new VaultIndexedDbStructuralIntentStore\(database, structuralScope\)/);
	assert.match(adapter, /this\.vaultSync === runtime && this\.vaultDatabase === database/);
	assert.match(adapter, /this\.authorityCoordinator\.current\.state === "active"/);
	assert.match(adapter, /sameAuthorityIdentity\(structuralAuthority, this\.authorityCoordinator\.current\.authority\)/);
	assert.match(adapter, /persistMaterializedPaths: \(moves\) => database\.setMaterializedPaths\(moves\)/);
	assert.match(main, /return !this\.diskMirror\?\.isStructuralPathPending\(path\)/);
});
if (executable) {
	tests.test("real browser IndexedDB schema preservation, transactional mapping failure, and recovery retirement", async () => {
		const verified = await runNativeBrowser(executable);
		assert.equal(verified.length, 8);
		for (const label of verified) console.log(`  NATIVE-IDB ${label}`);
	});
} else {
	console.log("Native browser-IDB verification not run: set YAOS_STRUCTURAL_NATIVE_IDB_BROWSER to a Chromium executable.");
}

await tests.done();
