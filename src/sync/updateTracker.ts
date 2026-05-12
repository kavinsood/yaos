/**
 * Tracks when local and remote Y.Doc updates occur.
 *
 * This module is intentionally Obsidian-free so it can be tested under Node.
 * The caller attaches it to a live Y.Doc; the tracker records timestamps that
 * honest status reporting can surface to the user.
 *
 * Terminology (matches INV-ACK-01 draft):
 *
 *   lastLocalUpdateAt  — last time the local CRDT changed from any local source
 *                        (user edits, disk syncs, snapshot restores). Excludes:
 *                        provider remote updates and IndexedDB persistence loads.
 *
 *   lastLocalUpdateWhileConnectedAt
 *                      — last time a local update occurred while getConnected()
 *                        was true. This is the strongest claim we can make without
 *                        a provider-level send hook or server receipt: the update
 *                        was eligible to be sent at that moment. It does NOT prove
 *                        the update was put on the socket, received, accepted, or
 *                        persisted by the server. Do not label this "sent" in UI.
 *
 *   lastRemoteUpdateAt — last time the provider applied a remote update from the
 *                        server. Tells the user "I last heard from the server at…"
 */

export type ProviderObject = object;
export type PersistenceObject = object;

export class UpdateTracker {
	private _lastLocalUpdateAt: number | null = null;
	private _lastLocalUpdateWhileConnectedAt: number | null = null;
	private _lastRemoteUpdateAt: number | null = null;

	/**
	 * Attach to a Y.Doc. Must be called exactly once after construction.
	 *
	 * Origin classification relies on how y-partyserver and y-indexeddb pass the
	 * transaction origin to Y.applyUpdate — verified against library source:
	 *
	 *   y-partyserver provider (dist/provider/index.js):
	 *     messageHandlers[messageSync] calls
	 *     syncProtocol.readSyncMessage(decoder, encoder, provider.doc, provider)
	 *     → y-protocols/sync.js readSyncStep2 → Y.applyUpdate(doc, update, transactionOrigin)
	 *     where transactionOrigin = provider (the provider object itself). ✓
	 *
	 *   y-indexeddb (src/y-indexeddb.js):
	 *     fetchUpdates calls
	 *     Y.transact(idbPersistence.doc, () => { updates.forEach(v => Y.applyUpdate(doc, v)) },
	 *       idbPersistence, false)
	 *     where the 3rd arg is the origin = idbPersistence (the persistence object itself).
	 *     _storeUpdate guards `origin !== this` to avoid re-persisting IDB-loaded updates. ✓
	 *
	 * If either library changes how it passes origins, classification will silently break.
	 * Re-verify when upgrading y-partyserver or y-indexeddb.
	 *
	 * @param doc           The vault Y.Doc to observe.
	 * @param getConnected  Returns true if the WebSocket is currently open.
	 *                      Called at update time so the tracker sees the live state.
	 * @param provider      The YSyncProvider instance — updates from this origin
	 *                      are classified as remote.
	 * @param persistence   The IndexeddbPersistence instance (optional). Updates
	 *                      from this origin are IDB cache loads and are not
	 *                      counted as local user/sync activity.
	 */
	attach(
		doc: { on: (event: "update", handler: (update: Uint8Array, origin: unknown) => void) => void },
		getConnected: () => boolean,
		provider: ProviderObject,
		persistence?: PersistenceObject,
	): void {
		doc.on("update", (_update: Uint8Array, origin: unknown) => {
			const now = Date.now();
			if (origin === provider) {
				this._lastRemoteUpdateAt = now;
			} else if (origin !== persistence) {
				this._lastLocalUpdateAt = now;
				if (getConnected()) {
					this._lastLocalUpdateWhileConnectedAt = now;
				}
			}
		});
	}

	get lastLocalUpdateAt(): number | null { return this._lastLocalUpdateAt; }
	get lastLocalUpdateWhileConnectedAt(): number | null { return this._lastLocalUpdateWhileConnectedAt; }
	get lastRemoteUpdateAt(): number | null { return this._lastRemoteUpdateAt; }
}
