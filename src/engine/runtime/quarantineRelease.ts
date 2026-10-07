/**
 * Quarantine release (DESIGN §d.6). `releaseQuarantine{stream}` (user action)
 * re-gates every quarantined row: rows that pass are applied, the rest are
 * dismissed, the doc unfreezes. `retryReaderQuarantine` is the automatic
 * "retried on upgrade or new keys" path: run after every session start (the
 * point where a key fetch or a new client version can change what this reader
 * opens). It only releases a stream when every live quarantined row is
 * reader-dependent and now passes; otherwise nothing changes (no dismissals).
 * A row a re-gate finds stale (e2ee-design §14.3) is settled: dismissed, never
 * applied. `regateUnopened` is the ns / cfg counterpart (§9.3: reader-dependent
 * rows wait in tail and halt the fold): run after every keyring change.
 */

import { CFG_STREAM, NS_STREAM, type StreamName } from "../../core/types";
import type { QuarantineRecord, TailRecord } from "../store/schema";
import { LOCAL_FLAG_UNOPENED } from "../sync/foldRuntime";
import { gateRow } from "../sync/ingestRow";
import type { EngineCtx } from "./context";

const isDismissed = (q: QuarantineRecord): boolean => q.detail.startsWith("dismissed:");
/** Gate failures that depend on this reader's version or keys (envelope isReaderDependent). */
const READER_DEPENDENT: ReadonlySet<QuarantineRecord["reason"]> = new Set(["envelope-version", "crypto-unknown-key", "crypto-auth", "keyring-hold"]);

interface Regated {
	readonly pass: TailRecord[];
	/** Settled without applying: stale-epoch (§14.3), or a stream class that is only accounted. */
	readonly settled: QuarantineRecord[];
	readonly fail: QuarantineRecord[];
}

async function regate(c: EngineCtx, stream: StreamName, rows: readonly QuarantineRecord[]): Promise<Regated> {
	const out: Regated = { pass: [], settled: [], fail: [] };
	for (const q of rows) {
		if (q.bytes.length < q.originalSize) {
			out.fail.push(q);
			continue;
		}
		const g = await gateRow(c.gateCtx, c.ports.hash, { stream, seq: q.seq, deviceId: q.deviceId, clientFrameId: q.clientFrameId, payload: q.bytes }, c.now());
		if (g.t === "row") out.pass.push(g.row);
		else if (g.t === "account") out.settled.push(q);
		else out.fail.push(q);
	}
	return out;
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
	const { pass, settled, fail } = await regate(c, stream, await c.repo.quarantineOf(stream));
	await release(c, stream, pass, [...settled, ...fail]);
	return { passed: pass.length, dismissed: settled.length + fail.length };
}

/** Automatic retry of reader-dependent quarantine; returns the streams released. */
export async function retryReaderQuarantine(c: EngineCtx): Promise<number> {
	let released = 0;
	for (const r of [...c.repo.streams()]) {
		if (r.frozen !== 1 || r.quarantinedRows === 0) continue;
		const rows = (await c.repo.quarantineOf(r.stream)).filter((q) => !isDismissed(q));
		if (rows.length === 0 || !rows.every((q) => READER_DEPENDENT.has(q.reason))) continue;
		const { pass, settled, fail } = await regate(c, r.stream, rows);
		if (fail.length > 0) continue;
		await release(c, r.stream, pass, settled);
		c.diag("quarantine-retried", { stream: r.stream, rows: pass.length, settled: settled.length });
		released++;
	}
	return released;
}

/**
 * Re-gate the unfolded ns / cfg rows a reader-dependent failure left unopened (raw payload, LOCAL_FLAG_UNOPENED):
 * new keys, a settled revoke or `k` judged further can open them, or find them stale (§14.3). Re-gated rows
 * replace the unopened ones, the halt lifts and the fold advances. Rows still unopened keep waiting.
 */
export async function regateUnopened(c: EngineCtx): Promise<number> {
	let n = 0;
	for (const fold of [c.ns, c.cfg]) {
		const rows = (await c.repo.getTail(fold.stream, fold.coversSeq)).filter((r) => r.flags & LOCAL_FLAG_UNOPENED);
		const out: TailRecord[] = [];
		for (const r of rows) {
			const g = await gateRow(c.gateCtx, c.ports.hash, { stream: r.stream, seq: r.seq, deviceId: r.deviceId, clientFrameId: r.clientFrameId, payload: r.content }, c.now());
			if (g.t === "row" && !(g.row.flags & LOCAL_FLAG_UNOPENED)) out.push(g.row);
		}
		if (out.length === 0) continue;
		const replaced = await c.repo.tReplaceTail(fold.stream, out, c.now());
		c.diag("unopened-regated", { stream: fold.stream, rows: replaced });
		await fold.resume();
		if (fold.stream === NS_STREAM) await c.afterNsChange();
		else if (fold.stream === CFG_STREAM) await c.afterCfgChange();
		n += replaced;
	}
	return n;
}
