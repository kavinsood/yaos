import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { ObsidianExcalidrawHostAdapter } from "../../src/host/obsidianExcalidrawHostAdapter";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "../../src/sync/excalidraw/types";
import { suite } from "../harness.ts";

const s = suite("obsidian-excalidraw-host-adapter");

function element(version: number, nonce: number, isDeleted = false, text = "value"): ExcalidrawElementRecord {
	return { id: "element1", type: "rectangle", version, versionNonce: nonce, isDeleted, index: "a0", text };
}

function fixture(withHook = true, withNativeChange = false) {
	const order: string[] = [];
	const file = { path: "Drawing.md" };
	let elements = [element(1, 10)];
	let files: Record<string, ExcalidrawNativeFile> = {};
	let appState: Record<string, unknown> = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: 800, height: 600 };
	let addGate: Promise<void> | null = null;
	const collaboratorUpdates: Array<Map<string, unknown>> = [];
	const pointerCalls: unknown[] = [];
	const nativeChangeListeners = new Set<(elements: readonly unknown[], appState: Record<string, unknown>,
		files: Record<string, unknown>) => void>();
	const api = {
		getSceneElementsIncludingDeleted: () => elements,
		getFiles: () => files,
		getAppState: () => appState,
		...(withNativeChange ? { onChange(callback: (elements: readonly unknown[], state: Record<string, unknown>,
			currentFiles: Record<string, unknown>) => void) {
			nativeChangeListeners.add(callback);
			return () => nativeChangeListeners.delete(callback);
		} } : {}),
		updateScene(input: { collaborators: Map<string, unknown> }) { collaboratorUpdates.push(input.collaborators); },
		async addFiles(input: { files: ExcalidrawNativeFile[] }) {
			order.push(`files:${input.files.length}`);
			await addGate;
			files = Object.fromEntries(input.files.map((value) => [value.id, value]));
		},
	};
	const view = {
		file,
		excalidrawAPI: api,
		getViewType: () => "excalidraw",
		onPointerUpdate(payload: unknown) { pointerCalls.push(payload); },
		async updateScene(input: { elements: ExcalidrawElementRecord[]; captureUpdate: string }) {
			order.push(`scene:${input.captureUpdate}`);
			elements = input.elements;
		},
	};
	const leaf = { view };
	const previousCalls: unknown[][] = [];
	const previousHook: { trackElements: boolean; appStateKeys?: string[]; callback: (...args: unknown[]) => unknown } = {
		trackElements: true, callback: (...args: unknown[]) => previousCalls.push(args),
	};
	const ea: { onSceneChangeHook?: typeof previousHook | null } = withHook ? { onSceneChangeHook: previousHook } : {};
	const app = { workspace: { getLeavesOfType: () => [leaf] }, plugins: {
		getPlugin: () => ({ ea }), plugins: {},
	} };
	return { app, ea, leaf, view, api, file, order, previousCalls, previousHook, collaboratorUpdates, pointerCalls,
		emitNativeChange() { for (const listener of nativeChangeListeners) listener(elements, appState, files); },
		nativeChangeListenerCount() { return nativeChangeListeners.size; },
		setElements(value: ExcalidrawElementRecord[]) { elements = value; },
		setAppState(value: Record<string, unknown>) { appState = value; },
		setAddGate(value: Promise<void> | null) { addGate = value; } };
}

s.test("discovers capability support, chains the existing hook, and snapshots tombstones from the API", async () => {
	const value = fixture();
	const captures: import("../../src/host/obsidianExcalidrawHostAdapter").ExcalidrawHostSnapshot[] = [];
	const adapter = new ObsidianExcalidrawHostAdapter(value.app as never);
	assert.deepEqual(adapter.discoverLeaves(), [value.leaf]);
	assert.equal(adapter.capabilities(value.leaf as never).realtime, true);
	const binding = adapter.bind(value.leaf as never, { onSceneChange: (snapshot) => { captures.push(snapshot); }, onDegraded: () => {} });
	value.setElements([element(2, 20, true)]);
	value.ea.onSceneChangeHook?.callback([], {}, {}, value.view as never, {});
	await delay(20);
	assert.equal(value.previousCalls.length, 1, "pre-existing consumer remains chained");
	assert.equal(captures[0]?.elements[0]?.isDeleted, true, "hook array is not trusted as tombstone authority");
	binding.release();
	assert.equal(value.ea.onSceneChangeHook, value.previousHook, "the exact prior hook is restored");
});

s.test("prefers the per-view native change subscription over the inert automation hook", async () => {
	const value = fixture(true, true);
	const captures: import("../../src/host/obsidianExcalidrawHostAdapter").ExcalidrawHostSnapshot[] = [];
	const adapter = new ObsidianExcalidrawHostAdapter(value.app as never);
	const binding = adapter.bind(value.leaf as never, {
		onSceneChange: (snapshot) => { captures.push(snapshot); },
		onDegraded: () => {},
	});
	assert.equal(value.ea.onSceneChangeHook, value.previousHook, "native capture does not replace the global automation hook");
	assert.equal(value.nativeChangeListenerCount(), 1);
	value.setElements([element(2, 20, true)]);
	value.emitNativeChange();
	await delay(20);
	assert.equal(captures[0]?.elements[0]?.isDeleted, true);
	binding.release();
	assert.equal(value.nativeChangeListenerCount(), 0, "release unsubscribes the exact view listener");
});

s.test("adds current-fork files before one NEVER apply and suppresses only the exact remote winner", async () => {
	const value = fixture();
	const captures: import("../../src/host/obsidianExcalidrawHostAdapter").ExcalidrawHostSnapshot[] = [];
	const adapter = new ObsidianExcalidrawHostAdapter(value.app as never);
	const binding = adapter.bind(value.leaf as never, { onSceneChange: (snapshot) => { captures.push(snapshot); }, onDegraded: () => {} });
	const binary: ExcalidrawNativeFile = { id: "resource1", dataURL: "data:image/png;base64,YQ==",
		mimeType: "image/png", created: 1 };
	const remote = element(2, 20, false, "remote");
	assert.equal(await binding.apply([remote], [binary], "Drawing.md"), true);
	value.ea.onSceneChangeHook?.callback([remote], {}, {}, value.view as never, {});
	await delay(20);
	assert.deepEqual(value.order, ["files:1", "scene:NEVER"]);
	assert.equal(captures[0]?.suppressedRevisionKeys.size, 1);
	value.setElements([element(3, 30, false, "local")]);
	value.ea.onSceneChangeHook?.callback([], {}, {}, value.view as never, {});
	await delay(20);
	assert.equal(captures[1]?.suppressedRevisionKeys.size, 0, "a later local revision is never hidden");
	binding.release();
});

s.test("an interleaved local edit defeats exact suppression and async file/view reuse fences apply", async () => {
	const value = fixture();
	const captures: import("../../src/host/obsidianExcalidrawHostAdapter").ExcalidrawHostSnapshot[] = [];
	const adapter = new ObsidianExcalidrawHostAdapter(value.app as never);
	const binding = adapter.bind(value.leaf as never, { onSceneChange: (snapshot) => { captures.push(snapshot); }, onDegraded: () => {} });
	const remote = element(2, 20, false, "remote");
	await binding.apply([remote], [], "Drawing.md");
	value.setElements([element(3, 30, false, "local-between-apply-and-hook")]);
	value.ea.onSceneChangeHook?.callback([], {}, {}, value.view as never, {});
	await delay(20);
	assert.equal(captures[0]?.suppressedRevisionKeys.size, 0);

	let releaseFiles = () => {};
	value.setAddGate(new Promise<void>((resolve) => { releaseFiles = resolve; }));
	const pending = binding.apply([element(4, 40)], [{ id: "resource1", dataURL: "data:image/png;base64,YQ==",
		mimeType: "image/png", created: 1 }], "Drawing.md");
	await Promise.resolve();
	value.view.file = { path: "Other.md" };
	releaseFiles();
	assert.equal(await pending, false);
	assert.equal(value.order.filter((entry) => entry.startsWith("scene:")).length, 1,
		"view identity changes after addFiles prevent scene application");
	binding.release();
});

s.test("takes the complete scene snapshot at each hook boundary before asynchronous hashing", async () => {
	const value = fixture();
	const versions: number[] = [];
	const adapter = new ObsidianExcalidrawHostAdapter(value.app as never);
	const binding = adapter.bind(value.leaf as never, { onSceneChange: (snapshot) => {
		versions.push(snapshot.elements[0]?.version ?? 0);
	}, onDegraded: () => {} });
	value.setElements([element(2, 20)]);
	value.ea.onSceneChangeHook?.callback([], {}, {}, value.view as never, {});
	value.setElements([element(3, 30)]);
	value.ea.onSceneChangeHook?.callback([], {}, {}, value.view as never, {});
	await delay(20);
	assert.deepEqual(versions, [2, 3]);
	binding.release();
});

s.test("missing supported hook fails closed as attachment-only", () => {
	const value = fixture(false);
	const degraded: string[] = [];
	const adapter = new ObsidianExcalidrawHostAdapter(value.app as never);
	assert.equal(adapter.capabilities(value.leaf as never).realtime, false);
	adapter.bind(value.leaf as never, { onSceneChange: () => {}, onDegraded: (reason) => degraded.push(reason) });
	assert.match(degraded[0] ?? "", /upgrade/);
});

s.test("captures pointer and app-state presence, renders collaborators, and restores the exact view method", async () => {
	const value = fixture();
	const originalPointerUpdate = value.view.onPointerUpdate;
	const presence: import("../../src/host/obsidianExcalidrawHostAdapter").ExcalidrawHostPresence[] = [];
	const adapter = new ObsidianExcalidrawHostAdapter(value.app as never);
	const binding = adapter.bind(value.leaf as never, { onSceneChange: () => {},
		onPresenceChange: (state) => presence.push(state), onDegraded: () => {} });
	value.setAppState({ scrollX: 10, scrollY: 20, zoom: { value: 2 }, width: 900, height: 700,
		selectedElementIds: { element1: true }, editingElement: { id: "element1" },
		userToFollow: { socketId: "session-follow" } });
	value.view.onPointerUpdate({ pointer: { x: 30, y: 40, tool: "laser", laserColor: "#f00" }, button: "down" });
	assert.equal(value.pointerCalls.length, 1, "the original plugin handler runs first");
	assert.deepEqual(presence.at(-1), { pointer: { x: 30, y: 40, tool: "laser", button: "down", laserColor: "#f00" },
		selectedElementIds: ["element1"], activeElementId: "element1", interaction: "editing",
		viewport: { scrollX: 10, scrollY: 20, zoom: 2, width: 900, height: 700 },
		followSessionId: "session-follow", idle: false });
	value.ea.onSceneChangeHook?.callback([], value.api.getAppState(), {}, value.view as never, {});
	await delay(10);
	assert.ok(value.ea.onSceneChangeHook?.appStateKeys?.includes("selectedElementIds"));
	assert.ok(value.ea.onSceneChangeHook?.appStateKeys?.includes("userToFollow"));
	assert.equal(binding.applyPresence?.([{ sessionId: "session-remote", displayName: "Alice",
		color: "hsl(12, 72%, 52%)", colorLight: "hsla(12, 72%, 52%, 0.2)", principalId: "principal-alice",
		presence: { pointer: { x: 5, y: 6, tool: "pointer", button: "up" }, selectedElementIds: ["element1"],
			activeElementId: null, interaction: "pointing", viewport: null, followSessionId: null, idle: false } }]), true);
	const collaborator = value.collaboratorUpdates.at(-1)?.get("session-remote") as Record<string, unknown>;
	assert.equal(collaborator.username, "Alice");
	assert.deepEqual(collaborator.selectedElementIds, { element1: true });
	binding.release();
	assert.equal(value.view.onPointerUpdate, originalPointerUpdate, "detach restores only YAOS's installed wrapper");
});

await s.done();
