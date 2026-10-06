/**
 * A SubtleCrypto proxy for tests: records every call, the `extractable`
 * argument of every importKey/deriveKey/generateKey, and every CryptoKey
 * returned, so a test can prove the suite-1 adapter only makes
 * non-extractable keys (e2ee-design §6.3).
 */
export interface SubtleSpy {
	readonly subtle: SubtleCrypto;
	readonly calls: string[];
	readonly extractable: unknown[];
	readonly keys: CryptoKey[];
}

const MAKES_KEY: Record<string, number> = { importKey: 3, deriveKey: 3, generateKey: 1 };

export function spySubtle(real: SubtleCrypto = globalThis.crypto.subtle): SubtleSpy {
	const calls: string[] = [];
	const extractable: unknown[] = [];
	const keys: CryptoKey[] = [];
	const subtle = new Proxy(real, {
		get(target, prop) {
			const v: unknown = Reflect.get(target, prop, target);
			if (typeof v !== "function") return v;
			return async (...args: unknown[]) => {
				const name = String(prop);
				calls.push(name);
				const at = MAKES_KEY[name];
				if (at !== undefined) extractable.push(args[at]);
				const r: unknown = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
				if (r instanceof CryptoKey) keys.push(r);
				return r;
			};
		},
	});
	return { subtle, calls, extractable, keys };
}
