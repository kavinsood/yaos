/**
 * SimNet: the simulated network of a run. One SimRelay (WP-A) on the run's
 * VirtualClock and the vault's blob store (R2, SimBlobStore), plus per-device
 * reachability: an offline device's connect fails "unavailable" and its open
 * sockets drop abruptly (1006), like a lost network. Also the relay-side
 * oracle for the invariants: a fresh observer device (real LogEngine, empty
 * store) bootstraps from the relay and reports the folded vault (live docs and
 * their texts), and an audit of every committed row (blobs never ride the log).
 */

import { NS_STREAM, streamClass, streamDocId, type DeviceId, type DocId, type StreamName, type VaultId, type VaultPath } from "../core/types";
import type { BlobPort } from "../ports/blob";
import type { RelayConnectResult, RelayPort } from "../ports/relay";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { LogEngine } from "../engine/runtime/engine";
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
	/** Markdown text (null for other kinds). */
	readonly text: string | null;
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

export class SimNet {
	readonly relay: SimRelay;
	/** The vault's blob store (relay-wire §11.3) on the run's clock: what a device gets unless given its own. */
	readonly blobs: SimBlobStore;
	/** false = the relay has no blob store (capabilities: attachments false): devices start, and probe, without one. */
	blobsAvailable = true;
	private readonly offline = new Set<DeviceId>();
	private oracleRuns = 0;
	private readonly audit = { foreign: new Set<StreamName>(), largestRecordRow: 0, docStreams: new Set<DocId>(), rows: 0, bytes: 0 };

	constructor(readonly clock: VirtualClock, o: { readonly seed?: number; readonly linkMs?: number; readonly jitterMs?: number } = {}) {
		const link = { uplinkMs: o.linkMs ?? 20, downlinkMs: o.linkMs ?? 20, jitterMs: o.jitterMs ?? 0, httpMs: o.linkMs ?? 20, connectMs: o.linkMs ?? 20 };
		this.relay = new SimRelay({ clock, seed: o.seed ?? 1, link });
		this.blobs = new SimBlobStore({ now: () => clock.now() });
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

	/** The RelayPort a device's engine uses. */
	port(deviceId: DeviceId): RelayPort {
		return {
			connect: async (params): Promise<RelayConnectResult> => {
				if (this.offline.has(deviceId)) return { ok: false, reason: "unavailable", retryAfterMs: null };
				const r = await this.relay.connect(params);
				// Went offline while the ticket/upgrade was in flight.
				if (r.ok && this.offline.has(deviceId)) this.relay.dropSession(deviceId);
				return r;
			},
		};
	}

	isOnline(deviceId: DeviceId): boolean {
		return !this.offline.has(deviceId);
	}

	setOnline(deviceId: DeviceId, online: boolean): void {
		if (online) {
			this.offline.delete(deviceId);
			return;
		}
		this.offline.add(deviceId);
		this.relay.dropSession(deviceId);
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
	async oracle(horizonMs = 120_000, suite1: OracleKeys | null = null): Promise<{ docs: OracleDoc[]; error: string | null }> {
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
		}).then((e) => (engine = e), (e) => (error = `oracle start: ${e instanceof Error ? e.message : String(e)}`));
		await this.clock.runUntil(() => engine !== null || error !== null, horizonMs);
		await started;
		const eng = engine as LogEngine | null;
		if (!eng) return { docs: [], error: error ?? "oracle start timed out" };
		const head = this.streamHead(NS_STREAM);
		const ok = await this.clock.runUntil(() => eng.isIdle() && eng.nsView().caughtUp && eng.nsView().coversSeq >= head, horizonMs);
		const docs: OracleDoc[] = [];
		if (!ok) error = `oracle did not catch up (ns covers ${eng.nsView().coversSeq} of ${head})`;
		for (const d of eng.listDocs()) {
			if (d.state !== "live") continue;
			let text: string | null = null;
			if (d.kind === "markdown") {
				const p = eng.docText(d.docId);
				let out: string | null = null;
				void p.then((t) => (out = t), () => (out = null));
				await this.clock.runUntil(() => out !== null, 30_000);
				text = out;
			}
			docs.push({ docId: d.docId, path: d.path, kind: d.kind, text });
		}
		const stopped = eng.stop();
		let done = false;
		void stopped.finally(() => (done = true));
		await this.clock.runUntil(() => done && this.quiet(), 30_000);
		return { docs, error };
	}
}
