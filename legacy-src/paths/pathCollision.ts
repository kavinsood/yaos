/**
 * Path collision detection.
 *
 * A collision occurs when two distinct display paths map to the same
 * canonical key. This means the vault has two "files" that are actually
 * the same identity from sync's perspective.
 *
 * Collisions are EXPLICIT. This module never silently picks a winner.
 * Callers must handle collisions (quarantine, report, reject, etc).
 *
 * NOTE: This module provides detection primitives only. Collision
 * enforcement at admission boundaries is future work.
 */

import { canonicalizeVaultPath } from "./canonicalPath";

export interface PathCollision {
	/** The canonical key that multiple display paths share. */
	readonly canonicalKey: string;
	/** The distinct display paths that collide on this key. */
	readonly displayPaths: readonly string[];
	/** What kind of normalization caused the collision. */
	readonly kind: "canonical-equivalence";
}

/**
 * Whether two path entries represent a canonical collision in sync state.
 *
 * Canonical-equivalent display paths are only a collision when they resolve
 * to separate CRDT file identities. A single file can be observed through
 * equivalent path spellings during a rename and must not be diagnosed.
 */
export function isCanonicalPathFileIdCollision(input: {
	oldCanonicalKey: string;
	newCanonicalKey: string;
	oldFileId: string | undefined;
	newFileId: string | undefined;
}): boolean {
	return input.oldCanonicalKey === input.newCanonicalKey
		&& input.oldFileId !== undefined
		&& input.newFileId !== undefined
		&& input.oldFileId !== input.newFileId;
}

/**
 * Find all canonical path collisions in a set of vault paths.
 *
 * Returns collisions where 2+ distinct display paths share the same
 * canonical key after normalization. Exact duplicates (same string
 * appearing twice) are not collisions — they are the same path.
 *
 * This is a detection primitive. It does not enforce policy.
 * Callers decide what to do with collisions.
 */
export function findCanonicalPathCollisions(paths: readonly string[]): PathCollision[] {
	const byKey = new Map<string, Set<string>>();

	for (const path of paths) {
		const key = canonicalizeVaultPath(path).canonicalKey;
		const existing = byKey.get(key);
		if (existing) {
			existing.add(path);
		} else {
			byKey.set(key, new Set([path]));
		}
	}

	return [...byKey.entries()]
		.filter(([, displayPaths]) => displayPaths.size > 1)
		.map(([canonicalKey, displayPaths]) => ({
			canonicalKey,
			displayPaths: [...displayPaths],
			kind: "canonical-equivalence" as const,
		}));
}
