import type { FlightMode, PathIdentity } from "./flightEvents";

/**
 * Local path normalizer — replaces backslashes, collapses repeated slashes,
 * removes leading slashes. Equivalent to Obsidian's normalizePath for vault paths.
 */
function normalizeTracePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
}

export type HashHex = (input: string) => Promise<string>;

type IdentityOptions = {
	mode: FlightMode;
	pathSecret: string;
	qaTraceSecret?: string | null;
};

const PATH_PREFIX = "p:";
const HASH_SEPARATOR = "\u0000";
const DEGRADED_PREFIX = "pd:";

export class PathIdentityResolver {
	private readonly mode: FlightMode;
	private readonly secret: string;
	/**
	 * Promise cache: same normalized path always resolves to the same promise,
	 * so concurrent callers awaiting the same path coalesce and ordering is
	 * stable without extra locking.
	 */
	private readonly cache = new Map<string, Promise<string>>();
	private degradedCount = 0;

	constructor(
		private readonly sha256Hex: HashHex,
		options: IdentityOptions,
	) {
		this.mode = options.mode;
		this.secret = this.mode === "qa-safe" && options.qaTraceSecret
			? options.qaTraceSecret
			: options.pathSecret;
	}

	async getPathIdentity(rawPath: string): Promise<PathIdentity> {
		const normalized = normalizeTracePath(rawPath);
		const pathId = await this.getOrComputePathId(normalized);
		if (this.mode === "full" || this.mode === "local-private") {
			return { pathId, path: normalized };
		}
		return { pathId };
	}

	/**
	 * Eagerly prime the cache for known paths (e.g., all active CRDT paths at
	 * trace start). This avoids ordering races on the hot recording path.
	 */
	async prime(paths: Iterable<string>): Promise<void> {
		const pending: Promise<void>[] = [];
		for (const rawPath of paths) {
			if (!rawPath) continue;
			const normalized = normalizeTracePath(rawPath);
			if (this.cache.has(normalized)) continue;
			pending.push(this.getOrComputePathId(normalized).then(() => undefined));
		}
		await Promise.all(pending);
	}

	get hasDegraded(): boolean {
		return this.degradedCount > 0;
	}

	// -----------------------------------------------------------------------

	private getOrComputePathId(normalized: string): Promise<string> {
		let p = this.cache.get(normalized);
		if (!p) {
			p = this.computePathId(normalized);
			this.cache.set(normalized, p);
		}
		return p;
	}

	/**
	 * Keyed SHA-256 path pseudonymization: SHA256(secret || \0 || normalizedPath).
	 * This is NOT HMAC. For this use case (non-security path pseudonymization where
	 * the secret is ephemeral and never shared with adversaries), keyed SHA-256 is
	 * acceptable. To upgrade to real HMAC, use crypto.subtle.importKey with HMAC algorithm.
	 */
	private async computePathId(normalized: string): Promise<string> {
		if (!normalized) return `${PATH_PREFIX}empty`;
		try {
			const digest = await this.sha256Hex(`${this.secret}${HASH_SEPARATOR}${normalized}`);
			// 128-bit prefix (32 hex chars)
			return `${PATH_PREFIX}${digest.slice(0, 32)}`;
		} catch {
			// sha256Hex unavailable (unusual, but guard against it)
			this.degradedCount++;
			return this.fallbackPathId(normalized);
		}
	}

	/**
	 * Emergency synchronous fallback (FNV-1a 32-bit).
	 * Only used when crypto.subtle is unavailable.
	 * Callers must check hasDegraded and emit path.identity.degraded.
	 */
	private fallbackPathId(normalized: string): string {
		let h = 0x811c9dc5;
		const seed = `${this.secret}${HASH_SEPARATOR}${normalized}`;
		for (let i = 0; i < seed.length; i++) {
			h ^= seed.charCodeAt(i);
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return `${DEGRADED_PREFIX}${h.toString(16).padStart(8, "0")}`;
	}
}
