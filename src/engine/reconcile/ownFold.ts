/**
 * S1 (DESIGN §c.13): own ns ops are applied to the synced tree only when they
 * fold as committed. Until then the doc is `pendingLocal` and the planner pins
 * it. One T_synced commit per batch of fold events.
 *
 *   create applied     -> nsTouchSeq = seq (blob: blobRev = seq);
 *                         a blob doc without S yet gets one from L (pushBlob
 *                         writes it after submit otherwise)
 *   create suffixed    -> S keeps the requested path and nsTouchSeq, so the next
 *                         plan sees the remote move and renames the file (or
 *                         collapses an identical loser); blob: blobRev
 *   rename applied     -> nsTouchSeq = seq; suffixed -> S.path = requested path
 *   restore revived    -> path = requested path, nsTouchSeq = seq
 *   setBlob applied    -> contentHash = op.hash, blobRev = seq, stat +
 *                         fingerprint from L when L holds that hash
 *   anything else      -> no change (the next plan re-derives)
 *
 * The fold stamps a blob's rev with the seq of the frame that set it, so the
 * rev comes from the event's own seq. Never from `entry`: that is the committed
 * state after the whole fold batch, which may already hold a later remote
 * setBlob (own hash + remote rev would read as "in sync" and hide the change).
 */

import type { SyncedEntry } from "../../core/types";
import type { SyncedRecord } from "../store/schema";
import type { Ctx } from "./context";
import type { OwnFoldEvent } from "./deps";

export async function applyOwnFold(ctx: Ctx, events: readonly OwnFoldEvent[]): Promise<void> {
	const next = new Map<string, SyncedEntry>();
	const get = (docId: string): SyncedEntry | undefined => next.get(docId) ?? ctx.synced(docId as SyncedEntry["docId"]);
	for (const ev of events) {
		const { op, seq, outcome } = ev;
		if (op.t === "upgradeRules") continue;
		const s = get(op.docId);
		switch (op.t) {
			case "create": {
				if (outcome.kind !== "applied" && outcome.kind !== "suffixed") break;
				const blobRev = op.kind === "blob" ? seq : 0;
				if (s) {
					next.set(op.docId, outcome.kind === "applied" ? { ...s, nsTouchSeq: seq, blobRev: op.kind === "blob" ? blobRev : s.blobRev } : { ...s, blobRev: op.kind === "blob" ? blobRev : s.blobRev });
					break;
				}
				if (op.kind !== "blob") break;
				const l = ctx.localAt(op.path);
				if (!l || l.hash !== op.contentHash || l.fingerprint === null) break;
				next.set(op.docId, {
					docId: op.docId, path: op.path, pathKey: ctx.pk(op.path), kind: "blob", contentHash: op.contentHash, fingerprint: l.fingerprint,
					size: l.size, mtimeMs: l.mtimeMs, bodyVersion: null, blobRev, nsTouchSeq: outcome.kind === "applied" ? seq : 0, hasBase: false,
				});
				break;
			}
			case "rename":
				if (!s) break;
				if (outcome.kind === "applied") next.set(op.docId, { ...s, nsTouchSeq: seq });
				else if (outcome.kind === "suffixed") next.set(op.docId, { ...s, path: outcome.requestedPath, pathKey: ctx.pk(outcome.requestedPath) });
				break;
			case "restore":
				if (!s || outcome.kind !== "revived") break;
				next.set(op.docId, { ...s, path: op.path, pathKey: ctx.pk(op.path), nsTouchSeq: seq });
				break;
			case "setBlob": {
				if (!s || outcome.kind !== "applied") break;
				const l = ctx.localAt(s.path);
				const stat = l && l.hash === op.hash && l.fingerprint !== null ? { size: l.size, mtimeMs: l.mtimeMs, fingerprint: l.fingerprint } : {};
				next.set(op.docId, { ...s, ...stat, contentHash: op.hash, blobRev: seq });
				break;
			}
			case "delete":
				break;
		}
	}
	if (next.size === 0) return;
	const put: SyncedRecord[] = [...next.values()].map((e) => ctx.record(e));
	await ctx.commit({ syncedPut: put });
}
