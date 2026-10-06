/**
 * Quiescence invariants (DESIGN §l.3).
 *
 *   1 convergence      same file set and byte-equal contents on every device;
 *                      the relay fold (a fresh observer bootstrapped from the
 *                      relay, net.oracle()) equals the disk: every live markdown
 *                      doc has its file with the same text, every markdown file
 *                      has a live doc; every device's NsFoldState encodes to the
 *                      same bytes; every resident body replica equals its file
 *   2 tokens           every live (not user-deleted, not crash-unacknowledged) token
 *                      survives somewhere in the converged vault (conflict copies count),
 *                      contiguous: "[A.15]" exactly, so a token split by a concurrent
 *                      edit ("[A.[B.23] 53]") or missing a bracket counts as lost.
 *                      Exempt: tokens Obsidian itself overwrote (an editor save landing
 *                      before the watcher reported an external write; ClobberRecord)
 *   3 destroyed        every token that ever reached any disk is in the vault, in a
 *                      trash record, or was deleted by a user action. Exempt: text held
 *                      only in a pending (disk-error) conflict copy when the app crashed
 *   5 clean            relay quiet, engines ready and caught up to the relay head,
 *                      ns not halted, no pending ns ops, no open intents, outbox and
 *                      disk queues empty, no frozen docs, no fatals; no vault events
 *                      in flight, no dirty views, open bound views equal their file,
 *                      bindMismatch = defaultReloadWhileBound = 0
 *   quiet              no echo loop: after quiescence nothing appends, writes, posts
 *                      or saves
 *
 * Not checked here: 4 (fold determinism; WP-A's fold fuzz covers it) and 6
 * (resource bounds; WP-C budget tests).
 */

import { encodeNsFoldV1 } from "../core/codec/nsFoldV1";
import { checkNsInvariants } from "../core/ns/verify";
import { pathKey } from "../core/paths/pathKey";
import { NS_STREAM, type VaultPath } from "../core/types";
import { tokensIn, type TokenLedger } from "./actors";
import type { VirtualClock } from "./clock";
import type { SimDevice } from "./device";
import type { OracleDoc, SimNet } from "./net";

export interface Violation {
	readonly inv: "convergence" | "tokens" | "destroyed" | "clean" | "quiet";
	readonly detail: string;
}

const relayKey = (p: string) => pathKey(p as VaultPath) as string;

function files(d: SimDevice): Map<string, { path: string; text: string }> {
	const out = new Map<string, { path: string; text: string }>();
	for (const [path, text] of d.vault.snapshot()) out.set(d.vault.key(path), { path, text });
	return out;
}

function brief(s: string): string {
	return JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);
}

function hex(b: Uint8Array): string {
	let h = 0x811c9dc5;
	for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
	return `${b.length}:${h.toString(16)}`;
}

export function checkConvergence(devs: readonly SimDevice[], oracle: { readonly docs: readonly OracleDoc[]; readonly error: string | null }): Violation[] {
	const out: Violation[] = [];
	const first = devs[0];
	if (!first) return out;
	const ref = files(first);
	for (const d of devs.slice(1)) {
		const mine = files(d);
		for (const [k, f] of ref) {
			const m = mine.get(k);
			if (!m) out.push({ inv: "convergence", detail: `${f.path} on ${first.name}, missing on ${d.name}` });
			else if (m.path.split("/").pop() !== f.path.split("/").pop()) out.push({ inv: "convergence", detail: `leaf display differs: ${f.path} vs ${m.path}` });
			else if (m.text !== f.text) out.push({ inv: "convergence", detail: `${f.path} differs: ${first.name}=${brief(f.text)} ${d.name}=${brief(m.text)}` });
		}
		for (const [k, m] of mine) if (!ref.has(k)) out.push({ inv: "convergence", detail: `${m.path} on ${d.name}, missing on ${first.name}` });
	}
	if (oracle.error) out.push({ inv: "convergence", detail: `relay oracle: ${oracle.error}` });
	const byKey = new Map<string, { path: string; text: string }>();
	for (const f of ref.values()) byKey.set(relayKey(f.path), f);
	const docKeys = new Set<string>();
	for (const doc of oracle.docs) {
		const k = relayKey(doc.path);
		docKeys.add(k);
		const f = byKey.get(k);
		if (!f) out.push({ inv: "convergence", detail: `relay doc ${doc.path} has no file` });
		else if (f.path !== doc.path) out.push({ inv: "convergence", detail: `relay path ${doc.path} vs disk ${f.path}` });
		else if (doc.text !== null && f.text !== doc.text) out.push({ inv: "convergence", detail: `relay ${doc.path}=${brief(doc.text)} disk=${brief(f.text)}` });
	}
	for (const [k, f] of byKey) if (f.path.endsWith(".md") && !docKeys.has(k)) out.push({ inv: "convergence", detail: `${f.path} never reached the relay` });
	const folds = new Map<string, string[]>();
	for (const d of devs) {
		const st = d.vrt?.log.c.ns.state;
		if (!st) continue;
		const bad = checkNsInvariants(st);
		if (bad) out.push({ inv: "convergence", detail: `${d.name}: ns invariant ${bad}` });
		const h = hex(encodeNsFoldV1(st));
		folds.set(h, [...(folds.get(h) ?? []), d.name]);
		for (const [path, text] of d.vault.snapshot()) {
			if (!path.endsWith(".md")) continue;
			const crdt = d.engineText(path);
			if (crdt !== null && crdt !== text) out.push({ inv: "convergence", detail: `${d.name}: body replica of ${path}=${brief(crdt)} disk=${brief(text)}` });
		}
	}
	if (folds.size > 1) out.push({ inv: "convergence", detail: `NsFoldState bytes differ: ${[...folds].map(([h, n]) => `${n.join("")}=${h}`).join(" ")}` });
	return out;
}

/** Tokens Obsidian itself destroyed (editor save over an unseen external/user write; vault.ts ClobberRecord). */
export function clobberedTokens(devs: readonly SimDevice[]): Set<string> {
	const out = new Set<string>();
	for (const d of devs) {
		for (const c of d.vault.clobbered) {
			const saved = new Set(tokensIn(c.savedText));
			for (const t of tokensIn(c.text)) if (!saved.has(t)) out.add(t);
		}
	}
	return out;
}

/** Contiguous tokens in the converged vault (device 0; convergence is checked separately). */
function vaultTokens(devs: readonly SimDevice[]): Set<string> {
	const out = new Set<string>();
	for (const text of devs[0]?.vault.snapshot().values() ?? []) for (const t of tokensIn(text)) out.add(t);
	return out;
}

export function checkTokens(devs: readonly SimDevice[], ledger: TokenLedger): Violation[] {
	const present = vaultTokens(devs);
	const clobbered = clobberedTokens(devs);
	const lost = ledger.live().filter((e) => !present.has(e.token) && !clobbered.has(e.token));
	return lost.slice(0, 10).map((e) => ({ inv: "tokens" as const, detail: `lost ${e.token} (${e.via} on ${e.dev} at step ${e.step})${lost.length > 10 ? ` (+${lost.length - 10} more)` : ""}` }));
}

export function checkNothingDestroyed(devs: readonly SimDevice[], ledger: TokenLedger): Violation[] {
	const kept = vaultTokens(devs);
	for (const d of devs) for (const r of d.vault.trashed) for (const t of tokensIn(r.text)) kept.add(t);
	for (const t of clobberedTokens(devs)) kept.add(t);
	// Known gap (wp-d-notes): a conflict copy still retrying a disk error dies with an app crash.
	for (const d of devs) for (const text of d.crashLost) for (const t of tokensIn(text)) kept.add(t);
	const out: Violation[] = [];
	const seen = new Set<string>();
	for (const d of devs) {
		for (const v of d.vault.history) {
			for (const t of tokensIn(v.text)) {
				if (seen.has(t)) continue;
				seen.add(t);
				if (kept.has(t) || ledger.entries.get(t)?.state === "deleted") continue;
				if (out.length < 10) out.push({ inv: "destroyed", detail: `${t} was on ${d.name}:${v.path} (${v.by}) and is gone` });
			}
		}
	}
	return out;
}

export function checkClean(devs: readonly SimDevice[], net: SimNet, isDown: (i: number) => boolean): Violation[] {
	const out: Violation[] = [];
	const bad = (detail: string) => out.push({ inv: "clean", detail });
	if (!net.quiet()) bad(`relay not quiet (pending ${net.relay.pendingCount()})`);
	const head = net.streamHead(NS_STREAM);
	devs.forEach((d, i) => {
		const n = d.name;
		if (isDown(i)) bad(`${n}: app still down`);
		if (!d.runtime.engine.isReady) bad(`${n}: engine not ready`);
		const rt = d.vrt;
		if (!rt) bad(`${n}: no vault runtime`);
		else {
			const v = rt.log.nsView();
			if (v.halted || v.overlayHalted) bad(`${n}: ns halted`);
			if (!v.caughtUp || v.coversSeq < head) bad(`${n}: ns covers ${v.coversSeq} of head ${head}`);
			if (v.pending.length > 0) bad(`${n}: ${v.pending.length} pending ns frames`);
			if (!rt.log.isIdle()) bad(`${n}: log engine not idle`);
			const intents = rt.rec.ctx.store.intents.size;
			if (intents > 0) bad(`${n}: ${intents} open intents`);
		}
		if (d.vault.pendingEvents() > 0) bad(`${n}: ${d.vault.pendingEvents()} vault events in flight`);
		if (d.ui.fatals.length > 0) bad(`${n}: fatal ${d.ui.fatals[0]?.code}`);
		const st = d.ui.statuses[d.ui.statuses.length - 1];
		if (st) {
			const c = st.counts;
			if (c.pendingDiskOps > 0 || c.outboxFrames > 0 || c.frozenDocs > 0 || c.unreceiptedFrames > 0) bad(`${n}: status pendingDiskOps=${c.pendingDiskOps} outbox=${c.outboxFrames} unreceipted=${c.unreceiptedFrames} frozen=${c.frozenDocs}`);
		}
		for (const ws of d.workspaces) {
			for (const v of ws.history) {
				if (v.counters.bindMismatch > 0) bad(`${n}: view ${v.viewId} bindMismatch=${v.counters.bindMismatch}`);
				if (v.counters.defaultReloadWhileBound > 0) bad(`${n}: view ${v.viewId} defaultReloadWhileBound=${v.counters.defaultReloadWhileBound}`);
			}
		}
		for (const v of d.workspace.views_()) {
			if (v.isDirty()) bad(`${n}: view ${v.viewId} (${v.path}) still dirty`);
			if (!v.hasEditor() || v.path === null || !v.path.endsWith(".md")) continue;
			const disk = d.vault.textOf(v.path);
			if (disk === null) continue;
			if (!v.isBound()) bad(`${n}: view ${v.viewId} (${v.path}) never bound`);
			if (v.buffer !== disk) bad(`${n}: view ${v.viewId} buffer ${brief(v.buffer)} != disk ${brief(disk)}`);
		}
	});
	return out;
}

export function activity(devs: readonly SimDevice[], net: SimNet): string {
	const rc = net.relay.counters();
	const parts: (number | string)[] = [net.relay.head(), rc.appendFrames, rc.provisionalBroadcasts];
	for (const d of devs) {
		const b = d.runtime.bindings.stats;
		parts.push(d.vault.calls.write, d.vault.calls.rename, d.vault.calls.trash, b.localUpdatesPosted, b.mergeUpdatesPosted, b.bindDeltasPosted, d.sideFiles.writes);
		for (const v of d.workspace.views_()) parts.push(v.counters.saves, v.counters.localTx, v.counters.remoteApplied);
	}
	return parts.join(",");
}

/** No echo loop: advancing `ms` after quiescence produces no appends, writes, posts or saves. */
export async function checkQuiet(clock: VirtualClock, devs: readonly SimDevice[], net: SimNet, ms = 30_000): Promise<Violation[]> {
	const before = activity(devs, net);
	await clock.advance(ms);
	const after = activity(devs, net);
	return before === after ? [] : [{ inv: "quiet", detail: `activity after quiescence: ${before} -> ${after}` }];
}
