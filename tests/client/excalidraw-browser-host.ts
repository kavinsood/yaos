import { strict as assert } from "node:assert";
import { BrowserExcalidrawHost, type BrowserExcalidrawApi } from "../../src/sync/excalidraw/browserHost";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "../../src/sync/excalidraw/types";
import type { ExcalidrawHostSnapshot } from "../../src/sync/excalidraw/host";
import { suite } from "../harness.ts";

const s = suite("excalidraw-browser-host");

function element(version: number, nonce = 10): ExcalidrawElementRecord {
	return { id: "element1", version, versionNonce: nonce, isDeleted: false, index: "a0", type: "rectangle" };
}

class Api implements BrowserExcalidrawApi {
	elements: ExcalidrawElementRecord[] = [element(1)];
	files: Record<string, ExcalidrawNativeFile> = {};
	updates: Array<Record<string, unknown>> = [];
	onUpdate: (() => void) | null = null;
	getSceneElementsIncludingDeleted() { return this.elements; }
	getFiles() { return this.files; }
	getAppState() { return { selectedElementIds: { element1: true }, scrollX: 1, scrollY: 2,
		zoom: { value: 1 }, width: 800, height: 600 }; }
	addFiles(files: readonly ExcalidrawNativeFile[]) { for (const file of files) this.files[file.id] = file; }
	updateScene(scene: { elements?: readonly ExcalidrawElementRecord[] }): void {
		this.updates.push(scene as Record<string, unknown>);
		if (scene.elements) this.elements = structuredClone([...scene.elements]);
		this.onUpdate?.();
	}
}

s.test("remote updateScene echo is tagged exactly once without muting the next local revision", async () => {
	const captures: ExcalidrawHostSnapshot[] = [];
	const host = new BrowserExcalidrawHost("public-drawing", {
		onSceneChange: (snapshot) => { captures.push(snapshot); },
		onDegraded: (reason) => { throw new Error(reason); },
	});
	const api = new Api();
	host.bindApi(api);
	api.onUpdate = () => host.handleSceneChange(api.elements, api.getAppState(), api.getFiles());
	await host.apply([element(2)], [], "public-drawing");
	await host.drainCallbacks();
	assert.equal(captures.length, 1);
	assert.equal(captures[0]!.suppressedRevisionKeys.size, 1);
	api.elements = [element(3)];
	host.handleSceneChange(api.elements, api.getAppState(), api.getFiles());
	await host.drainCallbacks();
	assert.equal(captures.length, 2);
	assert.equal(captures[1]!.suppressedRevisionKeys.size, 0);
	assert.equal((api.updates[0] as { captureUpdate?: string }).captureUpdate, "NEVER");
});

s.test("read-only browser drops local durable capture but still consumes a remote echo", async () => {
	const captures: ExcalidrawHostSnapshot[] = [];
	const host = new BrowserExcalidrawHost("public-drawing", {
		onSceneChange: (snapshot) => { captures.push(snapshot); },
		onDegraded: (reason) => { throw new Error(reason); },
	}, { writable: false });
	const api = new Api();
	host.bindApi(api);
	host.handleSceneChange([element(2)], {}, {});
	await host.drainCallbacks();
	assert.equal(captures.length, 0);
	api.onUpdate = () => host.handleSceneChange(api.elements, {}, {});
	await host.apply([element(3)], [], "public-drawing");
	await host.drainCallbacks();
	assert.equal(captures.length, 1);
	assert.equal(captures[0]!.suppressedRevisionKeys.size, 1);
});

s.test("audience-safe guests render through native collaborator state without principal identity", () => {
	const host = new BrowserExcalidrawHost("public-drawing", { onSceneChange: () => {}, onDegraded: () => {} });
	const api = new Api();
	host.bindApi(api);
	assert.equal(host.applyAudienceSafePresence([{
		sessionId: "session1",
		identity: { participantId: "participant1", kind: "guest", displayName: "Guest",
			color: "hsl(1, 72%, 52%)", colorLight: "hsla(1, 72%, 52%, 0.2)" },
		presence: { pointer: { x: 4, y: 5, tool: "pointer", button: "down" }, selectedElementIds: [],
			activeElementId: null, interaction: "pointing", viewport: null, followSessionId: null, idle: false },
	}]), true);
	const collaborators = (api.updates[0] as { collaborators: Map<string, { id?: string; username: string }> }).collaborators;
	assert.equal(collaborators.get("session1")?.username, "Guest");
	assert.equal(collaborators.get("session1")?.id, undefined);
});

await s.done();
