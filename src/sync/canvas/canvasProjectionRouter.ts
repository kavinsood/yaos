import type { WorkspaceLeaf } from "obsidian";
import { canvasToJson, parseCanvasBytes } from "@shared/canvasCodec";
import { canonicalCanvasBytes } from "@shared/canvasCodec";
import { sha256BytesHex } from "../../utils/sha256";
import { ObsidianCanvasHostAdapter, type CanvasViewBinding } from "../../host/obsidianCanvasHostAdapter";
import type { CanvasManager, CanvasProjectionPort } from "./canvasManager";

const CAPTURE_QUIET_MS = 50;
const CAPTURE_MAX_WAIT_MS = 1000;

interface BoundLeaf {
	binding: CanvasViewBinding;
	consumerId: string;
	quietTimer: number | null;
	maximumTimer: number | null;
}

export class CanvasProjectionRouter implements CanvasProjectionPort {
	private readonly leaves = new Map<WorkspaceLeaf, BoundLeaf>();
	private manager: CanvasManager | null = null;
	private disposed = false;
	private nextConsumerId = 1;

	constructor(private readonly disk: CanvasProjectionPort,
		private readonly host = new ObsidianCanvasHostAdapter()) {}

	attachManager(manager: CanvasManager): void {
		this.manager = manager;
		for (const bound of this.leaves.values()) void this.syncLiveConsumer(bound);
	}

	syncLeaves(leaves: readonly WorkspaceLeaf[]): void {
		if (this.disposed) return;
		const current = new Set(leaves);
		for (const [leaf, bound] of this.leaves) if (!current.has(leaf)) {
			this.releaseBound(bound);
			this.leaves.delete(leaf);
		}
		for (const leaf of leaves) if (!this.leaves.has(leaf) && this.host.capabilities(leaf).detect) {
			const bound: BoundLeaf = { binding: null as unknown as CanvasViewBinding,
				consumerId: `canvas-view:${this.nextConsumerId++}`, quietTimer: null, maximumTimer: null };
			bound.binding = this.host.bind(leaf, {
				onCaptureRequested: (reason) => this.scheduleCapture(bound, reason === "mutation" ? CAPTURE_QUIET_MS : 0),
				onOwnershipChanged: () => {
					void this.syncLiveConsumer(bound);
					this.scheduleCapture(bound, 0);
				},
			});
			this.leaves.set(leaf, bound);
			void this.establishInitialOwnership(bound);
		}
	}

	async read(path: string): Promise<Uint8Array | null> {
		const live = this.live(path);
		if (live.length === 0) return this.hasUnownedView(path) ? null : this.disk.read(path);
		return this.readLive(live);
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		const live = this.live(path);
		if (live.length === 0) {
			if (this.hasUnownedView(path)) throw new Error("open Canvas view ownership is not proven");
			return this.disk.write(path, bytes);
		}
		if (!await this.readLive(live)) throw new Error("split Canvas views disagree or are unreadable");
		const parsed = parseCanvasBytes(bytes);
		if (parsed.kind !== "valid" || live.some((bound) => !bound.binding.capabilities().apply || !bound.binding.capabilities().save)) {
			throw new Error("open Canvas view cannot safely accept remote state");
		}
		const data = canvasToJson(parsed.data);
		const applied = await Promise.all(live.map((bound) => bound.binding.apply(data, path)));
		if (applied.some((value) => !value)) throw new Error("Canvas view ownership changed during apply");
	}

	fingerprint(path: string): Promise<Uint8Array | null> {
		return this.disk.fingerprint ? this.disk.fingerprint(path) : this.disk.read(path);
	}

	preserveConflict(input: Parameters<CanvasProjectionPort["preserveConflict"]>[0]): Promise<boolean> {
		return this.disk.preserveConflict(input);
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const bound of this.leaves.values()) this.releaseBound(bound);
		this.leaves.clear();
		this.manager = null;
	}

	private live(path: string): BoundLeaf[] {
		return [...this.leaves.values()].filter((bound) => bound.binding.proof()?.path === path);
	}

	private hasUnownedView(path: string): boolean {
		return [...this.leaves.values()].some((bound) => !bound.binding.proof() && bound.binding.candidate()?.path === path);
	}

	private async readLive(live: readonly BoundLeaf[]): Promise<Uint8Array | null> {
		let selected: Uint8Array | null = null;
		let selectedHash: string | null = null;
		for (const bound of live) {
			const data = bound.binding.read();
			if (data === null) return null;
			let bytes: Uint8Array;
			try { bytes = new TextEncoder().encode(JSON.stringify(data)); }
			catch { return null; }
			const parsed = parseCanvasBytes(bytes);
			if (parsed.kind !== "valid") return null;
			const hash = await sha256BytesHex(canonicalCanvasBytes(parsed.data));
			if (selectedHash !== null && selectedHash !== hash) return null;
			selected = bytes;
			selectedHash = hash;
		}
		return selected;
	}

	private async establishInitialOwnership(bound: BoundLeaf): Promise<void> {
		const candidate = bound.binding.candidate();
		if (!candidate) return;
		const data = bound.binding.readCandidate();
		if (data === null) return;
		let viewBytes: Uint8Array;
		try { viewBytes = new TextEncoder().encode(JSON.stringify(data)); } catch { return; }
		const parsed = parseCanvasBytes(viewBytes);
		if (parsed.kind !== "valid") return;
		const diskBytes = await this.disk.read(candidate.path);
		if (!diskBytes || bound.binding.candidate()?.loadRevision !== candidate.loadRevision
			|| bound.binding.candidate()?.sessionGeneration !== candidate.sessionGeneration) return;
		const diskParsed = parseCanvasBytes(diskBytes);
		if (diskParsed.kind !== "valid") return;
		if (await sha256BytesHex(canonicalCanvasBytes(parsed.data))
			!== await sha256BytesHex(canonicalCanvasBytes(diskParsed.data))) return;
		if (bound.binding.adopt(candidate)) {
			await this.syncLiveConsumer(bound);
			this.scheduleCapture(bound, 0);
		}
	}

	private scheduleCapture(bound: BoundLeaf, delay: number): void {
		if (this.disposed) return;
		if (bound.quietTimer !== null) window.clearTimeout(bound.quietTimer);
		bound.quietTimer = window.setTimeout(() => void this.capture(bound), delay);
		if (bound.maximumTimer === null) bound.maximumTimer = window.setTimeout(() => void this.capture(bound), CAPTURE_MAX_WAIT_MS);
	}

	private async capture(bound: BoundLeaf): Promise<void> {
		if (bound.quietTimer !== null) window.clearTimeout(bound.quietTimer);
		if (bound.maximumTimer !== null) window.clearTimeout(bound.maximumTimer);
		bound.quietTimer = null;
		bound.maximumTimer = null;
		await this.syncLiveConsumer(bound);
		const proof = bound.binding.proof();
		if (!proof || !this.manager?.isSemanticPath(proof.path)) return;
		const data = bound.binding.read();
		if (data === null) return;
		let bytes: Uint8Array;
		try { bytes = new TextEncoder().encode(JSON.stringify(data)); }
		catch { return; }
		if (bound.binding.proof()?.sessionGeneration !== proof.sessionGeneration
			|| bound.binding.proof()?.loadRevision !== proof.loadRevision) return;
		await this.manager.ingest(proof.path, bytes);
	}

	private releaseBound(bound: BoundLeaf): void {
		if (bound.quietTimer !== null) window.clearTimeout(bound.quietTimer);
		if (bound.maximumTimer !== null) window.clearTimeout(bound.maximumTimer);
		void this.manager?.setLiveConsumer(bound.consumerId, null);
		bound.binding.release();
	}

	private async syncLiveConsumer(bound: BoundLeaf): Promise<void> {
		const path = bound.binding.proof()?.path ?? null;
		await this.manager?.setLiveConsumer(bound.consumerId, path);
	}
}
