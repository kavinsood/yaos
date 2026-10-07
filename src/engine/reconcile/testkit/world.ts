/**
 * Test world for the reconcile job: FakeVault + FakeGateway + FakeStorage +
 * StubLog + FakeBlobs + FakeClock wired into one Reconciler. Vault events are
 * buffered and delivered after the op that caused them (like the real host,
 * which posts events after the diskOps result).
 */

import type { BrakeConfig, BrakeReport, DocId, PathKey, SyncedEntry, VaultPath } from "../../../core/types";
import { DEFAULT_BRAKE } from "../../../core/plan/brake";
import type { VaultEvent } from "../../../ports/vault";
import { DB_SCHEMA_VERSION, STORE_SPECS } from "../../store/schema";
import type { ReconcileSettings } from "../context";
import type { OwnFoldEvent } from "../deps";
import { Reconciler } from "../reconciler";
import type { DiskSchema } from "../store";
import { FakeBlobs, FakeClock, FakeRandom } from "./fakes";
import { FakeGateway } from "./fakeGateway";
import { FakeStorage } from "./fakeStorage";
import { FakeVault } from "./fakeVault";
import { StubLog } from "./stubLog";

export interface WorldOptions {
	readonly caseInsensitive?: boolean;
	readonly blobs?: boolean;
	readonly brake?: Partial<BrakeConfig>;
	readonly settings?: Partial<ReconcileSettings>;
	readonly deviceLabel?: string;
	/** §c.12 path-keyed bases from the previous epoch (ReconcilerDeps.pathBase). */
	readonly pathBases?: ReadonlyMap<string, string>;
	/** Queue own fold events for the reconciler to take (ReconcilerDeps.takeOwnFold), as the vault runtime does. */
	readonly deferOwnFold?: boolean;
}

export const DB = "yaos2-test";

export class World {
	readonly storage = new FakeStorage();
	readonly clock = new FakeClock();
	readonly vault: FakeVault;
	readonly gateway: FakeGateway;
	readonly log = new StubLog();
	readonly blobs: FakeBlobs | null;
	readonly random = new FakeRandom(7);
	readonly pending: VaultEvent[] = [];
	readonly notices: { level: string; code: string; message: string }[] = [];
	readonly brakes: BrakeReport[] = [];
	/** ReconcilerDeps.onConflictCopy calls: [from, to]. */
	readonly conflictCopyEvents: [VaultPath, VaultPath][] = [];
	readonly ownQueue: OwnFoldEvent[] = [];
	/** ReconcilerDeps.onRebind calls: [from, into]. */
	readonly rebinds: [DocId, DocId][] = [];
	private rec: Reconciler | null = null;

	constructor(readonly opts: WorldOptions = {}) {
		this.vault = new FakeVault(opts.caseInsensitive ?? false, () => this.clock.now());
		this.vault.onEvent((e) => this.pending.push(e));
		this.gateway = new FakeGateway(this.vault);
		this.blobs = opts.blobs === false ? null : new FakeBlobs();
	}

	get r(): Reconciler {
		if (!this.rec) throw new Error("world not booted");
		return this.rec;
	}

	/** Open a Reconciler over the current storage, resume intents, deliver the full listing. */
	async boot(): Promise<Reconciler> {
		const db = await this.storage.open<DiskSchema>(DB, DB_SCHEMA_VERSION, STORE_SPECS);
		const rec = await Reconciler.open({
			db, log: this.log, disk: this.gateway, clock: this.clock, random: this.random, blobs: this.blobs,
			settings: { excludePatterns: [], syncAttachments: true, maxAttachmentBytes: 8 * 1024 * 1024, trashMode: "obsidian-trash", ...this.opts.settings },
			deviceLabel: this.opts.deviceLabel ?? "laptop",
			brake: { ...DEFAULT_BRAKE, ...this.opts.brake },
			notice: (level, code, message) => this.notices.push({ level, code, message }),
			onBrake: (report) => this.brakes.push(report),
			onConflictCopy: (from, to) => this.conflictCopyEvents.push([from, to]),
			onRebind: (from, into) => this.rebinds.push([from, into]),
			pathBase: this.opts.pathBases ? (key) => this.opts.pathBases!.get(key) ?? null : undefined,
			pathBaseKeys: this.opts.pathBases ? new Set([...this.opts.pathBases.keys()] as PathKey[]) : undefined,
			...(this.opts.deferOwnFold ? { takeOwnFold: () => this.ownQueue.splice(0) } : {}),
		});
		this.log.onOwnFold = this.opts.deferOwnFold ? async (events) => void this.ownQueue.push(...events) : (events) => rec.applyOwnFold(events);
		this.rec = rec;
		this.pending.length = 0; // the listing below covers everything that happened before boot
		await rec.start();
		const list = await this.vault.list();
		await rec.onObservations(list.map((stat) => ({ stat })), true);
		return rec;
	}

	/** Deliver buffered vault events to the reconciler. */
	flushEvents(): number {
		const events = this.pending.splice(0);
		if (events.length > 0) this.r.onVaultEvents(events);
		return events.length;
	}

	/** Deliver events, let time pass (racy window), reconcile until quiet, deliver the echoes. */
	async sync(maxPasses = 12): Promise<{ passes: number; quiet: boolean }> {
		this.flushEvents();
		this.clock.advance(5_000);
		const res = await this.r.runUntilQuiet(maxPasses);
		this.flushEvents();
		return { passes: res.passes, quiet: res.quiet };
	}

	/** Process death: storage handles die, the log loses replicas, buffered events are lost; then boot again. */
	async crashAndReboot(): Promise<Reconciler> {
		this.storage.crash();
		this.log.crash();
		this.storage.beforeCommit = null;
		this.storage.afterCommit = null;
		this.gateway.clearCrash();
		this.gateway.beforeOp = null;
		this.gateway.beforeRead = null;
		this.clock.onYield = null;
		this.rec = null;
		this.pending.length = 0;
		this.ownQueue.length = 0;
		this.clock.advance(5_000);
		return this.boot();
	}

	synced(docId: DocId): SyncedEntry | undefined {
		return this.r.ctx.synced(docId);
	}

	syncedByPath(path: string): SyncedEntry | undefined {
		return [...this.r.ctx.store.synced.values()].find((s) => s.path === path);
	}

	/** Paths of conflict copies on disk. */
	conflictCopies(): string[] {
		return this.vault.paths().filter((p) => p.includes("(conflict "));
	}

	intents(): number {
		return this.r.ctx.store.intents.size;
	}
}
