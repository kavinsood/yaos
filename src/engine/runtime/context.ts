/**
 * Shared engine state (one per LogEngine). The runtime modules (docRuntime,
 * liveIngest, sessionLoop, mirrorIo, maintenance) all hold this; it owns the
 * caches that mirror committed transactions (outbox, adopt map) and the
 * status / diagnostics surface.
 */

import type { Budgets, DeviceClass } from "../../core/limits";
import { streamDocId, type ClientFrameId, type DeviceId, type StreamName } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { TimerHandle } from "../../ports/clock";
import type { RelaySession } from "../../ports/relay";
import type { DiagnosticsEvent, EnginePhase, StatusSnapshot } from "../../protocol/status";
import { CheckpointState, type CheckpointDeps } from "../body/checkpoints";
import type { FrameCtx } from "../body/frames";
import type { HandleManager } from "../body/handles";
import { resolveRefRow, type RefDeps } from "../body/refs";
import type { Sender } from "../body/sender";
import type { GateCtx } from "../ingest/gate";
import type { Mut, Repo } from "../store/repo";
import type { OutboxRecord } from "../store/schema";
import type { CatchUpDeps } from "../sync/catchUp";
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
	repo!: Repo;
	ns!: NsRuntime;
	handles!: HandleManager;
	sender!: Sender;
	docs!: DocRuntime;
	live!: LiveIngest;
	sess!: SessionLoop;
	mirror!: MirrorWriter;

	phase: EnginePhase = "starting";
	session: RelaySession | null = null;
	/** Bumped on every session start / end; stale callbacks compare it. */
	gen = 0;
	stopped = false;
	readOnly = false;
	lastCloseCode: number | null = null;
	lastSyncedAtMs: number | null = null;
	dailyLimitUntilMono = 0;
	daily = { day: "", frames: 0 };
	/** Monotonic time the head hint was first seen above V with an idle live queue. */
	headAheadSince: number | null = null;
	/** Lazy T_sent batch (diagnostics only). */
	readonly sentPending = new Map<ClientFrameId, { attempts: number; atMs: number }>();
	/** (deviceId, provisional cfid) -> own adoptable cfid, and the reverse; adopt timers. */
	readonly adoptMap = new Map<string, ClientFrameId>();
	readonly adoptRev = new Map<ClientFrameId, string>();
	readonly adoptTimers = new Map<ClientFrameId, TimerHandle>();
	private readonly notices: Notice[] = [];
	private readonly ring: DiagnosticsEvent[] = [];
	private statusTimer: TimerHandle | null = null;

	constructor(readonly opts: EngineOptions) {
		this.ports = opts.ports;
		this.deviceClass = opts.deviceClass ?? "desktop";
		this.tuning = resolveTuning(opts.tuning);
		this.budgets = resolveBudgets(this.deviceClass, opts.budgets);
		this.gateCtx = { crypto: opts.ports.crypto, vaultId: opts.vaultId, maxCheckpointStateBytes: this.tuning.maxCheckpointStateBytes };
		const c = this;
		this.deps = {
			get repo() {
				return c.repo;
			},
			outbox: this.outbox,
			resolveRef: (row) => resolveRefRow(c.deps, row),
			nowMs: () => c.now(),
			gateCtx: this.gateCtx,
			hash: opts.ports.hash,
			crypto: opts.ports.crypto,
			random: opts.ports.random,
			blob: opts.ports.blob,
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

	onForbidden(): void {
		if (this.readOnly) return;
		this.readOnly = true;
		this.notice("read-only");
	}

	/** Mirror committed outbox transitions into the cache, the sender and the adopt map. */
	applyOutboxResult(res: { readonly removed: readonly OutboxRecord[]; readonly updated: readonly OutboxRecord[] }): void {
		for (const r of res.removed) {
			this.outbox.delete(r.clientFrameId);
			this.sender.remove(r.clientFrameId);
			this.sentPending.delete(r.clientFrameId);
			this.unregisterAdopt(r.clientFrameId);
		}
		for (const r of res.updated) {
			if (!this.outbox.has(r.clientFrameId)) continue; // removed later in the same result
			this.outbox.put(r);
			this.sender.upsert(r);
			if (r.state !== "adoptable") this.unregisterAdopt(r.clientFrameId);
		}
		if (res.removed.length > 0 || res.updated.length > 0) {
			this.mirror.schedule();
			this.scheduleStatus();
		}
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

	/** Fold newly available ns rows, then release / delete held records whose create folded (DESIGN §e.1). */
	async afterNsChange(): Promise<void> {
		await this.ns.advance();
		const changes = this.ns.reconcileHeld(this.outbox);
		if (changes.length > 0) this.applyOutboxResult(await this.repo.tOutbox(changes));
	}

	async freeze(stream: StreamName, reason: string): Promise<void> {
		const rec = this.repo.stream(stream);
		if (rec?.frozen && rec.frozenReason === reason) return;
		await this.repo.tPatchStreams([{ stream, patch: (r) => {
			r.frozen = 1;
			r.frozenReason = reason;
		} }], this.now());
		this.diag("doc-frozen", { reason, cls: rec?.cls ?? null });
		this.notice(`frozen:${reason}`);
		const docId = streamDocId(stream);
		if (docId) this.opts.onDocFrozen?.(docId, reason);
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
			if (this.repo) this.opts.onStatus?.(this.status());
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

