/**
 * Quarantine release (DESIGN §d.6). `releaseQuarantine{stream}` (user action)
 * re-gates every quarantined row: rows that pass are applied, the rest are
 * dismissed, the doc unfreezes. `retryReaderQuarantine` is the automatic
 * "retried on upgrade or new keys" path: run after every session start (the
 * point where a key fetch or a new client version can change what this reader
 * opens). It only releases a stream when every live quarantined row is
 * reader-dependent and now passes; otherwise nothing changes (no dismissals).
 */

import type { StreamName } from "../../core/types";
import type { QuarantineRecord, TailRecord } from "../store/schema";
import { gateRow } from "../sync/ingestRow";
import type { EngineCtx } from "./context";

const isDismissed = (q: QuarantineRecord): boolean => q.detail.startsWith("dismissed:");
/** Gate failures that depend on this reader's version or keys (envelope isReaderDependent). */
const READER_DEPENDENT: ReadonlySet<QuarantineRecord["reason"]> = new Set(["envelope-version", "crypto-unknown-key", "crypto-auth"]);

async function regate(c: EngineCtx, stream: StreamName, rows: readonly QuarantineRecord[]): Promise<{ pass: TailRecord[]; fail: QuarantineRecord[] }> {
	const pass: TailRecord[] = [];
	const fail: QuarantineRecord[] = [];
	for (const q of rows) {
		if (q.bytes.length < q.originalSize) {
			fail.push(q);
			continue;
		}
		const g = await gateRow(c.gateCtx, c.ports.hash, { stream, seq: q.seq, deviceId: q.deviceId, clientFrameId: q.clientFrameId, payload: q.bytes }, c.now());
		if (g.t === "row") pass.push(g.row);
		else fail.push(q);
	}
	return { pass, fail };
}

async function release(c: EngineCtx, stream: StreamName, pass: readonly TailRecord[], dismiss: readonly QuarantineRecord[]): Promise<void> {
	await c.repo.tReleaseQuarantine(stream, pass, dismiss, c.now());
	c.docs.clearCausal(stream);
	for (const n of c.noticeList()) {
		if (!n.code.startsWith("frozen:")) continue;
		const reason = n.code.slice("frozen:".length);
		if (![...c.repo.streams()].some((r) => r.frozen === 1 && r.frozenReason === reason)) c.clearNotice(n.code);
	}
	const h = c.handles.peek(stream);
	if (h) {
		if (pass.length > 0) await c.docs.applyToHandle(h, pass);
		c.docs.checkDoc(h);
	}
	c.sess.scheduleCatchUp();
	c.scheduleStatus();
}

/** User release: pass -> applied, the rest dismissed, the doc unfrozen. */
export async function releaseQuarantine(c: EngineCtx, stream: StreamName): Promise<{ passed: number; dismissed: number }> {
	const { pass, fail } = await regate(c, stream, await c.repo.quarantineOf(stream));
	await release(c, stream, pass, fail);
	return { passed: pass.length, dismissed: fail.length };
}

/** Automatic retry of reader-dependent quarantine; returns the streams released. */
export async function retryReaderQuarantine(c: EngineCtx): Promise<number> {
	let released = 0;
	for (const r of [...c.repo.streams()]) {
		if (r.frozen !== 1 || r.quarantinedRows === 0) continue;
		const rows = (await c.repo.quarantineOf(r.stream)).filter((q) => !isDismissed(q));
		if (rows.length === 0 || !rows.every((q) => READER_DEPENDENT.has(q.reason))) continue;
		const { pass, fail } = await regate(c, r.stream, rows);
		if (fail.length > 0) continue;
		await release(c, r.stream, pass, []);
		c.diag("quarantine-retried", { stream: r.stream, rows: pass.length });
		released++;
	}
	return released;
}
