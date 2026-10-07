/**
 * Host UI contract: plugin data shape, tolerant loader and the YaosUiHost interface that
 * src/host/plugin.ts implements. Pure: obsidian is imported for types only, so tests can load it.
 * The runtime wiring is in ./registerUi.ts.
 */

import type { App } from "obsidian";
import type { EngineSettings, UserCommand, EngineResultValue } from "../../protocol/messages";
import type { StatusSnapshot } from "../../protocol/status";
import type { BrakeReport } from "../../core/types";
import type { TrashMode } from "../../ports/vault";
import { isVaultId } from "../../core/codec/ids";
import { sanitizeCreating, sanitizePin, type CreatingMarker, type E2eePin } from "../keys/pin";
import {
	DEVICE_ID_RE, DEVICE_TOKEN_RE, ENROLLMENT_REQUEST_ID_RE, normalizeDeviceName, normalizeHost, normalizePairingCode,
	type EnrollmentAttempt,
} from "./pairing";

export { defaultDeviceName } from "./deviceName";
export type { DevicePlatformFlags } from "./deviceName";

/** Result of enrollment. deviceToken is SECRET (plugin data only, never logged/displayed unmasked). */
export interface PairedIdentity {
	readonly host: string; // https://... normalized, no trailing slash
	readonly vaultId: string;
	readonly deviceId: string;
	readonly deviceToken: string;
	readonly deviceName: string;
	readonly vaultGeneration: string | null;
}

export interface YaosPluginData {
	readonly version: 1;
	readonly identity: PairedIdentity | null;
	readonly deviceLabel: string; // human label for conflict copy names
	readonly engine: EngineSettings;
	readonly showStatusBar: boolean;
	/**
	 * SECRET (pairing code + the new device token): an /enroll sent but not yet answered, kept until
	 * success or a definitive refusal so the next load can retry it once (the relay replays an
	 * identical request). Never logged or exported.
	 */
	readonly pendingEnrollment?: EnrollmentAttempt;
	/**
	 * The suite pin (e2ee-design §6.1, §12.4; not secret). Absent = unpinned: the device writes nothing until main
	 * pins it from an authenticated source (src/host/keys/pin.ts). Only the controller writes it.
	 */
	readonly e2ee?: E2eePin;
	/** §15.1 crash-recovery marker: this device created that vault and may still choose its encryption. */
	readonly creating?: CreatingMarker;
}

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
	maxAttachmentBytes: 50 * MIB,
	syncSettings: false,
	trashMode: "follow-obsidian",
	provisionalBroadcast: true,
	snapshots: Object.freeze({ enabled: true, keepDaily: 7, uploadToBlobStore: false }),
});

/** Trim, collapse whitespace, bound length; falls back to `fallback` (then "Device") when empty. */
export function sanitizeDeviceLabel(value: unknown, fallback: string): string {
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

/** Returns a valid identity or null (any missing/invalid required field drops the whole identity). */
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
	if (typeof r.deviceId !== "string" || !DEVICE_ID_RE.test(r.deviceId)) return null;
	if (typeof r.deviceToken !== "string" || !DEVICE_TOKEN_RE.test(r.deviceToken)) return null;
	return {
		host,
		vaultId: r.vaultId,
		deviceId: r.deviceId,
		deviceToken: r.deviceToken,
		deviceName: typeof r.deviceName === "string" ? normalizeDeviceName(r.deviceName) : "",
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
			deviceId: str(r.deviceId),
			deviceToken: str(r.deviceToken),
		};
		const ok = ENROLLMENT_REQUEST_ID_RE.test(attempt.enrollmentRequestId) && DEVICE_ID_RE.test(attempt.deviceId) && DEVICE_TOKEN_RE.test(attempt.deviceToken);
		return ok ? attempt : null;
	} catch {
		return null;
	}
}

/** Tolerant loader for whatever loadData() returned (null, garbage, partial). Never throws. */
export function sanitizePluginData(raw: unknown, fallbackLabel: string): YaosPluginData {
	try {
		const r = asRecord(raw);
		if (!r) return defaultPluginData(fallbackLabel);
		const pending = sanitizePendingEnrollment(r.pendingEnrollment);
		const identity = sanitizeIdentity(r.identity);
		// A pin belongs to the vault the device is enrolled in: without one it is dropped (never inferred, §12.4).
		const pin = identity ? sanitizePin(r.e2ee) : undefined;
		const creating = sanitizeCreating(r.creating);
		return {
			version: 1,
			identity,
			deviceLabel: sanitizeDeviceLabel(r.deviceLabel, fallbackLabel),
			engine: sanitizeEngineSettings(r.engine),
			showStatusBar: bool(r.showStatusBar, true),
			...(pending ? { pendingEnrollment: pending } : {}),
			...(pin ? { e2ee: pin } : {}),
			...(creating ? { creating } : {}),
		};
	} catch {
		return defaultPluginData(fallbackLabel);
	}
}

/** True when both identities address the same relay credential (a change requires an engine restart). */
export function sameIdentity(a: PairedIdentity | null, b: PairedIdentity | null): boolean {
	if (a === null || b === null) return a === b;
	return a.host === b.host && a.vaultId === b.vaultId && a.deviceId === b.deviceId && a.deviceToken === b.deviceToken;
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
	readonly transport: "worker" | "inline" | null;
	readonly lastError: string | null;
};

export interface YaosUiHost {
	readonly app: App;
	readonly pluginVersion: string;
	data(): YaosPluginData;
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
