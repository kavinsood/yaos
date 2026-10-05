/**
 * Quiescence invariants (DESIGN §l.3), host-observable subset.
 *
 *   1 convergence      same file set and byte-equal contents on every device;
 *                      every hub doc equals the disk; every markdown file has a hub doc
 *   2 tokens           every live (not user-deleted, not crash-unacknowledged) token
 *                      survives somewhere in the converged vault (conflict copies count),
 *                      matched by identity ("A.15"): a minimal diff may move a bracket,
 *                      and a concurrent token may land inside a reused prefix (tokenIdsIn).
 *                      Exempt: tokens Obsidian itself overwrote (an editor save landing
 *                      before the watcher reported an external write; ClobberRecord)
 *   3 destroyed        every token that ever reached any disk is in the vault, in a
 *                      trash record, or was deleted by a user action. Exempt: text held
 *                      only in a pending (disk-error) conflict copy when the app crashed
 *   5 clean            engines ready, no vault events in flight, no dirty views,
 *                      no fatals, status counters drained, open bound views equal
 *                      their file, bindMismatch = defaultReloadWhileBound = 0
 *   quiet              no echo loop: after quiescence nothing publishes or writes
 *
 * INTEGRATION: 4 (fold determinism), the rest of 5 (outbox/held/adoptable/
 * cursors/intents) and 6 (resource bounds) need WP-A/WP-C introspection; add
 * them as extra checks fed by the real engine handles.
 */

import type { StandinHub } from "../engine/__standins__/hub";
import { tokenIdsIn, tokensIn, type TokenLedger } from "./actors";
import type { VirtualClock } from "./__standins__/clock";
import type { SimDevice } from "./device";

export interface Violation {
	readonly inv: "convergence" | "tokens" | "destroyed" | "clean" | "quiet";
	readonly detail: string;
}

const hubKey = (p: string) => p.normalize("NFC").toLowerCase();

function files(d: SimDevice): Map<string, { path: string; text: string }> {
	const out = new Map<string, { path: string; text: string }>();
	for (const [path, text] of d.vault.snapshot()) out.set(d.vault.key(path), { path, text });
	return out;
}

function brief(s: string): string {
	return JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);
}

export function checkConvergence(devs: readonly SimDevice[], hub: StandinHub): Violation[] {
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
	const byHubKey = new Map<string, { path: string; text: string }>();
	for (const f of ref.values()) byHubKey.set(hubKey(f.path), f);
	const hubKeys = new Set<string>();
	for (const { key, path } of hub.list()) {
		hubKeys.add(key);
		const f = byHubKey.get(key);
		const text = hub.text(key) ?? "";
		if (!f) out.push({ inv: "convergence", detail: `hub doc ${path} has no file` });
		else if (f.text !== text) out.push({ inv: "convergence", detail: `hub ${path}=${brief(text)} disk=${brief(f.text)}` });
	}
	for (const [k, f] of byHubKey) if (f.path.endsWith(".md") && !hubKeys.has(k)) out.push({ inv: "convergence", detail: `${f.path} never reached the hub` });
	return out;
}

/** Tokens Obsidian itself destroyed (editor save over an unseen external write; vault.ts ClobberRecord). */
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

/** Token identities in the converged vault (device 0; convergence is checked separately). Brackets are not required: see tokenIdsIn. */
function vaultTokens(devs: readonly SimDevice[]): Set<string> {
	const out = new Set<string>();
	for (const text of devs[0]?.vault.snapshot().values() ?? []) for (const t of tokenIdsIn(text)) out.add(t);
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
	for (const d of devs) for (const r of d.vault.trashed) for (const t of tokenIdsIn(r.text)) kept.add(t);
	for (const t of clobberedTokens(devs)) kept.add(t);
	// Known gap (wp-d-notes): a conflict copy still retrying a disk error dies with an app crash.
	for (const d of devs) for (const text of d.crashLost) for (const t of tokenIdsIn(text)) kept.add(t);
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

export function checkClean(devs: readonly SimDevice[], hub: StandinHub, isDown: (i: number) => boolean): Violation[] {
	const out: Violation[] = [];
	const bad = (detail: string) => out.push({ inv: "clean", detail });
	if (!hub.quiet()) bad("hub has queued or in-flight updates");
	devs.forEach((d, i) => {
		const n = d.name;
		if (isDown(i)) bad(`${n}: app still down`);
		if (!d.runtime.engine.isReady) bad(`${n}: engine not ready`);
		if (d.vault.pendingEvents() > 0) bad(`${n}: ${d.vault.pendingEvents()} vault events in flight`);
		if (d.ui.fatals.length > 0) bad(`${n}: fatal ${d.ui.fatals[0]?.code}`);
		const st = d.ui.statuses[d.ui.statuses.length - 1];
		if (st) {
			const c = st.counts;
			if (c.pendingDiskOps > 0 || c.outboxFrames > 0 || c.frozenDocs > 0) bad(`${n}: status pendingDiskOps=${c.pendingDiskOps} outbox=${c.outboxFrames} frozen=${c.frozenDocs}`);
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

export function activity(devs: readonly SimDevice[], hub: StandinHub): string {
	const parts: (number | string)[] = [hub.stats.published, hub.stats.delivered];
	for (const d of devs) {
		const b = d.runtime.bindings.stats;
		parts.push(d.vault.calls.write, d.vault.calls.rename, d.vault.calls.trash, b.localUpdatesPosted, b.mergeUpdatesPosted, b.bindDeltasPosted, d.engine?.stats.docUpdatesSent ?? "-");
		for (const v of d.workspace.views_()) parts.push(v.counters.saves, v.counters.localTx, v.counters.remoteApplied);
	}
	return parts.join(",");
}

/** No echo loop: advancing `ms` after quiescence produces no publishes, writes, posts or saves. */
export async function checkQuiet(clock: VirtualClock, devs: readonly SimDevice[], hub: StandinHub, ms = 30_000): Promise<Violation[]> {
	const before = activity(devs, hub);
	await clock.advance(ms);
	const after = activity(devs, hub);
	return before === after ? [] : [{ inv: "quiet", detail: `activity after quiescence: ${before} -> ${after}` }];
}
