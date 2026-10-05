import type { PathIdentity } from "./flightEvents";
import { fnv1a32, toHex8 } from "../../utils/fnv1a";
import { canonicalizeVaultPath } from "../../paths/canonicalPath";

export type HashHex = (input: string) => Promise<string>;

type IdentityOptions = {
	/** Vault-scoped pseudonymization salt from deriveVaultPathSalt(). */
	salt: string;
};

const PATH_PREFIX = "p:";
const HASH_SEPARATOR = "\u0000";
const DEGRADED_PREFIX = "pd:";
const SALT_DOMAIN = "yaos.path-pseudonym.v1";
const FINGERPRINT_DOMAIN = "yaos.path-pseudonym-fingerprint.v1";

/**
 * Derive the path pseudonymization salt for a vault.
 *
 * The salt is *vault*-scoped, not device-scoped and not user-managed: every
 * device configured against the same vaultId derives the same salt, so the
 * same vault path produces the same pathId in traces captured on different
 * devices. That cross-device correlation is the whole point — a distributed
 * sync bug is only legible when both sides of the conversation agree on what
 * to call a file.
 *
 * The salt is never written into an exported trace. vaultId is redacted out
 * of the safe export, and the salt is a domain-separated digest of it, so it
 * cannot be recomputed from the vaultIdHash that the export does carry.
 */
export async function deriveVaultPathSalt(sha256Hex: HashHex, vaultId: string): Promise<string> {
	return await sha256Hex(`${SALT_DOMAIN}${HASH_SEPARATOR}${vaultId.trim()}`);
}

/**
 * A shareable fingerprint of a derived salt, safe to publish in a trace
 * header. Two traces carrying the same fingerprint use the same pathId
 * namespace and can be merged; differing fingerprints cannot.
 */
export async function deriveSaltFingerprint(sha256Hex: HashHex, salt: string): Promise<string> {
	const digest = await sha256Hex(`${FINGERPRINT_DOMAIN}${HASH_SEPARATOR}${salt}`);
	return `sha256:${digest.slice(0, 32)}`;
}

export class PathIdentityResolver {
	private readonly salt: string;
	/**
	 * Promise cache: same normalized path always resolves to the same promise,
	 * so concurrent callers awaiting the same path coalesce and ordering is
	 * stable without extra locking.
	 */
	private readonly cache = new Map<string, Promise<string>>();
	/** Settled pathId per normalized path — backs directory(). */
	private readonly resolved = new Map<string, string>();
	private degradedCount = 0;

	constructor(
		private readonly sha256Hex: HashHex,
		options: IdentityOptions,
	) {
		this.salt = options.salt;
	}

	/**
	 * Resolve a vault path to its pseudonym. Raw paths are never returned:
	 * the recorder writes pseudonyms only, and the real path appears solely in
	 * the directory of an explicitly unredacted export.
	 */
	async getPathIdentity(rawPath: string): Promise<PathIdentity> {
		const normalized = canonicalizeVaultPath(rawPath).normalizedPath;
		return { pathId: await this.getOrComputePathId(normalized) };
	}

	/**
	 * Eagerly prime the cache for known paths (e.g., all active CRDT paths at
	 * trace start). This avoids ordering races on the hot recording path.
	 */
	async prime(paths: Iterable<string>): Promise<void> {
		const pending: Promise<void>[] = [];
		for (const rawPath of paths) {
			if (!rawPath) continue;
			const normalized = canonicalizeVaultPath(rawPath).normalizedPath;
			if (this.cache.has(normalized)) continue;
			pending.push(this.getOrComputePathId(normalized).then(() => undefined));
		}
		await Promise.all(pending);
	}

	/**
	 * Every canonical path resolved so far, paired with its pseudonym. This is
	 * the only place vault paths leave the resolver; the redacted export must
	 * not include it.
	 */
	directory(): Array<{ pathId: string; path: string }> {
		return [...this.resolved].map(([path, pathId]) => ({ pathId, path }));
	}

	get hasDegraded(): boolean {
		return this.degradedCount > 0;
	}

	// -----------------------------------------------------------------------

	private getOrComputePathId(normalized: string): Promise<string> {
		let p = this.cache.get(normalized);
		if (!p) {
			p = this.computePathId(normalized).then((pathId) => {
				this.resolved.set(normalized, pathId);
				return pathId;
			});
			this.cache.set(normalized, p);
		}
		return p;
	}

	/**
	 * Keyed SHA-256 path pseudonymization: SHA256(salt || \0 || normalizedPath).
	 * This is NOT HMAC. For this use case (non-security path pseudonymization where
	 * the salt is never shared with adversaries), keyed SHA-256 is acceptable.
	 * To upgrade to real HMAC, use crypto.subtle.importKey with HMAC algorithm.
	 */
	private async computePathId(normalized: string): Promise<string> {
		if (!normalized) return `${PATH_PREFIX}empty`;
		try {
			const digest = await this.sha256Hex(`${this.salt}${HASH_SEPARATOR}${normalized}`);
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
		const seed = `${this.salt}${HASH_SEPARATOR}${normalized}`;
		return `${DEGRADED_PREFIX}${toHex8(fnv1a32(seed))}`;
	}
}
