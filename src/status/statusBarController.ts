import type { ConnectionState } from "../runtime/connectionController";
import type { VaultSyncReceiptSnapshot } from "../sync/vaultSync";
import type { RecoveryReadiness } from "../snapshots/recoveryState";


export type ServerReceiptStatus = Readonly<
	Pick<
		VaultSyncReceiptSnapshot,
		| "serverAppliedLocalState"
		| "lastServerReceiptEchoAt"
		| "lastKnownServerReceiptEchoAt"
		| "candidatePersistenceHealthy"
		| "serverReceiptStartupValidation"
		| "serverPersistenceDegraded"
	>
>;


/**
 * Derives status text directly from the rich `ConnectionState`, preserving
 * actionable auth, compatibility, and local-persistence failure details.
 */
export function getLabelFromConnectionState(
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
	recovery?: RecoveryReadiness | null,
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
				case "server_format_unsupported":
					base = "YAOS: Server format unsupported";
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
		case "local_persistence_failed":
			base = "YAOS: Local storage error";
			break;
		case "error":
			base = "YAOS: Error";
			break;
	}
	if (transferStatus) base = `${base} (${transferStatus})`;
	const receipt = serverReceipt && shouldShowReceiptStatus(state)
		? getServerReceiptStatusLabel(serverReceipt, state.kind === "online")
		: null;
	if (attentionCount > 0) {
		base = `${base} · ${attentionCount} file${attentionCount === 1 ? "" : "s"} need attention`;
	}
	// Ranked ahead of the receipt: a receipt can be outstanding merely because
	// nothing was sent, whereas this says the server cannot store what it has
	// already accepted.  Shown even while "Connected", because a healthy socket
	// is exactly what makes this failure invisible.
	if (serverReceipt?.serverPersistenceDegraded === true) {
		base = `${base} · Server not saving`;
	}
	if (recovery) {
		base = `${base} · Recovery ${recovery}`;
	}
	return receipt ? `${base} · ${receipt}` : base;
}

function shouldShowReceiptStatus(state: ConnectionState): boolean {
	return state.kind === "online" || state.kind === "offline";
}

export const SERVER_RECEIPT_STATUS_TITLE =
	"Server receipt means this device’s latest local CRDT state was written to the server’s storage. It does not prove that another device received the change.";

export function getServerReceiptStatusTitle(): string {
	return SERVER_RECEIPT_STATUS_TITLE;
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
		label = "Receipt: server saved latest local state";
	} else if (receipt.serverAppliedLocalState === false && connected) {
		label = "Receipt: local state not yet received by server";
	} else if (receipt.serverAppliedLocalState === false && !connected) {
		label = "Receipt: offline — local state not yet received by server";
	} else if (receipt.serverAppliedLocalState === true && !connected && receipt.lastServerReceiptEchoAt !== null) {
		label = `Receipt: offline — server saved at ${fmtTime(receipt.lastServerReceiptEchoAt)}`;
	} else if (receipt.lastKnownServerReceiptEchoAt !== null && receipt.lastServerReceiptEchoAt === null) {
		label = `Receipt: last known server receipt at ${fmtTime(receipt.lastKnownServerReceiptEchoAt)} — checking…`;
	} else {
		label = "Receipt: not tracked yet";
	}
	if (receipt.candidatePersistenceHealthy === false) {
		label += " — receipt history not saved locally";
	}
	return label;
}


/** Renders the status bar from the canonical rich connection state. */
export function renderConnectionState(
	statusBarEl: HTMLElement,
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
	recovery?: RecoveryReadiness | null,
): void {
	statusBarEl.setText(getLabelFromConnectionState(
		state,
		transferStatus,
		serverReceipt,
		attentionCount,
		recovery,
	));
	const receiptTitle = serverReceipt && shouldShowReceiptStatus(state)
		? getServerReceiptStatusTitle()
		: "";
	const recoveryTitle = recovery
		? `Recovery is ${recovery}; sync connectivity and recovery preparation are independent.`
		: "";
	statusBarEl.setAttr("title", [receiptTitle, recoveryTitle].filter(Boolean).join(" "));
}
