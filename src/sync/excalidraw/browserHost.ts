import { revisionKey, revisionOf, validateExcalidrawElement } from "./canonical";
import type {
	ExcalidrawHostCapabilities,
	ExcalidrawHostCollaborator,
	ExcalidrawHostPointer,
	ExcalidrawHostPresence,
	ExcalidrawHostRemotePresence,
	ExcalidrawHostSnapshot,
	ExcalidrawViewBinding,
	ExcalidrawViewCallbacks,
	ExcalidrawViewProof,
} from "./host";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "./types";

export interface BrowserExcalidrawApi {
	getSceneElementsIncludingDeleted(): readonly unknown[];
	getFiles(): Record<string, unknown>;
	getAppState?(): Record<string, unknown>;
	addFiles(files: readonly ExcalidrawNativeFile[]): void | Promise<void>;
	updateScene(scene: {
		elements?: readonly ExcalidrawElementRecord[];
		collaborators?: Map<string, ExcalidrawHostCollaborator>;
		captureUpdate?: "NEVER";
	}): void | Promise<void>;
}

export interface AudienceSafePresenceIdentity {
	participantId: string;
	kind: "member" | "guest";
	displayName: string;
	color: string;
	colorLight: string;
}

export interface AudienceSafeRemotePresence {
	sessionId: string;
	identity: AudienceSafePresenceIdentity;
	presence: ExcalidrawHostPresence;
}

const CAPABILITIES: ExcalidrawHostCapabilities = Object.freeze({
	detect: true,
	sceneHook: true,
	readIncludingDeleted: true,
	applyNever: true,
	readFiles: true,
	addFiles: true,
	realtime: true,
	reason: null,
});

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

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectId(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0 && value.length <= 160) return value;
	if (value && typeof value === "object") return objectId((value as { id?: unknown }).id);
	return null;
}

function selectionOf(appState: Record<string, unknown>): string[] {
	const selected = appState.selectedElementIds;
	if (!selected || typeof selected !== "object" || Array.isArray(selected)) return [];
	return Object.entries(selected).filter(([, enabled]) => enabled === true).map(([id]) => id).slice(0, 256);
}

function zoomOf(value: unknown): number | null {
	return finite(value) ?? (value && typeof value === "object" ? finite((value as { value?: unknown }).value) : null);
}

/** Host-neutral adapter for the official React Excalidraw imperative API and callbacks. */
export class BrowserExcalidrawHost implements ExcalidrawViewBinding {
	private api: BrowserExcalidrawApi | null = null;
	private readonly proofValue: ExcalidrawViewProof;
	private readonly expectedRemoteRevisions = new Map<string, string>();
	private pointer: ExcalidrawHostPointer | null = null;
	private callbackWork = Promise.resolve();
	private released = false;
	private writable: boolean;

	constructor(
		path: string,
		private readonly callbacks: ExcalidrawViewCallbacks,
		options: { writable?: boolean } = {},
	) {
		const file = { path };
		this.proofValue = { leaf: {}, view: this, file, path };
		this.writable = options.writable ?? true;
	}

	bindApi(api: BrowserExcalidrawApi | null): void {
		this.api = api;
	}

	setWritable(writable: boolean): void {
		this.writable = writable;
	}

	isWritable(): boolean {
		return this.writable;
	}

	proof(): ExcalidrawViewProof | null {
		return this.released ? null : this.proofValue;
	}

	capabilities(): ExcalidrawHostCapabilities {
		return this.api && !this.released ? CAPABILITIES : { ...CAPABILITIES, detect: false, realtime: false,
			reason: this.released ? "browser host released" : "Excalidraw API is not mounted" };
	}

	async read(): Promise<ExcalidrawHostSnapshot | null> {
		if (!this.api || this.released) return null;
		return {
			proof: this.proofValue,
			elements: this.writable ? this.api.getSceneElementsIncludingDeleted().map(validateExcalidrawElement) : [],
			files: this.writable ? nativeFiles(this.api.getFiles()) : [],
			suppressedRevisionKeys: new Set(),
		};
	}

	async apply(elements: readonly ExcalidrawElementRecord[], files: readonly ExcalidrawNativeFile[],
		expectedPath: string): Promise<boolean> {
		const api = this.api;
		if (!api || this.released || expectedPath !== this.proofValue.path) return false;
		const validated = elements.map(validateExcalidrawElement);
		const prior = new Map<string, string | undefined>();
		for (const element of validated) {
			prior.set(element.id, this.expectedRemoteRevisions.get(element.id));
			this.expectedRemoteRevisions.set(element.id, revisionKey(await revisionOf(element)));
		}
		try {
			if (files.length > 0) await api.addFiles(files);
			if (api !== this.api || this.released) throw new Error("browser Excalidraw API changed during remote apply");
			await api.updateScene({ elements: validated, captureUpdate: "NEVER" });
			return api === this.api && !this.released;
		} catch (error) {
			for (const [elementId, key] of prior) {
				if (key === undefined) this.expectedRemoteRevisions.delete(elementId);
				else this.expectedRemoteRevisions.set(elementId, key);
			}
			throw error;
		}
	}

	/** Wire directly to the React component's `onChange` prop. */
	handleSceneChange(elements: readonly unknown[], appState: Record<string, unknown>,
		files: Record<string, unknown>): void {
		if (this.released) return;
		const capturedElements = elements.map(validateExcalidrawElement);
		const capturedFiles = nativeFiles(files);
		this.emitPresence(appState, "scene");
		this.callbackWork = this.callbackWork.then(async () => {
			const suppressed = new Set<string>();
			for (const element of capturedElements) {
				const key = revisionKey(await revisionOf(element));
				const expected = this.expectedRemoteRevisions.get(element.id);
				if (expected === key) {
					suppressed.add(key);
					this.expectedRemoteRevisions.delete(element.id);
				} else if (expected !== undefined) this.expectedRemoteRevisions.delete(element.id);
			}
			if (!this.writable && suppressed.size === 0) return;
			await this.callbacks.onSceneChange({ proof: this.proofValue, elements: capturedElements,
				files: capturedFiles, suppressedRevisionKeys: suppressed });
		}).catch(() => this.callbacks.onDegraded("browser Excalidraw scene capture failed"));
	}

	/** Wire directly to the React component's `onPointerUpdate` prop. */
	handlePointerUpdate(payload: { pointer?: { x?: unknown; y?: unknown; tool?: unknown; laserColor?: unknown };
		button?: unknown }): void {
		const x = finite(payload.pointer?.x);
		const y = finite(payload.pointer?.y);
		if (x === null || y === null) this.pointer = null;
		else {
			const tool = payload.pointer?.tool === "laser" ? "laser" : "pointer";
			this.pointer = { x, y, tool, button: payload.button === "down" ? "down" : "up",
				...(tool === "laser" && typeof payload.pointer?.laserColor === "string"
					? { laserColor: payload.pointer.laserColor } : {}) };
		}
		this.emitPresence(this.api?.getAppState?.() ?? {}, "pointer");
	}

	applyPresence(peers: readonly ExcalidrawHostRemotePresence[]): boolean {
		const api = this.api;
		if (!api || this.released) return false;
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
		void api.updateScene({ collaborators, captureUpdate: "NEVER" });
		return true;
	}

	applyAudienceSafePresence(peers: readonly AudienceSafeRemotePresence[]): boolean {
		return this.applyPresence(peers.map((peer) => ({ sessionId: peer.sessionId,
			displayName: peer.identity.displayName, color: peer.identity.color,
			colorLight: peer.identity.colorLight, presence: peer.presence })));
	}

	async drainCallbacks(): Promise<void> {
		await this.callbackWork;
	}

	release(): void {
		this.released = true;
		this.api = null;
		this.expectedRemoteRevisions.clear();
	}

	private emitPresence(appState: Record<string, unknown>, source: "pointer" | "scene"): void {
		const editing = objectId(appState.editingElement);
		const dragging = objectId(appState.draggingElement);
		const selectedElementIds = selectionOf(appState);
		const scrollX = finite(appState.scrollX);
		const scrollY = finite(appState.scrollY);
		const zoom = zoomOf(appState.zoom);
		const width = finite(appState.width);
		const height = finite(appState.height);
		const following = appState.userToFollow && typeof appState.userToFollow === "object"
			? objectId((appState.userToFollow as { socketId?: unknown }).socketId) : null;
		this.callbacks.onPresenceChange?.({
			pointer: this.pointer,
			selectedElementIds,
			activeElementId: editing ?? dragging,
			interaction: editing ? "editing" : dragging ? "dragging" : this.pointer ? "pointing" : "idle",
			viewport: scrollX !== null && scrollY !== null && zoom !== null && width !== null && height !== null
				? { scrollX, scrollY, zoom, width, height } : null,
			followSessionId: following,
			idle: !editing && !dragging && !this.pointer,
		}, source);
	}
}
