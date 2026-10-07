/**
 * DelayedCrypto (e2ee-design §16.3, §20.3): the real suite-1 adapter on Node WebCrypto, with every CryptoPort,
 * KeyringCrypto and HashPort call settling only after a real `setTimeout(0)`, as WebCrypto settles on a task in a
 * browser. A crypto or hash await inside a `runTx` body then trips MemStoragePort's inactive-transaction check
 * (storage.ts "idb"), exactly as IndexedDB auto-commits on a device.
 *
 * Determinism ("same seed, same trace" under suite 1, e2ee-design §21 "E7 as built"). Real WebCrypto finishes on
 * the libuv thread pool in no fixed order and at no fixed time, so on its own it makes a virtual-clock run depend on
 * the host's timing. RealWork removes that:
 *  - The adapter runs over a SubtleCrypto whose every call starts the real operation at once but delivers its
 *    outcome in a batch: the calls queued while no code ran are taken together, awaited together, then settled in
 *    call order. The adapter's own continuations (key installs, nonce draws from its seeded RandomPort) therefore
 *    run in one order for one seed.
 *  - Port results wait for a real `setTimeout(0)` after they settle, then settle in the order they became ready.
 *  - One driver delivers both kinds, one batch at a time, each only once every storage idle check armed so far has
 *    run (VirtualClock.macrotask counts them; an auto-commit can start another body, which can arm another), and
 *    the VirtualClock (addRealWork) fires no timer and runs no idle hook while any work is outstanding. Virtual time and crypto completion order are then a pure function of the seed: the trace, the
 *    sealed bytes and the digest repeat exactly, so ddmin replays still work.
 */

import type { BlobAddress, CryptoPort, HashPort, KeyringCrypto } from "../ports/crypto";
import type { VaultId } from "../core/types";
import type { RandomPort } from "../ports/random";
import { createWebCryptoSuite1, type Suite1Crypto } from "../engine/adapters/webCryptoSuite1";
import { realMacrotask, type VirtualClock } from "./clock";

interface Pending {
	readonly settle: () => void;
}

interface RealItem extends Pending {
	readonly done: Promise<unknown>;
}

/** One run's outstanding real work (every device's crypto on one VirtualClock shares it: one global order). */
export class RealWork {
	private readonly realQ: RealItem[] = [];
	private readonly lateQ: Pending[] = [];
	/** Port calls whose inner promise has not settled yet. */
	private waiting = 0;
	private driving = false;
	private idleWaiters: (() => void)[] = [];
	private readonly macrotask = realMacrotask();
	/** Real macrotasks other code has armed and not run yet (VirtualClock.pendingRealTasks: storage idle checks). */
	private others: () => number = () => 0;
	/** Counters (tests and the E7 notes): calls per kind, delivery batches, driver turns with nothing deliverable. */
	readonly stats = { subtle: 0, port: 0, batches: 0, strays: 0 };

	constructor(private readonly timeout0: () => Promise<void> = () => new Promise<void>((r) => setTimeout(r, 0))) {}

	/**
	 * Hold the clock: it waits for this run's crypto before firing a timer, and nothing settles while a storage idle
	 * check is armed (storage ports must use `clock.macrotask`).
	 */
	attach(clock: VirtualClock): this {
		clock.addRealWork(() => (this.busy() ? new Promise<void>((r) => this.idleWaiters.push(r)) : null));
		this.others = () => clock.pendingRealTasks();
		return this;
	}

	busy(): boolean {
		return this.driving || this.realQ.length > 0 || this.lateQ.length > 0 || this.waiting > 0;
	}

	/** A real operation, started now, settled in a batch in call order. */
	real<T>(start: () => Promise<T>): Promise<T> {
		this.stats.subtle++;
		let p: Promise<T>;
		try {
			p = start();
		} catch (e) {
			p = Promise.reject(e);
		}
		return new Promise<T>((resolve, reject) => {
			let out: { ok: true; v: T } | { ok: false; e: unknown } | null = null;
			const done = p.then((v) => void (out = { ok: true, v }), (e: unknown) => void (out = { ok: false, e }));
			this.realQ.push({
				done,
				settle: () => {
					const o = out as { ok: true; v: T } | { ok: false; e: unknown };
					if (o.ok) resolve(o.v);
					else reject(o.e);
				},
			});
			this.kick();
		});
	}

	/** `p`'s outcome, settled only after a real setTimeout(0) once it is ready (FIFO by readiness). */
	later<T>(p: Promise<T>): Promise<T> {
		this.stats.port++;
		this.waiting++;
		this.kick();
		return new Promise<T>((resolve, reject) => {
			const ready = (settle: () => void): void => {
				this.waiting--;
				this.lateQ.push({ settle });
				this.kick();
			};
			p.then((v) => ready(() => resolve(v)), (e: unknown) => ready(() => reject(e)));
		});
	}

	private kick(): void {
		if (this.driving) return;
		this.driving = true;
		void this.drive();
	}

	/**
	 * Real macrotasks until no other armed macrotask is left: every storage idle check armed so far has run, with
	 * everything it set off (an auto-commit starts the next queued body, which may arm another). What a batch holds
	 * and when it settles are then fixed by the run's state, not by when the thread pool answers.
	 */
	private async quiet(): Promise<void> {
		do await this.macrotask();
		while (this.others() > 0);
	}

	private async drive(): Promise<void> {
		let idleTurns = 0;
		try {
			for (;;) {
				await this.quiet();
				if (this.realQ.length > 0) {
					const batch = this.realQ.splice(0);
					await Promise.all(batch.map((b) => b.done));
					await this.quiet();
					this.stats.batches++;
					for (const b of batch) b.settle();
					idleTurns = 0;
					continue;
				}
				if (this.lateQ.length > 0) {
					await this.timeout0();
					await this.quiet();
					const batch = this.lateQ.splice(0);
					this.stats.batches++;
					for (const b of batch) b.settle();
					idleTurns = 0;
					continue;
				}
				if (this.waiting > 0) {
					// A port call waits on something that is not routed through real(): should not happen. Keep turning
					// (it settles on its own) and count it, so a test can assert there are none.
					if (++idleTurns === 1) this.stats.strays++;
					await this.timeout0();
					continue;
				}
				return;
			}
		} finally {
			this.driving = false;
			if (!this.busy()) {
				const w = this.idleWaiters;
				this.idleWaiters = [];
				for (const r of w) r();
			} else this.kick();
		}
	}
}

const works = new WeakMap<VirtualClock, RealWork>();

/** The RealWork of `clock`'s run, attached on first use (one per clock: every device's crypto in one order). */
export function realWorkFor(clock: VirtualClock): RealWork {
	let w = works.get(clock);
	if (!w) {
		w = new RealWork().attach(clock);
		works.set(clock, w);
	}
	return w;
}

/** A SubtleCrypto whose every call is real work of `w` (the adapter's internals then run in one order). */
export function delayedSubtle(w: RealWork, inner: SubtleCrypto = crypto.subtle): SubtleCrypto {
	return new Proxy(inner, {
		get(target, prop) {
			const v = Reflect.get(target, prop, target) as unknown;
			if (typeof v !== "function") return v;
			return (...args: unknown[]) => w.real(() => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args));
		},
	});
}

/** `inner` with every async call settled after a real setTimeout(0) (RealWork.later); sync calls pass through. */
export function delayedCrypto(w: RealWork, inner: CryptoPort & KeyringCrypto): CryptoPort & KeyringCrypto {
	return {
		get suite() {
			return inner.suite;
		},
		sealEpoch: () => inner.sealEpoch(),
		keyState: (e) => inner.keyState(e),
		seal: (input) => w.later(inner.seal(input)),
		open: (input) => w.later(inner.open(input)),
		sealBlob: (input) => w.later(inner.sealBlob(input)),
		openBlob: (input) => w.later(inner.openBlob(input)),
		blobAddress: (hash): Promise<BlobAddress> => w.later(inner.blobAddress(hash)),
		diagHash: (bytes) => w.later(inner.diagHash(bytes)),
		generate: (e) => w.later(inner.generate(e)),
		install: (e, raw) => w.later(inner.install(e, raw)),
		kcv: (e) => w.later(inner.kcv(e)),
		wrap: (role, e, aad, rk) => w.later(inner.wrap(role, e, aad, rk)),
		unwrap: (role, e, aad, wrapped, rk) => w.later(inner.unwrap(role, e, aad, wrapped, rk)),
		markVerified: (e) => inner.markVerified(e),
		setSealEpoch: (e) => inner.setSealEpoch(e),
		drop: (e) => inner.drop(e),
		exportForHost: () => inner.exportForHost(),
	};
}

/** `inner` settled after a real setTimeout(0), like WebCrypto's digest (§16.3: no hash await inside a tx body either). */
export function delayedHash(w: RealWork, inner: HashPort): HashPort {
	return { sha256: (bytes) => w.later(inner.sha256(bytes)) };
}

/** The real suite-1 adapter over Node WebCrypto, wrapped in DelayedCrypto. Keys are zero-filled on import, as unwrapped. */
export async function createDelayedSuite1(w: RealWork, o: { readonly vaultId: VaultId; readonly random: RandomPort; readonly keys?: readonly { readonly e: number; readonly k: Uint8Array }[] }): Promise<CryptoPort & KeyringCrypto> {
	const inner: Suite1Crypto = await w.later(createWebCryptoSuite1({ vaultId: o.vaultId, random: o.random, subtle: delayedSubtle(w), keys: o.keys ? [...o.keys] : [] }));
	return delayedCrypto(w, inner);
}
