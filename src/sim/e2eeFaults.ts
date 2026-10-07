/**
 * Suite-1 faults of the seeded sim (e2ee-design §20.2 "new sim faults", WP-E7). They run only in a `crypto: "suite1"`
 * run (run.ts) and are driven by FaultState (faults.ts):
 *
 *   keyStoreLoss {dev}       SecretStorage wiped while the app is down: the device restarts key-missing ("no-key")
 *                            and is re-keyed by a sim QR (another device's stored key) after a delay.
 *   keyRoll {dev, also}      a roll (§4.2) forced now on `dev`, and with `also` a concurrent roll on a second device:
 *                            one record wins the epoch, the other loses (§11.3, §11.4).
 *   revoke {dev, by}         `by` revokes and re-keys (§14.2) because `dev` is lost; every other device goes
 *                            key-missing and is re-keyed by QR from `by`, `dev` last (it was found again).
 *   epochRestore {back}      point-in-time restore (server D8b: content == T, a new epoch) to a relay snapshot taken
 *                            `back` steps ago: records committed after T are gone from `k` and are re-published (§11.5).
 *   hostileReplay {pick}     the relay re-appends a genuine row (any stream, `k` included) as a new row, bypassing its
 *                            dedupe: every reader ignores it (replay window, duplicate ring; a `k` copy is a
 *                            verbatim re-publish).
 *   hostileDowngrade {pick}  the relay forges suite-0 body frames (valid Yjs, a marker text) from a hostile device id,
 *                            and (`join`) hides `k` from a fresh key-less device J that joins by link: J must end
 *                            key-missing "no-pin" with zero writes, never pinned and never `creatable`; once `k` is
 *                            shown again J says "encrypted-vault", still with zero writes. Every device quarantines
 *                            the forged rows and freezes the doc (DESIGN §d.6); after heal the user releases it
 *                            (`releaseQuarantine`): the forged rows fail the gate again and are dismissed, genuine
 *                            held rows open (keys present by then), the doc unfreezes.
 *
 * Every re-key is the user's QR scan, done by one keeper loop on virtual time (clock.sleep, so the run loop drives
 * it and the trace stays a function of the seed). Key bytes are read from a device's SecretStorage, passed by
 * reference and zero-filled; nothing here prints or traces one. Outcomes are counted (stats), not traced.
 */

import * as Y from "yjs";
import { newClientFrameId } from "../core/codec/ids";
import { bytesToHex } from "../core/codec/lib0";
import { KEYRING_STREAM, type DeviceId, type StreamName, type VaultEpoch } from "../core/types";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { sealFrame } from "../engine/ingest/envelope";
import type { OwnOutcome } from "../engine/keyring/keyring";
import type { KeyringRuntime } from "../engine/keyring/keyringRuntime";
import { KeyRecordKind } from "../engine/keyring/record";
import type { EngineCtx } from "../engine/runtime/context";
import { READER_DEPENDENT } from "../engine/runtime/quarantineRelease";
import { gateRow } from "../engine/sync/ingestRow";
import type { VirtualClock } from "./clock";
import { SimDevice } from "./device";
import { e2eeOf, HOSTILE_DEVICE_PREFIX, isLive, keyMissing, lastStatus, seededRk, storedKeys, storedEpochs } from "./e2ee";
import { simHashPort } from "./hash";
import type { Violation } from "./invariants";
import { SIM_VAULT_ID, type SimNet } from "./net";
import { SeededRandom } from "./random";
import type { StoreFrame, StoreSnapshot } from "./relay";

export type E2eeFaultAction =
	| { readonly t: "keyStoreLoss"; readonly dev: number; readonly downMs: number; readonly rekeyMs: number }
	| { readonly t: "keyRoll"; readonly dev: number; readonly also: number | null }
	| { readonly t: "revoke"; readonly dev: number; readonly by: number; readonly rekeyMs: number; readonly rkSeed: number }
	| { readonly t: "epochRestore"; readonly back: number }
	| { readonly t: "hostileReplay"; readonly pick: number; readonly copies: number }
	| { readonly t: "hostileDowngrade"; readonly pick: number; readonly rows: number; readonly join: boolean };

export const E2EE_FAULT_KINDS: readonly E2eeFaultAction["t"][] = ["keyStoreLoss", "keyRoll", "revoke", "epochRestore", "hostileReplay", "hostileDowngrade"];

/** Text the forged suite-0 frames insert: no device may ever show it (it would mean a suite-0 row was applied). */
export const HOSTILE_MARKER = "HOSTILE-DOWNGRADE";

/** Relay snapshots kept for epochRestore (one per step). */
const SNAPSHOT_RING = 12;
const KEEPER_TICK_MS = 1_000;
const RESCAN_MS = 20_000;
const JOIN_WAIT_MS = 60_000;

export interface E2eeFaultStats {
	rolls: { won: number; lost: number; pending: number; failed: number; skipped: number };
	revokes: { won: number; lost: number; pending: number; failed: number; skipped: number };
	rekeys: number;
	rkRekeys: number;
	rekeyConflicts: number;
	restores: number;
	replayed: number;
	downgradeRows: number;
	/** Docs released by the user after heal (frozen by forged rows, perhaps with genuine reader-dependent ones). */
	released: number;
	joins: { started: number; noPin: number; encryptedVault: number; suite0LinkRefused: number };
}

type RuntimeInternals = { flow: unknown; runOwn(kind: KeyRecordKind, rk?: Uint8Array): Promise<OwnOutcome> };

export class E2eeFaults {
	private readonly snaps: StoreSnapshot[] = [];
	/** Earliest virtual time (monotonic) at which each device may be re-keyed (the user scans the QR then). */
	private readonly rekeyAt = new Map<number, number>();
	private readonly scannedAt = new Map<number, number>();
	private readonly ops: Promise<void>[] = [];
	private pending = 0;
	private keeper = false;
	private stopped = false;
	private healing = false;
	private restores = 0;
	private joinsMade = 0;
	private readonly out: Violation[] = [];
	/** Recovery keys the user may hold, newest first (onboarding's, then each revoke's): the re-key of last resort. */
	private readonly rks: (() => Uint8Array)[] = [];
	readonly stats: E2eeFaultStats = {
		rolls: { won: 0, lost: 0, pending: 0, failed: 0, skipped: 0 },
		revokes: { won: 0, lost: 0, pending: 0, failed: 0, skipped: 0 },
		rekeys: 0, rkRekeys: 0, rekeyConflicts: 0, restores: 0, replayed: 0, downgradeRows: 0, released: 0,
		joins: { started: 0, noPin: 0, encryptedVault: 0, suite0LinkRefused: 0 },
	};

	constructor(
		private readonly clock: VirtualClock,
		private readonly devs: readonly SimDevice[],
		private readonly net: SimNet,
		private readonly isDown: (i: number) => boolean,
		/** Snapshot the relay after every step (only when epochRestore can be drawn). */
		private readonly snapshots: boolean,
		/** Onboarding's recovery key (a fresh copy per call). */
		initialRk: (() => Uint8Array) | null,
	) {
		if (initialRk) this.rks.push(initialRk);
	}

	/** run.ts, after every plan step. */
	afterStep(): void {
		if (!this.snapshots) return;
		this.snaps.push(this.net.relay.snapshot());
		if (this.snaps.length > SNAPSHOT_RING) this.snaps.shift();
	}

	/** The fault's trace line; outcomes that settle later are counted in stats. */
	run(f: E2eeFaultAction): string {
		switch (f.t) {
			case "keyStoreLoss":
				return "keyStoreLoss is run by FaultState (it is an app crash)";
			case "keyRoll":
				return this.roll(f.dev, f.also);
			case "revoke":
				return this.revoke(f.dev, f.by, f.rekeyMs, f.rkSeed);
			case "epochRestore":
				return this.restore(f.back);
			case "hostileReplay":
				return this.replay(f.pick, f.copies);
			case "hostileDowngrade":
				return this.downgrade(f.pick, f.rows, f.join);
		}
	}

	/** keyStoreLoss: the device (down now, back after downMs) may be re-keyed `afterMs` from now. */
	scheduleRekey(i: number, afterMs: number): void {
		const at = this.clock.monotonic() + afterMs;
		const cur = this.rekeyAt.get(i);
		if (cur === undefined || at < cur) this.rekeyAt.set(i, at);
		this.startKeeper();
	}

	// ------------------------------------------------------------------ keyRoll

	private ctxOf(i: number): EngineCtx | null {
		const d = this.devs[i];
		if (!d || this.isDown(i)) return null;
		return d.vrt?.log.c ?? null;
	}

	private runtimeOf(i: number): KeyringRuntime | null {
		return this.ctxOf(i)?.keyring ?? null;
	}

	/** The roll trigger's guards (KeyringRuntime.tick), then the own-record flow it starts (§4.2). */
	private startRoll(i: number): boolean {
		const c = this.ctxOf(i);
		const kr = c?.keyring;
		if (!kr || !c || kr.suite !== 1) return false;
		const inner = kr as unknown as RuntimeInternals;
		if (inner.flow || !c.session?.canWrite || c.phase !== "live" || kr.keyMissing() !== null) return false;
		void inner.runOwn(KeyRecordKind.roll).then((o) => void this.stats.rolls[o]++, () => void this.stats.rolls.failed++);
		return true;
	}

	private roll(dev: number, also: number | null): string {
		const a = this.startRoll(dev);
		const b = also !== null && also !== dev ? this.startRoll(also) : false;
		if (!a) this.stats.rolls.skipped++;
		if (also !== null && !b) this.stats.rolls.skipped++;
		const names = [a ? this.devs[dev]?.name : null, b && also !== null ? this.devs[also]?.name : null].filter((n) => n);
		return names.length === 0 ? "skip fault keyRoll: no live writer" : `fault keyRoll ${names.join("+")}`;
	}

	// ------------------------------------------------------------------ revoke

	private revoke(dev: number, by: number, rekeyMs: number, rkSeed: number): string {
		const b = this.devs[by];
		const lost = this.devs[dev];
		if (!b || !lost || by === dev) return "skip fault revoke: no device";
		const kr = this.runtimeOf(by);
		if (!kr || kr.suite !== 1 || !isLive(b) || (kr as unknown as RuntimeInternals).flow) {
			this.stats.revokes.skipped++;
			return `skip fault revoke: ${b.name} cannot revoke now`;
		}
		const rk = seededRk(new SeededRandom(rkSeed));
		// The command transfers (detaches) the new RK on a worker carrier; the inline one zero-fills it (keyringRuntime).
		// "pending" also answers ok: the record may still win, so the user keeps the new RK too.
		void b.runtime.command({ t: "revokeRekey", rk }).then(
			() => {
				this.stats.revokes.won++;
				this.rks.unshift(() => seededRk(new SeededRandom(rkSeed)));
			},
			(e: unknown) => void ((e as { error?: { code?: string } })?.error?.code === "refused" ? this.stats.revokes.lost++ : this.stats.revokes.failed++),
		);
		const now = this.clock.monotonic();
		this.devs.forEach((_, i) => {
			if (i === by) return;
			const at = now + (i === dev ? 2 * rekeyMs : rekeyMs);
			const cur = this.rekeyAt.get(i);
			if (cur === undefined || at < cur) this.rekeyAt.set(i, at);
		});
		this.startKeeper();
		return `fault revoke ${lost.name} by ${b.name} rekey ${rekeyMs}ms`;
	}

	// ------------------------------------------------------------------ re-key (the user's QR scan)

	private startKeeper(): void {
		if (this.keeper || this.stopped) return;
		this.keeper = true;
		this.track(this.keep());
	}

	private async keep(): Promise<void> {
		while (!this.stopped) {
			await this.clock.sleep(KEEPER_TICK_MS, "sim-rekey");
			if (this.stopped) return;
			const now = this.clock.monotonic();
			for (let i = 0; i < this.devs.length; i++) {
				const at = this.rekeyAt.get(i);
				if (at === undefined || at > now || this.isDown(i)) continue;
				const d = this.devs[i]!;
				const why = keyMissing(d);
				if (why !== "no-key" && why !== "revoked-epoch") continue;
				// The user scans once, then again only if the device still says key-missing a while later (a QR key stays
				// pending, unverified, while the device cannot read `k`, §12.4 (i)).
				const last = this.scannedAt.get(i);
				if (last !== undefined && now - last < RESCAN_MS) continue;
				this.scannedAt.set(i, now);
				if (await this.qrFromBest(i)) this.stats.rekeys++;
				else if (await this.rkInstall(i)) this.stats.rkRekeys++;
			}
			if (this.healing) for (let i = 0; i < this.devs.length; i++) if (!this.isDown(i)) await this.releaseForged(i);
		}
	}

	/**
	 * The user releases a doc frozen by forged rows (DESIGN §d.6 releaseQuarantine), once the device holds every key:
	 * only when each live record is forged or reader-dependent (a genuine deterministic failure is a finding, left
	 * frozen for the clean check). After the release no genuine record may be dismissed: it must have opened, unless
	 * it is stale (e2ee-design §14.3: sealed under a revoked epoch past the revoke, settled unapplied; stale is
	 * monotonic, so a re-gate after the release still says so).
	 */
	private async releaseForged(i: number): Promise<void> {
		const d = this.devs[i]!;
		const c = this.ctxOf(i);
		if (!c || c.phase !== "live" || keyMissing(d) !== null) return;
		for (const r of [...c.repo.streams()]) {
			if (r.frozen !== 1) continue;
			const live = (await c.repo.quarantineOf(r.stream)).filter((q) => !q.detail.startsWith("dismissed:"));
			const forged = (q: { deviceId: string }) => q.deviceId.startsWith(HOSTILE_DEVICE_PREFIX);
			if (!live.some(forged) || !live.every((q) => forged(q) || READER_DEPENDENT.has(q.reason))) continue;
			try {
				await d.runtime.command({ t: "releaseQuarantine", stream: r.stream });
			} catch {
				continue; // the engine stopped under us (a crash): the next tick retries
			}
			this.stats.released++;
			const after = await c.repo.quarantineOf(r.stream);
			let lost = 0;
			for (const q of after) {
				if (forged(q) || !q.detail.startsWith("dismissed:") || !live.some((l) => l.seq === q.seq)) continue;
				const row = { stream: r.stream, seq: q.seq, deviceId: q.deviceId, clientFrameId: q.clientFrameId, payload: q.bytes };
				if ((await gateRow(c.gateCtx, c.ports.hash, row, c.now())).t !== "account") lost++;
			}
			if (lost > 0) this.bad(`${d.name}: releasing a doc frozen by forged rows dismissed ${lost} genuine rows`);
		}
	}

	/**
	 * Install another device's newest winning epoch key by QR (§12.1: the link holds the newest winning epoch, the
	 * one it seals under); true once one was accepted. Not its newest stored key: that may be an own key whose record
	 * never reached `k` (a crash before the append), which no reader can verify.
	 */
	private async qrFromBest(i: number): Promise<boolean> {
		const to = this.devs[i]!;
		const sources = this.devs
			.map((d, j) => ({ d, j, e: keyMissing(d) === null ? (lastStatus(d)?.e2ee?.sealEpoch ?? 0) : 0 }))
			.filter((s) => s.j !== i && s.e > 0 && !this.isDown(s.j))
			.sort((x, y) => y.e - x.e || x.j - y.j);
		for (const s of sources) {
			const k = storedKeys(s.d)?.keys.find((x) => x.e === s.e)?.k;
			if (!k) continue;
			try {
				await to.runtime.command({ t: "installKey", source: "qr", e: s.e, k });
				return true;
			} catch (e) {
				if ((e as { error?: { code?: string } })?.error?.code === "refused") this.stats.rekeyConflicts++;
			} finally {
				if (k.byteLength > 0) k.fill(0);
			}
		}
		return false;
	}

	/** No device can show a QR (all key-missing or down): the user enters a recovery key, newest first. */
	private async rkInstall(i: number): Promise<boolean> {
		if (this.devs.some((d, j) => j !== i && !this.isDown(j) && keyMissing(d) === null && storedEpochs(d).length > 0)) return false;
		for (const make of this.rks) {
			const rk = make();
			try {
				await this.devs[i]!.runtime.command({ t: "installKey", source: "rk", rk });
				if (keyMissing(this.devs[i]!) === null) return true;
			} catch {
				// a wrong or older RK: try the next one
			} finally {
				if (rk.byteLength > 0) rk.fill(0);
			}
		}
		return false;
	}

	// ------------------------------------------------------------------ epochRestore

	private restore(back: number): string {
		if (this.snaps.length === 0) return "skip fault epochRestore: no snapshot";
		const idx = Math.max(0, this.snaps.length - back);
		const snap = this.snaps[idx]!;
		const epoch = `sim-epoch-restore-${++this.restores}` as VaultEpoch;
		this.net.relay.restoreEpoch(snap, epoch);
		this.snaps.length = 0; // later restores rewind within the new epoch only
		this.stats.restores++;
		return `fault epochRestore ${epoch} to head ${snap.head}`;
	}

	// ------------------------------------------------------------------ hostile relay

	private genuineRows(): StoreFrame[] {
		const out: StoreFrame[] = [];
		for (const stream of this.net.relay.streams()) {
			for (const r of this.net.relay.rows(stream, { includeGc: true })) {
				if ((r.deviceId as string).startsWith(HOSTILE_DEVICE_PREFIX)) continue;
				out.push({ stream, deviceId: r.deviceId, clientFrameId: r.clientFrameId, payload: r.payload });
			}
		}
		return out;
	}

	private replay(pick: number, copies: number): string {
		const rows = this.genuineRows();
		if (rows.length === 0) return "skip fault hostileReplay: no rows";
		const r = rows[pick % rows.length]!;
		const frames = Array.from({ length: copies }, () => ({ stream: r.stream, deviceId: r.deviceId, clientFrameId: r.clientFrameId, payload: r.payload.slice() }));
		this.net.relay.forge(frames);
		this.stats.replayed += copies;
		return `fault hostileReplay ${r.stream === KEYRING_STREAM ? "k" : r.stream.slice(0, 2)} x${copies}`;
	}

	private downgrade(pick: number, rows: number, join: boolean): string {
		const bodies = this.net.relay.streams().filter((s) => s.startsWith("b:"));
		const parts: string[] = [];
		if (bodies.length > 0) {
			const rng = new SeededRandom(pick);
			const stream = bodies[pick % bodies.length]!;
			const deviceId = `${HOSTILE_DEVICE_PREFIX}${bytesToHex(rng.bytes(4))}` as DeviceId;
			this.track((async () => {
				const crypto = createNoopCrypto(simHashPort());
				const frames = [];
				for (let n = 0; n < rows; n++) {
					const doc = new Y.Doc();
					doc.getText("text").insert(0, `${HOSTILE_MARKER} ${n}\n`);
					const content = Y.encodeStateAsUpdate(doc);
					doc.destroy();
					const clientFrameId = newClientFrameId(rng);
					const s = await sealFrame(crypto, SIM_VAULT_ID, { stream, deviceId, clientFrameId, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content });
					frames.push({ stream, deviceId, clientFrameId, payload: s.sealed });
				}
				this.net.relay.forge(frames);
				this.stats.downgradeRows += frames.length;
			})());
			parts.push(`suite-0 rows x${rows}`);
		}
		if (join) parts.push(this.keylessJoin());
		return parts.length === 0 ? "skip fault hostileDowngrade: nothing to forge" : `fault hostileDowngrade ${parts.join(", ")}`;
	}

	/** A fresh unpinned device (a key-less link) joins while the relay hides `k` from it (module doc). */
	private keylessJoin(): string {
		const name = `J${++this.joinsMade}`;
		const j = new SimDevice({ name, clock: this.clock, net: this.net, pin: null });
		const relay = this.net.relay;
		relay.hideFrom(j.deviceId, KEYRING_STREAM);
		this.stats.joins.started++;
		const headAtJoin = relay.head();
		const bad = (why: string) => this.bad(`${name} (key-less join, k hidden): ${why}`);
		const check = (phase: string) => {
			const rows = this.rowsBy(j.deviceId);
			if (rows > 0) bad(`${rows} rows written (${phase})`);
			if (j.pinData.e2ee !== undefined) bad(`pinned suite ${j.pinData.e2ee.suite} (${phase})`);
			if (j.ui.statuses.some((s) => s.e2ee?.creatable === true)) bad(`creatable (${phase})`);
		};
		this.track((async () => {
			void j.start().catch(() => undefined);
			const t0 = this.clock.monotonic();
			while (keyMissing(j) !== "no-pin" && this.clock.monotonic() - t0 < JOIN_WAIT_MS) await this.clock.sleep(KEEPER_TICK_MS, "sim-join");
			if (keyMissing(j) === "no-pin") this.stats.joins.noPin++;
			else bad(`not key-missing no-pin after ${JOIN_WAIT_MS}ms (phase ${lastStatus(j)?.phase ?? "none"}, head at join ${headAtJoin})`);
			check("k hidden");
			relay.unhideFrom(j.deviceId, KEYRING_STREAM);
			// The k rows it missed are not pushed again: a reconnect reads `k` (the user retries the link).
			relay.dropSession(j.deviceId, 1006);
			const t1 = this.clock.monotonic();
			while (keyMissing(j) !== "encrypted-vault" && this.clock.monotonic() - t1 < JOIN_WAIT_MS) await this.clock.sleep(KEEPER_TICK_MS, "sim-join");
			if (keyMissing(j) === "encrypted-vault") this.stats.joins.encryptedVault++;
			else bad(`not key-missing encrypted-vault once k is shown (phase ${lastStatus(j)?.phase ?? "none"}, ${e2eeOf(j)?.keyMissing ?? "-"})`);
			check("k shown");
			// §20.2 "Suite-0 link after a genesis": the relay hides `k` again and a suite=0 link arrives: refused.
			relay.hideFrom(j.deviceId, KEYRING_STREAM);
			relay.dropSession(j.deviceId, 1006);
			await this.clock.sleep(5_000, "sim-join");
			const r = await j.runtime.command({ t: "pinSuite0", source: "link" }).then(() => "ok", (e: unknown) => (e as { error?: { code?: string } })?.error?.code ?? "error");
			if (r === "refused") this.stats.joins.suite0LinkRefused++;
			else bad(`suite=0 link after the genesis answered ${r}`);
			check("suite-0 link");
			relay.unhideFrom(j.deviceId, KEYRING_STREAM);
			await j.runtime.stop().catch(() => undefined);
		})());
		return `key-less join ${name}`;
	}

	private rowsBy(deviceId: DeviceId): number {
		let n = 0;
		for (const s of this.net.relay.streams()) for (const r of this.net.relay.rows(s, { includeGc: true })) if (r.deviceId === deviceId) n++;
		return n;
	}

	// ------------------------------------------------------------------ run end

	/** heal(): every device may be re-keyed now (the user scans a QR on each key-missing device). */
	heal(): void {
		this.healing = true;
		if (this.stats.downgradeRows > 0) this.startKeeper();
		const now = this.clock.monotonic();
		this.devs.forEach((_, i) => this.rekeyAt.set(i, Math.min(this.rekeyAt.get(i) ?? now, now)));
		if (this.rekeyAt.size > 0 && this.devs.some((d) => keyMissing(d) !== null)) this.startKeeper();
		else if (this.keeper) this.startKeeper();
	}

	/** After quiescence: stop the keeper; true when every tracked operation finished. */
	async stop(horizonMs = 120_000): Promise<boolean> {
		this.stopped = true;
		if (this.pending > 0) await this.clock.runUntil(() => this.pending === 0, horizonMs);
		await Promise.all(this.ops);
		return this.pending === 0;
	}

	/** End-of-run checks (module doc). */
	check(): Violation[] {
		const out = [...this.out];
		const bad = (detail: string) => {
			if (out.length < 12) out.push({ inv: "e2ee", detail });
		};
		for (const d of this.devs) {
			for (const [path, text] of d.vault.snapshot()) if (text.includes(HOSTILE_MARKER)) bad(`${d.name}: ${path.length > 0 ? "a file" : "?"} shows a forged suite-0 frame`);
		}
		// §11.5: every winner a device stores is in `k` this vault epoch (re-published after a reset or a restore).
		const k = new Set(this.net.relay.rows(KEYRING_STREAM, { includeGc: true }).map((r) => bytesToHex(r.payload)));
		for (const d of this.devs) {
			const recs = storedKeys(d)?.records ?? [];
			const missing = recs.filter((r) => !k.has(bytesToHex(r))).length;
			if (missing > 0) bad(`${d.name}: ${missing} stored key records missing from k`);
		}
		const epochs = new Set(this.devs.map((d) => e2eeOf(d)?.sealEpoch ?? -1));
		if (epochs.size > 1) bad(`devices seal under different epochs: ${[...epochs].sort().join(",")}`);
		return out;
	}

	private bad(detail: string): void {
		if (this.out.length < 12) this.out.push({ inv: "e2ee", detail });
	}

	private track(p: Promise<void>): void {
		this.pending++;
		this.ops.push(p.catch((e: unknown) => this.bad(`sim fault op threw: ${e instanceof Error ? e.message : String(e)}`)).finally(() => this.pending--));
	}
}
