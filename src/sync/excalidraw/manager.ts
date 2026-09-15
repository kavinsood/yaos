import type { WorkspaceLeaf } from "obsidian";
import { canonicalExcalidrawJson } from "./canonical";
import { ExcalidrawSameVaultEngine, type ExcalidrawEngineStatus } from "./engine";
import type { ExcalidrawPersistencePort } from "./persistence";
import type { SameVaultExcalidrawResources } from "./resources";
import type { ExcalidrawTransportPort } from "./transport";
import type { ObsidianExcalidrawHostAdapter, ExcalidrawHostCapabilities, ExcalidrawHostSnapshot,
	ExcalidrawViewBinding, ExcalidrawViewProof } from "../../host/obsidianExcalidrawHostAdapter";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "./types";
import { ExcalidrawPresenceController } from "./presence";

export interface ExcalidrawCatalogEntry {
	documentId: string;
	drawingEpoch: number;
	kind: "excalidraw";
	format: "excalidraw-native";
	formatVersion: 1;
}

export interface ExcalidrawManagerOptions {
	host: ObsidianExcalidrawHostAdapter;
	persistence: ExcalidrawPersistencePort;
	transport(drawingId: string): ExcalidrawTransportPort;
	resources(drawingId: string): SameVaultExcalidrawResources;
	onStatus?(drawingId: string, status: ExcalidrawEngineStatus): void;
	onDegraded?(path: string, reason: string): void;
}

class HostGroup implements ExcalidrawViewBinding {
	readonly bindings = new Set<ExcalidrawViewBinding>();
	private lastReadSafe = false;
	constructor(readonly path: string) {}
	proof(): ExcalidrawViewProof | null { return [...this.bindings][0]?.proof() ?? null; }
	capabilities(): ExcalidrawHostCapabilities {
		const values = [...this.bindings].map((binding) => binding.capabilities());
		const first = values[0];
		if (!first) return { detect: false, sceneHook: false, readIncludingDeleted: false, applyNever: false,
			readFiles: false, addFiles: false, realtime: false, reason: "no live Excalidraw view" };
		return values.every((value) => value.realtime) ? first : { ...first, realtime: false,
			reason: values.find((value) => !value.realtime)?.reason ?? "one split view is unsupported" };
	}
	async read(): Promise<ExcalidrawHostSnapshot | null> {
		let selected: ExcalidrawHostSnapshot | null = null;
		for (const binding of this.bindings) {
			const snapshot = await binding.read();
			if (!snapshot) { this.lastReadSafe = false; return null; }
			if (selected && canonicalExcalidrawJson(selected.elements) !== canonicalExcalidrawJson(snapshot.elements)) {
				this.lastReadSafe = false; return null;
			}
			selected = snapshot;
		}
		this.lastReadSafe = selected !== null;
		return selected;
	}
	async apply(elements: readonly ExcalidrawElementRecord[], files: readonly ExcalidrawNativeFile[], expectedPath: string): Promise<boolean> {
		if (!this.lastReadSafe) return false;
		const results = await Promise.all([...this.bindings].map((binding) => binding.apply(elements, files, expectedPath)));
		return results.length > 0 && results.every(Boolean);
	}
	applyPresence(peers: readonly import("../../host/obsidianExcalidrawHostAdapter").ExcalidrawHostRemotePresence[]): boolean {
		const results = [...this.bindings].map((binding) => binding.applyPresence?.(peers) ?? false);
		return results.length > 0 && results.every(Boolean);
	}
	release(): void { for (const binding of this.bindings) binding.release(); this.bindings.clear(); }
}

interface DrawingSession {
	entry: ExcalidrawCatalogEntry;
	path: string;
	host: HostGroup;
	engine: ExcalidrawSameVaultEngine;
	presence: ExcalidrawPresenceController;
	start: Promise<void>;
}

/** Catalog-and-workspace coordinator; global wiring only needs replaceCatalog() and syncLeaves(). */
export class ExcalidrawManager {
	private readonly catalog = new Map<string, ExcalidrawCatalogEntry>();
	private readonly sessions = new Map<string, DrawingSession>();
	private readonly leafBindings = new Map<WorkspaceLeaf, { drawingId: string; binding: ExcalidrawViewBinding }>();
	private disposed = false;

	constructor(private readonly options: ExcalidrawManagerOptions) {}

	replaceCatalog(entries: Iterable<[string, ExcalidrawCatalogEntry]>): void {
		this.catalog.clear();
		for (const [path, entry] of entries) if (entry.kind === "excalidraw"
			&& entry.format === "excalidraw-native" && entry.formatVersion === 1) this.catalog.set(path, entry);
		for (const [drawingId, session] of this.sessions) {
			const current = this.catalog.get(session.path);
			if (!current || current.documentId !== drawingId || current.drawingEpoch !== session.entry.drawingEpoch) {
				this.closeSession(drawingId);
			}
		}
	}

	syncLeaves(leaves: readonly WorkspaceLeaf[]): void {
		if (this.disposed) return;
		const current = new Set(leaves);
		for (const [leaf, owned] of this.leafBindings) {
			const path = owned.binding.proof()?.path;
			const entry = path ? this.catalog.get(path) : null;
			if (!current.has(leaf) || !entry || entry.documentId !== owned.drawingId) this.releaseLeaf(leaf);
		}
		for (const leaf of leaves) {
			if (this.leafBindings.has(leaf)) continue;
			const path = (leaf.view as unknown as { file?: { path?: string } }).file?.path;
			const entry = path ? this.catalog.get(path) : null;
			if (!path || !entry) continue;
			this.attachLeaf(leaf, path, entry);
		}
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const leaf of [...this.leafBindings.keys()]) this.releaseLeaf(leaf);
		for (const drawingId of [...this.sessions.keys()]) this.closeSession(drawingId);
		this.options.host.destroy();
	}

	activeStatuses(): Array<{ drawingId: string; path: string; status: ExcalidrawEngineStatus }> {
		return [...this.sessions].map(([drawingId, session]) => ({ drawingId, path: session.path, status: session.engine.status() }));
	}

	entryForPath(path: string): ExcalidrawCatalogEntry | null {
		const entry = this.catalog.get(path);
		return entry ? { ...entry } : null;
	}

	private attachLeaf(leaf: WorkspaceLeaf, path: string, entry: ExcalidrawCatalogEntry): void {
		let session = this.sessions.get(entry.documentId);
		let engine: ExcalidrawSameVaultEngine;
		let presence: ExcalidrawPresenceController;
		const binding = this.options.host.bind(leaf, {
			onSceneChange: (snapshot) => void engine.capture(snapshot),
			onPresenceChange: (state, source) => presence.capture(state, source),
			onDegraded: (reason) => this.options.onDegraded?.(path, reason),
		});
		if (!binding.capabilities().realtime) { binding.release(); return; }
		if (!session) {
			const group = new HostGroup(path);
			group.bindings.add(binding);
			presence = new ExcalidrawPresenceController({ drawingId: entry.documentId,
				drawingEpoch: entry.drawingEpoch, host: group,
				onDegraded: (reason) => this.options.onDegraded?.(path, reason) });
			presence.start();
			engine = new ExcalidrawSameVaultEngine({ drawingId: entry.documentId, drawingEpoch: entry.drawingEpoch,
				path, persistence: this.options.persistence, transport: this.options.transport(entry.documentId), host: group,
				resources: this.options.resources(entry.documentId), presence,
				onStatus: (status) => this.options.onStatus?.(entry.documentId, status) });
			session = { entry, path, host: group, engine, presence, start: Promise.resolve() };
			session.start = engine.start().catch((error: unknown) => {
				this.options.onDegraded?.(path, error instanceof Error ? error.message : "Excalidraw startup failed");
			});
			this.sessions.set(entry.documentId, session);
		} else {
			engine = session.engine;
			presence = session.presence;
			session.host.bindings.add(binding);
			void session.start.then(() => engine.refreshHost());
		}
		this.leafBindings.set(leaf, { drawingId: entry.documentId, binding });
	}

	private releaseLeaf(leaf: WorkspaceLeaf): void {
		const owned = this.leafBindings.get(leaf);
		if (!owned) return;
		this.leafBindings.delete(leaf);
		owned.binding.release();
		const session = this.sessions.get(owned.drawingId);
		if (!session) return;
		session.host.bindings.delete(owned.binding);
		if (session.host.bindings.size === 0) this.closeSession(owned.drawingId);
	}

	private closeSession(drawingId: string): void {
		const session = this.sessions.get(drawingId);
		if (!session) return;
		this.sessions.delete(drawingId);
		for (const [leaf, owned] of this.leafBindings) if (owned.drawingId === drawingId) {
			owned.binding.release(); this.leafBindings.delete(leaf);
		}
		session.presence.stop();
		session.engine.stop();
		session.host.release();
	}
}
