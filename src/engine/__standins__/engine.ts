/**
 * STAND-IN for WP-C's engine/runtime/engine.ts createEngine.
 * INTEGRATION: host/plugin.ts, engine/workerMain.ts and the sim switch to
 *   createEngine(transport, { carrier, makePorts(config) }) from engine/runtime/engine.
 *
 * Speaks the real protocol (§g) so the host, transports and simulation are
 * exercised end to end: ping in every phase, init -> ready, observations ->
 * readRequest -> ingest, openDoc -> bind, localUpdate/bindDelta, docUpdate
 * within docCredit (FIFO, full-state resync above 4x window), boundSaved,
 * closeDoc -> projection, diskOps with preconditions. Path-keyed docs, a
 * StandinHub instead of a relay, markdown only, no deletes/renames.
 */

import * as Y from "yjs";
import { BUDGETS } from "../../core/limits";
import type { DocId, MergeFn } from "../../core/types";
import type { ClockPort } from "../../ports/clock";
import type { HashPort } from "../../ports/crypto";
import type { ProtocolError } from "../../protocol/errors";
import type { EngineInitConfig, EngineResultValue, EngineToMain, MainResultValue, MainToEngine } from "../../protocol/messages";
import type { EngineTransport } from "../../protocol/transport";
import { owned, postOwned } from "../../protocol/workerTransport";
import { HUB_IN, MAIN_IN, LOAD, conservativeMerge, newDocState, persistedOf, statusSnapshot, type DocState, type StandinStore } from "./docs";
import { LOCAL_DISK, isSyncedPath, project, readPaths, type HostRequestBody, type SyncCtx } from "./diskSync";
import type { HubMemberHandle, StandinHub } from "./hub";
import { handleMessage } from "./engineMessages";

export { HUB_IN, MAIN_IN, LOAD };

export interface StandinEngineOptions {
	readonly carrier: "worker" | "inline";
	readonly clock: ClockPort;
	readonly hash: HashPort;
	/** Shared in-memory relay (sim). null = local only. */
	readonly hub?: StandinHub | null;
	/** Hub member id; defaults to config.deviceId. */
	readonly memberId?: string;
	/** Survives engine restarts (sim "IndexedDB"). Without it docIds are per incarnation. */
	readonly store?: StandinStore | null;
	/** Delay before a change is persisted (0 = synchronous). Unpersisted changes die with the engine. */
	readonly persistDelayMs?: number;
	readonly merge?: MergeFn;
	/** Fail init with this error (OR-1 storage failure simulation). */
	readonly initError?: ProtocolError | null;
}

export interface StandinEngineHandle {
	dispose(): void;
	readonly engine: StandinEngine;
}

export function createStandinEngine(transport: EngineTransport, options: StandinEngineOptions): StandinEngineHandle {
	const engine = new StandinEngine(transport, options);
	return { engine, dispose: () => engine.dispose() };
}

let incarnation = 0;

export class StandinEngine implements SyncCtx {
	config: EngineInitConfig | null = null;
	disposed = false;
	member: HubMemberHandle | null = null;
	readonly docs = new Map<string, DocState>();
	readonly byDocId = new Map<DocId, DocState>();
	readonly waiting = new Set<string>();
	readonly merge: MergeFn;
	readonly hash: HashPort;
	readonly stats = { reads: 0, projections: 0, conflictCopies: 0, ingests: 0, docUpdatesSent: 0, resyncs: 0, localUpdates: 0 };
	private readonly token = `${++incarnation}`;
	private nextRid = 1;
	private readonly pending = new Map<number, { resolve(v: MainResultValue): void; reject(e: ProtocolError): void }>();
	private readonly offs: (() => void)[] = [];
	// docUpdate flow control (§g.3): one credit per docUpdate, FIFO.
	private creditUsed = 0;
	private readonly outQ = new Map<DocId, { parts: Uint8Array[]; bytes: number; resync: boolean }>();
	readonly seen = new Map<string, { size: number; mtimeMs: number }>();

	constructor(
		readonly transport: EngineTransport,
		readonly options: StandinEngineOptions,
	) {
		this.merge = options.merge ?? conservativeMerge;
		this.hash = options.hash;
		this.offs.push(transport.onMessage((m) => this.onMessage(m)));
	}

	get deviceLabel(): string {
		return this.config?.deviceLabel ?? "device";
	}

	get window(): number {
		return BUDGETS[this.config?.deviceClass ?? "desktop"].docUpdateWindowBytes;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const off of this.offs) off();
		this.member?.leave();
		this.member = null;
		for (const st of this.docs.values()) {
			if (st.persistTimer !== null) this.options.clock.clearTimer(st.persistTimer);
			st.doc.destroy();
		}
	}

	// --- SyncCtx --------------------------------------------------------------

	keyOf(path: string): string {
		return path.normalize("NFC").toLowerCase();
	}

	doc(key: string): DocState | undefined {
		return this.docs.get(key);
	}

	addDoc(key: string, path: string): DocState {
		const docId = (this.options.store ? `d:${key}` : `d:${this.token}:${key}`) as DocId;
		const st = newDocState(key, docId, path);
		this.docs.set(key, st);
		this.byDocId.set(docId, st);
		st.doc.on("update", (update: Uint8Array, origin: unknown) => this.onDocUpdate(st, update, origin));
		const hubState = this.member?.state(key);
		if (hubState) Y.applyUpdate(st.doc, hubState, LOAD);
		return st;
	}

	persist(st: DocState): void {
		const store = this.options.store;
		if (!store || this.disposed) return;
		const delay = this.options.persistDelayMs ?? 0;
		if (delay <= 0) {
			store.set(st.key, persistedOf(st));
			return;
		}
		if (st.persistTimer !== null) return;
		st.persistTimer = this.options.clock.setTimer(delay, () => {
			st.persistTimer = null;
			if (!this.disposed) store.set(st.key, persistedOf(st));
		});
	}

	persistNow(st: DocState): void {
		const store = this.options.store;
		if (!store || this.disposed) return;
		if (st.persistTimer !== null) {
			this.options.clock.clearTimer(st.persistTimer);
			st.persistTimer = null;
		}
		store.set(st.key, persistedOf(st));
	}

	post(message: EngineToMain): void {
		if (this.disposed) return;
		postOwned(this.transport, message);
	}

	hostRequest(body: HostRequestBody): Promise<MainResultValue> {
		return new Promise((resolve, reject) => {
			if (this.disposed) return reject({ code: "aborted", message: "engine disposed", retryable: true } satisfies ProtocolError);
			const rid = this.nextRid++;
			this.pending.set(rid, { resolve, reject });
			this.post({ ...body, rid } as EngineToMain);
		});
	}

	later(ms: number, fn: () => void): void {
		if (this.disposed) return;
		this.options.clock.setTimer(ms, () => {
			if (!this.disposed) fn();
		});
	}

	answer(rid: number, value: EngineResultValue): void {
		this.post({ t: "result", re: rid, value });
	}

	fail(rid: number, error: ProtocolError): void {
		this.post({ t: "error", re: rid, error });
	}

	settle(re: number, value: MainResultValue | null, error: ProtocolError | null): void {
		const p = this.pending.get(re);
		if (!p) return;
		this.pending.delete(re);
		if (error) p.reject(error);
		else p.resolve(value as MainResultValue);
	}

	// --- hub ------------------------------------------------------------------

	joinHub(): void {
		const hub = this.options.hub;
		if (!hub || !this.config) return;
		this.member = hub.join(this.options.memberId ?? this.config.deviceId, {
			onUpdate: (key, path, update) => {
				if (this.disposed) return;
				let st = this.docs.get(key);
				if (!st) {
					st = this.addDoc(key, path); // applies the hub state; projection below
					project(this, st);
				}
				Y.applyUpdate(st.doc, update, HUB_IN);
			},
		});
		// Publish what we hold (idempotent at the hub); covers updates applied while not joined.
		for (const st of this.docs.values()) this.member.publish(st.key, Y.encodeStateAsUpdate(st.doc));
	}

	// --- doc updates ----------------------------------------------------------

	private onDocUpdate(st: DocState, update: Uint8Array, origin: unknown): void {
		if (this.disposed) return;
		if (origin !== HUB_IN && origin !== LOAD) this.member?.publish(st.key, update);
		if (st.bound.size > 0) {
			if (origin !== MAIN_IN && origin !== LOAD) this.queueDocUpdate(st, update);
		} else if (origin === HUB_IN) {
			project(this, st);
		}
		if (origin !== LOAD) this.persist(st);
	}

	queueDocUpdate(st: DocState, update: Uint8Array): void {
		let q = this.outQ.get(st.docId);
		if (!q) {
			q = { parts: [], bytes: 0, resync: false };
			this.outQ.set(st.docId, q);
		}
		if (!q.resync) {
			q.parts.push(update.slice());
			q.bytes += update.byteLength;
			if (q.bytes > 4 * this.window) {
				q.resync = true;
				q.parts = [];
				q.bytes = 0;
			}
		}
		this.pump();
	}

	dropDocUpdates(docId: DocId): void {
		this.outQ.delete(docId);
	}

	onCredit(bytes: number): void {
		this.creditUsed = Math.max(0, this.creditUsed - bytes);
		this.pump();
	}

	private pump(): void {
		for (const [docId, q] of [...this.outQ]) {
			const st = this.byDocId.get(docId);
			if (!st || st.bound.size === 0) {
				this.outQ.delete(docId);
				continue;
			}
			const update = q.resync ? Y.encodeStateAsUpdate(st.doc) : q.parts.length === 1 ? (q.parts[0] as Uint8Array) : Y.mergeUpdates(q.parts);
			if (this.creditUsed > 0 && this.creditUsed + update.byteLength > this.window) return;
			this.outQ.delete(docId);
			this.creditUsed += update.byteLength;
			this.stats.docUpdatesSent++;
			if (q.resync) this.stats.resyncs++;
			this.post({ t: "docUpdate", docId, update: owned(update), origin: q.resync ? "resync" : "remote" });
		}
	}

	private onMessage(m: MainToEngine): void {
		if (this.disposed) return;
		handleMessage(this, m);
	}

	// used by engineMessages
	loadStore(): boolean {
		const store = this.options.store;
		if (!store) return false;
		for (const [key, p] of store) {
			const st = this.addDoc(key, p.path);
			Y.applyUpdate(st.doc, p.state, LOAD);
			st.base = p.base;
			st.diskText = p.diskText;
			st.diskFp = p.diskFp;
		}
		return store.size > 0;
	}

	scanChunk(stats: readonly { readonly path: string; readonly size: number; readonly mtimeMs: number }[]): void {
		const toRead: string[] = [];
		for (const s of stats) {
			if (!isSyncedPath(s.path)) continue;
			const key = this.keyOf(s.path);
			const prev = this.seen.get(key);
			this.seen.set(key, { size: s.size, mtimeMs: s.mtimeMs });
			if (!prev || prev.size !== s.size || prev.mtimeMs !== s.mtimeMs || !this.docs.has(key)) toRead.push(s.path);
		}
		if (toRead.length > 0) void readPaths(this, toRead);
	}

	postStatus(): void {
		if (!this.config) return;
		const online = this.member ? (this.options.hub?.isOnline(this.member.id) ?? false) : false;
		this.post({ t: "status", status: statusSnapshot({ deviceClass: this.config.deviceClass, transport: this.options.carrier, liveDocs: this.docs.size, residentDocs: this.docs.size, pendingDiskOps: 0, online, nowMs: this.options.clock.now() }) });
	}
}

export { LOCAL_DISK };
