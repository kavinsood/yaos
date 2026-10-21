/**
 * SimNet: the simulated network of a run. One SimRelay (WP-A) on the run's
 * VirtualClock and the vault's blob store (R2, SimBlobStore), plus per-device
 * reachability: an offline device's connect fails "unavailable" and its open
 * sockets drop abruptly (1006), like a lost network. Also the relay-side
 * oracle for the invariants: a fresh observer device (real LogEngine, empty
 * store) bootstraps from the relay and reports the folded vault (live docs and
 * their texts), and an audit of every committed row (blobs never ride the log).
 */

import type { NsPruneRules } from "../engine/runtime/options";
import { CFG_STREAM, NS_STREAM, SNAP_STREAM, streamClass, streamDocId, type DeviceId, type DocId, type StreamName, type VaultId, type VaultPath } from "../core/types";
import type { BlobPort } from "../ports/blob";
import type { DeviceState, GrantFetchOutcome, RegisterOutcome, RetireOutcome } from "../ports/identity";
import { retireKeyHash } from "../engine/compose/storeIdentity";
import type { RelayConnectResult, RelayPort } from "../ports/relay";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { LogEngine } from "../engine/runtime/engine";
import { docText } from "../engine/runtime/testHarness";
import { projectCanvasBytes } from "../engine/reconcile/canvasDoc";
import type { EngineE2ee } from "../engine/keyring/keyringRuntime";
import { SimBlobStore } from "./blobStore";
import type { VirtualClock } from "./clock";
import { createDelayedSuite1, delayedHash, realWorkFor } from "./delayedCrypto";
import { simHashPort } from "./hash";
import { hashLabel, SeededRandom } from "./random";
import { SimRelay } from "./relay";
import { MemStoragePort } from "./storage";

export const SIM_VAULT_ID = "simVaultAAAAAAAAAAAAAA" as VaultId;

export interface OracleDoc {
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly kind: string;
	/** Markdown text, or a canvas doc's disk projection (DESIGN §j.2); null for blobs or a canvas that does not project. */
	readonly text: string | null;
	/** Canvas: why the CRDT does not project (null when it does). */
	readonly invalid?: string | null;
}

/** Fingerprints of a fold's canonical encoding (nsFoldV1 / cfgFoldV1 / snapFoldV1), by stream class. */
export type FoldPrints = Readonly<Record<"ns" | "cfg" | "snap", string>>;

/** What the relay oracle (a fresh device bootstrapped from the relay) folded. */
export interface OracleResult {
	readonly docs: OracleDoc[];
	readonly error: string | null;
	/** Its fold encodings once caught up (null: it did not catch up). */
	readonly folds: FoldPrints | null;
}

/** FNV-1a fingerprint of bytes: `<length>:<hash>`. */
export function bytesPrint(b: Uint8Array): string {
	let h = 0x811c9dc5;
	for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
	return `${b.length}:${h.toString(16)}`;
}

/** A suite-1 oracle's keys and keyring records (a keyed device's SecretStorage contents; copied, never printed). */
export interface OracleKeys {
	readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[];
	readonly records: readonly Uint8Array[];
}

/** Every row the relay committed, by what it could carry (SimNet.logAudit). */
export interface LogAudit {
	/** Committed streams outside ns / cfg / snap / k / b: / c: (an attachment carrier on the log would be one). */
	readonly foreign: readonly StreamName[];
	/** Largest committed row payload on ns / cfg / snap / k. */
	readonly largestRecordRow: number;
	/** Docs with a committed b: / c: row (an attachment doc must never have one). */
	readonly docStreams: ReadonlySet<DocId>;
	readonly rows: number;
	readonly bytes: number;
}

const LOG_CLASSES = new Set(["ns", "cfg", "snap", "keyring", "body", "canvas"]);

/** The server's grant limits (server vault/host.ts registerDevice, identity-per-store §3.3). */
export const SIM_GRANT_DAILY_REGISTRATIONS = 20;
export const SIM_GRANT_LIVE_DEVICES = 50;
/** The server's inactivity retirement (vault/pairing.ts INACTIVITY_RETIRE_DAYS, identity-per-store §6.2). */
export const SIM_INACTIVITY_RETIRE_DAYS = 90;
const DAY_MS = 86_400_000;

interface SimGrant {
	/** Stable across rotations (the server's grantId). */
	readonly id: number;
	/** The current secret (a rotation replaces it; the old one is unknown from then on). */
	secret: string;
	/** Rotated at least once: the server keeps the secret (wrapped) and a live device may fetch it. */
	rotated: boolean;
	revoked: boolean;
	/** Registration times (wall ms) of the current UTC day. */
	day: number;
	today: number;
}

interface SimRegistered {
	/** The grant's id (SimGrant.id). */
	readonly grant: number;
	readonly deviceToken: string;
	readonly retireKeyHash: string;
	retired: boolean;
	/** UTC day of the last connect (the server's `last_seen_day`, written at ticket). */
	seenDay: number;
}

/**
 * The relay's identity registry (server phase 1, identity-per-store §3): pairing grants, the devices registered under
 * them, and their tombstones. `POST /auth/device` as the server answers it, in its order: grant (401 unauthorized /
 * grant_revoked) → id or token taken (409 device_exists) / retired (409 device_retired) → 20 a UTC day (429
 * registration_limit, Retry-After to midnight) → 50 live (409 device_limit).
 */
export class SimIdentityRegistry {
	/** By current secret. */
	private readonly grants = new Map<string, SimGrant>();
	private readonly grantsById = new Map<number, SimGrant>();
	private readonly devices = new Map<DeviceId, SimRegistered>();
	private readonly tokens = new Map<string, DeviceId>();
	private nextGrant = 0;
	private rotations = 0;
	private readonly rotatedAway = new Set<string>();
	/** The UTC day the inactivity sweep last finished (once a day, as the server's per runtime). */
	private sweptDay = -1;
	/** Registrations the server accepted, and refused (by reason): sim stats. */
	readonly counts: Record<string, number> = {};
	/**
	 * The server's inactivity threshold in UTC days (YAOS_INACTIVITY_RETIRE_DAYS, 1–3650 there). Tests shorten it; 0
	 * (sim only) makes a device stale from the UTC day after it was last seen.
	 */
	inactivityDays = SIM_INACTIVITY_RETIRE_DAYS;

	constructor(private readonly now: () => number) {}

	private newGrant(secret: string): void {
		const g: SimGrant = { id: ++this.nextGrant, secret, rotated: false, revoked: false, day: -1, today: 0 };
		this.grants.set(secret, g);
		this.grantsById.set(g.id, g);
	}

	/** A new pairing grant (an enroll with a pairing code); returns its secret. */
	issueGrant(label: string): string {
		const secret = `grant-${label}-${String(this.nextGrant + 1).padStart(8, "0")}`.padEnd(43, "0");
		this.newGrant(secret);
		return secret;
	}

	/** A grant whose secret the client chose (the enroll of a fake pairing server in a test): known from now on. */
	addGrant(secret: string): void {
		// A rotated-away secret stays unknown (a copy of an old data.json does not bring it back).
		if (this.grants.has(secret) || this.rotatedAway.has(secret)) return;
		this.newGrant(secret);
	}

	revokeGrant(secret: string): void {
		const g = this.grants.get(secret);
		if (g) g.revoked = true;
	}

	/**
	 * The operator's "Rotate secret" (identity-per-store §3.4): a new secret; the old one is unknown from now on. The
	 * grant's devices stay live. Returns the new secret (tests only: the server never shows it), null for an unknown or
	 * revoked grant.
	 */
	rotateGrant(secret: string): string | null {
		const g = this.grants.get(secret);
		if (!g || g.revoked) return null;
		const next = `rotated-${++this.rotations}-${secret.slice(0, 12)}`.padEnd(43, "0");
		this.grants.delete(secret);
		this.rotatedAway.add(secret);
		g.secret = next;
		g.rotated = true;
		this.grants.set(next, g);
		return next;
	}

	/** `GET /auth/grant` as the device of `deviceToken` (the server's fetchGrant). */
	fetchGrant(deviceToken: string): GrantFetchOutcome {
		const id = this.tokens.get(deviceToken);
		const d = id === undefined ? undefined : this.devices.get(id);
		const g = d === undefined ? undefined : this.grantsById.get(d.grant);
		if (!d || d.retired || !g || g.revoked) return { ok: false, reason: "refused" };
		return g.rotated ? { ok: true, grantSecret: g.secret } : { ok: false, reason: "unavailable" };
	}

	/**
	 * The server's lazy inactivity sweep (host.ts retireInactive): run at registration and device status, once a UTC
	 * day; a device not seen for more than `inactivityDays` is retired, one with an open socket (`connected`) is seen
	 * now instead. Returns the ids retired (the caller revokes their relay sessions).
	 */
	sweepInactive(connected: (deviceId: DeviceId) => boolean): DeviceId[] {
		const today = Math.floor(this.now() / DAY_MS);
		if (this.sweptDay === today) return [];
		this.sweptDay = today;
		const out: DeviceId[] = [];
		for (const [id, d] of this.devices) {
			if (d.retired || d.seenDay >= today - this.inactivityDays) continue;
			if (connected(id)) {
				d.seenDay = today;
				continue;
			}
			d.retired = true;
			out.push(id);
		}
		if (out.length > 0) this.counts["inactive"] = (this.counts["inactive"] ?? 0) + out.length;
		return out;
	}

	register(grantSecret: string, c: { readonly deviceId: DeviceId; readonly deviceToken: string; readonly retireKeyHash: string }): RegisterOutcome {
		const out = this.decide(grantSecret, c);
		const k = out.ok ? "ok" : out.reason;
		this.counts[k] = (this.counts[k] ?? 0) + 1;
		return out;
	}

	private decide(grantSecret: string, c: { readonly deviceId: DeviceId; readonly deviceToken: string; readonly retireKeyHash: string }): RegisterOutcome {
		const g = this.grants.get(grantSecret);
		if (!g) return { ok: false, reason: "unauthorized", retryAfterMs: null };
		if (g.revoked) return { ok: false, reason: "grant-revoked", retryAfterMs: null };
		const known = this.devices.get(c.deviceId);
		if (known?.retired) return { ok: false, reason: "device-retired", retryAfterMs: null };
		if (known || this.tokens.has(c.deviceToken)) return { ok: false, reason: "device-exists", retryAfterMs: null };
		const now = this.now();
		const day = Math.floor(now / DAY_MS);
		if (g.day !== day) {
			g.day = day;
			g.today = 0;
		}
		if (g.today >= SIM_GRANT_DAILY_REGISTRATIONS) return { ok: false, reason: "registration-limit", retryAfterMs: (day + 1) * DAY_MS - now };
		let live = 0;
		for (const d of this.devices.values()) if (d.grant === g.id && !d.retired) live++;
		if (live >= SIM_GRANT_LIVE_DEVICES) return { ok: false, reason: "device-limit", retryAfterMs: null };
		g.today++;
		this.devices.set(c.deviceId, { grant: g.id, deviceToken: c.deviceToken, retireKeyHash: c.retireKeyHash, retired: false, seenDay: day });
		this.tokens.set(c.deviceToken, c.deviceId);
		return { ok: true };
	}

	/** The console's retire: the id is tombstoned and never registers again. */
	retire(deviceId: DeviceId): void {
		const d = this.devices.get(deviceId);
		if (d) d.retired = true;
	}

	/**
	 * `POST /auth/device/retire` (server retireByKey): `retireKeyHash` must be the device's. Gone or unknown is done
	 * (`retired: false`); a wrong key `unauthorized`. The caller revokes the relay's sessions and buffer (D7).
	 */
	retireByKey(deviceId: DeviceId, retireKeyHash: string): RetireOutcome {
		const d = this.devices.get(deviceId);
		const out: RetireOutcome = !d || d.retired ? { ok: true, retired: false } : d.retireKeyHash !== retireKeyHash ? { ok: false, reason: "unauthorized" } : { ok: true, retired: true };
		if (out.ok && out.retired && d) d.retired = true;
		const k = out.ok ? (out.retired ? "retire" : "retire-gone") : `retire-${out.reason}`;
		this.counts[k] = (this.counts[k] ?? 0) + 1;
		return out;
	}

	/** `POST /auth/device/status`: live, retired (tombstoned) or unknown. */
	state(deviceId: DeviceId): DeviceState {
		const d = this.devices.get(deviceId);
		return !d ? "unknown" : d.retired ? "retired" : "live";
	}

	/**
	 * A connect as `deviceId` with `token` authenticates: registered, live, the token it registered, grant not revoked.
	 * It is the ticket, so it marks the device seen today (the server's `last_seen_day`).
	 */
	authenticates(deviceId: DeviceId, token: string): boolean {
		const d = this.devices.get(deviceId);
		const ok = d !== undefined && !d.retired && d.deviceToken === token && this.grantsById.get(d.grant)?.revoked === false;
		if (ok) d.seenDay = Math.floor(this.now() / DAY_MS);
		return ok;
	}

	/** The server answers this secret's grant routes (it names a grant, revoked or not): else 401 before any sweep. */
	grantKnown(secret: string): boolean {
		return this.grants.has(secret);
	}

	/** Every registered device id (live or retired). */
	registered(): DeviceId[] {
		return [...this.devices.keys()];
	}
}

export class SimNet {
	readonly relay: SimRelay;
	/** The vault's blob store (relay-wire §11.3) on the run's clock, with its stall / slow models: what a device gets unless given its own. */
	readonly blobs: SimBlobStore;
	/** false = the relay has no blob store (capabilities: attachments false): devices start, and probe, without one. */
	blobsAvailable = true;
	/** Machines (SimDevice.machineKey) without a network. */
	private readonly offline = new Set<string>();
	/** Every deviceId each machine connected as (its stores, over time): dropped together when it goes offline. */
	private readonly machineIds = new Map<string, Set<DeviceId>>();
	readonly identities: SimIdentityRegistry;
	private readonly httpMs: number;
	private oracleRuns = 0;
	/** Diagnostics of every oracle run, counted as SimDevice.diagCounts (checkpoint adoption on a fresh device). */
	readonly oracleDiag: Record<string, number> = {};
	readonly oracleDisputed: string[] = [];
	private readonly audit = { foreign: new Set<StreamName>(), largestRecordRow: 0, docStreams: new Set<DocId>(), rows: 0, bytes: 0 };

	/** The run's ns prune rules (run.ts pruneWorld; FOLD: the oracle folds with the devices' cap), null = production. */
	readonly nsPrune: NsPruneRules | null;

	constructor(readonly clock: VirtualClock, o: { readonly seed?: number; readonly linkMs?: number; readonly jitterMs?: number; readonly sealBytes?: number; readonly dedupeWindowBytes?: number; readonly nsPrune?: NsPruneRules | null } = {}) {
		this.nsPrune = o.nsPrune ?? null;
		this.httpMs = o.linkMs ?? 20;
		const link = { uplinkMs: o.linkMs ?? 20, downlinkMs: o.linkMs ?? 20, jitterMs: o.jitterMs ?? 0, httpMs: o.linkMs ?? 20, connectMs: o.linkMs ?? 20 };
		this.relay = new SimRelay({ clock, seed: o.seed ?? 1, link, ...(o.sealBytes !== undefined ? { sealBytes: o.sealBytes } : {}), ...(o.dedupeWindowBytes !== undefined ? { dedupeWindowBytes: o.dedupeWindowBytes } : {}) });
		this.blobs = new SimBlobStore({ now: () => clock.now(), timers: clock });
		this.identities = new SimIdentityRegistry(() => clock.now());
		this.relay.onCommit((info) => {
			for (const r of info.rows) {
				const cls = streamClass(r.stream);
				this.audit.rows++;
				this.audit.bytes += r.payload.length;
				const doc = streamDocId(r.stream);
				if (!LOG_CLASSES.has(cls)) this.audit.foreign.add(r.stream);
				else if (doc) this.audit.docStreams.add(doc);
				else this.audit.largestRecordRow = Math.max(this.audit.largestRecordRow, r.payload.length);
			}
		});
	}

	/** The blob store a device's ports get (and its connect-time probe finds): null while blobsAvailable is false. */
	blobPort(): BlobPort | null {
		return this.blobsAvailable ? this.blobs : null;
	}

	logAudit(): LogAudit {
		const a = this.audit;
		return { foreign: [...a.foreign], largestRecordRow: a.largestRecordRow, docStreams: new Set(a.docStreams), rows: a.rows, bytes: a.bytes };
	}

	/**
	 * The RelayPort an engine on `machine` uses. `token`: the device token it authenticates with (IdentityPort.use);
	 * a connect as a deviceId the registry does not know with that token is `unauthorized`, as the server's ticket
	 * check. Absent: no authentication (oracles, engine-level tests).
	 */
	port(machine: string, token?: () => string | null): RelayPort {
		return {
			connect: async (params): Promise<RelayConnectResult> => {
				if (this.offline.has(machine)) return { ok: false, reason: "unavailable", retryAfterMs: null };
				if (token) {
					const t = token();
					if (t === null || !this.identities.authenticates(params.deviceId, t)) return { ok: false, reason: "unauthorized", retryAfterMs: null };
				}
				let ids = this.machineIds.get(machine);
				if (!ids) this.machineIds.set(machine, (ids = new Set()));
				ids.add(params.deviceId);
				const r = await this.relay.connect(params);
				// Went offline while the ticket/upgrade was in flight.
				if (r.ok && this.offline.has(machine)) this.relay.dropSession(params.deviceId);
				return r;
			},
		};
	}

	/** `POST /auth/device` from `machine` under `grantSecret`, one link round trip ("network" while offline). */
	async register(machine: string, grantSecret: string | null, c: { readonly deviceId: DeviceId; readonly deviceToken: string; readonly retireKeyHash: string }): Promise<RegisterOutcome> {
		if (grantSecret === null) return { ok: false, reason: "no-grant", retryAfterMs: null };
		if (this.offline.has(machine)) return { ok: false, reason: "network", retryAfterMs: null };
		await new Promise<void>((resolve) => this.clock.setTimer(this.httpMs, resolve));
		if (this.offline.has(machine)) return { ok: false, reason: "network", retryAfterMs: null };
		if (this.identities.grantKnown(grantSecret)) this.sweepInactive();
		return this.identities.register(grantSecret, c);
	}

	/** The server's lazy inactivity sweep (registration, device status): retired devices lose their sessions (D7). */
	private sweepInactive(): void {
		for (const id of this.identities.sweepInactive((d) => this.relay.subscriptionsOf(d).length > 0)) this.relay.revoke(id);
	}

	/** `GET /auth/grant` from `machine` as the store of `token` (one round trip); "network" while offline. */
	async fetchGrant(machine: string, token: string | null): Promise<GrantFetchOutcome> {
		if (token === null) return { ok: false, reason: "no-store" };
		if (this.offline.has(machine)) return { ok: false, reason: "network" };
		await new Promise<void>((resolve) => this.clock.setTimer(this.httpMs, resolve));
		if (this.offline.has(machine)) return { ok: false, reason: "network" };
		this.identities.counts["grant-fetch"] = (this.identities.counts["grant-fetch"] ?? 0) + 1;
		return this.identities.fetchGrant(token);
	}

	/**
	 * `POST /auth/device/retire` from `machine` (the successor fence, identity-per-store §5.2): one link round trip;
	 * a retired device's sessions close and its buffered frames are dropped (relay revoke, D7).
	 */
	async retire(machine: string, c: { readonly deviceId: DeviceId; readonly retireKey: string }): Promise<RetireOutcome> {
		if (this.offline.has(machine)) return { ok: false, reason: "network" };
		const hash = await retireKeyHash(simHashPort(), c.retireKey);
		await new Promise<void>((resolve) => this.clock.setTimer(this.httpMs, resolve));
		if (this.offline.has(machine)) return { ok: false, reason: "network" };
		const out = this.identities.retireByKey(c.deviceId, hash);
		if (out.ok && out.retired) this.relay.revoke(c.deviceId);
		return out;
	}

	/** The operator's "Remove device" (console): tombstoned, sessions closed, buffered frames dropped. */
	removeDevice(deviceId: DeviceId): void {
		this.identities.retire(deviceId);
		this.relay.revoke(deviceId);
	}

	/** `POST /auth/device/status` from `machine` as an authenticated store (one round trip); null while offline. */
	async status(machine: string, ids: readonly DeviceId[]): Promise<ReadonlyMap<DeviceId, DeviceState> | null> {
		if (this.offline.has(machine)) return null;
		await new Promise<void>((resolve) => this.clock.setTimer(this.httpMs, resolve));
		if (this.offline.has(machine)) return null;
		this.identities.counts["status"] = (this.identities.counts["status"] ?? 0) + 1;
		this.sweepInactive();
		return new Map(ids.map((id) => [id, this.identities.state(id)]));
	}

	isOnline(machine: string): boolean {
		return !this.offline.has(machine);
	}

	setOnline(machine: string, online: boolean): void {
		if (online) {
			this.offline.delete(machine);
			return;
		}
		this.offline.add(machine);
		this.dropMachine(machine);
	}

	/** Every socket of every store `machine` connected as drops abruptly (1006). */
	dropMachine(machine: string): void {
		for (const id of this.machineIds.get(machine) ?? []) this.relay.dropSession(id);
	}

	/** Nothing buffered, no timers, no HTTP or connects in flight, every socket idle. */
	quiet(): boolean {
		return this.relay.quiescent() && this.relay.pendingCount() === 0;
	}

	activity(): string {
		return `${this.relay.head()}`;
	}

	/** Seq of the last row of `stream` (GC'd rows included; the checkpoint's coversSeq if none). */
	streamHead(stream: StreamName): number {
		const rows = this.relay.rows(stream, { includeGc: true });
		const last = rows[rows.length - 1];
		return last ? last.seq : (this.relay.checkpoint(stream)?.coversSeq ?? 0);
	}

	/**
	 * Bootstrap a fresh observer from the relay and read the folded vault.
	 * Runs the clock (the caller must not be inside a clock step).
	 * `suite1`: open a suite-1 vault with a keyed device's keys and records (DelayedCrypto, as the devices).
	 */
	async oracle(horizonMs = 120_000, suite1: OracleKeys | null = null): Promise<OracleResult> {
		const n = ++this.oracleRuns;
		const deviceId = `oracle-${n}` as DeviceId;
		const random = new SeededRandom(hashLabel(deviceId));
		const work = suite1 ? realWorkFor(this.clock) : null;
		const hash = work ? delayedHash(work, simHashPort()) : simHashPort();
		const storage = new MemStoragePort({ beforeNextTimer: this.clock.beforeNextTimer, macrotask: this.clock.macrotask });
		let engine: LogEngine | null = null;
		let error: string | null = null;
		const crypto = work && suite1 ? await createDelayedSuite1(work, { vaultId: SIM_VAULT_ID, random, keys: suite1.keys.map((x) => ({ e: x.e, k: x.k.slice() })) }) : createNoopCrypto(hash);
		const e2ee: EngineE2ee = suite1 ? { suite: 1, records: suite1.records.map((r) => r.slice()), persist: async (ch) => { for (const x of ch.keys) x.k.fill(0); } } : { suite: 0 };
		const started = LogEngine.start({
			ports: { relay: this.port(deviceId), storage, clock: this.clock, random, crypto, hash, blob: this.blobPort() },
			vaultId: SIM_VAULT_ID, deviceId, clientVersion: "sim-oracle", sideFiles: null, autoReconnect: true, e2ee,
			...(this.nsPrune ? { tuning: { nsPrune: this.nsPrune } } : {}),
			onDiag: (ev) => {
				const cls = ev.fields["cls"];
				const k = typeof cls === "string" ? `${ev.code}:${cls}` : ev.code;
				this.oracleDiag[k] = (this.oracleDiag[k] ?? 0) + 1;
				if (ev.code === "checkpoint-disputed" && this.oracleDisputed.length < 10) this.oracleDisputed.push(`${String(cls)}@${String(ev.fields["coversSeq"])} ${String(ev.fields["detail"])}`);
			},
		}).then((e) => (engine = e), (e) => (error = `oracle start: ${e instanceof Error ? e.message : String(e)}`));
		await this.clock.runUntil(() => engine !== null || error !== null, horizonMs);
		await started;
		const eng = engine as LogEngine | null;
		if (!eng) return { docs: [], error: error ?? "oracle start timed out", folds: null };
		const head = this.streamHead(NS_STREAM);
		const cfgHead = this.streamHead(CFG_STREAM);
		const snapHead = this.streamHead(SNAP_STREAM);
		const c = eng.c;
		const ok = await this.clock.runUntil(() => eng.isIdle() && eng.nsView().caughtUp && eng.nsView().coversSeq >= head && c.cfg.coversSeq >= cfgHead && c.snap.coversSeq >= snapHead, horizonMs);
		const docs: OracleDoc[] = [];
		if (!ok) error = `oracle did not catch up (ns covers ${eng.nsView().coversSeq} of ${head}, cfg ${c.cfg.coversSeq} of ${cfgHead}, snap ${c.snap.coversSeq} of ${snapHead})`;
		const folds: FoldPrints | null = ok ? { ns: bytesPrint(c.ns.encodeState()), cfg: bytesPrint(c.cfg.encodeState()), snap: bytesPrint(c.snap.encodeState()) } : null;
		for (const d of eng.listDocs()) {
			if (d.state !== "live") continue;
			let text: string | null = null;
			let invalid: string | null = null;
			if (d.kind === "markdown") {
				const p = docText(eng, d.docId);
				let out: string | null = null;
				void p.then((t) => (out = t), () => (out = null));
				await this.clock.runUntil(() => out !== null, 30_000);
				text = out;
			} else if (d.kind === "canvas") {
				// The relay's canvas state as a fresh device builds it (checkpoint + tail), projected as a merge job would.
				let done = false;
				void eng.c.handles.load(eng.streamOf(d.docId)).then((h) => {
					const p = projectCanvasBytes(h.doc);
					if (p.ok) text = p.text;
					else invalid = p.reason;
				}, (e) => (invalid = `load failed: ${e instanceof Error ? e.message : String(e)}`)).finally(() => (done = true));
				await this.clock.runUntil(() => done, 30_000);
				if (!done) invalid = "load timed out";
			}
			docs.push({ docId: d.docId, path: d.path, kind: d.kind, text, ...(d.kind === "canvas" ? { invalid } : {}) });
		}
		const stopped = eng.stop();
		let done = false;
		void stopped.finally(() => (done = true));
		await this.clock.runUntil(() => done && this.quiet(), 30_000);
		return { docs, error, folds };
	}
}
