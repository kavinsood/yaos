import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "./types";

export interface ExcalidrawHostPointer {
	x: number;
	y: number;
	tool: "pointer" | "laser";
	button: "up" | "down";
	laserColor?: string;
}

export interface ExcalidrawHostViewport {
	scrollX: number;
	scrollY: number;
	zoom: number;
	width: number;
	height: number;
}

export interface ExcalidrawHostPresence {
	pointer: ExcalidrawHostPointer | null;
	selectedElementIds: string[];
	activeElementId: string | null;
	interaction: "idle" | "pointing" | "dragging" | "editing";
	viewport: ExcalidrawHostViewport | null;
	followSessionId: string | null;
	idle: boolean;
}

export interface ExcalidrawHostCollaborator {
	username: string;
	pointer?: { x: number; y: number; tool: "pointer" | "laser"; laserColor?: string };
	button?: "up" | "down";
	selectedElementIds?: Record<string, boolean>;
	color?: { background: string; stroke: string };
	userState?: "active" | "idle" | "away";
	id?: string;
	socketId?: string;
}

export interface ExcalidrawHostRemotePresence {
	sessionId: string;
	displayName: string;
	color: string;
	colorLight: string;
	principalId?: string;
	presence: ExcalidrawHostPresence;
}

export interface ExcalidrawHostCapabilities {
	detect: boolean;
	sceneHook: boolean;
	readIncludingDeleted: boolean;
	applyNever: boolean;
	readFiles: boolean;
	addFiles: boolean;
	realtime: boolean;
	reason: string | null;
}

export interface ExcalidrawViewProof {
	leaf: object;
	view: object;
	file: { path: string };
	path: string;
}

export interface ExcalidrawHostSnapshot {
	proof: ExcalidrawViewProof;
	elements: ExcalidrawElementRecord[];
	files: ExcalidrawNativeFile[];
	suppressedRevisionKeys: ReadonlySet<string>;
}

export interface ExcalidrawViewCallbacks {
	onSceneChange(snapshot: ExcalidrawHostSnapshot): void | Promise<void>;
	onPresenceChange?(presence: ExcalidrawHostPresence, source: "pointer" | "scene"): void;
	onDegraded(reason: string): void;
}

export interface ExcalidrawViewBinding {
	proof(): ExcalidrawViewProof | null;
	capabilities(): ExcalidrawHostCapabilities;
	read(): Promise<ExcalidrawHostSnapshot | null>;
	apply(elements: readonly ExcalidrawElementRecord[], files: readonly ExcalidrawNativeFile[], expectedPath: string): Promise<boolean>;
	applyPresence?(peers: readonly ExcalidrawHostRemotePresence[]): boolean;
	release(): void;
}

export interface ExcalidrawResourcesPort {
	publish(files: readonly ExcalidrawNativeFile[]): Promise<import("./types").ExcalidrawResourceManifest>;
	resolve(manifest: import("./types").ExcalidrawResourceManifest): Promise<import("./types").ExcalidrawResourceResolution>;
}
