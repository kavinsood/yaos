/** Status assembly for the composed engine (DESIGN §j.7): log status + disk-side counters. */

import type { BrakeReport, VaultEpoch } from "../../core/types";
import type { DeviceClass } from "../../core/limits";
import type { EnginePhase, StatusSnapshot } from "../../protocol/status";

export function idleStatus(o: { deviceClass: DeviceClass; transport: "worker" | "inline"; vaultEpoch: VaultEpoch | null; phase: EnginePhase; nowMs: number }): StatusSnapshot {
	return {
		phase: o.phase,
		deviceClass: o.deviceClass,
		transport: o.transport,
		vaultEpoch: o.vaultEpoch,
		vaultSeq: 0,
		headSeq: 0,
		relay: { connected: false, lastCloseCode: null, reconnectInMs: null, rttMs: null },
		counts: {
			liveDocs: 0, staleStreams: 0, outboxFrames: 0, outboxBytes: 0, unreceiptedFrames: 0, residentDocs: 0,
			residentBytesEstimate: 0, pendingDiskOps: 0, pendingBlobs: 0, quarantinedRows: 0, frozenDocs: 0, conflictCopiesToday: 0,
		},
		bootstrap: null,
		brake: null,
		lastFullReconcileAtMs: null,
		lastSyncedAtMs: null,
		dailyFramesUsed: 0,
		maxBlobBytes: null,
		notices: [],
	};
}

export interface DiskSideStatus {
	readonly transport: "worker" | "inline";
	readonly paused: boolean;
	readonly migrating: boolean;
	readonly brake: BrakeReport | null;
	readonly pendingDiskOps: number;
	readonly pendingBlobs: number;
	readonly conflictCopiesToday: number;
	readonly lastFullReconcileAtMs: number | null;
	readonly bootstrap: StatusSnapshot["bootstrap"];
	readonly maxBlobBytes: number | null;
	readonly notices: readonly { readonly code: string; readonly level: "info" | "warn" | "error"; readonly atMs: number }[];
}

/** Phases the log side owns outright; the disk side never overrides them. */
const HARD: ReadonlySet<EnginePhase> = new Set(["superseded", "revoked", "upgrade-required", "key-missing", "error", "daily-limit"]);

export function mergeStatus(log: StatusSnapshot, d: DiskSideStatus): StatusSnapshot {
	let phase = log.phase;
	if (d.migrating) phase = "epoch-migrating";
	else if (!HARD.has(phase)) {
		if (d.paused) phase = "paused";
		else if (d.brake) phase = "braked";
		else if (phase === "live" && d.bootstrap && d.bootstrap.docsMaterialized < d.bootstrap.docsTotal) phase = "bootstrapping";
	}
	const notices = [...log.notices];
	for (const n of d.notices) if (!notices.some((x) => x.code === n.code)) notices.push(n);
	return {
		...log,
		phase,
		transport: d.transport,
		counts: { ...log.counts, pendingDiskOps: d.pendingDiskOps, pendingBlobs: d.pendingBlobs, conflictCopiesToday: d.conflictCopiesToday },
		bootstrap: d.bootstrap,
		brake: d.brake,
		lastFullReconcileAtMs: d.lastFullReconcileAtMs,
		maxBlobBytes: d.maxBlobBytes,
		notices: notices.slice(-32),
	};
}
