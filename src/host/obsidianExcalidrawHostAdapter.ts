import type { App, TFile, WorkspaceLeaf } from "obsidian";
import { revisionKey, revisionOf, validateExcalidrawElement } from "../sync/excalidraw/canonical";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "../sync/excalidraw/types";
import type {
	ExcalidrawHostCapabilities,
	ExcalidrawHostCollaborator,
	ExcalidrawHostPointer,
	ExcalidrawHostPresence,
	ExcalidrawHostSnapshot,
	ExcalidrawViewBinding,
	ExcalidrawViewCallbacks,
	ExcalidrawViewProof,
} from "../sync/excalidraw/host";

export type {
	ExcalidrawHostCapabilities,
	ExcalidrawHostCollaborator,
	ExcalidrawHostPointer,
	ExcalidrawHostPresence,
	ExcalidrawHostRemotePresence,
	ExcalidrawHostSnapshot,
	ExcalidrawViewBinding,
	ExcalidrawViewCallbacks,
	ExcalidrawViewProof,
} from "../sync/excalidraw/host";

const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

type SceneHook = {
	appStateKeys?: string[];
	trackElements?: boolean;
	triggerWhenInvisible?: boolean;
	callback: (elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>,
		view: ExcalidrawView, automate: unknown) => void;
};

type ExcalidrawAutomate = { onSceneChangeHook?: SceneHook | null };
type ExcalidrawPlugin = { ea?: ExcalidrawAutomate };
type ExcalidrawApi = {
	getSceneElementsIncludingDeleted?: () => readonly unknown[];
	getFiles?: () => Record<string, unknown>;
	getAppState?: () => Record<string, unknown>;
	onChange?: (callback: (elements: readonly unknown[], appState: Record<string, unknown>,
		files: Record<string, unknown>) => void) => (() => void);
	addFiles?: (input: { files: ExcalidrawNativeFile[] }) => unknown;
	updateScene?: (scene: { collaborators: Map<string, ExcalidrawHostCollaborator> }) => unknown;
};
type PointerUpdate = {
	pointer?: { x?: unknown; y?: unknown; tool?: unknown; laserColor?: unknown };
	button?: unknown;
};
type ExcalidrawView = {
	file?: TFile | null;
	excalidrawAPI?: ExcalidrawApi | null;
	getViewType?: () => string;
	updateScene?: (scene: { elements: ExcalidrawElementRecord[]; captureUpdate: "NEVER" }, shouldRestore?: boolean) => unknown;
	onPointerUpdate?: (payload: PointerUpdate) => unknown;
};

type RegisteredBinding = {
	view: ExcalidrawView;
	released: boolean;
	onHook(appState: Record<string, unknown>): void;
	restore(): void;
};

const PRESENCE_APP_STATE_KEYS = ["selectedElementIds", "editingElement", "draggingElement", "scrollX", "scrollY", "zoom",
	"width", "height", "userToFollow"];

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringId(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
	if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
		return stringId((value as { id: string }).id);
	}
	return null;
}

function selectionOf(appState: Record<string, unknown>): string[] {
	const selected = appState.selectedElementIds;
	if (!selected || typeof selected !== "object" || Array.isArray(selected)) return [];
	return Object.entries(selected).filter(([, value]) => value === true).map(([id]) => id).slice(0, 256);
}

function zoomOf(value: unknown): number | null {
	const direct = finite(value);
	if (direct !== null) return direct;
	return value && typeof value === "object" ? finite((value as { value?: unknown }).value) : null;
}

function presenceFromAppState(appState: Record<string, unknown>, pointer: ExcalidrawHostPointer | null): ExcalidrawHostPresence {
	const editing = stringId(appState.editingElement);
	const dragging = stringId(appState.draggingElement);
	const scrollX = finite(appState.scrollX);
	const scrollY = finite(appState.scrollY);
	const zoom = zoomOf(appState.zoom);
	const width = finite(appState.width);
	const height = finite(appState.height);
	const following = appState.userToFollow && typeof appState.userToFollow === "object"
		? stringId((appState.userToFollow as { socketId?: unknown }).socketId) : null;
	return {
		pointer,
		selectedElementIds: selectionOf(appState),
		activeElementId: editing ?? dragging,
		interaction: editing ? "editing" : dragging ? "dragging" : pointer ? "pointing" : "idle",
		viewport: scrollX !== null && scrollY !== null && zoom !== null && width !== null && height !== null
			? { scrollX, scrollY, zoom, width, height } : null,
		followSessionId: following,
		idle: !editing && !dragging && !pointer,
	};
}

function pluginOf(app: App): ExcalidrawPlugin | null {
	const plugins = (app as unknown as { plugins?: { getPlugin?: (id: string) => unknown;
		plugins?: Record<string, unknown> } }).plugins;
	return (plugins?.getPlugin?.(EXCALIDRAW_PLUGIN_ID) ?? plugins?.plugins?.[EXCALIDRAW_PLUGIN_ID] ?? null) as ExcalidrawPlugin | null;
}

function viewOf(leaf: WorkspaceLeaf): ExcalidrawView | null {
	const view = leaf.view as unknown as ExcalidrawView;
	return view?.getViewType?.() === "excalidraw" ? view : null;
}

function capabilities(plugin: ExcalidrawPlugin | null, view: ExcalidrawView | null): ExcalidrawHostCapabilities {
	const detect = view !== null;
	const sceneHook = typeof view?.excalidrawAPI?.onChange === "function"
		|| (!!plugin?.ea && "onSceneChangeHook" in plugin.ea);
	const readIncludingDeleted = typeof view?.excalidrawAPI?.getSceneElementsIncludingDeleted === "function";
	const applyNever = typeof view?.updateScene === "function";
	const readFiles = typeof view?.excalidrawAPI?.getFiles === "function";
	const addFiles = typeof view?.excalidrawAPI?.addFiles === "function";
	const realtime = detect && sceneHook && readIncludingDeleted && applyNever && readFiles && addFiles;
	let reason: string | null = null;
	if (!detect) reason = "not an Excalidraw view";
	else if (!sceneHook) reason = "Obsidian Excalidraw scene-change APIs are unavailable; upgrade to 2.26.0 or later";
	else if (!readIncludingDeleted) reason = "complete scene snapshots including tombstones are unavailable";
	else if (!applyNever) reason = "remote scene application with CaptureUpdateAction.NEVER is unavailable";
	else if (!readFiles || !addFiles) reason = "binary resource APIs are unavailable";
	return { detect, sceneHook, readIncludingDeleted, applyNever, readFiles, addFiles, realtime, reason };
}

function nativeFiles(value: Record<string, unknown>): ExcalidrawNativeFile[] {
	const files: ExcalidrawNativeFile[] = [];
	for (const unknownFile of Object.values(value)) {
		if (!unknownFile || typeof unknownFile !== "object") continue;
		const file = unknownFile as Partial<ExcalidrawNativeFile>;
		if (typeof file.id !== "string" || typeof file.dataURL !== "string" || typeof file.mimeType !== "string"
			|| !Number.isSafeInteger(file.created) || (file.created as number) < 0) continue;
		files.push({ ...(unknownFile as ExcalidrawNativeFile) });
	}
	return files;
}

/** Supported-hook boundary for Obsidian Excalidraw; unsupported versions remain attachment-only. */
export class ObsidianExcalidrawHostAdapter {
	private readonly bindings = new Set<RegisteredBinding>();
	private installedHook: SceneHook | null = null;
	private previousHook: SceneHook | null = null;

	constructor(private readonly app: App) {}

	discoverLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType("excalidraw");
	}

	capabilities(leaf: WorkspaceLeaf): ExcalidrawHostCapabilities {
		return capabilities(pluginOf(this.app), viewOf(leaf));
	}

	bind(leaf: WorkspaceLeaf, callbacks: ExcalidrawViewCallbacks): ExcalidrawViewBinding {
		const view = viewOf(leaf);
		const plugin = pluginOf(this.app);
		const initialCapabilities = capabilities(plugin, view);
		let released = false;
		let pointer: ExcalidrawHostPointer | null = null;
		const originalPointerUpdate = view?.onPointerUpdate;
		let installedPointerUpdate: ExcalidrawView["onPointerUpdate"] | null = null;
		let unsubscribeSceneChange: (() => void) | null = null;
		const expectedRemoteRevisions = new Map<string, string>();
		let captureWork = Promise.resolve();
		const proof = (): ExcalidrawViewProof | null => {
			const file = view?.file;
			if (released || !view || leaf.view !== view || !file) return null;
			return { leaf, view, file, path: file.path };
		};
		const captureRaw = (): Omit<ExcalidrawHostSnapshot, "suppressedRevisionKeys"> | null => {
			const before = proof();
			const api = view?.excalidrawAPI;
			if (!before || typeof api?.getSceneElementsIncludingDeleted !== "function" || typeof api.getFiles !== "function") return null;
			let elements: ExcalidrawElementRecord[];
			try { elements = api.getSceneElementsIncludingDeleted().map(validateExcalidrawElement); }
			catch { callbacks.onDegraded("live Excalidraw scene contains an unsupported or invalid record"); return null; }
			const after = proof();
			if (!after || after.file !== before.file) return null;
			return { proof: after, elements, files: nativeFiles(api.getFiles()) };
		};
		const snapshot = async (consumeExpected = false,
			raw: Omit<ExcalidrawHostSnapshot, "suppressedRevisionKeys"> | null = captureRaw()): Promise<ExcalidrawHostSnapshot | null> => {
			if (!raw) return null;
			const suppressed = new Set<string>();
			const seen = new Set<string>();
			for (const element of raw.elements) {
				const key = revisionKey(await revisionOf(element));
				seen.add(element.id);
				const expected = consumeExpected ? expectedRemoteRevisions.get(element.id) : undefined;
				if (!expected) continue;
				expectedRemoteRevisions.delete(element.id);
				if (expected === key) suppressed.add(key);
			}
			for (const elementId of expectedRemoteRevisions.keys()) if (consumeExpected && !seen.has(elementId)) {
				expectedRemoteRevisions.delete(elementId);
			}
			return { ...raw, suppressedRevisionKeys: suppressed };
		};
		const emitPresence = (appState: Record<string, unknown>, source: "pointer" | "scene") => callbacks.onPresenceChange?.(
			presenceFromAppState(appState, pointer), source);
		if (view && typeof originalPointerUpdate === "function" && callbacks.onPresenceChange) {
			installedPointerUpdate = function wrappedPointerUpdate(this: ExcalidrawView, payload: PointerUpdate) {
				const result = originalPointerUpdate.call(this, payload);
				const x = finite(payload.pointer?.x);
				const y = finite(payload.pointer?.y);
				if (x !== null && y !== null) {
					const tool = payload.pointer?.tool === "laser" ? "laser" : "pointer";
					pointer = { x, y, tool, button: payload.button === "down" ? "down" : "up",
						...(tool === "laser" && typeof payload.pointer?.laserColor === "string"
							? { laserColor: payload.pointer.laserColor } : {}) };
				} else pointer = null;
				emitPresence(view.excalidrawAPI?.getAppState?.() ?? {}, "pointer");
				return result;
			};
			view.onPointerUpdate = installedPointerUpdate;
		}
		const registered: RegisteredBinding = { view: view ?? {}, released: false,
			restore: () => {
				unsubscribeSceneChange?.();
				unsubscribeSceneChange = null;
				if (view?.onPointerUpdate === installedPointerUpdate) view.onPointerUpdate = originalPointerUpdate;
			},
			onHook: (appState) => {
			const raw = captureRaw();
			emitPresence(appState, "scene");
			captureWork = captureWork.then(async () => {
				const current = await snapshot(true, raw);
				if (current) await callbacks.onSceneChange(current);
			}).catch(() => callbacks.onDegraded("Excalidraw scene capture failed"));
		} };
		if (initialCapabilities.realtime) {
			this.bindings.add(registered);
			if (typeof view?.excalidrawAPI?.onChange === "function") {
				unsubscribeSceneChange = view.excalidrawAPI.onChange((_elements, appState) => registered.onHook(appState));
			} else this.installGlobalHook(plugin!);
		} else callbacks.onDegraded(initialCapabilities.reason ?? "Excalidraw realtime capabilities are unavailable");
		return {
			proof,
			capabilities: () => capabilities(pluginOf(this.app), view),
			read: snapshot,
			apply: async (elements, files, expectedPath) => {
				const before = proof();
				const api = view?.excalidrawAPI;
				if (!before || before.path !== expectedPath || !capabilities(pluginOf(this.app), view).realtime
					|| typeof api?.addFiles !== "function" || typeof view?.updateScene !== "function") return false;
				const validated = elements.map(validateExcalidrawElement);
				const prior = new Map<string, string | undefined>();
				for (const element of validated) {
					prior.set(element.id, expectedRemoteRevisions.get(element.id));
					expectedRemoteRevisions.set(element.id, revisionKey(await revisionOf(element)));
				}
				const restoreExpected = () => {
					for (const [elementId, old] of prior) {
						if (old === undefined) expectedRemoteRevisions.delete(elementId);
						else expectedRemoteRevisions.set(elementId, old);
					}
				};
				try {
					if (files.length > 0) await api.addFiles({ files: [...files] });
					const afterFiles = proof();
					if (!afterFiles || afterFiles.file !== before.file) { restoreExpected(); return false; }
					await view.updateScene({ elements: validated, captureUpdate: "NEVER" }, false);
					const afterApply = proof();
					if (!afterApply || afterApply.file !== before.file) { restoreExpected(); return false; }
					return true;
				} catch (error) {
					restoreExpected();
					throw error;
				}
			},
			applyPresence: (peers) => {
				const current = proof();
				const api = view?.excalidrawAPI;
				if (!current || typeof api?.updateScene !== "function") return false;
				const collaborators = new Map<string, ExcalidrawHostCollaborator>();
				for (const peer of peers) {
					const remote = peer.presence;
					collaborators.set(peer.sessionId, {
						username: peer.displayName,
						...(remote.pointer ? { pointer: { x: remote.pointer.x, y: remote.pointer.y,
							tool: remote.pointer.tool, ...(remote.pointer.laserColor ? { laserColor: remote.pointer.laserColor } : {}) },
						button: remote.pointer.button } : {}),
						selectedElementIds: Object.fromEntries(remote.selectedElementIds.map((id) => [id, true])),
						color: { background: peer.colorLight, stroke: peer.color },
						userState: remote.idle ? "idle" : "active",
						...(peer.principalId ? { id: peer.principalId } : {}),
						socketId: peer.sessionId,
					});
				}
				api.updateScene({ collaborators });
				return true;
			},
			release: () => {
				if (released) return;
				released = true;
				registered.released = true;
				this.bindings.delete(registered);
				expectedRemoteRevisions.clear();
				registered.restore();
				this.uninstallGlobalHookIfIdle();
			},
		};
	}

	destroy(): void {
		for (const binding of this.bindings) { binding.released = true; binding.restore(); }
		this.bindings.clear();
		this.uninstallGlobalHookIfIdle();
	}

	private installGlobalHook(plugin: ExcalidrawPlugin): void {
		const automate = plugin.ea;
		if (!automate || this.installedHook) return;
		this.previousHook = automate.onSceneChangeHook ?? null;
		const previous = this.previousHook;
		const appStateKeys = [...new Set([...(previous?.appStateKeys ?? []), ...PRESENCE_APP_STATE_KEYS])];
		const hook: SceneHook = {
			appStateKeys,
			trackElements: true,
			triggerWhenInvisible: true,
			callback: (...args) => {
				try { previous?.callback(...args); } catch { /* The prior hook must not break YAOS capture. */ }
				const view = args[3];
				for (const binding of this.bindings) if (!binding.released && binding.view === view) binding.onHook(args[1]);
			},
		};
		automate.onSceneChangeHook = hook;
		this.installedHook = hook;
	}

	private uninstallGlobalHookIfIdle(): void {
		if (this.bindings.size > 0 || !this.installedHook) return;
		const automate = pluginOf(this.app)?.ea;
		if (automate?.onSceneChangeHook === this.installedHook) automate.onSceneChangeHook = this.previousHook;
		this.installedHook = null;
		this.previousHook = null;
	}
}
