/**
 * Connection fact derivation for Phase 1.4.
 *
 * This module is intentionally Obsidian-free so it can be tested under Node.
 * `deriveSyncFacts()` is a pure function: given a snapshot of sync state, it
 * returns the decomposed connection facts that honest status reporting requires.
 *
 * Design notes:
 *
 *   serverReachable — null when unknown (no connection established AND no auth
 *     response received). True when either the WebSocket is open OR we received
 *     any fatal auth response from the server (both mean the network can reach
 *     it). We do not perform HTTP probes; this field reflects what we know from
 *     WebSocket + auth messages only.
 *
 *   authAccepted — null when unknown. True only when websocketOpen (WebSocket
 *     open implies server accepted the token and vaultId). False only when the
 *     server explicitly sent a rejection code.
 *
 *   lastLocalUpdateWhileConnectedAt — the strongest honest claim we can make about
 *     outbound candidates today. A local Y.Doc update that happened while the
 *     WebSocket was open is "eligible" to have been sent — but we have no provider-
 *     level send hook or server receipt to prove it was actually delivered. Do NOT
 *     label this "sent" in UI copy. See FU-8 in engineering/phase-1-followups.md
 *     for the server receipt mechanism needed to make stronger claims.
 *
 *   pendingLocalCount — null always until a real server ack/queue mechanism exists.
 *     "Connected" only means transport is open; it does not prove the outbound
 *     buffer was flushed, the server received the update, or the update persisted.
 *     See FU-8. Do NOT set this to 0 merely because websocketOpen is true.
 */

import type { ConnectionState } from "./connectionController";

export interface SyncFacts {
	/** True = server responded. False/null = unknown (no connection, no auth message). */
	serverReachable: boolean | null;
	/** True = WebSocket opened (implies auth succeeded). False = explicit rejection. */
	authAccepted: boolean | null;
	/** Whether the WebSocket is currently open. */
	websocketOpen: boolean;
	/** The most recent fatal auth code from the server, or null. */
	lastAuthRejectCode: string | null;

	/** Timestamp (ms) of the last local CRDT change. Null if none since startup. */
	lastLocalUpdateAt: number | null;
	/**
	 * Timestamp (ms) of the last local update that occurred while the WebSocket
	 * was open. NOT proof of server delivery. See comment in connectionFacts.ts.
	 */
	lastLocalUpdateWhileConnectedAt: number | null;
	/** Timestamp (ms) of the last remote update applied from the server. */
	lastRemoteUpdateAt: number | null;

	/**
	 * Always null — not derivable without a server ack/queue mechanism.
	 * "WebSocket open" does NOT mean pending = 0: the transport being open says
	 * nothing about whether the outbound buffer was flushed, the server received
	 * the update, or the server persisted it. See FU-8 (server receipt mechanism).
	 */
	pendingLocalCount: null;

	/** Count of blob uploads pending. */
	pendingBlobUploads: number;

	/** FU-8 Level 3 server receipt facts. Not durable. */
	serverAppliedLocalState: boolean | null;
	lastServerReceiptEchoAt: number | null;
	lastKnownServerReceiptEchoAt: number | null;
	candidatePersistenceHealthy: boolean | null;
	candidatePersistenceFailureCount: number | null;
	hasUnconfirmedServerReceiptCandidate: boolean;
	serverReceiptCandidateCapturedAt: number | null;

	/** Derived headline connection state. */
	headlineState: ConnectionState["kind"];
}

export interface SyncFactsSnapshot {
	connected: boolean;
	fatalAuthError: boolean;
	fatalAuthCode: string | null;
	lastLocalUpdateAt: number | null;
	lastLocalUpdateWhileConnectedAt: number | null;
	lastRemoteUpdateAt: number | null;
	pendingBlobUploads: number;
	serverAppliedLocalState?: boolean | null;
	lastServerReceiptEchoAt?: number | null;
	lastKnownServerReceiptEchoAt?: number | null;
	candidatePersistenceHealthy?: boolean | null;
	candidatePersistenceFailureCount?: number | null;
	hasUnconfirmedServerReceiptCandidate?: boolean;
	serverReceiptCandidateCapturedAt?: number | null;
}

export function deriveSyncFacts(
	snapshot: SyncFactsSnapshot,
	headlineState: ConnectionState["kind"],
): SyncFacts {
	const { connected, fatalAuthError, fatalAuthCode } = snapshot;

	const websocketOpen = connected;

	// serverReachable: we can only claim "true" if we've successfully communicated
	// (ws connected) or the server sent an auth response. Unknown otherwise.
	const serverReachable: boolean | null = connected || fatalAuthError ? true : null;

	// authAccepted: definitely true if ws is open (auth must have passed to open the
	// WebSocket). Also true for update_required: the server checked credentials first,
	// then rejected the protocol version — auth itself succeeded. Definitively false
	// only for explicit credential rejections.
	let authAccepted: boolean | null = null;
	if (connected) {
		authAccepted = true;
	} else if (fatalAuthError && fatalAuthCode) {
		if (fatalAuthCode === "update_required") {
			// Auth passed but schema/version is incompatible. Credentials were accepted.
			authAccepted = true;
		} else {
			// Explicit credential rejection: unauthorized, unclaimed, server_misconfigured.
			authAccepted = false;
		}
	}

	// pendingLocalCount: always null. "WebSocket open" proves only that the transport
	// is up — not that the outbound buffer is empty, not that the server received
	// anything, not that updates persisted. A real pending count requires a server
	// ack/receipt mechanism (see FU-8 in engineering/phase-1-followups.md).
	const pendingLocalCount = null;

	return {
		serverReachable,
		authAccepted,
		websocketOpen,
		lastAuthRejectCode: fatalAuthCode,
		lastLocalUpdateAt: snapshot.lastLocalUpdateAt,
		lastLocalUpdateWhileConnectedAt: snapshot.lastLocalUpdateWhileConnectedAt,
		lastRemoteUpdateAt: snapshot.lastRemoteUpdateAt,
		pendingLocalCount,
		pendingBlobUploads: snapshot.pendingBlobUploads,
		serverAppliedLocalState: snapshot.serverAppliedLocalState ?? null,
		lastServerReceiptEchoAt: snapshot.lastServerReceiptEchoAt ?? null,
		lastKnownServerReceiptEchoAt: snapshot.lastKnownServerReceiptEchoAt ?? null,
		candidatePersistenceHealthy: snapshot.candidatePersistenceHealthy ?? null,
		candidatePersistenceFailureCount: snapshot.candidatePersistenceFailureCount ?? null,
		hasUnconfirmedServerReceiptCandidate: snapshot.hasUnconfirmedServerReceiptCandidate ?? false,
		serverReceiptCandidateCapturedAt: snapshot.serverReceiptCandidateCapturedAt ?? null,
		headlineState,
	};
}
