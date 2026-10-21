/**
 * Host UI contract: plugin data shape, tolerant loader and the YaosUiHost interface that
 * src/host/plugin.ts implements. Pure: obsidian is imported for types only, so tests can load it.
 * The runtime wiring is in ./registerUi.ts.
 */

import type { App } from "obsidian";
import type { EngineSettings, UserCommand, EngineResultValue } from "../../protocol/messages";
import type { DeviceCheckMode, DeviceCheckReport, StatusSnapshot } from "../../protocol/status";
import type { BrakeReport } from "../../core/types";
import type { TrashMode } from "../../ports/vault";
import { isVaultId } from "../../core/codec/ids";
import { sanitizePin, type CreatingMarker, type E2eePin } from "../keys/pin";
import {
	ENROLLMENT_REQUEST_ID_RE, GRANT_ID_RE, GRANT_SECRET_RE, normalizeDeviceName, normalizeHost, normalizePairingCode,
	type EnrollmentAttempt,
} from "./pairing";

export { defaultDeviceName } from "./deviceName";
export type { DevicePlatformFlags } from "./deviceName";

/**
 * The install's pairing grant (identity-per-store §3.1): the result of enrollment, stored in data.json in place of
 * the old device identity. The device identity lives in the store (meta.identity), never here, so a copied vault
 * folder carries a grant (and registers its own device, decision 1), not this install's identity. grantSecret is
 * SECRET (plugin data only, never logged or displayed unmasked).
 */
export interface PairedIdentity {
	readonly host: string; // https://... normalized, no trailing slash
	readonly vaultId: string;
	readonly grantId: string;
	readonly grantSecret: string;
	/** The grant's name on the server ("Mac 2"); every store of this install is listed under it. */
	readonly grantName: string;
	readonly vaultGeneration: string | null;
}

/**
 * data.json (Plugin.loadData / saveData, in the vault folder): the fields a copied or synced twin may share
 * (identity-per-store §8). The per-install fields are in the local settings record (src/host/localSettings.ts).
 */
export interface StoredPluginData {
	readonly version: 1;
	readonly identity: PairedIdentity | null;
	readonly engine: EngineSettings;
	/**
	 * The suite pin (e2ee-design §6.1, §12.4; not secret). Absent = unpinned: the device writes nothing until main
	 * pins it from an authenticated source (src/host/keys/pin.ts). Only the controller writes it.
	 */
	readonly e2ee?: E2eePin;
}

/**
 * The per-install fields (identity-per-store §8): kept in vault-local storage (src/host/localSettings.ts), never in
 * data.json, which other tools copy and sync between machines.
 */
export interface LocalPluginFields {
	readonly deviceLabel: string; // human label for conflict copy names
	readonly showStatusBar: boolean;
	/**
	 * SECRET (pairing code + the new grant secret): an /enroll sent but not yet answered, kept until
	 * success or a definitive refusal so the next load can retry it once (the relay replays an
	 * identical request). Never logged or exported.
	 */
	readonly pendingEnrollment?: EnrollmentAttempt;
	/** §15.1 crash-recovery marker: this device created that vault and may still choose its encryption. */
	readonly creating?: CreatingMarker;
}

/**
 * What the host and the UI read and write: data.json's shared fields plus this install's local ones. Assembled at load
 * (localSettings.ts withLocal) and split again on every save (pluginController.ts).
 */
export interface YaosPluginData extends StoredPluginData, LocalPluginFields {}

export const MIB = 1024 * 1024;
export const MAX_ATTACHMENT_BYTES_LIMIT = 1024 * MIB;
export const MAX_KEEP_DAILY = 90;
export const MAX_EXCLUDE_PATTERNS = 500;
export const MAX_EXCLUDE_PATTERN_CHARS = 512;
export const MAX_DEVICE_LABEL_CHARS = 64;

export const TRASH_MODES: readonly TrashMode[] = Object.freeze(["follow-obsidian", "obsidian-trash", "system-trash"]);

export function isTrashMode(value: unknown): value is TrashMode {
	return (TRASH_MODES as readonly unknown[]).includes(value);
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = Object.freeze({
	excludePatterns: Object.freeze([]) as readonly string[],
	syncAttachments: true,
	// The most there is: the effective cap is min(this, the server's), so by default the server's (localState.ts).
	maxAttachmentBytes: MAX_ATTACHMENT_BYTES_LIMIT,
	syncSettings: false,
	trashMode: "follow-obsidian",
	provisionalBroadcast: true,
	snapshots: Object.freeze({ enabled: true, keepDaily: 7, uploadToBlobStore: false }),
});

/** Trim, collapse whitespace, bound length; falls back to `fallback` (then "Device") when empty. */
export function sanitizeDeviceLabel(value: unknown, fallback: string): string {
	// eslint-disable-next-line no-control-regex -- matching C0 controls and DEL is the point of this pattern
	const clean = (v: string): string => v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DEVICE_LABEL_CHARS).trim();
	const label = typeof value === "string" ? clean(value) : "";
	if (label) return label;
	return clean(fallback) || "Device";
}

export function defaultPluginData(deviceLabel: string): YaosPluginData {
	return {
		version: 1,
		identity: null,
		deviceLabel: sanitizeDeviceLabel(deviceLabel, "Device"),
		engine: DEFAULT_ENGINE_SETTINGS,
		showStatusBar: true,
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function intInRange(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

/** One pattern per entry, trimmed, non-empty, de-duplicated, bounded. */
export function sanitizeExcludePatterns(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const p = item.trim();
		if (!p || p.length > MAX_EXCLUDE_PATTERN_CHARS || seen.has(p)) continue;
		seen.add(p);
		out.push(p);
		if (out.length >= MAX_EXCLUDE_PATTERNS) break;
	}
	return out;
}

export function sanitizeEngineSettings(raw: unknown): EngineSettings {
	const r = asRecord(raw);
	if (!r) return DEFAULT_ENGINE_SETTINGS;
	const d = DEFAULT_ENGINE_SETTINGS;
	const snap = asRecord(r.snapshots);
	return {
		excludePatterns: sanitizeExcludePatterns(r.excludePatterns),
		syncAttachments: bool(r.syncAttachments, d.syncAttachments),
		maxAttachmentBytes: intInRange(r.maxAttachmentBytes, 1, MAX_ATTACHMENT_BYTES_LIMIT, d.maxAttachmentBytes),
		syncSettings: bool(r.syncSettings, d.syncSettings),
		...(r.syncSettingsSeed === "device" || r.syncSettingsSeed === "vault" ? { syncSettingsSeed: r.syncSettingsSeed } : {}),
		trashMode: isTrashMode(r.trashMode) ? r.trashMode : d.trashMode,
		provisionalBroadcast: bool(r.provisionalBroadcast, d.provisionalBroadcast),
		snapshots: {
			enabled: bool(snap?.enabled, d.snapshots.enabled),
			keepDaily: intInRange(snap?.keepDaily, 1, MAX_KEEP_DAILY, d.snapshots.keepDaily),
			uploadToBlobStore: bool(snap?.uploadToBlobStore, d.snapshots.uploadToBlobStore),
		},
	};
}

/**
 * Returns a valid grant or null (any missing/invalid required field drops it). The old device identity
 * (deviceId/deviceToken, no grant) is dropped here: such an install starts unpaired and pairs again
 * (identity-per-store §13).
 */
export function sanitizeIdentity(raw: unknown): PairedIdentity | null {
	const r = asRecord(raw);
	if (!r) return null;
	let host: string;
	try {
		host = normalizeHost(typeof r.host === "string" ? r.host : "");
	} catch {
		return null;
	}
	// Exactly a vaultId (22-char canonical base64url, server DECISIONS §2.1): nothing trimmed, nothing else trusted.
	if (typeof r.vaultId !== "string" || !isVaultId(r.vaultId)) return null;
	if (typeof r.grantId !== "string" || !GRANT_ID_RE.test(r.grantId)) return null;
	if (typeof r.grantSecret !== "string" || !GRANT_SECRET_RE.test(r.grantSecret)) return null;
	return {
		host,
		vaultId: r.vaultId,
		grantId: r.grantId,
		grantSecret: r.grantSecret,
		grantName: typeof r.grantName === "string" ? normalizeDeviceName(r.grantName) : "",
		vaultGeneration: typeof r.vaultGeneration === "string" && r.vaultGeneration.trim() ? r.vaultGeneration : null,
	};
}

/** Returns a well-formed pending enrollment attempt or null. */
export function sanitizePendingEnrollment(raw: unknown): EnrollmentAttempt | null {
	const r = asRecord(raw);
	if (!r) return null;
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	try {
		const attempt: EnrollmentAttempt = {
			host: normalizeHost(str(r.host)),
			pairingCode: normalizePairingCode(str(r.pairingCode)),
			deviceName: normalizeDeviceName(str(r.deviceName)),
			enrollmentRequestId: str(r.enrollmentRequestId),
			grantSecret: str(r.grantSecret),
		};
		const ok = ENROLLMENT_REQUEST_ID_RE.test(attempt.enrollmentRequestId) && GRANT_SECRET_RE.test(attempt.grantSecret);
		return ok ? attempt : null;
	} catch {
		return null;
	}
}

/**
 * Tolerant loader for whatever loadData() returned (null, garbage, partial). Never throws. The per-install fields an
 * older data.json carried are not read here (localSettings.ts migrates the label and the status bar flag).
 */
export function sanitizeStoredData(raw: unknown): StoredPluginData {
	try {
		const r = asRecord(raw);
		if (!r) return { version: 1, identity: null, engine: DEFAULT_ENGINE_SETTINGS };
		const identity = sanitizeIdentity(r.identity);
		// A pin belongs to the vault the device is enrolled in: without one it is dropped (never inferred, §12.4).
		const pin = identity ? sanitizePin(r.e2ee) : undefined;
		return { version: 1, identity, engine: sanitizeEngineSettings(r.engine), ...(pin ? { e2ee: pin } : {}) };
	} catch {
		return { version: 1, identity: null, engine: DEFAULT_ENGINE_SETTINGS };
	}
}

/** The data.json part of `d` (identity-per-store §8): never a per-install field. */
export function storedPart(d: StoredPluginData): StoredPluginData {
	return { version: 1, identity: d.identity, engine: d.engine, ...(d.e2ee ? { e2ee: d.e2ee } : {}) };
}

/** True when both name the same pairing on the same relay (a change requires an engine restart). */
export function sameIdentity(a: PairedIdentity | null, b: PairedIdentity | null): boolean {
	if (a === null || b === null) return a === b;
	return a.host === b.host && a.vaultId === b.vaultId && a.grantId === b.grantId && a.grantSecret === b.grantSecret;
}

/** Deep equality of two EngineSettings (to skip no-op updateSettings commands). */
export function sameEngineSettings(a: EngineSettings, b: EngineSettings): boolean {
	return a.syncAttachments === b.syncAttachments
		&& a.maxAttachmentBytes === b.maxAttachmentBytes
		&& a.syncSettings === b.syncSettings
		&& a.syncSettingsSeed === b.syncSettingsSeed
		&& a.trashMode === b.trashMode
		&& a.provisionalBroadcast === b.provisionalBroadcast
		&& a.snapshots.enabled === b.snapshots.enabled
		&& a.snapshots.keepDaily === b.snapshots.keepDaily
		&& a.snapshots.uploadToBlobStore === b.snapshots.uploadToBlobStore
		&& a.excludePatterns.length === b.excludePatterns.length
		&& a.excludePatterns.every((p, i) => p === b.excludePatterns[i]);
}

export type EngineRunState = {
	readonly phase: "unpaired" | "stopped" | "starting" | "running" | "failed";
	readonly lastError: string | null;
};

export interface YaosUiHost {
	readonly app: App;
	readonly pluginVersion: string;
	data(): YaosPluginData;
	/** This install's current store device id (identity-per-store §2.4, the install record), or null before one. */
	deviceId(): string | null;
	/** Persist; the host applies it (engine updateSettings, or restart when identity changes). */
	updateData(mutate: (d: YaosPluginData) => YaosPluginData): Promise<void>;
	status(): StatusSnapshot | null;
	runState(): EngineRunState;
	/** Fires on every status/runState change. */
	onChange(listener: () => void): () => void;
	/** Sends a UserCommand; rejects with an Error whose message is safe to show. */
	command(command: UserCommand): Promise<EngineResultValue>;
	restartEngine(): Promise<void>;
	/** Pending brake, if any (also in status().brake). */
	brake(): BrakeReport | null;
	/** Write a file under <configDir>/plugins/yaos/diagnostics/ (returns the vault-relative path). */
	writeDiagnosticsFile(name: string, text: string): Promise<string>;
	/** The on-device self-test, run in the engine (deviceCheck.ts); rejects with an Error whose message is safe to show. */
	deviceCheck(mode: DeviceCheckMode): Promise<DeviceCheckReport>;
	/**
	 * e2ee-design §15.1 step 1 done: this device created `vaultId` on the server. Only "Create a new vault"
	 * (createVault.ts) calls it, right after the creating response.
	 */
	markCreating(vaultId: string): Promise<void>;
	/** §15.1: the creation of `vaultId` failed its step-3 check. Drops the marker; no pin is set. */
	abandonCreating(vaultId: string): Promise<void>;
	/** First 3 bytes of SHA-256(secret) for a 32-byte RK secret (§13.1), hashed by the engine. `secret` is unchanged. */
	rkChecksum(secret: Uint8Array): Promise<Uint8Array>;
	/** SECRET: the key a pairing or re-key QR carries (a copy; zero-fill it), or null when this device has none to give. */
	vaultKeyForQr(): { readonly e: number; readonly k: Uint8Array } | null;
}

/** The pending brake from either source (host.brake() wins). */
export function pendingBrake(host: Pick<YaosUiHost, "brake" | "status">): BrakeReport | null {
	return host.brake() ?? host.status()?.brake ?? null;
}
