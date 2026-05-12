import * as Y from "yjs";

/**
 * Returns true if state vector `a` is "greater than or equal to" state
 * vector `b` in the Yjs sense: for every (clientId, clock) pair in `b`,
 * the corresponding clock in `a` is >= that value.
 *
 * Used to check whether a server SV echo confirms a local candidate SV:
 *   isStateVectorGe(serverSv, candidateSv) === true means the server's
 *   Y.Doc includes all ops from the candidate.
 *
 * Fails closed on malformed input — returns false rather than true.
 * Caller must not interpret false as "not yet confirmed"; they must
 * distinguish null candidate from false-due-to-error at the call site.
 */
export function isStateVectorGe(a: Uint8Array, b: Uint8Array): boolean {
	try {
		const svA = Y.decodeStateVector(a);
		const svB = Y.decodeStateVector(b);
		for (const [clientId, clock] of svB) {
			if ((svA.get(clientId) ?? 0) < clock) return false;
		}
		return true;
	} catch {
		return false;
	}
}
