/** Status and diagnostics shapes. DESIGN §j.7. No secrets, no file contents. */

import type { BrakeReport, Seq, VaultEpoch, VaultPath } from "../core/types";
import type { DeviceClass } from "../core/limits";

export type EnginePhase =
	| "starting"
	| "recovering"
	| "bootstrapping"
	| "catching-up"
	| "live"
	| "offline"
	| "paused"
	| "braked"
	| "daily-limit"
	| "superseded"
	| "revoked"
	| "epoch-migrating"
	| "upgrade-required"
	| "key-missing"
	| "error";

export interface StatusSnapshot {
	readonly phase: EnginePhase;
	readonly deviceClass: DeviceClass;
	readonly transport: "worker" | "inline";
	readonly vaultEpoch: VaultEpoch | null;
	readonly vaultSeq: Seq;
	readonly headSeq: Seq;
	readonly relay: {
		readonly connected: boolean;
		readonly lastCloseCode: number | null;
		readonly reconnectInMs: number | null;
		readonly rttMs: number | null;
	};
	readonly counts: {
		readonly liveDocs: number;
		readonly staleStreams: number;
		readonly outboxFrames: number;
		readonly outboxBytes: number;
		readonly unreceiptedFrames: number;
		readonly residentDocs: number;
		readonly residentBytesEstimate: number;
		readonly pendingDiskOps: number;
		readonly pendingBlobs: number;
		readonly quarantinedRows: number;
		readonly frozenDocs: number;
		readonly conflictCopiesToday: number;
	};
	readonly bootstrap: { readonly docsTotal: number; readonly docsMaterialized: number } | null;
	readonly brake: BrakeReport | null;
	readonly lastFullReconcileAtMs: number | null;
	readonly lastSyncedAtMs: number | null;
	readonly dailyFramesUsed: number;
	/**
	 * Largest attachment the open carrier moves: the blob store's limit (the server's
	 * maxBlobUploadBytes, or the client default when the probe failed) or the log's 8 MiB without
	 * one. Files over min(this, settings.maxAttachmentBytes) are skipped. null until a vault is open.
	 */
	readonly maxBlobBytes: number | null;
	readonly notices: readonly { readonly code: string; readonly level: "info" | "warn" | "error"; readonly atMs: number }[];
	/** End-to-end encryption state (e2ee-design §18.4). No secrets. The engine always sets it; optional only so older snapshot literals still type-check. */
	readonly e2ee?: E2eeStatus;
}

/** Why a key-missing device cannot write (e2ee-design §9.3, §12.4). */
export type KeyMissingReason = "no-pin" | "no-key" | "revoked-epoch" | "encrypted-vault";

export interface E2eeStatus {
	/** The pin: null for an unpinned device, which writes nothing (§12.4). */
	readonly suite: 0 | 1 | null;
	/** Epoch of new seals; 0 under suite 0 and while no key is usable. */
	readonly sealEpoch: number;
	readonly keyMissing: KeyMissingReason | null;
	/** Sticky: this device has read a decodable `k` record for its vault, so a suite-0 link is refused (§12.4 (ii)). */
	readonly keyringSeen: boolean;
	/** Only for an engine started with `creating`, after VAULT_READY.head = 0 and an empty `k` (§15.1). */
	readonly creatable: boolean;
}

export interface DiagnosticsEvent {
	readonly atMs: number;
	readonly code: string;
	/** Numbers, booleans, stream classes and error messages; streams and paths only as pseudonyms in a bundle. */
	readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * exportDiagnostics answer. No secrets, no file contents, and no vault paths outside `paths`.
 *
 * Files are named by pseudonyms: the first 12 hex chars of CryptoPort.diagHash over a random
 * per-bundle salt and the file's vault path (or its stream name when the engine does not know the
 * path). diagHash is a SHA-256 prefix under suite 0 and HMAC(kDiag) under suite 1 (e2ee-design §6.4).
 * The salt is not included, so pseudonyms cannot be matched across bundles or tested against guessed
 * paths. Within one bundle the same file always has the same pseudonym. A doc stream is written as its
 * class prefix plus the pseudonym ("b:1a2b3c4d5e6f"); the vault-wide "ns", "cfg" and "k" streams keep
 * their names.
 */
export interface DiagnosticsBundle {
	readonly generatedAtMs: number;
	readonly clientVersion: string;
	/** Status at export time; `brake.samplePaths` holds pseudonyms. */
	readonly status: StatusSnapshot;
	/**
	 * The engine's whole diagnostics ring (at most 2000 events, oldest first): the window before an
	 * incident is what support needs, and 200 events often missed it. `stream` and `path` fields are
	 * pseudonymized; `error` fields are error messages as thrown by storage and network code.
	 */
	readonly recentEvents: readonly DiagnosticsEvent[];
	/** At most 200 quarantined rows; `stream` is pseudonymized. */
	readonly quarantine: readonly { readonly stream: string; readonly seq: Seq; readonly reason: string; readonly bytes: number }[];
	/** Frozen doc streams; `stream` is pseudonymized. */
	readonly frozenDocs: readonly { readonly stream: string; readonly reason: string }[];
	readonly stores: Readonly<Record<string, { readonly records: number; readonly bytes: number }>>;
	/**
	 * Only when the user opted in (exportDiagnostics{includePaths: true}), else null: the vault path
	 * of every pseudonym in this bundle whose path the engine knows, sorted by path.
	 */
	readonly paths: readonly { readonly pseudonym: string; readonly path: VaultPath }[] | null;
}
