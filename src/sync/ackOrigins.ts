/**
 * Origin predicate for the server-ack candidate tracker.
 *
 * Intentionally separate from diskMirror / origins.isLocalOrigin() — that
 * predicate gates writeback suppression; this one gates candidate SV capture.
 * The classifications are identical today, but they are decoupled so future
 * changes to either predicate cannot silently break the other.
 */
export function isAckTrackedLocalOrigin(
	origin: unknown,
	provider: unknown,
	persistence: unknown,
): boolean {
	// Only exclude provider/persistence origins when they are actually set
	// (non-null/undefined). Y.Doc fires origin=null for direct user edits; we
	// must not confuse that with a null argument meaning "not attached yet."
	if (provider != null && origin === provider) return false; // remote update via sync provider
	if (persistence != null && origin === persistence) return false; // IDB persistence replay
	return true; // user edits, disk sync, repair, restore, migrations, etc.
}
