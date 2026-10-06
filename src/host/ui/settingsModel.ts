/**
 * Pure model behind the settings tab: control keys <-> YaosPluginData, validation, and the
 * read-only info rows (connection, engine). No obsidian runtime import.
 */

import type { TrashMode } from "../../ports/vault";
import type { StatusSnapshot } from "../../protocol/status";
import {
	MAX_ATTACHMENT_BYTES_LIMIT, MAX_DEVICE_LABEL_CHARS, MAX_EXCLUDE_PATTERN_CHARS, MAX_EXCLUDE_PATTERNS, MAX_KEEP_DAILY, MIB,
	isTrashMode, sanitizeDeviceLabel,
	type EngineRunState, type PairedIdentity, type YaosPluginData,
} from "./api";
import { formatAgo, formatDuration, maskSecret, plural } from "./format";
import { unsyncedCount } from "./statusBar";

export const CONTROL_KEYS = [
	"deviceLabel",
	"excludePatterns",
	"syncAttachments",
	"maxAttachmentMb",
	"syncSettings",
	"trashMode",
	"provisionalBroadcast",
	"snapshotsEnabled",
	"snapshotsKeepDaily",
	"snapshotsUpload",
	"showStatusBar",
] as const;

export type ControlKey = (typeof CONTROL_KEYS)[number];

/** Free-text controls whose writes the tab debounces. */
export const TEXT_CONTROL_KEYS: ReadonlySet<ControlKey> = new Set<ControlKey>(["deviceLabel", "excludePatterns"]);

export const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES_LIMIT / MIB;

export const TRASH_MODE_OPTIONS: Readonly<Record<TrashMode, string>> = Object.freeze({
	"follow-obsidian": "Follow Obsidian (Files and links → Deleted files)",
	"obsidian-trash": "Obsidian trash (.trash folder)",
	"system-trash": "System trash",
});

export function isControlKey(key: string): key is ControlKey {
	return (CONTROL_KEYS as readonly string[]).includes(key);
}

/** Exclude patterns textarea: one pattern per line; blank lines and duplicates dropped. */
export function parseExcludePatterns(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const p = line.trim();
		if (!p || seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

export function readControl(data: YaosPluginData, key: ControlKey): string | number | boolean {
	const e = data.engine;
	switch (key) {
		case "deviceLabel": return data.deviceLabel;
		case "excludePatterns": return e.excludePatterns.join("\n");
		case "syncAttachments": return e.syncAttachments;
		case "maxAttachmentMb": return Math.min(MAX_ATTACHMENT_MB, Math.max(1, Math.round(e.maxAttachmentBytes / MIB)));
		case "syncSettings": return e.syncSettings;
		case "trashMode": return e.trashMode;
		case "provisionalBroadcast": return e.provisionalBroadcast;
		case "snapshotsEnabled": return e.snapshots.enabled;
		case "snapshotsKeepDaily": return e.snapshots.keepDaily;
		case "snapshotsUpload": return e.snapshots.uploadToBlobStore;
		case "showStatusBar": return data.showStatusBar;
	}
}

function intError(value: unknown, min: number, max: number, unit: string): string | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		return `Enter a whole number of ${unit} from ${min} to ${max}.`;
	}
	return null;
}

/** Returns a message safe to show inline, or null when `value` is acceptable for `key`. */
export function validateControl(key: ControlKey, value: unknown): string | null {
	switch (key) {
		case "deviceLabel": {
			if (typeof value !== "string" || !value.trim()) return "Enter a device name.";
			if (value.trim().length > MAX_DEVICE_LABEL_CHARS) return `Use at most ${MAX_DEVICE_LABEL_CHARS} characters.`;
			return null;
		}
		case "excludePatterns": {
			if (typeof value !== "string") return "Enter one pattern per line.";
			const patterns = parseExcludePatterns(value);
			if (patterns.length > MAX_EXCLUDE_PATTERNS) return `Use at most ${MAX_EXCLUDE_PATTERNS} patterns.`;
			const long = patterns.find((p) => p.length > MAX_EXCLUDE_PATTERN_CHARS);
			if (long !== undefined) return `Each pattern can be at most ${MAX_EXCLUDE_PATTERN_CHARS} characters.`;
			return null;
		}
		case "maxAttachmentMb": return intError(value, 1, MAX_ATTACHMENT_MB, "MB");
		case "snapshotsKeepDaily": return intError(value, 1, MAX_KEEP_DAILY, "days");
		case "trashMode": return isTrashMode(value) ? null : "Choose a trash mode.";
		case "syncAttachments":
		case "syncSettings":
		case "provisionalBroadcast":
		case "snapshotsEnabled":
		case "snapshotsUpload":
		case "showStatusBar":
			return typeof value === "boolean" ? null : "Expected on or off.";
	}
}

/**
 * Returns `data` with `key` set to `value`. Throws RangeError (message safe to show) when invalid.
 * Returns the same object when nothing changes, so callers can skip the write.
 */
export function applyControl(data: YaosPluginData, key: ControlKey, value: unknown): YaosPluginData {
	const problem = validateControl(key, value);
	if (problem) throw new RangeError(problem);
	if (readControl(data, key) === value) return data;
	const e = data.engine;
	switch (key) {
		case "deviceLabel": {
			const label = sanitizeDeviceLabel(value, data.deviceLabel);
			return label === data.deviceLabel ? data : { ...data, deviceLabel: label };
		}
		case "excludePatterns": {
			const patterns = parseExcludePatterns(value as string);
			if (patterns.length === e.excludePatterns.length && patterns.every((p, i) => p === e.excludePatterns[i])) return data;
			return { ...data, engine: { ...e, excludePatterns: patterns } };
		}
		case "syncAttachments": return { ...data, engine: { ...e, syncAttachments: value as boolean } };
		case "maxAttachmentMb": return { ...data, engine: { ...e, maxAttachmentBytes: (value as number) * MIB } };
		case "syncSettings": return { ...data, engine: { ...e, syncSettings: value as boolean } };
		case "trashMode": return { ...data, engine: { ...e, trashMode: value as TrashMode } };
		case "provisionalBroadcast": return { ...data, engine: { ...e, provisionalBroadcast: value as boolean } };
		case "snapshotsEnabled": return { ...data, engine: { ...e, snapshots: { ...e.snapshots, enabled: value as boolean } } };
		case "snapshotsKeepDaily": return { ...data, engine: { ...e, snapshots: { ...e.snapshots, keepDaily: value as number } } };
		case "snapshotsUpload": return { ...data, engine: { ...e, snapshots: { ...e.snapshots, uploadToBlobStore: value as boolean } } };
		case "showStatusBar": return { ...data, showStatusBar: value as boolean };
	}
}

export type SettingsSeed = "device" | "vault";

/**
 * Turns settings sync on with the user's answer to "whose settings first?" (DESIGN §j.3). The seed only
 * matters on the engine's first settings pass on this device (empty base); later passes merge normally.
 */
export function enableSettingsSync(data: YaosPluginData, seed: SettingsSeed): YaosPluginData {
	return { ...data, engine: { ...data.engine, syncSettings: true, syncSettingsSeed: seed } };
}

// ---------------------------------------------------------------------------
// Info rows
// ---------------------------------------------------------------------------

export interface InfoRow {
	readonly name: string;
	readonly value: string;
}

/** Connection rows. The device token is always masked; the pairing code is never stored. */
export function connectionRows(identity: PairedIdentity | null): InfoRow[] {
	if (!identity) return [{ name: "Status", value: "Not paired. Pair this device to start syncing." }];
	return [
		{ name: "Server", value: identity.host },
		{ name: "Vault ID", value: identity.vaultId },
		{ name: "Device name", value: identity.deviceName || "(unnamed)" },
		{ name: "Device token", value: maskSecret(identity.deviceToken) },
	];
}

export function runStateLabel(run: EngineRunState): string {
	switch (run.phase) {
		case "unpaired": return "Not paired";
		case "stopped": return "Stopped";
		case "starting": return "Starting…";
		case "failed": return `Failed: ${run.lastError ?? "unknown error"}`;
		case "running":
			return run.transport === "inline" ? "Running on the main thread (background worker unavailable)" : "Running in a background worker";
	}
}

export function phaseLabel(phase: StatusSnapshot["phase"]): string {
	switch (phase) {
		case "starting": return "Starting";
		case "recovering": return "Recovering local state";
		case "bootstrapping": return "First sync (downloading)";
		case "catching-up": return "Catching up";
		case "live": return "Live";
		case "offline": return "Offline";
		case "paused": return "Paused";
		case "braked": return "Waiting for your approval";
		case "daily-limit": return "Server daily limit reached";
		case "superseded": return "Reconnecting";
		case "revoked": return "Device access revoked";
		case "epoch-migrating": return "Re-syncing after a server reset";
		case "upgrade-required": return "Plugin update required";
		case "error": return "Error";
	}
}

/** Engine section rows: run state, phase, transport, connection, unsynced count, last sync. */
export function engineRows(run: EngineRunState, status: StatusSnapshot | null, nowMs: number): InfoRow[] {
	const rows: InfoRow[] = [{ name: "Engine", value: runStateLabel(run) }];
	if (run.phase !== "running" || !status) return rows;
	rows.push({ name: "Phase", value: phaseLabel(status.phase) });
	rows.push({ name: "Transport", value: status.transport === "inline" ? "Main thread (inline)" : "Background worker" });
	const relay = status.relay;
	let connection: string;
	if (relay.connected) connection = relay.rttMs !== null ? `Connected (${Math.round(relay.rttMs)} ms round trip)` : "Connected";
	else if (relay.reconnectInMs !== null) connection = `Disconnected, retrying in ${formatDuration(relay.reconnectInMs)}`;
	else connection = "Disconnected";
	rows.push({ name: "Server connection", value: connection });
	const n = unsyncedCount(status);
	rows.push({ name: "Unsynced changes", value: n === 0 ? "None" : plural(n, "change") });
	if (status.bootstrap && status.bootstrap.docsTotal > 0) {
		rows.push({ name: "First sync", value: `${Math.min(status.bootstrap.docsMaterialized, status.bootstrap.docsTotal)} of ${plural(status.bootstrap.docsTotal, "note")}` });
	}
	rows.push({ name: "Last synced", value: status.lastSyncedAtMs === null ? "Never" : formatAgo(status.lastSyncedAtMs, nowMs) });
	const attention = status.counts.frozenDocs + status.counts.quarantinedRows;
	if (attention > 0) {
		rows.push({ name: "Needs attention", value: `${plural(status.counts.frozenDocs, "frozen note")}, ${plural(status.counts.quarantinedRows, "quarantined change")}. Export diagnostics for details.` });
	}
	return rows;
}

/** True when user commands can be sent to the engine. */
export function engineAcceptsCommands(run: EngineRunState): boolean {
	return run.phase === "running";
}

/** True when the engine reports the paused phase (the tab then offers Resume instead of Pause). */
export function isPaused(status: StatusSnapshot | null): boolean {
	return status?.phase === "paused";
}
