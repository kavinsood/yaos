/**
 * Seeded RandomPort for simulation (DESIGN §m). sfc32 seeded via splitmix32
 * (12 warm-up draws). Bit-for-bit the same sequence as the former WP-D
 * stand-in, so seeds recorded against it still reproduce.
 *
 * `fork(label)` derives an independent deterministic stream
 * (seed ^ FNV-1a(label)) so adding draws in one actor never shifts another.
 */

import type { RandomPort } from "../ports/random";

function splitmix32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x9e3779b9) >>> 0;
		let z = s;
		z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
		z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
		return (z ^ (z >>> 16)) >>> 0;
	};
}

/** FNV-1a over UTF-16 code units. */
export function hashLabel(label: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
	return h;
}

export class SeededRandom implements RandomPort {
	private a: number;
	private b: number;
	private c: number;
	private d: number;

	constructor(readonly seed: number) {
		const sm = splitmix32(seed);
		this.a = sm();
		this.b = sm();
		this.c = sm();
		this.d = sm();
		for (let i = 0; i < 12; i++) this.u32();
	}

	u32(): number {
		const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
		this.d = (this.d + 1) >>> 0;
		this.a = this.b ^ (this.b >>> 9);
		this.b = (this.c + (this.c << 3)) >>> 0;
		this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
		this.c = (this.c + t) >>> 0;
		return t;
	}

	/** Uniform [0, 1). */
	float(): number {
		return this.u32() / 4294967296;
	}

	bytes(length: number): Uint8Array {
		const out = new Uint8Array(length);
		for (let i = 0; i < length; i++) out[i] = this.u32() & 0xff;
		return out;
	}

	/** Integer in [0, n). */
	int(n: number): number {
		return Math.floor(this.float() * n);
	}

	/** Integer in [lo, hi] (inclusive). */
	range(lo: number, hi: number): number {
		return lo + this.int(hi - lo + 1);
	}

	chance(p: number): boolean {
		return this.float() < p;
	}

	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new Error("pick from empty list");
		return items[this.int(items.length)] as T;
	}

	/** Weighted pick: entries [item, weight >= 0]; at least one positive weight. */
	weighted<T>(entries: readonly (readonly [T, number])[]): T {
		let total = 0;
		for (const [, w] of entries) total += Math.max(0, w);
		if (!(total > 0)) throw new Error("weighted pick with no positive weight");
		let x = this.float() * total;
		for (const [item, w] of entries) {
			x -= Math.max(0, w);
			if (x < 0) return item;
		}
		return entries[entries.length - 1]![0];
	}

	/** Fisher-Yates in place; returns the array. */
	shuffle<T>(items: T[]): T[] {
		for (let i = items.length - 1; i > 0; i--) {
			const j = this.int(i + 1);
			const t = items[i] as T;
			items[i] = items[j] as T;
			items[j] = t;
		}
		return items;
	}

	/** Exponentially distributed value with the given mean (>= 0). */
	exponential(mean: number): number {
		return -Math.log(1 - this.float()) * mean;
	}

	fork(label: string): SeededRandom {
		return new SeededRandom((this.seed ^ hashLabel(label)) >>> 0);
	}

	/** Short unique-ish token [a-z0-9]{n}. */
	token(n = 8): string {
		const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
		let s = "";
		for (let i = 0; i < n; i++) s += alphabet[this.int(alphabet.length)];
		return s;
	}
}
