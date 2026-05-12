/**
 * Authoritative source for Yjs transaction origin constants.
 *
 * This module is intentionally Obsidian-free so it can be imported in Node
 * regression tests. All call sites that write to Y.Text with a local-repair
 * origin MUST import constants from here — raw string literals at call sites
 * are a regression risk.
 *
 * ORIGIN_SEED: src/types.ts re-exports this from here (legacy import path).
 * ORIGIN_RESTORE: src/sync/snapshotClient.ts imports from here (duplicate removed).
 */

export const ORIGIN_SEED = "vault-crdt-seed" as const;
export const ORIGIN_RESTORE = "snapshot-restore" as const;
export const ORIGIN_DISK_SYNC = "disk-sync" as const;
export const ORIGIN_DISK_SYNC_RECOVER_BOUND = "disk-sync-recover-bound" as const;
export const ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER = "disk-sync-open-idle-recover" as const;
export const ORIGIN_EDITOR_HEALTH_HEAL = "editor-health-heal" as const;

/**
 * Internal set — not exported directly to prevent mutable cast-away access.
 * Use isLocalOrigin() for gate decisions or LOCAL_REPAIR_ORIGINS for
 * enumeration in tests.
 *
 * Convention: any new local-repair origin emitted elsewhere in the codebase
 * must be added here in the same change as the call site.
 */
const LOCAL_STRING_ORIGIN_SET = new Set<string>([
	ORIGIN_SEED,
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_RESTORE,
]);

/**
 * Readonly array of all local-repair origin strings. Use this in tests that
 * need to enumerate the set. Production code should use isLocalOrigin() or
 * isLocalStringOrigin().
 */
export const LOCAL_REPAIR_ORIGINS: readonly string[] = Object.freeze([
	...LOCAL_STRING_ORIGIN_SET,
]);

/**
 * Returns true if a plain string origin is a known local-repair origin.
 * Prefer isLocalOrigin() for gate decisions (handles provider identity +
 * null + object origins). This predicate is for string-only membership checks.
 */
export function isLocalStringOrigin(origin: string): boolean {
	return LOCAL_STRING_ORIGIN_SET.has(origin);
}

/**
 * Returns true if the Yjs transaction origin is local (should NOT trigger a
 * disk write). The sync provider applies remote updates with
 * `transactionOrigin = provider`. y-codemirror applies local editor updates
 * with `transactionOrigin = YSyncConfig`.
 *
 * We only treat provider-origin transactions as remote.
 */
export function isLocalOrigin(origin: unknown, provider: unknown): boolean {
	if (origin === provider) return false;
	if (typeof origin === "string") return LOCAL_STRING_ORIGIN_SET.has(origin);
	if (origin == null) return true;
	// Non-null object origins (e.g. y-codemirror's YSyncConfig) are local.
	return true;
}
