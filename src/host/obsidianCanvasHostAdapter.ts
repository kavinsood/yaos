import type { TFile, WorkspaceLeaf } from "obsidian";
import { HostPatchRegistry, type HostPatchRelease } from "./hostPatchRegistry";

type CanvasController = {
	getData?: () => unknown;
	importData?: (data: unknown, clear?: boolean) => unknown;
	requestSave?: () => unknown;
	applyHistory?: (...args: unknown[]) => unknown;
	markDirty?: (...args: unknown[]) => unknown;
	markMoved?: (...args: unknown[]) => unknown;
	nodes?: Map<string, { isEditing?: boolean; text?: string; setText?: (text: string) => unknown }>;
};

type CanvasView = {
	file?: TFile | null;
	canvas?: CanvasController;
	getViewType?: () => string;
	setViewData?: (data: string, clear: boolean) => unknown;
};

export interface CanvasHostCapabilities {
	detect: boolean;
	read: boolean;
	apply: boolean;
	save: boolean;
	observeMutation: boolean;
	observeLoad: boolean;
	observeHistory: boolean;
}

export interface CanvasViewProof {
	leaf: WorkspaceLeaf;
	view: object;
	file: TFile;
	path: string;
	loadRevision: number;
	sessionGeneration: number;
}

export interface CanvasViewBinding {
	proof(): CanvasViewProof | null;
	candidate(): CanvasViewProof | null;
	capabilities(): CanvasHostCapabilities;
	read(): unknown | null;
	readCandidate(): unknown | null;
	adopt(candidate: CanvasViewProof): boolean;
	apply(data: unknown, expectedPath: string): Promise<boolean>;
	release(): void;
}

export interface CanvasViewCallbacks {
	onCaptureRequested(reason: "mutation" | "save" | "history" | "load"): void;
	onOwnershipChanged(owned: boolean): void;
}

function viewOf(leaf: WorkspaceLeaf): CanvasView | null {
	const view = leaf.view as unknown as CanvasView;
	return view?.getViewType?.() === "canvas" ? view : null;
}

function capabilities(view: CanvasView | null): CanvasHostCapabilities {
	const canvas = view?.canvas;
	return {
		detect: view !== null,
		read: typeof canvas?.getData === "function",
		apply: typeof canvas?.importData === "function",
		save: typeof canvas?.requestSave === "function",
		observeMutation: typeof canvas?.markDirty === "function" || typeof canvas?.markMoved === "function",
		observeLoad: typeof view?.setViewData === "function",
		observeHistory: typeof canvas?.applyHistory === "function",
	};
}

function preAdoptActiveText(data: unknown, canvas: CanvasController): unknown {
	if (!data || typeof data !== "object" || !Array.isArray((data as { nodes?: unknown }).nodes)
		|| !(canvas.nodes instanceof Map)) return data;
	const incoming = data as { nodes: Array<Record<string, unknown>> };
	let changed = false;
	const nodes = incoming.nodes.map((node) => {
		if (typeof node.id !== "string" || typeof node.text !== "string") return node;
		const live = canvas.nodes?.get(node.id);
		if (!live?.isEditing || typeof live.text !== "string" || live.text === node.text) return node;
		changed = true;
		return { ...node, text: live.text };
	});
	return changed ? { ...(data as Record<string, unknown>), nodes } : data;
}

/** Sole boundary for Obsidian's undocumented Canvas view/controller surface. */
export class ObsidianCanvasHostAdapter {
	constructor(private readonly patches = new HostPatchRegistry()) {}

	capabilities(leaf: WorkspaceLeaf): CanvasHostCapabilities { return capabilities(viewOf(leaf)); }

	bind(leaf: WorkspaceLeaf, callbacks: CanvasViewCallbacks): CanvasViewBinding {
		const view = viewOf(leaf);
		const canvas = view?.canvas;
		const releases: HostPatchRelease[] = [];
		let released = false;
		let ownedFile: TFile | null = null;
		let observedFile: TFile | null = view?.file ?? null;
		let loadRevision = 0;
		let sessionGeneration = 1;
		let applying = false;
		const current = (): CanvasViewProof | null => {
			if (released || !view || leaf.view !== view || !ownedFile || view.file !== ownedFile) return null;
			return { leaf, view, file: ownedFile, path: ownedFile.path, loadRevision, sessionGeneration };
		};
		const candidate = (): CanvasViewProof | null => {
			if (released || !view || leaf.view !== view || !observedFile || view.file !== observedFile) return null;
			return { leaf, view, file: observedFile, path: observedFile.path, loadRevision, sessionGeneration };
		};
		const requestCapture = (reason: Parameters<CanvasViewCallbacks["onCaptureRequested"]>[0]): void => {
			if (!released && !applying && current()) callbacks.onCaptureRequested(reason);
		};
		if (view) releases.push(this.patches.observe(view, "setViewData", (_args) => {
			loadRevision++;
			const nextFile = view.file instanceof Object ? view.file as TFile : null;
			const changed = nextFile !== observedFile;
			observedFile = nextFile;
			if (changed) sessionGeneration++;
			ownedFile = nextFile;
			callbacks.onOwnershipChanged(ownedFile !== null);
			requestCapture("load");
		}));
		if (canvas) {
			for (const method of ["markDirty", "markMoved"] as const) releases.push(this.patches.observe(canvas, method, () => {
				queueMicrotask(() => requestCapture("mutation"));
			}));
			releases.push(this.patches.observe(canvas, "requestSave", () => {
				if (!ownedFile && observedFile && view?.file === observedFile) {
					ownedFile = observedFile;
					callbacks.onOwnershipChanged(true);
				}
				requestCapture("save");
			}));
			releases.push(this.patches.observe(canvas, "applyHistory", () => requestCapture("history")));
		}
		return {
			proof: current,
			candidate,
			capabilities: () => capabilities(view),
			read: () => {
				if (!current() || typeof canvas?.getData !== "function") return null;
				return canvas.getData.call(canvas);
			},
			readCandidate: () => {
				if (!candidate() || typeof canvas?.getData !== "function") return null;
				return canvas.getData.call(canvas);
			},
			adopt: (expected) => {
				const currentCandidate = candidate();
				if (!currentCandidate || currentCandidate.file !== expected.file
					|| currentCandidate.loadRevision !== expected.loadRevision
					|| currentCandidate.sessionGeneration !== expected.sessionGeneration) return false;
				ownedFile = currentCandidate.file;
				callbacks.onOwnershipChanged(true);
				return true;
			},
			apply: async (data, expectedPath) => {
				const before = current();
				if (!before || before.path !== expectedPath || typeof canvas?.importData !== "function"
					|| typeof canvas.requestSave !== "function") return false;
				applying = true;
				try {
					await canvas.importData.call(canvas, preAdoptActiveText(data, canvas), false);
					const afterImport = current();
					if (!afterImport || afterImport.file !== before.file || afterImport.loadRevision !== before.loadRevision
						|| afterImport.sessionGeneration !== before.sessionGeneration) return false;
					await canvas.requestSave.call(canvas);
					const afterSave = current();
					return !!afterSave && afterSave.file === before.file && afterSave.loadRevision === before.loadRevision
						&& afterSave.sessionGeneration === before.sessionGeneration;
				} finally { applying = false; }
			},
			release: () => {
				if (released) return;
				released = true;
				ownedFile = null;
				observedFile = null;
				sessionGeneration++;
				for (const release of releases) release();
				callbacks.onOwnershipChanged(false);
			},
		};
	}
}
