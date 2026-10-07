/**
 * Shared engine state (one per LogEngine). The runtime modules (docRuntime,
 * liveIngest, sessionLoop, mirrorIo, maintenance) all hold this; it owns the
 * caches that mirror committed transactions (outbox, adopt map) and the
 * status / diagnostics surface.
 */

import type { Budgets, DeviceClass } from "../../core/limits";
import { CFG_STREAM, NS_STREAM, SNAP_STREAM, streamClass, streamDocId, type ClientFrameId, type ContentHash, type DeviceId, type DocId, type Seq, type StreamName } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { TimerHandle } from "../../ports/clock";
import type { RelaySession } from "../../ports/relay";
import type { DiagnosticsEvent, EnginePhase, KeyMissingReason, StatusSnapshot } from "../../protocol/status";
import { BlobTouch, committedBlobHashes } from "../blobs/touch";
import { TransferLink } from "../blobs/transferLink";
import { CheckpointState, type CheckpointDeps } from "../body/checkpoints";
import { DailyLimitNoticeGate } from "./dailyLimit";
import type { FrameCtx } from "../body/frames";
import type { HandleManager } from "../body/handles";
import { resolveRefRow, type RefDeps } from "../body/refs";
import type { Sender } from "../body/sender";
import type { GateCtx } from "../ingest/gate";
import type { Mut, OutboxRename, Repo } from "../store/repo";
import type { OutboxRecord } from "../store/schema";
import type { CatchUpDeps } from "../sync/catchUp";
import type { CfgRuntime } from "../sync/cfgRuntime";
import type { SnapRuntime } from "../sync/snapRuntime";
import type { KeyringRuntime } from "../keyring/keyringRuntime";
import { assertWritable, gatedBlob, gatedCrypto } from "../keyring/writeGate";
import type { NsRuntime } from "../sync/nsRuntime";
import type { DocRuntime } from "./docRuntime";
import type { LiveIngest } from "./liveIngest";
import type { MirrorWriter } from "./mirrorIo";
import { resolveBudgets, resolveTuning, type EngineOptions, type EngineTuning } from "./options";
import { OutboxCache } from "./outboxCache";
import type { SessionLoop } from "./sessionLoop";
import { buildStatus } from "./status";

export type EngineDeps = CatchUpDeps & CheckpointDeps & RefDeps & FrameCtx;
type Fields = Record<string, string | number | boolean | null>;
type Notice = { code: string; level: "info" | "warn" | "error"; atMs: number };
/** An own ns create in the outbox (EngineCtx.pendingCreates). */
export interface PendingCreate {
	readonly cfid: ClientFrameId;
	readonly live: boolean;
}

const DIAG_RING = 2_000;
const ERROR_NOTICES = new Set(["device-revoked", "upgrade-required", "epoch-changed", "vault-unclaimed", "vault-not-found"]);
const INFO_NOTICES = new Set(["recovered-from-mirror"]);

export function adoptKey(deviceId: DeviceId, cfid: ClientFrameId): string {
	return `${deviceId}\u0000${cfid}`;
}

export class EngineCtx {
	readonly ports: EnginePorts;
	readonly tuning: EngineTuning;
	readonly budgets: Budgets;
	readonly deviceClass: DeviceClass;
	readonly outbox = new OutboxCache();
	readonly ckpt = new CheckpointState();
	readonly gateCtx: Mut<GateCtx>;
	readonly deps: EngineDeps;
	/** R2 put policy and R3 send gate (e2ee-design §10.4). */
	readonly touch: BlobTouch;
	/** Aborts the blob store calls in flight when the session loop declares the link dead (blobs/transferLink.ts). */
	readonly blobLink = new TransferLink();
	private committedCache: { readonly key: readonly unknown[]; readonly hashes: ReadonlySet<ContentHash> } | null = null;
	repo!: Repo;
	ns!: NsRuntime;
	cfg!: CfgRuntime;
	snap!: SnapRuntime;
	handles!: HandleManager;
	sender!: Sender;
	docs!: DocRuntime;
	live!: LiveIngest;
	sess!: SessionLoop;
	mirror!: MirrorWriter;
	/** Opened right after the repo, before anything can seal (e2ee-design §12.4). */
	keyring!: KeyringRuntime;

	phase: EnginePhase = "starting";
	session: RelaySession | null = null;
	/** Bumped on every session start / end; stale callbacks compare it. */
	gen = 0;
	stopped = false;
	/** App backgrounded (DESIGN §i.4): lanes 3–4 (stale reads, compaction, checkpoints) wait. */
	background = false;
	readOnly = false;
	lastCloseCode: number | null = null;
	lastSyncedAtMs: number | null = null;
	dailyLimitUntilMono = 0;
	private readonly dailyLimitNotices = new DailyLimitNoticeGate();
	daily = { day: "", frames: 0 };
	/** Monotonic time the head hint was first seen above V with an idle live queue. */
	headAheadSince: number | null = null;
	/** Lazy T_sent batch (diagnostics only). */
	readonly sentPending = new Map<ClientFrameId, { attempts: number; atMs: number }>();
	/** (deviceId, provisional cfid) -> own adoptable cfid, and the reverse; adopt timers. */
	readonly adoptMap = new Map<string, ClientFrameId>();
	readonly adoptRev = new Map<ClientFrameId, string>();
	readonly adoptTimers = new Map<ClientFrameId, TimerHandle>();
	/**
	 * docId -> the own ns frame creating it: its body frames depend on it while it is in the outbox (§e.1). `live`:
	 * a create outside onboarding / the first reconcile pass; its body frames are pending, sent right after it.
	 */
	readonly pendingCreates = new Map<DocId, PendingCreate>();
	private readonly notices: Notice[] = [];
	private readonly ring: DiagnosticsEvent[] = [];
	private statusTimer: TimerHandle | null = null;
	readonly gate: () => KeyMissingReason | null;

	constructor(readonly opts: EngineOptions) {
		this.ports = opts.ports;
		this.deviceClass = opts.deviceClass ?? "desktop";
		this.tuning = resolveTuning(opts.tuning);
		this.budgets = resolveBudgets(this.deviceClass, opts.budgets);
		const c = this;
		// §14.3: held (reader-dependent) until the keyring is open.
		const staleCheck = (e: number, seq: Seq | null) => (c.keyring ? c.keyring.staleCheck(e, seq) : "hold" as const);
		this.gateCtx = { crypto: opts.ports.crypto, vaultId: opts.vaultId, maxCheckpointStateBytes: this.tuning.maxCheckpointStateBytes, staleCheck };
		// The one write gate (writeGate.ts): shut until the keyring is open, then whenever it reports key-missing.
		const gate = (): KeyMissingReason | null => (c.keyring ? c.keyring.keyMissing() : "no-pin");
		this.gate = gate;
		// Every blob write (upload, refresh PUT, GC delete) and every seal goes through the gate; every transfer is
		// tied to the link.
		const blob = this.blobLink.wrap(gatedBlob(opts.ports.blob, gate));
		const crypto = gatedCrypto(opts.ports.crypto, gate, () => c.keyring?.noteSeal());
		this.touch = new BlobTouch({
			store: blob,
			crypto,
			hash: opts.ports.hash,
			clock: opts.ports.clock,
			graceMs: this.tuning.blobGcGraceMs,
			times: () => c.repo,
			committed: () => c.committedBlobs(),
			blobBytes: (h) => opts.blobBytes?.(h) ?? Promise.resolve(null),
			onReady: () => c.sender?.poke(),
			diag: (code, fields) => c.diag(code, fields),
		});
		this.deps = {
			get repo() {
				return c.repo;
			},
			outbox: this.outbox,
			resolveRef: (row) => resolveRefRow(c.deps, row),
			nowMs: () => c.now(),
			gateCtx: this.gateCtx,
			hash: opts.ports.hash,
			crypto,
			random: opts.ports.random,
			blob,
			touch: this.touch,
			self: opts.deviceId,
			vaultId: opts.vaultId,
			adoptFor: (d, f) => c.adoptFor(d, f),
			diag: (code, fields) => c.diag(code, fields),
			monotonic: () => c.mono(),
			authorNsSeq: () => c.ns.coversSeq,
			onForbidden: () => c.onForbidden(),
		};
	}

	get self(): DeviceId {
		return this.opts.deviceId;
	}
	now(): number {
		return this.ports.clock.now();
	}
	mono(): number {
		return this.ports.clock.monotonic();
	}
	day(): string {
		return new Date(this.now()).toISOString().slice(0, 10);
	}

	diag(code: string, fields: Fields = {}): void {
		const ev: DiagnosticsEvent = { atMs: this.now(), code, fields };
		this.ring.push(ev);
		if (this.ring.length > DIAG_RING) this.ring.splice(0, this.ring.length - DIAG_RING);
		this.opts.onDiag?.(ev);
	}
	diagnostics(): readonly DiagnosticsEvent[] {
		return this.ring;
	}

	notice(code: string): void {
		const level = ERROR_NOTICES.has(code) ? "error" : INFO_NOTICES.has(code) ? "info" : "warn";
		const i = this.notices.findIndex((n) => n.code === code);
		if (i >= 0) this.notices.splice(i, 1);
		this.notices.push({ code, level, atMs: this.now() });
		if (this.notices.length > 20) this.notices.shift();
		this.scheduleStatus();
	}
	/** Relay refused with cf_daily_limit (append or connect): one host popup per reset window. */
	dailyLimitPopup(retryAfterMs: number | null): void {
		const text = this.dailyLimitNotices.trip(this.now(), retryAfterMs);
		if (text !== null) this.opts.onHostNotice?.("warn", "daily-limit", text);
	}
	noticeList(): readonly Notice[] {
		return [...this.notices];
	}
	clearNotice(code: string): void {
		const i = this.notices.findIndex((n) => n.code === code);
		if (i >= 0) this.notices.splice(i, 1);
	}

	setPhase(p: EnginePhase): void {
		if (this.phase === p) return;
		this.diag("phase", { from: this.phase, to: p });
		this.phase = p;
		this.scheduleStatus();
	}

	/** The phase of a caught-up session: key-missing while the write gate is shut (e2ee-design §9.3). */
	livePhase(): EnginePhase {
		if (this.gate() !== null) return "key-missing";
		return this.dailyLimitUntilMono > this.mono() ? "daily-limit" : "live";
	}

	/** Host write entry points: refuse up front while the gate is shut (the seal would refuse anyway). */
	assertWritable(): void {
		assertWritable(this.gate);
	}

	onForbidden(): void {
		if (this.readOnly) return;
		this.readOnly = true;
		this.notice("read-only");
	}

	/** Mirror committed outbox transitions into the cache, the sender and the adopt map. */
	applyOutboxResult(res: { readonly removed: readonly OutboxRecord[]; readonly updated: readonly OutboxRecord[]; readonly renamed?: readonly OutboxRename[] }): void {
		const drained = new Set<StreamName>();
		for (const r of res.removed) {
			const cls = streamClass(r.stream);
			if (cls === "body" || cls === "canvas") drained.add(r.stream);
			// ns/cfg/snap records leave the outbox only on (late) receipt: keep them in the overlay until folded.
			if (r.stream === NS_STREAM) this.ns.noteCommitted(r);
			else if (r.stream === CFG_STREAM) this.cfg.noteCommitted(r);
			else if (r.stream === SNAP_STREAM) this.snap.noteCommitted(r);
			this.outbox.delete(r.clientFrameId);
			this.sender.remove(r.clientFrameId);
			this.sentPending.delete(r.clientFrameId);
			this.unregisterAdopt(r.clientFrameId);
		}
		// Re-sealed (e2ee-design §14.2 step 4): not committed, so no fold note and the doc is not drained.
		for (const { old, next } of res.renamed ?? []) {
			if (next.clientFrameId !== old.clientFrameId) {
				this.outbox.delete(old.clientFrameId);
				this.sender.remove(old.clientFrameId);
				this.sentPending.delete(old.clientFrameId);
				this.unregisterAdopt(old.clientFrameId);
				for (const [doc, p] of this.pendingCreates) if (p.cfid === old.clientFrameId) this.pendingCreates.set(doc, { ...p, cfid: next.clientFrameId });
			}
			this.outbox.put(next);
			this.sender.upsert(next);
		}
		for (const r of res.updated) {
			if (!this.outbox.has(r.clientFrameId)) continue; // removed later in the same result
			this.outbox.put(r);
			this.sender.upsert(r);
			if (r.state !== "adoptable") this.unregisterAdopt(r.clientFrameId);
		}
		if (res.removed.length > 0 || res.updated.length > 0 || (res.renamed?.length ?? 0) > 0) {
			this.mirror.schedule();
			this.scheduleStatus();
		}
		const settled: DocId[] = [];
		for (const s of drained) {
			const d = streamDocId(s);
			if (d && this.outbox.ofStream(s).length === 0) settled.push(d);
		}
		if (settled.length > 0) this.emit("onOwnBodySettled", () => this.opts.onOwnBodySettled?.(settled));
	}

	/** New own records (T_edit / T_adopt). */
	addOutbox(recs: readonly OutboxRecord[]): void {
		for (const r of recs) {
			this.outbox.put(r);
			if (r.state === "adoptable") this.registerAdopt(r);
			else this.sender.upsert(r);
		}
		this.mirror.schedule();
		this.scheduleStatus();
	}

	registerAdopt(r: OutboxRecord): void {
		if (!r.adoptOf || r.state !== "adoptable") return;
		const key = adoptKey(r.adoptOf.deviceId, r.adoptOf.clientFrameId);
		this.adoptMap.set(key, r.clientFrameId);
		this.adoptRev.set(r.clientFrameId, key);
		const old = this.adoptTimers.get(r.clientFrameId);
		if (old !== undefined) this.ports.clock.clearTimer(old);
		const wait = Math.max(0, r.adoptOf.receivedAtMs + this.tuning.provisionalAdoptMs - this.now());
		this.adoptTimers.set(r.clientFrameId, this.ports.clock.setTimer(wait, () => {
			this.adoptTimers.delete(r.clientFrameId);
			void this.docs.adoptToPending(r.clientFrameId, "timeout");
		}));
	}
	unregisterAdopt(cfid: ClientFrameId): void {
		const key = this.adoptRev.get(cfid);
		if (key !== undefined) {
			this.adoptRev.delete(cfid);
			if (this.adoptMap.get(key) === cfid) this.adoptMap.delete(key);
		}
		const t = this.adoptTimers.get(cfid);
		if (t !== undefined) {
			this.ports.clock.clearTimer(t);
			this.adoptTimers.delete(cfid);
		}
	}
	/** Own adoptable shadowing (deviceId, cfid), if still adoptable (DESIGN §d.5 settle). */
	adoptFor(deviceId: DeviceId, cfid: ClientFrameId): ClientFrameId | null {
		const own = this.adoptMap.get(adoptKey(deviceId, cfid));
		if (!own) return null;
		return this.outbox.get(own)?.state === "adoptable" ? own : null;
	}

	/**
	 * Fold newly available ns rows (reload: snapshot replaced, refold from it), then release / delete held
	 * records whose create folded (DESIGN §e.1), then report the folded frames.
	 */
	async afterNsChange(reload = false): Promise<void> {
		const folded = reload ? await this.ns.load() : await this.ns.advance();
		const changes = this.ns.reconcileHeld(this.outbox);
		if (changes.length > 0) this.applyOutboxResult(await this.repo.tOutbox(changes));
		if (folded.length > 0 || reload) this.emit("onNsFold", () => this.opts.onNsFold?.(folded, reload));
	}

	/** Fold newly available cfg rows (reload: snapshot replaced) and report them. */
	async afterCfgChange(reload = false): Promise<void> {
		const folded = reload ? await this.cfg.load() : await this.cfg.advance();
		if (folded.length === 0 && !reload) return;
		const events = folded.flatMap((f) => f.events);
		this.emit("onCfgFold", () => this.opts.onCfgFold?.(events, reload));
	}

	/** Fold newly available snap rows (reload: snapshot replaced). The index is read on demand (snapView). */
	async afterSnapChange(reload = false): Promise<void> {
		const before = this.snap.unknownVersions;
		const folded = reload ? await this.snap.load() : await this.snap.advance();
		if (this.snap.unknownVersions > before) this.diag("snap-unknown-version", { ops: this.snap.unknownVersions - before });
		if (folded.length > 0 || reload) this.diag("snap-fold", { frames: folded.length, coversSeq: this.snap.coversSeq, reload });
	}

	/** onBodyChange for the body / canvas streams among `streams` (deduped; nothing if none). */
	noteBodyChange(streams: Iterable<StreamName>): void {
		const ids = new Set<DocId>();
		for (const s of streams) {
			const cls = streamClass(s);
			const d = cls === "body" || cls === "canvas" ? streamDocId(s) : null;
			if (d) ids.add(d);
		}
		if (ids.size > 0) this.emit("onBodyChange", () => this.opts.onBodyChange?.([...ids]));
	}

	/** Host callback; a throwing callback is logged, never breaks the engine. */
	emit(name: string, fn: () => void): void {
		try {
			fn();
		} catch (e) {
			this.diag("callback-failed", { name, error: String(e) });
		}
	}

	/**
	 * Blob hashes the committed ns / cfg / snap folds reference (blobs/touch.ts committedBlobHashes), or null when
	 * the folds may be behind the relay: no session or live queue, a fold stream stale or halted.
	 */
	committedBlobs(): ReadonlySet<ContentHash> | null {
		if (!this.session || !this.live?.enabled) return null;
		for (const rt of [this.ns, this.cfg, this.snap]) {
			if (rt.halted || this.repo.stream(rt.stream)?.stale === 1) return null;
		}
		const key = [this.ns.state, this.ns.coversSeq, this.cfg.state, this.cfg.coversSeq, this.snap.state, this.snap.coversSeq];
		const hit = this.committedCache;
		if (hit && hit.key.every((k, i) => k === key[i])) return hit.hashes;
		const hashes = committedBlobHashes(this.ns.state, this.cfg.state, this.snap.state);
		this.committedCache = { key, hashes };
		return hashes;
	}

	/** Own ns create of `docId` still in the outbox (the dependency of its body frames), else null. */
	createDependency(docId: DocId): PendingCreate | null {
		const p = this.pendingCreates.get(docId);
		if (p === undefined) return null;
		if (this.outbox.has(p.cfid)) return p;
		this.pendingCreates.delete(docId);
		return null;
	}

	async freeze(stream: StreamName, reason: string): Promise<void> {
		const rec = this.repo.stream(stream);
		if (rec?.frozen && rec.frozenReason === reason) return;
		await this.repo.tPatchStreams([{ stream, patch: (r) => {
			r.frozen = 1;
			r.frozenReason = reason;
		} }], this.now());
		this.frozen(stream, reason, rec?.cls ?? null);
	}

	/** A stream just froze (freeze, or a quarantine record put by an ingest): notice, and the host retargets its views. */
	frozen(stream: StreamName, reason: string, cls: string | null): void {
		this.diag("doc-frozen", { reason, cls });
		this.notice(`frozen:${reason}`);
		const docId = streamDocId(stream);
		if (docId) this.emit("onDocFrozen", () => this.opts.onDocFrozen?.(docId, reason));
	}

	/** Open-frame timer multiplier: x4 beyond the daily soft frame budget (DESIGN §i.6). */
	frameStretch(): number {
		const over = this.daily.day === this.day() && this.daily.frames > this.budgets.dailyFrameSoftBudget;
		return this.tuning.frameStretch * (over ? 4 : 1);
	}

	countReceipts(n: number): void {
		const d = this.day();
		if (this.daily.day !== d) this.daily = { day: d, frames: 0 };
		this.daily.frames += n;
	}

	scheduleStatus(): void {
		if (!this.opts.onStatus || this.statusTimer !== null || this.stopped) return;
		this.statusTimer = this.ports.clock.setTimer(this.tuning.statusIntervalMs, () => {
			this.statusTimer = null;
			if (this.repo && this.keyring) this.opts.onStatus?.(this.status());
		});
	}
	clearStatusTimer(): void {
		if (this.statusTimer !== null) this.ports.clock.clearTimer(this.statusTimer);
		this.statusTimer = null;
	}
	status(): StatusSnapshot {
		return buildStatus(this);
	}
}

