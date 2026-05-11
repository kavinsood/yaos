import type { ConnectionState } from "../runtime/connectionController";

export type SyncStatus = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

export type ServerReceiptStatus = {
	serverAppliedLocalState: boolean | null;
	lastServerReceiptEchoAt: number | null;
	lastKnownServerReceiptEchoAt: number | null;
	candidatePersistenceHealthy: boolean | null;
	serverReceiptStartupValidation: string | null;
};

export function getSyncStatusLabel(state: SyncStatus): string {
	const labels: Record<SyncStatus, string> = {
		disconnected: "CRDT: Disconnected",
		loading: "CRDT: Loading cache...",
		syncing: "CRDT: Syncing...",
		connected: "CRDT: Connected",
		offline: "CRDT: Offline",
		error: "CRDT: Error",
		unauthorized: "CRDT: Unauthorized",
	};
	return labels[state];
}

/**
 * Derives a status bar label directly from the rich `ConnectionState`. This
 * replaces the coarse 7-value SyncStatus → label mapping for the visible
 * status bar text, allowing the user to see auth rejection reasons and
 * schema-mismatch details without a full dashboard. Per the stabilization
 * plan (INV-AUTH-01): not a dashboard — just enough truth.
 */
export function getLabelFromConnectionState(
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
): string {
	let base: string;
	switch (state.kind) {
		case "disconnected":
			base = "YAOS: Disconnected";
			break;
		case "loading_cache":
			base = "YAOS: Loading...";
			break;
		case "connecting":
			base = "YAOS: Connecting...";
			break;
		case "online":
			base = "YAOS: Connected";
			break;
		case "offline":
			base = "YAOS: Offline";
			break;
		case "auth_failed":
			switch (state.code) {
				case "unclaimed":
					base = "YAOS: Server unclaimed";
					break;
				case "server_misconfigured":
					base = "YAOS: Server misconfigured";
					break;
				case "unauthorized":
				default:
					base = "YAOS: Auth rejected";
					break;
			}
			break;
		case "server_update_required":
			base = "YAOS: Update required";
			break;
	}
	if (transferStatus) base = `${base} (${transferStatus})`;
	const receipt = serverReceipt && shouldShowReceiptStatus(state)
		? getServerReceiptStatusLabel(serverReceipt, state.kind === "online")
		: null;
	if (attentionCount > 0) {
		base = `${base} · ${attentionCount} file${attentionCount === 1 ? "" : "s"} need attention`;
	}
	return receipt ? `${base} · ${receipt}` : base;
}

function shouldShowReceiptStatus(state: ConnectionState): boolean {
	return state.kind === "online" || state.kind === "offline";
}

function fmtTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function getServerReceiptStatusLabel(
	receipt: ServerReceiptStatus,
	connected: boolean,
): string {
	let label: string;
	if (receipt.serverAppliedLocalState === true && connected) {
		label = "Receipt: received";
	} else if (receipt.serverAppliedLocalState === false && connected) {
		label = "Receipt: waiting";
	} else if (receipt.serverAppliedLocalState === false && !connected) {
		label = "Receipt: offline, waiting";
	} else if (receipt.serverAppliedLocalState === true && !connected && receipt.lastServerReceiptEchoAt !== null) {
		label = `Receipt: offline, last echo ${fmtTime(receipt.lastServerReceiptEchoAt)}`;
	} else if (receipt.serverReceiptStartupValidation === "skipped_local_yjs_timeout") {
		label = "Receipt: restart unchecked";
	} else if (receipt.lastKnownServerReceiptEchoAt !== null && receipt.lastServerReceiptEchoAt === null) {
		label = "Receipt: checking";
	} else {
		label = "Receipt: not tracked";
	}
	if (receipt.candidatePersistenceHealthy === false) {
		label += " (persistence degraded)";
	}
	return label;
}

export function renderSyncStatus(
	statusBarEl: HTMLElement,
	state: SyncStatus,
	transferStatus?: string | null,
	attentionCount = 0,
): void {
	let text = getSyncStatusLabel(state);
	if (transferStatus) {
		text += ` (${transferStatus})`;
	}
	if (attentionCount > 0) {
		text += ` · ${attentionCount} file${attentionCount === 1 ? "" : "s"} need attention`;
	}
	statusBarEl.setText(text);
}

/**
 * Renders the status bar using the rich ConnectionState label. Prefer this
 * over renderSyncStatus when the ConnectionState is available.
 */
export function renderConnectionState(
	statusBarEl: HTMLElement,
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
): void {
	statusBarEl.setText(getLabelFromConnectionState(state, transferStatus, serverReceipt, attentionCount));
	const title = serverReceipt && shouldShowReceiptStatus(state)
		? "Server receipt means the server Y.Doc received this device's latest local CRDT state. It is not durable and does not mean other devices have applied it."
		: "";
	statusBarEl.setAttr("title", title);
}
