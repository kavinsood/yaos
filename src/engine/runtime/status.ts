/** StatusSnapshot assembly (src/protocol/status.ts). Pure read of engine state. */

import type { StatusSnapshot } from "../../protocol/status";
import type { EngineCtx } from "./context";

export function buildStatus(c: EngineCtx): StatusSnapshot {
	let staleStreams = 0;
	let quarantinedRows = 0;
	let frozenDocs = 0;
	for (const r of c.repo.streams()) {
		if (r.stale && r.cls !== "other") staleStreams++;
		quarantinedRows += r.quarantinedRows;
		if (r.frozen) frozenDocs++;
	}
	let liveDocs = 0;
	if (c.ns) for (const e of c.ns.state.entries.values()) if (e.state === "live") liveDocs++;
	const reconnectIn = c.sess?.reconnectAtMono ?? null;
	return {
		phase: c.phase,
		deviceClass: c.deviceClass,
		transport: "inline",
		vaultEpoch: c.repo.identity.vaultEpoch,
		vaultSeq: c.repo.cursor.vaultSeq,
		headSeq: c.repo.cursor.headSeqSeen,
		relay: {
			connected: c.session !== null,
			lastCloseCode: c.lastCloseCode,
			reconnectInMs: reconnectIn === null ? null : Math.max(0, reconnectIn - c.mono()),
			rttMs: null,
		},
		counts: {
			liveDocs,
			staleStreams,
			outboxFrames: c.outbox.size,
			outboxBytes: c.outbox.totalBytes,
			unreceiptedFrames: c.outbox.unreceipted(),
			residentDocs: c.handles?.count ?? 0,
			residentBytesEstimate: c.handles?.bytes ?? 0,
			pendingDiskOps: 0,
			pendingBlobs: 0,
			quarantinedRows,
			frozenDocs,
			conflictCopiesToday: 0,
		},
		bootstrap: null,
		brake: null,
		lastFullReconcileAtMs: null,
		lastSyncedAtMs: c.lastSyncedAtMs,
		dailyFramesUsed: c.daily.day === c.day() ? c.daily.frames : 0,
		notices: c.noticeList(),
	};
}
