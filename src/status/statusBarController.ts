export type SyncStatus = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

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

export function renderSyncStatus(
	statusBarEl: HTMLElement,
	state: SyncStatus,
	transferStatus?: string | null,
): void {
	let text = getSyncStatusLabel(state);
	if (transferStatus) {
		text += ` (${transferStatus})`;
	}
	statusBarEl.setText(text);
}
