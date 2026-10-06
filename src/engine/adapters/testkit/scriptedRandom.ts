/** Test-only RandomPort: hands out queued byte strings in order, so each suite-1 vector names its nonce or key. */

import type { RandomPort } from "../../../ports/random";

export class ScriptedRandom implements RandomPort {
	private readonly queue: Uint8Array[] = [];
	/** Calls served so far. */
	calls = 0;

	push(...items: Uint8Array[]): this {
		this.queue.push(...items.map((b) => b.slice()));
		return this;
	}

	get pending(): number {
		return this.queue.length;
	}

	/** Returns the next queued item as is, whatever `length` asks for (so tests can feed bad nonce lengths). */
	bytes(length: number): Uint8Array {
		const next = this.queue.shift();
		if (!next) throw new Error(`ScriptedRandom: nothing queued for bytes(${length})`);
		this.calls++;
		return next;
	}

	float(): number {
		throw new Error("ScriptedRandom: float() is not scripted");
	}
}
