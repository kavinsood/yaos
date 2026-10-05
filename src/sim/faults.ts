/**
 * Seeded faults (DESIGN §l.2), the subset the host + stand-in engine can
 * express today: engine (worker) crash, whole-app crash with restart, offline
 * periods, vault I/O failures, backgrounding (hidden/pagehide/freeze), wall
 * clock jumps, slow watchers and engine persistence lag (per-device options
 * chosen in run.ts).
 *
 * INTEGRATION: relay faults (socket close points, relay restart/STREAM_RESEND,
 * dedupe expiry), crash at every StorageTx step and IDB wipe come with WP-A's
 * SimRelay/MemStoragePort and WP-C's engine; add them as FaultAction variants
 * here so plans and the minimizer cover them unchanged.
 */

import * as Y from "yjs";
import type { StandinHub } from "../engine/__standins__/hub";
import type { LifecycleEvent } from "../ports/platform";
import type { TimerHandle } from "../ports/clock";
import { tokensIn, type TokenLedger } from "./actors";
import type { VirtualClock } from "./__standins__/clock";
import type { SeededRandom } from "./__standins__/random";
import type { SimDevice } from "./device";

export type FaultAction =
	| { readonly t: "engineCrash"; readonly dev: number }
	| { readonly t: "appCrash"; readonly dev: number; readonly downMs: number }
	| { readonly t: "offline"; readonly dev: number; readonly durationMs: number }
	| { readonly t: "ioFail"; readonly dev: number; readonly ops: number }
	| { readonly t: "background"; readonly dev: number; readonly event: "hidden" | "pagehide" | "freeze"; readonly durationMs: number }
	| { readonly t: "clockSkew"; readonly deltaMs: number };

export type FaultWeights = Readonly<Record<FaultAction["t"], number>>;

export const DEFAULT_FAULTS: FaultWeights = { engineCrash: 3, appCrash: 2, offline: 4, ioFail: 2, background: 3, clockSkew: 1 };

export function generateFault(rng: SeededRandom, devices: number, weights: FaultWeights): FaultAction {
	const dev = rng.int(devices);
	const keys = (Object.keys(weights) as FaultAction["t"][]).filter((k) => weights[k] > 0);
	let x = rng.float() * keys.reduce((s, k) => s + weights[k], 0);
	let kind = keys[keys.length - 1] ?? "offline";
	for (const k of keys) {
		x -= weights[k];
		if (x < 0) {
			kind = k;
			break;
		}
	}
	switch (kind) {
		case "engineCrash": return { t: "engineCrash", dev };
		case "appCrash": return { t: "appCrash", dev, downMs: rng.range(200, 20_000) };
		case "offline": return { t: "offline", dev, durationMs: rng.range(1_000, 120_000) };
		case "ioFail": return { t: "ioFail", dev, ops: rng.range(1, 3) };
		case "background": return { t: "background", dev, event: rng.pick(["hidden", "pagehide", "freeze"] as const), durationMs: rng.range(100, 30_000) };
		case "clockSkew": return { t: "clockSkew", deltaMs: (rng.chance(0.5) ? 1 : -1) * rng.range(60_000, 3 * 86_400_000) };
	}
}

/** Tokens that survive an app crash of `d`: on any disk or in any trash, accepted by the hub, or in d's engine store. */
export function durableTokens(devs: readonly SimDevice[], hub: StandinHub, d: SimDevice): Set<string> {
	const out = new Set<string>();
	const add = (text: string | null) => {
		if (text) for (const t of tokensIn(text)) out.add(t);
	};
	for (const x of devs) {
		for (const text of x.vault.snapshot().values()) add(text);
		for (const r of x.vault.trashed) add(r.text);
	}
	for (const { key } of hub.list()) add(hub.text(key));
	for (const p of d.store.values()) {
		const doc = new Y.Doc();
		Y.applyUpdate(doc, p.state);
		add(doc.getText("text").toString());
		doc.destroy();
	}
	return out;
}

export class FaultState {
	private readonly down = new Set<number>();
	private readonly offline = new Set<number>();
	private readonly backgrounded = new Map<number, LifecycleEvent>();
	private readonly timers = new Set<TimerHandle>();
	readonly counts: Record<FaultAction["t"], number> = { engineCrash: 0, appCrash: 0, offline: 0, ioFail: 0, background: 0, clockSkew: 0 };

	constructor(
		private readonly clock: VirtualClock,
		private readonly devs: readonly SimDevice[],
		private readonly hub: StandinHub,
		private readonly ledger: TokenLedger,
	) {}

	isDown(i: number): boolean {
		return this.down.has(i);
	}

	private later(ms: number, fn: () => void): void {
		const h = this.clock.setTimer(ms, () => {
			this.timers.delete(h);
			fn();
		}, "sim-fault");
		this.timers.add(h);
	}

	run(f: FaultAction): string {
		if (f.t === "clockSkew") {
			this.clock.skewWall(f.deltaMs);
			this.counts.clockSkew++;
			return `fault clockSkew ${f.deltaMs}`;
		}
		const d = this.devs[f.dev];
		if (!d) return `skip fault ${f.t}: no device`;
		const tag = `fault ${d.name} ${f.t}`;
		if (this.down.has(f.dev)) return `skip ${tag}: app down`;
		this.counts[f.t]++;
		switch (f.t) {
			case "engineCrash":
				d.crashEngine();
				return tag;
			case "appCrash": {
				const durable = durableTokens(this.devs, this.hub, d);
				let lost = 0;
				for (const e of this.ledger.live()) {
					if (e.dev === d.name && !durable.has(e.token)) {
						this.ledger.unacked(e.token);
						lost++;
					}
				}
				d.crashApp();
				this.down.add(f.dev);
				this.backgrounded.delete(f.dev);
				this.later(f.downMs, () => this.restart(f.dev));
				return `${tag} down ${f.downMs}ms (${lost} unacknowledged tokens)`;
			}
			case "offline":
				if (this.offline.has(f.dev)) return `skip ${tag}: already offline`;
				this.offline.add(f.dev);
				d.setOnline(false);
				this.later(f.durationMs, () => this.reconnect(f.dev));
				return `${tag} ${f.durationMs}ms`;
			case "ioFail":
				d.vault.failNextOps += f.ops;
				return `${tag} x${f.ops}`;
			case "background":
				if (this.backgrounded.has(f.dev)) return `skip ${tag}: already backgrounded`;
				this.backgrounded.set(f.dev, f.event);
				d.platform.emit(f.event);
				this.later(f.durationMs, () => this.foreground(f.dev));
				return `${tag} ${f.event} ${f.durationMs}ms`;
		}
	}

	private restart(i: number): void {
		const d = this.devs[i];
		if (!d || !this.down.delete(i)) return;
		void d.restartApp().catch(() => undefined);
	}

	private reconnect(i: number): void {
		const d = this.devs[i];
		if (!d || !this.offline.delete(i)) return;
		d.setOnline(true);
	}

	private foreground(i: number): void {
		const d = this.devs[i];
		const ev = this.backgrounded.get(i);
		if (!d || ev === undefined) return;
		this.backgrounded.delete(i);
		if (!this.down.has(i)) d.platform.emit(ev === "freeze" ? "resume" : "visible");
	}

	/** All faults off: cancel pending fault timers, reconnect, restart, foreground, no I/O failures. */
	heal(): void {
		for (const h of this.timers) this.clock.clearTimer(h);
		this.timers.clear();
		for (const i of [...this.offline]) this.reconnect(i);
		for (const i of [...this.backgrounded.keys()]) this.foreground(i);
		for (const i of [...this.down]) this.restart(i);
		for (const d of this.devs) d.vault.failNextOps = 0;
	}
}
