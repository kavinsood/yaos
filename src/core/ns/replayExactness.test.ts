/**
 * e2ee-design §8.2 exactness, as a property: an honest writer that allocates
 * frameNos in outbox order and sends frame f only while
 * f < (lowest unreceipted own frameNo) + NS_SEND_WINDOW never has a frame
 * rejected as replay-*, whatever order the relay commits in, however late
 * receipts arrive, across reconnects with copies lingering on old sockets and
 * across runtime restarts (IndexedDB intact; the first allocation skips
 * NS_DEDUPE_RING). Every later commit of an already committed frame is
 * rejected. The relay is assumed not to dedupe at all (worst case).
 *
 * Argument: if f is uncommitted then u <= f, so every sent frame is
 * < f + NS_SEND_WINDOW, so R < f + 32 and f > R - REPLAY_WINDOW: never stale;
 * frameNos are distinct, so f's bit is clear: never a duplicate.
 * Not covered (open, see the design doc): IndexedDB lost while an old socket
 * still holds frames that commit after the new runtime's frames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NS_DEDUPE_RING, NS_SEND_WINDOW, REPLAY_WINDOW } from "../limits";
import type { ClientFrameId, DeviceId, NsFoldEvent } from "../types";
import { foldNsFrame } from "./fold";
import { newNsFoldIndex, newNsFoldState } from "./index";

function prng(seed: number) {
	let x = seed * 0x9e3779b1 + 1;
	return () => {
		x = (x + 0x6d2b79f5) | 0;
		let t = Math.imul(x ^ (x >>> 15), 1 | x);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Frame { readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly frameNo: number }

class Writer {
	readonly outbox = new Map<ClientFrameId, Frame>();
	/** Persisted max: outbox and receipted rows (the receipt writes the own tail row). */
	private receiptedMax = 0;
	private seen = 0;
	private allocated = false;
	private onSocket = new Set<ClientFrameId>();
	private n = 0;
	constructor(readonly deviceId: DeviceId, private readonly window: number) {}

	create(): void {
		let max = Math.max(this.seen, this.receiptedMax, ...[...this.outbox.values()].map((f) => f.frameNo));
		if (!this.allocated) { max += NS_DEDUPE_RING; this.allocated = true; }
		this.seen = max + 1;
		const clientFrameId = `${this.deviceId}-${this.n++}`.padEnd(22, "x") as ClientFrameId;
		this.outbox.set(clientFrameId, { deviceId: this.deviceId, clientFrameId, frameNo: max + 1 });
	}
	/** Frames to write on the current socket now (Sender.window rule). */
	send(): Frame[] {
		let u = Infinity;
		for (const f of this.outbox.values()) u = Math.min(u, f.frameNo);
		const out: Frame[] = [];
		for (const f of this.outbox.values()) {
			if (this.onSocket.has(f.clientFrameId) || f.frameNo >= u + this.window) continue;
			this.onSocket.add(f.clientFrameId);
			out.push(f);
		}
		return out;
	}
	receipt(f: Frame): void {
		if (!this.outbox.delete(f.clientFrameId)) return;
		this.receiptedMax = Math.max(this.receiptedMax, f.frameNo);
	}
	reconnect(): void { this.onSocket = new Set(); }
	restart(): void { this.reconnect(); this.seen = 0; this.allocated = false; }
}

/** Runs one schedule; returns the number of honest first commits rejected (0 = exact). */
function run(seed: number, window: number, steps: number): { falseRejects: number; accepted: number; replays: number } {
	const rnd = prng(seed);
	const writers = [new Writer("devA" as DeviceId, window), new Writer("devB" as DeviceId, window)];
	const state = newNsFoldState();
	const index = newNsFoldIndex();
	let pool: Frame[] = [];
	const committed = new Set<ClientFrameId>();
	const unreceipted: Frame[] = [];
	let seq = 0, falseRejects = 0, accepted = 0, replays = 0;
	const commit = () => {
		const i = Math.floor(rnd() * pool.length);
		const f = pool[i]!;
		pool = pool.filter((_, j) => j !== i);
		const ev: readonly NsFoldEvent[] = foldNsFrame(state, index, { seq: ++seq, deviceId: f.deviceId, clientFrameId: f.clientFrameId, frameNo: f.frameNo, authorNsSeq: 0, ops: [] });
		const rejected = ev.length === 1 && ev[0]!.index === -1 && ev[0]!.outcome.kind === "ignored";
		if (committed.has(f.clientFrameId)) {
			assert.ok(rejected, `seed ${seed}: a second commit of ${f.clientFrameId} was accepted`);
			return;
		}
		committed.add(f.clientFrameId);
		unreceipted.push(f);
		if (rejected) falseRejects++;
		else accepted++;
	};
	for (let step = 0; step < steps || pool.length > 0 || unreceipted.length > 0 || writers.some((w) => w.outbox.size > 0); step++) {
		const w = writers[Math.floor(rnd() * writers.length)]!;
		const roll = rnd();
		const draining = step >= steps;
		if (!draining && roll < 0.3) w.create();
		else if (roll < 0.5) for (const f of w.send()) pool.push(f);
		else if (roll < 0.75 && pool.length > 0) commit();
		else if (roll < 0.95 && unreceipted.length > 0) {
			const i = Math.floor(rnd() * unreceipted.length);
			const f = unreceipted.splice(i, 1)[0]!;
			writers.find((x) => x.deviceId === f.deviceId)!.receipt(f);
		} else if (!draining && roll < 0.985) w.reconnect();
		else if (!draining) w.restart();
		if (step > steps * 20) throw new Error(`seed ${seed}: schedule did not drain`);
	}
	replays = seq - committed.size;
	return { falseRejects, accepted, replays };
}

test("§8.2 exactness: an honest writer behind the frameNo send window is never rejected as replay-*", () => {
	assert.ok(REPLAY_WINDOW >= 2 * NS_SEND_WINDOW);
	let accepted = 0, replays = 0;
	for (let seed = 1; seed <= 150; seed++) {
		const r = run(seed, NS_SEND_WINDOW, 1500);
		assert.equal(r.falseRejects, 0, `seed ${seed}`);
		accepted += r.accepted;
		replays += r.replays;
	}
	assert.ok(accepted > 20_000, `exercised ${accepted} frames`);
	assert.ok(replays > 1_000, `exercised ${replays} lingering duplicate commits`);
});

test("§8.2 exactness needs the send window: without it some honest frame goes stale", () => {
	let falseRejects = 0;
	for (let seed = 1; seed <= 40 && falseRejects === 0; seed++) falseRejects += run(seed, Infinity, 1500).falseRejects;
	assert.ok(falseRejects > 0);
});
