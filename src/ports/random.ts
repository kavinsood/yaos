/** RandomPort. DESIGN §h. Seeded in simulation. */

export interface RandomPort {
	/** Cryptographically strong in production (crypto.getRandomValues). */
	bytes(length: number): Uint8Array;
	/** Uniform [0, 1). Jitter only; never identifiers. */
	float(): number;
}
