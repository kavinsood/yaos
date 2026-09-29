/**
 * Relay v2 spike (§5.5 / §7.3 B5): in-memory model of the lease + semantic
 * reset CAS, plus simulated devices driving the real client rebase path.
 *
 * Server model (one body):
 *   - epoch (int, starts 1), latestSequence (global clock), checkpoint state of
 *     the current epoch + tail of accepted updates;
 *   - append(expectedEpoch, update) → rejected with epoch_mismatch when stale
 *     (the 4409 fence), otherwise sequence++ and broadcast to online devices;
 *   - compaction lease: one holder, TTL, only for the current epoch, optional
 *     cooldown enforcement using the server-owned policy state;
 *   - semantic-reset CAS, checked in this order inside one "transaction":
 *       lease id current & unexpired & same holder  → else lease_invalid/lease_expired
 *       expectedEpoch == epoch                      → else epoch_mismatch
 *       coveredSequence == latestSequence (EXACT)   → else head_advanced
 *       canonicalMarkdownHash(snapshot body) == contentHash → else hash_mismatch
 *     success: epoch++, sequence++, checkpoint = snapshot, tail = [], lease
 *     cleared, policy state updated, every online device fenced.
 *
 * Devices (`SimDevice`) implement `ResetBodyHandle`; their bookkeeping mirrors
 * bodyManager: durableBaseline := text whenever nothing is unacknowledged,
 * installSemanticEpochTransition semantics on install.
 */
import * as Y from "yjs";
import { canonicalMarkdownHash } from "@shared/markdownCodec";
import type { ReadySemanticEpochTransition } from "../../../src/sync/semanticEpochTransition";
import { BODY_TEXT_ROOT } from "./builder";
import type { SemanticCompactionState } from "./policy";
import {
	rebaseOntoCurrent,
	type BodyStateResponse,
	type LeaseRequest,
	type LeaseResponse,
	type RebaseOutcome,
	type ResetBodyHandle,
	type ResetTransport,
	type SemanticResetRequest,
	type SemanticResetResponse,
} from "./leaseClient";

export const DEFAULT_LEASE_TTL_MS = 60_000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

type ServerEvent =
	| { type: "update"; epoch: number; sequence: number; update: Uint8Array; from: string }
	| { type: "fence"; epoch: number; sequence: number };

interface Lease { leaseId: string; holder: string; epoch: number; expiresAt: number }

export interface ResetLogEntry {
	at: number;
	holder: string;
	previousEpoch: number;
	epoch: number;
	coveredSequence: number;
	sequence: number;
	snapshotBytes: number;
	contentHash: string;
}

export class MockRelayBody {
	epoch = 1;
	latestSequence = 0;
	private state: Y.Doc;
	private lease: Lease | null = null;
	private leaseCounter = 0;
	private readonly subscribers = new Map<string, (event: ServerEvent) => void>();
	policy: SemanticCompactionState = { lastCompactedAt: null, postCompactionEncodedStateBytes: null };
	readonly resets: ResetLogEntry[] = [];
	readonly rejectedAppends: Array<{ from: string; expectedEpoch: number; epoch: number }> = [];
	readonly resetAttempts: Array<{ from: string; ok: boolean; reason?: string }> = [];
	readonly leaseAttempts: Array<{ from: string; granted: boolean; reason?: string }> = [];

	constructor(
		readonly bodyId: string,
		initialState: Uint8Array | null,
		readonly clock: () => number = Date.now,
		readonly options: { enforceCooldown?: boolean } = {},
	) {
		this.state = new Y.Doc({ guid: bodyId });
		if (initialState) Y.applyUpdate(this.state, initialState);
	}

	text(): string { return this.state.getText(BODY_TEXT_ROOT).toJSON(); }
	encodedState(): Uint8Array { return Y.encodeStateAsUpdate(this.state); }

	subscribe(deviceId: string, listener: (event: ServerEvent) => void): void { this.subscribers.set(deviceId, listener); }
	unsubscribe(deviceId: string): void { this.subscribers.delete(deviceId); }

	private broadcast(event: ServerEvent, except?: string): void {
		for (const [deviceId, listener] of [...this.subscribers]) if (deviceId !== except) listener(event);
	}

	append(from: string, expectedEpoch: number, update: Uint8Array):
		| { ok: true; sequence: number } | { ok: false; reason: "epoch_mismatch"; epoch: number } {
		if (expectedEpoch !== this.epoch) {
			this.rejectedAppends.push({ from, expectedEpoch, epoch: this.epoch });
			return { ok: false, reason: "epoch_mismatch", epoch: this.epoch };
		}
		Y.applyUpdate(this.state, update, from);
		const sequence = ++this.latestSequence;
		this.broadcast({ type: "update", epoch: this.epoch, sequence, update, from }, from);
		return { ok: true, sequence };
	}

	requestLease(from: string, request: LeaseRequest): LeaseResponse {
		const now = this.clock();
		const deny = (reason: string): LeaseResponse => {
			this.leaseAttempts.push({ from, granted: false, reason });
			return {
				granted: false, reason, epoch: this.epoch, headSequence: this.latestSequence,
				...(this.lease ? { holderDeviceId: this.lease.holder, expiresAt: this.lease.expiresAt } : {}),
			};
		};
		if (request.expectedEpoch !== this.epoch) return deny("epoch_mismatch");
		if (this.lease && this.lease.expiresAt > now && this.lease.holder !== from) return deny("held");
		if (this.options.enforceCooldown && this.policy.lastCompactedAt !== null
			&& now - this.policy.lastCompactedAt < COOLDOWN_MS) return deny("cooldown");
		this.lease = {
			leaseId: `lease-${++this.leaseCounter}`, holder: from, epoch: this.epoch,
			expiresAt: now + (request.ttlMs ?? DEFAULT_LEASE_TTL_MS),
		};
		this.leaseAttempts.push({ from, granted: true });
		return {
			granted: true, leaseId: this.lease.leaseId, expiresAt: this.lease.expiresAt, epoch: this.epoch,
			headSequence: this.latestSequence, stateVector: Y.encodeStateVector(this.state), policy: { ...this.policy },
		};
	}

	releaseLease(from: string, leaseId: string): void {
		if (this.lease && this.lease.leaseId === leaseId && this.lease.holder === from) this.lease = null;
	}

	async semanticReset(from: string, request: SemanticResetRequest): Promise<SemanticResetResponse> {
		// Hash is computed before the synchronous CAS section (it is async); the
		// check itself is part of the atomic decision below.
		const probe = new Y.Doc();
		Y.applyUpdate(probe, request.snapshot);
		const claimed = await canonicalMarkdownHash(probe.getText(BODY_TEXT_ROOT).toJSON());
		probe.destroy();
		const now = this.clock();
		const fail = (reason: string): SemanticResetResponse => {
			this.resetAttempts.push({ from, ok: false, reason });
			return { ok: false, reason, epoch: this.epoch, headSequence: this.latestSequence };
		};
		if (!this.lease || this.lease.leaseId !== request.leaseId || this.lease.holder !== from) return fail("lease_invalid");
		if (this.lease.expiresAt <= now) return fail("lease_expired");
		if (request.expectedEpoch !== this.epoch || this.lease.epoch !== this.epoch) return fail("epoch_mismatch");
		if (request.coveredSequence !== this.latestSequence) return fail("head_advanced");
		if (claimed !== request.contentHash) return fail("hash_mismatch");
		const previousEpoch = this.epoch;
		this.state.destroy();
		this.state = new Y.Doc({ guid: this.bodyId });
		Y.applyUpdate(this.state, request.snapshot, "semantic-reset");
		this.epoch++;
		const sequence = ++this.latestSequence;
		this.lease = null;
		this.policy = { lastCompactedAt: now, postCompactionEncodedStateBytes: request.snapshot.byteLength };
		this.resets.push({
			at: now, holder: from, previousEpoch, epoch: this.epoch, coveredSequence: request.coveredSequence,
			sequence, snapshotBytes: request.snapshot.byteLength, contentHash: request.contentHash,
		});
		this.resetAttempts.push({ from, ok: true });
		this.broadcast({ type: "fence", epoch: this.epoch, sequence }, from);
		return { ok: true, epoch: this.epoch, previousEpoch, sequence, fencedSockets: this.subscribers.size - (this.subscribers.has(from) ? 1 : 0) };
	}

	fetchBody(): BodyStateResponse {
		return { epoch: this.epoch, headSequence: this.latestSequence, encodedState: this.encodedState() };
	}
}

/** Per-device transport with optional latency (for race tests). */
export class MockTransport implements ResetTransport {
	constructor(
		private readonly server: MockRelayBody,
		private readonly deviceId: string,
		readonly latency: { lease?: number; reset?: number; fetch?: number } = {},
	) {}
	private async delay(ms: number | undefined): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms ?? 0)); }
	async requestLease(_bodyId: string, request: LeaseRequest): Promise<LeaseResponse> {
		await this.delay(this.latency.lease);
		return this.server.requestLease(this.deviceId, request);
	}
	async semanticReset(_bodyId: string, request: SemanticResetRequest): Promise<SemanticResetResponse> {
		await this.delay(this.latency.reset);
		return this.server.semanticReset(this.deviceId, request);
	}
	async fetchBody(): Promise<BodyStateResponse> {
		await this.delay(this.latency.fetch);
		return this.server.fetchBody();
	}
	async releaseLease(_bodyId: string, leaseId: string): Promise<void> { this.server.releaseLease(this.deviceId, leaseId); }
}

const LOCAL = "sim-local";

/** A simulated client with the note loaded. */
export class SimDevice implements ResetBodyHandle {
	readonly bodyId: string;
	readonly transport: MockTransport;
	private currentDoc: Y.Doc;
	private currentEpoch: number;
	private baseline: string;
	private applied: number;
	private pending: Uint8Array[] = [];
	private isOnline = false;
	private rebasing: Promise<RebaseOutcome | null> | null = null;
	/** Rebase was refused and no conflict hook exists: the device keeps its old-epoch doc and stops sending. */
	failedClosed = false;
	/** Hold local updates instead of sending them (simulates an in-flight / not-yet-flushed edit). */
	holdOutgoing = false;
	readonly rebases: RebaseOutcome[] = [];
	/** Conflict copies written by preserveConflict (the user's intent survives here). */
	readonly conflictCopies: Array<{ epoch: number; kind: string; pendingMarkdown: string }> = [];
	/** Set false to model a client without a conflict-copy hook (fails closed). */
	conflictCopiesEnabled = true;
	readonly log: string[] = [];
	private detach: () => void = () => {};

	constructor(readonly deviceId: string, readonly server: MockRelayBody, options: { online?: boolean; latency?: MockTransport["latency"] } = {}) {
		this.bodyId = server.bodyId;
		this.transport = new MockTransport(server, deviceId, options.latency);
		const state = server.fetchBody();
		this.currentDoc = new Y.Doc({ guid: this.bodyId });
		Y.applyUpdate(this.currentDoc, state.encodedState, "load");
		this.currentEpoch = state.epoch;
		this.applied = state.headSequence;
		this.baseline = this.text();
		this.bind();
		if (options.online !== false) this.goOnline();
	}

	// ResetBodyHandle -------------------------------------------------------
	epoch(): number { return this.currentEpoch; }
	doc(): Y.Doc { return this.currentDoc; }
	durableBaseline(): string { return this.baseline; }
	appliedSequence(): number { return this.applied; }
	hasPendingLocal(): boolean { return this.pending.length > 0; }

	async installEpoch(transition: ReadySemanticEpochTransition, headSequence: number): Promise<void> {
		if (transition.bodyEpoch <= this.currentEpoch) throw new Error("stale semantic epoch");
		this.detach();
		this.currentDoc.destroy();
		this.currentDoc = transition.document;
		this.currentEpoch = transition.bodyEpoch;
		this.baseline = transition.authoritativeContent;
		this.applied = headSequence;
		this.pending = transition.rebasedUpdate ? [transition.rebasedUpdate] : [];
		this.bind();
		this.log.push(`install epoch=${transition.bodyEpoch} outcome=${transition.outcome} rebased=${transition.rebasedUpdate?.byteLength ?? 0}`);
		// Socket catch-up on the new epoch (anything appended to it since `headSequence`).
		if (this.isOnline) {
			const state = this.server.fetchBody();
			if (state.epoch === this.currentEpoch && state.headSequence !== this.applied) {
				Y.applyUpdate(this.currentDoc, state.encodedState, "remote");
				this.applied = state.headSequence;
			}
		}
		if (this.pending.length === 0) this.baseline = this.text();
		if (this.isOnline && !this.holdOutgoing) this.flush();
	}

	get preserveConflict(): ResetBodyHandle["preserveConflict"] {
		if (!this.conflictCopiesEnabled) return undefined;
		return async (result) => {
			this.conflictCopies.push({ epoch: result.nextBodyEpoch, kind: result.kind, pendingMarkdown: result.pendingMarkdown });
			this.log.push(`conflict copy (${result.kind})`);
		};
	}

	async awaitCurrent(sequence: number, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.isOnline) this.flush();
			if (!this.hasPendingLocal() && this.applied === this.server.latestSequence && this.applied >= sequence) return true;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return false;
	}

	// Device behaviour ------------------------------------------------------
	text(): string { return this.currentDoc.getText(BODY_TEXT_ROOT).toJSON(); }
	online(): boolean { return this.isOnline; }

	private bind(): void {
		const doc = this.currentDoc;
		const onUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin !== LOCAL) return;
			this.pending.push(update);
			if (this.isOnline && !this.holdOutgoing) this.flush();
		};
		doc.on("update", onUpdate);
		this.detach = () => doc.off("update", onUpdate);
	}

	edit(fn: (text: Y.Text) => void): void {
		this.currentDoc.transact(() => fn(this.currentDoc.getText(BODY_TEXT_ROOT)), LOCAL);
	}

	insertAt(index: number, content: string): void { this.edit((text) => text.insert(Math.min(index, text.length), content)); }
	append(content: string): void { this.edit((text) => text.insert(text.length, content)); }

	/** Send pending updates; on a 4409-style rejection, keep them and rebase. */
	flush(): void {
		if (this.rebasing || this.failedClosed) return;
		while (this.pending.length > 0) {
			const result = this.server.append(this.deviceId, this.currentEpoch, this.pending[0]!);
			if (!result.ok) {
				this.log.push(`fenced on append (device epoch ${this.currentEpoch}, server ${result.epoch})`);
				void this.rebase();
				return;
			}
			this.pending.shift();
			this.applied = result.sequence;
		}
		this.settle();
	}

	private settle(): void {
		if (this.pending.length === 0) this.baseline = this.text();
	}

	private onEvent(event: ServerEvent): void {
		if (event.type === "fence") {
			this.log.push(`fence → epoch ${event.epoch}`);
			void this.rebase();
			return;
		}
		if (event.epoch !== this.currentEpoch) return; // new-epoch traffic before install: covered by install catch-up
		Y.applyUpdate(this.currentDoc, event.update, "remote");
		this.applied = event.sequence;
		this.settle();
	}

	/** vaultSync rebaseBodyAcrossSemanticEpoch equivalent (serialized). */
	rebase(): Promise<RebaseOutcome | null> {
		if (this.rebasing) return this.rebasing;
		this.rebasing = (async () => {
			try {
				const outcome = await rebaseOntoCurrent(this, this.transport);
				this.rebases.push(outcome);
				this.log.push(`rebase ${outcome.status}`);
				// A client without a conflict-copy hook stays on the old epoch (fails closed).
				this.failedClosed = (outcome.status === "conflict" || outcome.status === "too-large") && !outcome.installed;
				return outcome;
			} finally {
				this.rebasing = null;
				if (this.isOnline && !this.holdOutgoing) this.flush();
			}
		})();
		return this.rebasing;
	}

	/** Wait for any in-flight rebase. */
	async idle(): Promise<void> {
		while (this.rebasing) await this.rebasing;
	}

	goOffline(): void {
		this.isOnline = false;
		this.server.unsubscribe(this.deviceId);
	}

	/** Reconnect: same epoch → catch up from the server; newer epoch → rebase; then flush. */
	goOnline(): void {
		this.isOnline = true;
		this.server.subscribe(this.deviceId, (event) => this.onEvent(event));
		const state = this.server.fetchBody();
		if (state.epoch !== this.currentEpoch) {
			void this.rebase();
			return;
		}
		if (state.headSequence !== this.applied) {
			Y.applyUpdate(this.currentDoc, state.encodedState, "remote");
			this.applied = state.headSequence;
		}
		if (!this.holdOutgoing) this.flush(); else this.settle();
	}

	release(): void {
		this.holdOutgoing = false;
		if (this.isOnline) this.flush();
	}

	destroy(): void {
		this.goOffline();
		this.detach();
		this.currentDoc.destroy();
	}
}
