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
 *     open implies server accepted the device credential and vaultId). False only when the
 *     server explicitly sent a rejection code.
 *
 *   lastLocalUpdateWhileConnectedAt — a transport observation, not a receipt.
 *     A local Y.Doc update happened while the WebSocket was open, but this does
 *     not identify the update or prove durable application. The latest-state
 *     server receipt is exposed separately through serverReceipt.
 *
 *   pendingLocalCount — null because the durable receipt tracks the latest
 *     candidate state vector, not individually identified queued updates. It
 *     cannot provide queue cardinality or prove that an outbound buffer is empty.
 */

import type { ConnectionState } from "./connectionController";
import type { VaultSyncReceiptSnapshot } from "../sync/vaultSync";

export type SyncFactsReceipt = Readonly<
	Pick<
		VaultSyncReceiptSnapshot,
		| "serverAppliedLocalState"
		| "lastServerReceiptEchoAt"
		| "lastKnownServerReceiptEchoAt"
		| "candidatePersistenceHealthy"
		| "candidatePersistenceFailureCount"
		| "hasUnconfirmedCandidate"
		| "candidateCapturedAt"
	>
>;


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
	 * Always null: the latest-state durable receipt is not a queue. It tracks a
	 * candidate state vector, not individually identified pending updates, so it
	 * cannot provide queue cardinality.
	 */
	pendingLocalCount: null;

	/** Count of blob uploads pending. */
	pendingBlobUploads: number;

	/** Canonical server-receipt facts, or null before the sync runtime exists. */
	serverReceipt: SyncFactsReceipt | null;

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
	serverReceipt?: SyncFactsReceipt | null;
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
			// Explicit credential/configuration rejection: unauthorized, unclaimed,
			// server_misconfigured, or server_format_unsupported.
			authAccepted = false;
		}
	}

	// The latest-state receipt can prove whether one candidate state vector was
	// durably applied. It does not identify every queued update, so it cannot
	// yield a pending count.
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
		serverReceipt: snapshot.serverReceipt ?? null,
		headlineState,
	};
}
