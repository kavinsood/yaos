/**
 * A hostile or buggy device (sim fault `hostile`, HOSTILE_FAULTS): a registered member of the vault running broken or
 * malicious code. It opens its own relay session (the real relay path: admission, dedupe, group commit, fan-out) and
 * appends frames no honest client builds:
 *
 *   malformed      garbage bytes as a doc's body row (the envelope does not decode)
 *   truncatedYjs   a body update cut short (decode-failed)
 *   badType        a body update with a Y.Map root (disallowed-type)
 *   deflateBomb    a body update that deflates to a small frame and inflates past MAX_FRAME_CONTENT_BYTES (oversize)
 *   oversizeFrame  a payload over the relay's maxFrameBytes, sent past the client's own check (the relay closes the
 *                  socket 1009; nothing commits)
 *   badWire        an APPEND with an invalid stream name or clientFrameId (the relay closes the socket 1008)
 *   wrongKind      an nsOps envelope on a body stream, a bodyUpdate envelope on ns (wrong kind for the stream)
 *   outOfOrder     a buggy sender: two valid body updates of one edit, the second first and the first 1-200 s later.
 *                  Readers hold a causal hole (re-reads, maybe a `causal-hole` freeze) until the missing row comes,
 *                  then thaw. A genuine edit (ORDER_TEXT), so it must end applied everywhere like any other
 *   nsInvalid      structurally valid ns ops every reader must ignore: an invalid path, a kind that does not match
 *                  the path, setBlob on a markdown doc, a create of a docId that exists, a rename of an unknown docId,
 *                  a rename of a deleted doc by an author that saw the delete (stale-revive), a restore against a delete
 *                  that is not the doc's current one
 *   nsReplay       its own committed ns frames again: the same frame with a new clientFrameId (replay-duplicate), an
 *                  old frameNo after its counter jumped ahead (replay-stale), and the same clientFrameId and bytes
 *                  (the relay dedupes it inside the H2 window; past it, readers' duplicate ring: duplicate-frame).
 *                  Its frames carry only upgradeRules(FOLD_RULES_VERSION) (noop), so what folds changes nothing
 *   staleEpoch     suite 1: an ns frame and a body update sealed under the vault's oldest epoch key, below a
 *                  winning revoke (a revoked member's key: e2ee-design §14.3, every reader ignores them). Suite 0
 *                  has no epochs: skipped
 *
 * In suite 1 it seals with a vault key it holds (a member's keys, copied from an honest device's key store): its rows
 * open, and the ns / body checks after the envelope are what stop them.
 *
 * What "correct" means with such a peer (check()): no device shows a body text it sent (HOSTILE_TEXT) and no ns entry it
 * created exists anywhere; the docs its rows froze are released by the user (QuarantineUser) and end unfrozen; a
 * release never dismisses a genuine row; and every other invariant (tokens, convergence, clean, fold, ...) holds for the
 * honest devices as in any run.
 */

import * as Y from "yjs";
import { newClientFrameId, newDocId } from "../core/codec/ids";
import { encodeNsOps } from "../core/codec/nsOps";
import { markdownContentHash } from "../core/hash/markdownLf";
import { FOLD_RULES_VERSION } from "../core/limits";
import { NS_STREAM, type ClientFrameId, type DeviceId, type DocId, type NsEntry, type NsOp, type StreamName, type VaultPath } from "../core/types";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { sealFrame } from "../engine/ingest/envelope";
import { READER_DEPENDENT } from "../engine/runtime/quarantineRelease";
import { gateRow } from "../engine/sync/ingestRow";
import type { CryptoPort } from "../ports/crypto";
import type { RelaySession } from "../ports/relay";
import type { VirtualClock } from "./clock";
import { encodeAppend } from "../engine/adapters/relayFrames";
import type { SimRelaySession } from "./a-relay-session";
import { createDelayedSuite1, realWorkFor } from "./delayedCrypto";
import type { SimDevice } from "./device";
import { HOSTILE_DEVICE_PREFIX, keyMissing, storedKeys } from "./e2ee";
import { simHashPort } from "./hash";
import type { Violation } from "./invariants";
import { SIM_VAULT_ID, type SimNet } from "./net";
import { SeededRandom } from "./random";

export const HOSTILE_KINDS = ["malformed", "truncatedYjs", "badType", "deflateBomb", "oversizeFrame", "badWire", "wrongKind", "outOfOrder", "nsInvalid", "nsReplay", "staleEpoch"] as const;
export type HostileKind = (typeof HOSTILE_KINDS)[number];

export interface HostileAction {
	readonly t: "hostile";
	readonly kind: HostileKind;
	readonly pick: number;
}

/** Text the hostile body updates insert: no device may ever show it (a hostile row was applied). */
export const HOSTILE_TEXT = "HOSTILE-DEVICE-ROW";
/** Text of the outOfOrder edit (genuine content: it must end on every device). */
export const ORDER_TEXT = "buggy-device-out-of-order";
/** The hostile device's id: HOSTILE_DEVICE_PREFIX, like the hostile relay's forged rows (the leak check skips both). */
export const HOSTILE_DEVICE_ID = `${HOSTILE_DEVICE_PREFIX}device` as DeviceId;
const HOSTILE_PREFIX = HOSTILE_DEVICE_PREFIX;
/** The user notices a frozen doc's notice and releases it this long after it froze (QUARANTINE-UI: no UI flow yet). */
const RELEASE_AFTER_MS = 4_000;
const TICK_MS = 1_000;

export interface HostileStats {
	actions: Record<string, number>;
	frames: number;
	refused: number;
	released: number;
}

export class HostileDevice {
	readonly stats: HostileStats = { actions: {}, frames: 0, refused: 0, released: 0 };
	private session: RelaySession | null = null;
	private connecting: Promise<RelaySession | null> | null = null;
	private crypto: CryptoPort | null = null;
	private cryptoTop = 0;
	private readonly random: SeededRandom;
	private frameNo = 0;
	/** Its committed-or-sent ns frames (for nsReplay): clientFrameId, frameNo, sealed payload, content. */
	private readonly sent: { readonly cfid: ClientFrameId; readonly frameNo: number; readonly payload: Uint8Array; readonly content: Uint8Array }[] = [];
	private readonly ops: Promise<void>[] = [];
	private readonly open = new Set<string>();
	private pending = 0;
	private readonly out: Violation[] = [];
	/** Streams seen frozen by hostile rows, per device name, with the time first seen (the user's notice delay). */
	private readonly frozenSince = new Map<string, number>();
	private keeper = false;
	private loop: Promise<void> | null = null;
	private loopEnded = false;
	private healed = false;
	private readonly wakers = new Set<() => void>();
	private stopped = false;

	constructor(
		private readonly clock: VirtualClock,
		private readonly devs: readonly SimDevice[],
		private readonly net: SimNet,
		private readonly suite1: boolean,
		private readonly isDown: (i: number) => boolean,
		seed: number,
	) {
		this.random = new SeededRandom(seed).fork("hostile");
	}

	run(a: HostileAction): string {
		const ref = this.reference();
		if (!ref) return `skip fault hostile ${a.kind}: no live honest device to read the vault from`;
		const entries = [...(ref.vrt?.log.c.ns.state.entries.values() ?? [])].sort((x, y) => (x.docId < y.docId ? -1 : 1));
		const live = entries.filter((e) => e.state === "live" && e.kind === "markdown" && !e.path.startsWith("import/"));
		const body = live.length > 0 ? live[Math.floor(a.pick * live.length)]! : null;
		const needsBody = a.kind !== "nsInvalid" && a.kind !== "nsReplay";
		if (needsBody && !body) return `skip fault hostile ${a.kind}: no live note`;
		if (a.kind === "nsReplay" && this.sent.length === 0 && this.frameNo > 0) return `skip fault hostile ${a.kind}: nothing sent yet`;
		const epochs = (storedKeys(ref)?.keys ?? []).map((k) => k.e).sort((x, y) => x - y);
		// Stale only below a winning revoke (§14.3): a plain roll leaves older epochs valid for members' in-flight frames.
		const revoked = this.suite1 ? (ref.vrt?.log.c.keyring.minSendEpoch() ?? 0) : 0;
		if (a.kind === "staleEpoch" && (!this.suite1 || revoked === 0 || epochs[0]! >= revoked)) return `skip fault hostile ${a.kind}: ${this.suite1 ? "no revoked epoch" : "suite 0"}`;
		this.stats.actions[a.kind] = (this.stats.actions[a.kind] ?? 0) + 1;
		this.refreshKeys(ref);
		const headNs = this.net.streamHead(NS_STREAM);
		this.track((async () => {
			const s = await this.connect(ref);
			if (!s || !this.crypto) return;
			switch (a.kind) {
				case "malformed":
					return this.append(s, `b:${body!.docId}` as StreamName, this.random.bytes(24 + this.random.int(200)));
				case "truncatedYjs": {
					const u = bodyUpdate(`${HOSTILE_TEXT} truncated`);
					return this.appendSealed(s, `b:${body!.docId}` as StreamName, "bodyUpdate", u.slice(0, Math.max(1, u.length - 1 - this.random.int(u.length - 1))));
				}
				case "badType": {
					const doc = new Y.Doc();
					doc.getMap("evil").set("x", HOSTILE_TEXT);
					const u = Y.encodeStateAsUpdate(doc);
					doc.destroy();
					return this.appendSealed(s, `b:${body!.docId}` as StreamName, "bodyUpdate", u);
				}
				case "deflateBomb":
					// ~1.1 MB of one character: deflates to a few KiB, inflates past MAX_FRAME_CONTENT_BYTES.
					return this.appendSealed(s, `b:${body!.docId}` as StreamName, "bodyUpdate", bodyUpdate(`${HOSTILE_TEXT} ${"a".repeat(1_100_000)}`));
				case "oversizeFrame":
					// Over the relay's maxFrameBytes: it closes the socket (1009) and commits nothing.
					return this.raw(s, `b:${body!.docId}`, newClientFrameId(this.random), this.random.bytes(this.net.relay.limits.maxFrameBytes + 1 + this.random.int(4096)));
				case "badWire": {
					const payload = this.random.bytes(16);
					return this.random.chance(0.5)
						? this.raw(s, this.random.chance(0.5) ? "" : "x".repeat(257), newClientFrameId(this.random), payload)
						: this.raw(s, `b:${body!.docId}`, this.random.chance(0.5) ? "" : "y".repeat(129), payload);
				}
				case "outOfOrder": {
					const doc = new Y.Doc();
					const t = doc.getText("text");
					t.insert(0, `${ORDER_TEXT}-a\n`);
					const sv = Y.encodeStateVector(doc);
					const first = Y.encodeStateAsUpdate(doc);
					t.insert(t.length, `${ORDER_TEXT}-b\n`);
					const second = Y.encodeStateAsUpdate(doc, sv);
					doc.destroy();
					const stream = `b:${body!.docId}` as StreamName;
					await this.appendSealed(s, stream, "bodyUpdate", second, 0, 0, true);
					await this.delay(Math.round(1_000 * 200 ** this.random.float()));
					// Sealed now, under the newest epoch it holds by then (a revoke meanwhile makes older ones stale).
					const now = this.reference();
					if (now) this.refreshKeys(now);
					const again = await this.connect(now);
					if (again) await this.appendSealed(again, stream, "bodyUpdate", first, 0, 0, true);
					return;
				}
				case "wrongKind":
					await this.appendSealed(s, `b:${body!.docId}` as StreamName, "nsOps", encodeNsOps([{ t: "upgradeRules", version: FOLD_RULES_VERSION }]), 0, 1);
					return this.appendSealed(s, NS_STREAM, "bodyUpdate", bodyUpdate(`${HOSTILE_TEXT} on ns`));
				case "nsInvalid":
					return this.appendNs(s, await this.invalidOps(entries, a.pick, headNs), headNs);
				case "nsReplay":
					return this.replay(s);
				case "staleEpoch": {
					const keys = (storedKeys(ref)?.keys ?? []).map((x) => ({ e: x.e, k: x.k.slice() }));
					const old = await createDelayedSuite1(realWorkFor(this.clock), { vaultId: SIM_VAULT_ID, random: this.random.fork(`stale-${this.stats.frames}`), keys });
					for (const k of keys) old.markVerified(k.e);
					old.setSealEpoch(epochs[0]!);
					const seal = async (stream: StreamName, kind: "bodyUpdate" | "nsOps", content: Uint8Array, frameNo: number) => {
						const cfid = newClientFrameId(this.random);
						const sealed = await sealFrame(old, SIM_VAULT_ID, { stream, deviceId: HOSTILE_DEVICE_ID, clientFrameId: cfid, kind, authorNsSeq: 0, flags: 0, frameNo, content });
						this.append(s, stream, sealed.sealed, cfid);
					};
					await seal(NS_STREAM, "nsOps", encodeNsOps([{ t: "upgradeRules", version: FOLD_RULES_VERSION }]), ++this.frameNo);
					if (body) await seal(`b:${body.docId}` as StreamName, "bodyUpdate", bodyUpdate(`${HOSTILE_TEXT} stale epoch`), 0);
					return;
				}
			}
		})(), a.kind);
		return `fault hostile ${a.kind}${body && needsBody ? ` b:${body.docId.slice(0, 6)}` : ""}`;
	}

	/** A member: it takes each new epoch key like the others do (sealing under the newest). */
	private refreshKeys(ref: SimDevice): void {
		const top = Math.max(0, ...(storedKeys(ref)?.keys ?? []).map((k) => k.e));
		if (this.suite1 && top > this.cryptoTop) this.crypto = null;
	}

	/** An honest device the hostile one reads the vault from (and, in suite 1, copies its keys from). */
	private reference(): SimDevice | null {
		for (let i = 0; i < this.devs.length; i++) {
			const d = this.devs[i]!;
			if (this.isDown(i) || !d.vrt?.log.c.ns || keyMissing(d) !== null) continue;
			if (this.suite1 && (storedKeys(d)?.keys.length ?? 0) === 0) continue;
			return d;
		}
		return null;
	}

	private async connect(ref: SimDevice | null): Promise<RelaySession | null> {
		if (this.session && !this.closed && this.crypto) return this.session;
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			if (!this.crypto) {
				if (!ref) return null;
				if (this.suite1) {
					const keys = (storedKeys(ref)?.keys ?? []).map((x) => ({ e: x.e, k: x.k.slice() }));
					const c = await createDelayedSuite1(realWorkFor(this.clock), { vaultId: SIM_VAULT_ID, random: this.random.fork(`crypto-${this.stats.frames}`), keys });
					const top = Math.max(0, ...keys.map((k) => k.e));
					for (const k of keys) c.markVerified(k.e);
					if (top > 0) c.setSealEpoch(top);
					this.cryptoTop = top;
					this.crypto = c;
				} else this.crypto = createNoopCrypto(simHashPort());
			}
			if (this.session && !this.closed) return this.session;
			const r = await this.net.port("hostile-machine").connect({ vaultId: SIM_VAULT_ID, deviceId: HOSTILE_DEVICE_ID });
			if (!r.ok) return null;
			this.session = r.session;
			this.closed = false;
			const session = r.session;
			session.onEvent((ev) => {
				if (ev.t === "closed") {
					this.stats.actions[`closed:${ev.code}`] = (this.stats.actions[`closed:${ev.code}`] ?? 0) + 1;
					if (this.session === session) this.closed = true;
				} else if (ev.t === "receipt") this.unreceipted.delete(ev.clientFrameId);
				else if (ev.t === "refused") {
					this.stats.refused++;
					this.stats.actions[`refused:${ev.reason}`] = (this.stats.actions[`refused:${ev.reason}`] ?? 0) + 1;
					// Refusals that pass (the daily limit, a busy stream) are resent; the rest end the frame.
					if (ev.reason !== "daily-limit" && ev.retryAfterMs === null) this.unreceipted.delete(ev.clientFrameId);
					else this.resendDue = true;
				}
			});
			// Like any client after a reconnect: the frames it holds no receipt for go again (same clientFrameId).
			for (const [cfid, f] of this.unreceipted) session.append({ stream: f.stream, clientFrameId: cfid, payload: f.payload });
			return r.session;
		})().finally(() => (this.connecting = null));
		return this.connecting;
	}

	private closed = true;
	/** Frames it means to land (ns frames, outOfOrder halves): resent after a reconnect until receipted or refused. */
	private readonly unreceipted = new Map<ClientFrameId, { readonly stream: StreamName; readonly payload: Uint8Array }>();
	private resendDue = false;

	private append(s: RelaySession, stream: StreamName, payload: Uint8Array, cfid: ClientFrameId = newClientFrameId(this.random)): void {
		this.stats.frames++;
		s.append({ stream, clientFrameId: cfid, payload });
	}

	/** One APPEND as raw wire bytes: no client-side size or name check (a hostile client skips its own). */
	private raw(s: RelaySession, stream: string, clientFrameId: string, payload: Uint8Array): void {
		this.stats.frames++;
		(s as SimRelaySession).sendRawBinary(encodeAppend({ stream, clientFrameId, payload }));
	}

	private async appendSealed(s: RelaySession, stream: StreamName, kind: "bodyUpdate" | "nsOps", content: Uint8Array, authorNsSeq = 0, frameNo = 0, land = false): Promise<void> {
		const cfid = newClientFrameId(this.random);
		const sealed = await sealFrame(this.crypto!, SIM_VAULT_ID, { stream, deviceId: HOSTILE_DEVICE_ID, clientFrameId: cfid, kind, authorNsSeq, flags: 0, frameNo, content });
		if (land) this.unreceipted.set(cfid, { stream, payload: sealed.sealed });
		this.append(s, stream, sealed.sealed, cfid);
	}

	private async appendNs(s: RelaySession, ops: readonly NsOp[], authorNsSeq: number): Promise<void> {
		if (ops.length === 0) return;
		const content = encodeNsOps(ops);
		const frameNo = ++this.frameNo;
		const cfid = newClientFrameId(this.random);
		const sealed = await sealFrame(this.crypto!, SIM_VAULT_ID, { stream: NS_STREAM, deviceId: HOSTILE_DEVICE_ID, clientFrameId: cfid, kind: "nsOps", authorNsSeq, flags: 0, frameNo, content });
		this.sent.push({ cfid, frameNo, payload: sealed.sealed, content });
		this.unreceipted.set(cfid, { stream: NS_STREAM, payload: sealed.sealed });
		this.append(s, NS_STREAM, sealed.sealed, cfid);
	}

	/** One op per ignore reason the vault offers a target for (module doc); none can apply. */
	private async invalidOps(entries: readonly NsEntry[], pick: number, headNs: number): Promise<NsOp[]> {
		const hash = await markdownContentHash(simHashPort(), `${HOSTILE_TEXT}\n`);
		const of = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(pick * xs.length)]);
		const fresh = (): DocId => newDocId(this.random);
		const ops: NsOp[] = [
			{ t: "create", docId: fresh(), kind: "markdown", path: "../outside.md" as VaultPath, contentHash: hash, size: 20 },
			{ t: "create", docId: fresh(), kind: "blob", path: "notes/hostile.md" as VaultPath, contentHash: hash, size: 20 },
			{ t: "rename", docId: fresh(), path: "notes/hostile-unknown.md" as VaultPath },
		];
		// Only entries whose create row the relay holds now: after an epoch reset the devices re-create their docs, and
		// a create of a docId not re-created yet is not a duplicate but the first one (a member may create any doc).
		const ns = this.net.relay.rows(NS_STREAM, { includeGc: true });
		const onRelay = (e: NsEntry) => ns.some((r) => r.seq === e.createdSeq && r.deviceId === e.createdBy);
		const md = of(entries.filter((e) => e.state === "live" && e.kind === "markdown" && onRelay(e)));
		if (md) {
			ops.push({ t: "setBlob", docId: md.docId, hash, size: 20, baseRev: 0 });
			ops.push({ t: "create", docId: md.docId, kind: "markdown", path: "notes/hostile-dup.md" as VaultPath, contentHash: hash, size: 20 });
		}
		const dead = of(entries.filter((e) => e.state === "deleted" && onRelay(e)));
		if (dead && dead.deletedSeq <= headNs) {
			// An author whose ns view covers the delete renames the doc anyway (its path: noop if it was revived there).
			ops.push({ t: "rename", docId: dead.docId, path: dead.path });
			ops.push({ t: "restore", docId: dead.docId, path: dead.path, againstDeleteSeq: dead.deletedSeq + 1 });
		}
		return ops;
	}

	private async replay(s: RelaySession): Promise<void> {
		const noop = encodeNsOps([{ t: "upgradeRules", version: FOLD_RULES_VERSION }]);
		if (this.sent.length === 0) {
			await this.appendNs(s, [{ t: "upgradeRules", version: FOLD_RULES_VERSION }], 0);
			return;
		}
		const r = this.random.int(3);
		const old = this.sent[this.random.int(this.sent.length)]!;
		if (r === 0) {
			// The same frame (same frameNo) under a new clientFrameId: a re-seal after a lost store, say.
			const cfid = newClientFrameId(this.random);
			const sealed = await sealFrame(this.crypto!, SIM_VAULT_ID, { stream: NS_STREAM, deviceId: HOSTILE_DEVICE_ID, clientFrameId: cfid, kind: "nsOps", authorNsSeq: 0, flags: 0, frameNo: old.frameNo, content: old.content });
			this.append(s, NS_STREAM, sealed.sealed, cfid);
		} else if (r === 1) {
			// Its frame counter jumps ahead (a bug), then an old frameNo comes back: below the window.
			this.frameNo += 100;
			await this.appendNs(s, [{ t: "upgradeRules", version: FOLD_RULES_VERSION }], 0);
			const cfid = newClientFrameId(this.random);
			const sealed = await sealFrame(this.crypto!, SIM_VAULT_ID, { stream: NS_STREAM, deviceId: HOSTILE_DEVICE_ID, clientFrameId: cfid, kind: "nsOps", authorNsSeq: 0, flags: 0, frameNo: old.frameNo, content: noop });
			this.append(s, NS_STREAM, sealed.sealed, cfid);
		} else {
			// The very same frame again (a resend that forgot its receipt): deduped by the relay inside its window.
			this.append(s, NS_STREAM, old.payload, old.cfid);
		}
	}

	/** Sleeps `ms` of virtual time, or until heal() (all faults off: the buggy device sends what it held back). */
	private delay(ms: number): Promise<void> {
		if (this.healed) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = () => {
				this.wakers.delete(done);
				this.clock.clearTimer(h);
				resolve();
			};
			const h = this.clock.setTimer(ms, done, "sim-hostile-delay");
			this.wakers.add(done);
		});
	}

	/** FaultState.heal: no new hostile frames are held back (held-back halves go now). */
	heal(): void {
		this.healed = true;
		for (const w of [...this.wakers]) w();
	}

	// ------------------------------------------------------------------ the user releases frozen docs

	/**
	 * Starts the tick loop (until stop()): the device reconnects and resends its unreceipted frames, and the user
	 * releases docs frozen by its rows.
	 */
	startUser(): void {
		if (this.keeper) return;
		this.keeper = true;
		this.loop = (async () => {
			while (!this.stopped) {
				await this.clock.sleep(TICK_MS, "sim-hostile-user");
				if (this.stopped) return;
				if (this.unreceipted.size > 0 && (this.closed || this.resendDue)) {
					if (this.resendDue && this.session && !this.closed) for (const [cfid, f] of this.unreceipted) this.session.append({ stream: f.stream, clientFrameId: cfid, payload: f.payload });
					this.resendDue = false;
					await this.connect(null);
				}
				for (let i = 0; i < this.devs.length; i++) if (!this.isDown(i)) await this.releaseOn(i);
			}
		})().catch((e: unknown) => this.bad(`tick loop threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)).finally(() => (this.loopEnded = true));
	}

	/** run.ts quiescence: a send it holds back or a frame it still resends (the run is not idle while it does). */
	busy(): boolean {
		return this.pending > 0 || this.unreceipted.size > 0;
	}

	/**
	 * DESIGN §d.6 releaseQuarantine, as the user would run it from the frozen-doc notice (the engine command: the host
	 * has no flow for it yet, BACKLOG QUARANTINE-UI): a doc whose live quarantine records all came from the hostile
	 * device (or are reader-dependent) is released RELEASE_AFTER_MS after it was first seen frozen. A doc frozen by a
	 * genuine row is left alone (the clean check reports it).
	 */
	private async releaseOn(i: number): Promise<void> {
		const d = this.devs[i]!;
		const c = d.vrt?.log.c;
		if (!c || c.phase !== "live" || keyMissing(d) !== null) return;
		for (const r of [...c.repo.streams()]) {
			const key = `${d.name}|${r.stream}`;
			if (r.frozen !== 1) {
				this.frozenSince.delete(key);
				continue;
			}
			const live = (await c.repo.quarantineOf(r.stream)).filter((q) => !q.detail.startsWith("dismissed:"));
			const hostile = (q: { deviceId: string }) => q.deviceId.startsWith(HOSTILE_PREFIX);
			if (!live.some(hostile) || !live.every((q) => hostile(q) || READER_DEPENDENT.has(q.reason))) continue;
			const now = this.clock.monotonic();
			const since = this.frozenSince.get(key);
			if (since === undefined) {
				this.frozenSince.set(key, now);
				continue;
			}
			if (now - since < RELEASE_AFTER_MS) continue;
			try {
				await d.runtime.command({ t: "releaseQuarantine", stream: r.stream });
			} catch {
				continue; // the engine stopped under us (a crash): the next tick retries
			}
			this.frozenSince.delete(key);
			this.stats.released++;
			const after = await c.repo.quarantineOf(r.stream);
			let lost = 0;
			for (const q of after) {
				if (hostile(q) || !q.detail.startsWith("dismissed:") || !live.some((l) => l.seq === q.seq)) continue;
				const row = { stream: r.stream, seq: q.seq, deviceId: q.deviceId, clientFrameId: q.clientFrameId, payload: q.bytes };
				if ((await gateRow(c.gateCtx, c.ports.hash, row, c.now())).t !== "account") lost++;
			}
			if (lost > 0) this.bad(`${d.name}: releasing a doc frozen by hostile rows dismissed ${lost} genuine rows`);
		}
	}

	// ------------------------------------------------------------------ run end

	/** After quiescence: stop the user, close the session; true when every tracked operation finished. */
	async stop(horizonMs = 120_000): Promise<boolean> {
		this.stopped = true;
		if (this.pending > 0) await this.clock.runUntil(() => this.pending === 0, horizonMs);
		if (this.pending > 0) {
			this.bad(`operations still pending at the end: ${[...this.open].join(", ")}`);
			return false;
		}
		await Promise.all(this.ops);
		if (this.loop) {
			await this.clock.runUntil(() => this.loopEnded, 5_000);
			await this.loop;
		}
		if (this.session && !this.closed) this.session.close(1000, "done");
		return this.pending === 0;
	}

	/** Seqs of the rows it committed (a reader rightly never applies them; the checkpoint check skips them). */
	committedSeqs(): Set<number> {
		const out = new Set<number>();
		for (const s of this.net.relay.streams()) for (const r of this.net.relay.rows(s, { includeGc: true })) if (r.deviceId === HOSTILE_DEVICE_ID) out.add(r.seq);
		return out;
	}

	/** End-of-run checks (module doc). */
	check(): Violation[] {
		const out = [...this.out];
		const bad = (detail: string) => {
			if (out.length < 12) out.push({ inv: "clean", detail: `hostile device: ${detail}` });
		};
		for (const d of this.devs) {
			for (const [path, text] of d.vault.snapshot()) if (text.includes(HOSTILE_TEXT)) bad(`${d.name}: ${path} shows a hostile row's text`);
			for (const e of d.vrt?.log.c.ns.state.entries.values() ?? []) if (e.createdBy === HOSTILE_DEVICE_ID) bad(`${d.name}: ns entry ${e.docId} (${e.path}, ${e.state}) created by the hostile device`);
		}
		return out;
	}

	private bad(detail: string): void {
		if (this.out.length < 12) this.out.push({ inv: "clean", detail: `hostile device: ${detail}` });
	}

	private track(p: Promise<void>, label: string): void {
		this.pending++;
		const tag = `${label}@${this.clock.monotonic()}`;
		this.open.add(tag);
		this.ops.push(p.catch((e: unknown) => this.bad(`op threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)).finally(() => {
			this.pending--;
			this.open.delete(tag);
		}));
	}
}

function bodyUpdate(text: string): Uint8Array {
	const doc = new Y.Doc();
	doc.getText("text").insert(0, `${text}\n`);
	const u = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return u;
}
