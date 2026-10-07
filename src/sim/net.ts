/**
 * SimNet: the simulated network of a run. One SimRelay (WP-A) on the run's
 * VirtualClock, plus per-device reachability: an offline device's connect
 * fails "unavailable" and its open sockets drop abruptly (1006), like a lost
 * network. Also the relay-side oracle for the invariants: a fresh observer
 * device (real LogEngine, empty store) bootstraps from the relay and reports
 * the folded vault (live docs and their texts).
 */

import { NS_STREAM, type DeviceId, type DocId, type StreamName, type VaultId, type VaultPath } from "../core/types";
import type { RelayConnectResult, RelayPort } from "../ports/relay";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { LogEngine } from "../engine/runtime/engine";
import type { VirtualClock } from "./clock";
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

export class SimNet {
	readonly relay: SimRelay;
	private readonly offline = new Set<DeviceId>();
	private oracleRuns = 0;

	constructor(readonly clock: VirtualClock, o: { readonly seed?: number; readonly linkMs?: number; readonly jitterMs?: number } = {}) {
		const link = { uplinkMs: o.linkMs ?? 20, downlinkMs: o.linkMs ?? 20, jitterMs: o.jitterMs ?? 0, httpMs: o.linkMs ?? 20, connectMs: o.linkMs ?? 20 };
		this.relay = new SimRelay({ clock, seed: o.seed ?? 1, link });
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
	 */
	async oracle(horizonMs = 120_000): Promise<{ docs: OracleDoc[]; error: string | null }> {
		const n = ++this.oracleRuns;
		const deviceId = `oracle-${n}` as DeviceId;
		const hash = simHashPort();
		const storage = new MemStoragePort({ beforeNextTimer: this.clock.beforeNextTimer });
		let engine: LogEngine | null = null;
		let error: string | null = null;
		const started = LogEngine.start({
			ports: { relay: this.port(deviceId), storage, clock: this.clock, random: new SeededRandom(hashLabel(deviceId)), crypto: createNoopCrypto(hash), hash, blob: null },
			vaultId: SIM_VAULT_ID, deviceId, clientVersion: "sim-oracle", sideFiles: null, autoReconnect: true,
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
