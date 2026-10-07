/**
 * "Clean up unused server attachments" (e2ee-design §10.4): one cleanUpAttachments command, then one notice
 * saying what was deleted, what was kept and why, or why nothing was deleted. No progress, status row or
 * schedule. Pure: the notice is injected, so no obsidian runtime import.
 */

import type { AttachmentCleanupRefusal, EngineResultValue } from "../../protocol/messages";
import type { YaosUiHost } from "./api";
import { errorMessage, plural } from "./format";

type Cleaned = Extract<EngineResultValue, { t: "attachmentsCleaned" }>;

const REFUSAL_TEXT: Readonly<Record<AttachmentCleanupRefusal, string>> = Object.freeze({
	"no-store": "this server has no attachment storage",
	"keys-unverified": "this device has not confirmed the vault's encryption key",
	offline: "not connected to the server",
	"read-only": "this device has read-only access to the vault",
	"not-caught-up": "this device could not read the latest file list from the server; try again once sync is up to date",
	"fold-incomplete": "some of the vault's sync history does not open on this device, so it cannot tell which attachments are still in use",
	"body-unreadable": "some note history does not open on this device, so it cannot tell which attachments are still in use",
	"addressing-mismatch": "none of the vault's attachments were found on the server under this device's keys, so deleting would be unsafe",
	busy: "a clean-up is already running",
	interrupted: "the clean-up was interrupted",
});

/**
 * "keys-unverified" has three sources, told apart by the engine's detail text (the detail itself is not shown):
 * a device whose engine never opened (no pin, or the key is missing: keyReader.ts:191), and a running engine whose
 * in-session write gate is shut (blobGc.ts:108). Anything else is the unconfirmed-key case (blobGc.ts:104).
 */
export const CLOSED_DEVICE_DETAIL = "this device has no usable encryption pin or key";
export const SHUT_GATE_DETAIL_PREFIX = "this device may not write to the vault (";
const CLOSED_DEVICE_TEXT = "this device does not have the vault's encryption key yet; enter your recovery key or scan a QR code from one of your devices first";
const SHUT_GATE_TEXT = "this device may not write to the vault right now (for example, the vault key changed and this device has not been re-keyed yet); try again once it syncs normally";

function refusalText(refused: Exclude<AttachmentCleanupRefusal, "interrupted">, detail: string | null): string {
	if (refused === "keys-unverified" && detail !== null) {
		if (detail === CLOSED_DEVICE_DETAIL) return CLOSED_DEVICE_TEXT;
		if (detail.startsWith(SHUT_GATE_DETAIL_PREFIX)) return SHUT_GATE_TEXT;
	}
	return REFUSAL_TEXT[refused];
}

export function attachmentsCleanedNotice(r: Cleaned): { readonly message: string; readonly level: "info" | "error" } {
	if (r.refused !== null && r.refused !== "interrupted") {
		return { message: `Nothing was deleted: ${refusalText(r.refused, r.detail)}.`, level: "error" };
	}
	const parts: string[] = [];
	if (r.refused === "interrupted") parts.push(`The clean-up stopped part-way${r.detail ? ` (${r.detail})` : ""}.`);
	if (r.deleted > 0) parts.push(`Deleted ${plural(r.deleted, "unused attachment")} from the server.`);
	else if (r.refused === null) parts.push("No unused attachments to delete.");
	if (r.keptNewer > 0) parts.push(`Kept ${plural(r.keptNewer, "unused recent upload")}; a later clean-up removes ${r.keptNewer === 1 ? "it" : "them"} once older.`);
	if (r.repaired > 0) parts.push(`Uploaded ${plural(r.repaired, "attachment")} again that another device started using meanwhile.`);
	if (r.lost > 0) parts.push(`${plural(r.lost, "attachment")} another device started using meanwhile ${r.lost === 1 ? "was" : "were"} deleted and this device has no copy: add ${r.lost === 1 ? "it" : "them"} again from the device that has ${r.lost === 1 ? "it" : "them"}.`);
	return { message: parts.join(" "), level: r.refused !== null || r.lost > 0 ? "error" : "info" };
}

/** Sends the command and reports once through notify. Never throws. */
export async function cleanUpAttachments(host: Pick<YaosUiHost, "command">, notify: (message: string, level: "info" | "error") => void): Promise<void> {
	try {
		const r = await host.command({ t: "cleanUpAttachments" });
		if (r.t !== "attachmentsCleaned") throw new Error("the sync engine did not run the clean-up");
		const n = attachmentsCleanedNotice(r);
		notify(n.message, n.level);
	} catch (err) {
		notify(`Could not clean up attachments: ${errorMessage(err)}`, "error");
	}
}
