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
	readonly notices: readonly { readonly code: string; readonly level: "info" | "warn" | "error"; readonly atMs: number }[];
}

export interface DiagnosticsEvent {
	readonly atMs: number;
	readonly code: string;
	/** Numbers, booleans, stream classes, hashed paths only. */
	readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DiagnosticsBundle {
	readonly generatedAtMs: number;
	readonly clientVersion: string;
	readonly status: StatusSnapshot;
	readonly recentEvents: readonly DiagnosticsEvent[];
	readonly quarantine: readonly { readonly stream: string; readonly seq: Seq; readonly reason: string; readonly bytes: number }[];
	readonly frozenDocs: readonly { readonly pathHash: string; readonly reason: string }[];
	readonly stores: Readonly<Record<string, { readonly records: number; readonly bytes: number }>>;
	/** Present only if the user opts in to include paths. */
	readonly paths: readonly VaultPath[] | null;
}
