/**
 * Command palette entries: ids, names and when each is available. Pure; registerUi binds the
 * actions. Obsidian prefixes ids with the plugin id ("yaos:yaos-pause").
 */

import { isCreating, pinnedSuite } from "../keys/pin";
import { pendingBrake, type YaosUiHost } from "./api";
import { engineAcceptsCommands, isPaused } from "./settingsModel";

type StateHost = Pick<YaosUiHost, "data" | "status">;

/**
 * "Create a new vault" may start (§15.1, §15.2): on an unpaired device, or on a paired one that holds its vault's
 * pin and key (the engine reports nothing missing). A paired device that is blocked for want of a key or pin, or
 * whose engine has not said yet, only takes a key (§12.4): the command and the settings action are not offered,
 * and createAndEnroll refuses before any request.
 */
export function canCreateVault(h: StateHost): boolean {
	const d = h.data();
	if (d.identity === null) return true;
	return pinnedSuite(d.e2ee) !== null && h.status()?.e2ee?.keyMissing === null;
}

/** This device is enrolled in a vault it was creating and has not pinned yet (§15.1: resume at step 3). */
export function canFinishCreating(h: StateHost): boolean {
	return isCreating(h.data(), h.data().identity?.vaultId ?? null);
}

/** The engine reports this device blocked for want of a key or pin (§12.4). */
export function isKeyMissing(h: StateHost): boolean {
	const reason = h.status()?.e2ee?.keyMissing;
	return reason !== undefined && reason !== null;
}

/** Pinned to suite 1 and holding the current key: it can show a re-key QR and re-key after a revoke (§14.2). */
export function canRekey(h: StateHost): boolean {
	return h.data().e2ee?.suite === 1 && h.status()?.e2ee?.keyMissing === null;
}

export type UiCommandId =
	| "yaos-pause"
	| "yaos-resume"
	| "yaos-reconcile-now"
	| "yaos-export-diagnostics"
	| "yaos-export-diagnostics-with-paths"
	| "yaos-show-brake"
	| "yaos-pair-device"
	| "yaos-pair-another-device"
	| "yaos-create-snapshot"
	| "yaos-browse-snapshots"
	| "yaos-rebuild-local-cache"
	| "yaos-clean-up-attachments"
	| "yaos-restart-engine"
	| "yaos-create-vault"
	| "yaos-finish-creating-vault"
	| "yaos-unlock"
	| "yaos-show-rekey-qr"
	| "yaos-rekey-after-revoke";

export interface UiCommandSpec {
	readonly id: UiCommandId;
	readonly name: string;
	readonly available: (host: Pick<YaosUiHost, "data" | "status" | "runState" | "brake">) => boolean;
}

export const UI_COMMANDS: readonly UiCommandSpec[] = Object.freeze([
	{ id: "yaos-pause", name: "Pause sync", available: (h) => engineAcceptsCommands(h.runState()) && !isPaused(h.status()) },
	{ id: "yaos-resume", name: "Resume sync", available: (h) => engineAcceptsCommands(h.runState()) && isPaused(h.status()) },
	{ id: "yaos-reconcile-now", name: "Sync now (full rescan)", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-export-diagnostics", name: "Export diagnostics", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-export-diagnostics-with-paths", name: "Export diagnostics (include file names)", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-show-brake", name: "Review held changes", available: (h) => pendingBrake(h) !== null },
	{ id: "yaos-pair-device", name: "Pair this device", available: () => true },
	{ id: "yaos-pair-another-device", name: "Pair another device", available: (h) => h.data().identity !== null },
	{ id: "yaos-create-snapshot", name: "Create snapshot now", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-browse-snapshots", name: "Browse and restore snapshots", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-rebuild-local-cache", name: "Rebuild local cache", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-clean-up-attachments", name: "Clean up unused server attachments", available: (h) => engineAcceptsCommands(h.runState()) },
	// Also offered when the engine failed or stopped: restarting is how to recover.
	{ id: "yaos-restart-engine", name: "Restart sync engine", available: (h) => h.data().identity !== null },
	{ id: "yaos-create-vault", name: "Create a new vault", available: canCreateVault },
	{ id: "yaos-finish-creating-vault", name: "Finish creating this vault", available: canFinishCreating },
	{ id: "yaos-unlock", name: "Enter recovery key or scan a QR code", available: isKeyMissing },
	{ id: "yaos-show-rekey-qr", name: "Show re-key QR", available: canRekey },
	{ id: "yaos-rekey-after-revoke", name: "Re-key after revoking a device", available: canRekey },
] satisfies UiCommandSpec[]);
