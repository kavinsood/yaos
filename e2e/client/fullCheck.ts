/**
 * Convergence, clean-state and latency helpers for the full-client e2e (fullClients.ts).
 *
 * converge(): every client is clean (engine ready and live, caught up, idle, no intents, outbox/disk/blob
 * queues empty, nothing frozen or quarantined, no vault events in flight, open views bound, saved and equal
 * to disk, resident body replicas equal to disk) and every client has the same vault files byte for byte,
 * the same synced .obsidian files, and the same NsFoldState bytes; twice in a row.
 */
import { createHash } from "node:crypto";
import { encodeNsFoldV1 } from "../../src/core/codec/nsFoldV1";
import { pathKey } from "../../src/core/paths/pathKey";
import type { ConfigRelPath, VaultPath } from "../../src/core/types";
import { residentText } from "../../src/engine/compose/runtimeOps";
import { classifyConfigPath } from "../../src/engine/settings/allowlist";
import type { FullClient } from "./fullKit";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function sha(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export const enc = (s: string) => new TextEncoder().encode(s);

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (a === null || b === null) return a === b;
	return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
}

export async function bytesOf(c: FullClient, path: string): Promise<Uint8Array | null> {
	return c.vault.hasFile(path) ? c.vault.readBytes(path) : null;
}

/** Synced config files (allowlisted by classifyConfigPath), config-relative. */
export function syncedConfig(c: FullClient): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const [p, b] of c.configDir.files) if (classifyConfigPath(p as ConfigRelPath) !== null) out.set(p, b);
	return out;
}

/** path -> sha of every vault file, ".obsidian/<p>" for synced config files, "#nsfold" for the ns fold. */
export async function fingerprint(c: FullClient): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const st of await c.vault.list()) out.set(st.path, `${st.size}:${sha(await c.vault.readBytes(st.path))}`);
	for (const [p, b] of syncedConfig(c)) out.set(`${c.vault.configDir}/${p}`, `${b.byteLength}:${sha(b)}`);
	const ns = c.vrt?.log.c.ns.state;
	out.set("#nsfold", ns ? sha(encodeNsFoldV1(ns)) : "none");
	return out;
}

export function diffPrints(an: string, a: Map<string, string>, bn: string, b: Map<string, string>): string[] {
	const out: string[] = [];
	for (const [k, v] of a) {
		const w = b.get(k);
		if (w === undefined) out.push(`${k} on ${an}, missing on ${bn}`);
		else if (w !== v) out.push(`${k} differs ${an}=${v} ${bn}=${w}`);
	}
	for (const k of b.keys()) if (!a.has(k)) out.push(`${k} on ${bn}, missing on ${an}`);
	return out;
}

export function conflictCopies(c: FullClient): string[] {
	return [...c.vault.snapshot().keys()].filter((p) => / \(conflict /.test(p));
}

/** Why `c` is not clean (empty = clean). Mirrors src/sim/invariants.ts checkClean, minus the relay oracle. */
export function cleanIssues(c: FullClient): string[] {
	const out: string[] = [];
	const n = c.name;
	if (!c.runtime.engine.isReady) out.push(`${n}: engine not ready`);
	const rt = c.vrt;
	if (!rt) out.push(`${n}: no vault runtime`);
	else {
		const v = rt.log.nsView();
		if (v.halted || v.overlayHalted) out.push(`${n}: ns halted`);
		if (!v.caughtUp) out.push(`${n}: ns not caught up`);
		if (v.pending.length > 0) out.push(`${n}: ${v.pending.length} pending ns frames`);
		if (!rt.log.isIdle()) out.push(`${n}: log engine not idle`);
		const intents = rt.rec.ctx.store.intents.size;
		if (intents > 0) out.push(`${n}: ${intents} open intents`);
		const s = rt.status();
		if (s.phase !== "live") out.push(`${n}: phase ${s.phase}`);
		const k = s.counts;
		if (k.pendingDiskOps || k.outboxFrames || k.unreceiptedFrames || k.frozenDocs || k.pendingBlobs || k.quarantinedRows) {
			out.push(`${n}: counts disk=${k.pendingDiskOps} outbox=${k.outboxFrames} unreceipted=${k.unreceiptedFrames} frozen=${k.frozenDocs} blobs=${k.pendingBlobs} quarantined=${k.quarantinedRows}`);
		}
		const view = rt.port.view();
		for (const [path, text] of c.vault.snapshot()) {
			if (!path.endsWith(".md")) continue;
			const id = view.remoteByPathKey.get(pathKey(path as VaultPath));
			const crdt = id ? residentText(rt, id) : null;
			if (crdt !== null && crdt !== text) out.push(`${n}: body replica of ${path} != disk`);
		}
	}
	if (c.vault.pendingEvents() > 0) out.push(`${n}: ${c.vault.pendingEvents()} vault events in flight`);
	if (c.ui.fatals.length > 0) out.push(`${n}: fatal ${c.ui.fatals[0]?.code}`);
	for (const ws of c.workspaces) {
		for (const v of ws.history) {
			if (v.counters.bindMismatch > 0) out.push(`${n}: view ${v.viewId} bindMismatch=${v.counters.bindMismatch}`);
			if (v.counters.defaultReloadWhileBound > 0) out.push(`${n}: view ${v.viewId} defaultReloadWhileBound=${v.counters.defaultReloadWhileBound}`);
		}
	}
	for (const v of c.workspace.views_()) {
		if (v.isDirty()) out.push(`${n}: view ${v.viewId} (${v.path}) dirty`);
		if (!v.hasEditor() || v.path === null || !v.path.endsWith(".md")) continue;
		const disk = c.vault.textOf(v.path);
		if (disk === null) continue;
		if (!v.isBound()) out.push(`${n}: view ${v.viewId} (${v.path}) not bound`);
		if (v.buffer !== disk) out.push(`${n}: view ${v.viewId} (${v.path}) buffer != disk`);
	}
	return out;
}

/** Issues keeping `clients` from convergence (empty = converged). */
export async function convergeIssues(clients: readonly FullClient[]): Promise<string[]> {
	const out = clients.flatMap(cleanIssues);
	const prints = await Promise.all(clients.map(fingerprint));
	const first = clients[0];
	for (let i = 1; i < clients.length; i++) out.push(...diffPrints(first!.name, prints[0]!, clients[i]!.name, prints[i]!));
	return out;
}

/** Waits until converged on two consecutive polls; returns the elapsed ms. Throws with the issues on timeout. */
export async function converge(clients: readonly FullClient[], timeoutMs = 60_000, pollMs = 100): Promise<number> {
	const t0 = performance.now();
	let streak = 0;
	let issues: string[] = [];
	for (;;) {
		issues = await convergeIssues(clients);
		streak = issues.length === 0 ? streak + 1 : 0;
		if (streak >= 2) return performance.now() - t0 - pollMs;
		if (performance.now() - t0 > timeoutMs) {
			throw new Error(`not converged after ${timeoutMs} ms: ${issues.slice(0, 12).join("; ")}${issues.length > 12 ? ` (+${issues.length - 12})` : ""}`);
		}
		await sleep(pollMs);
	}
}

/** Polls `pred` (default every 5 ms); returns the ms since `t0` when it held. */
export async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000, t0 = performance.now(), pollMs = 5): Promise<number> {
	for (;;) {
		if (await pred()) return performance.now() - t0;
		if (performance.now() - t0 > timeoutMs) throw new Error(`timed out (${timeoutMs} ms) waiting for ${what}`);
		await sleep(pollMs);
	}
}

/** Waits until every peer has `path` with exactly `want` (null = absent); returns each peer's latency from t0. */
export async function reachPeers(peers: readonly FullClient[], path: string, want: Uint8Array | null, t0: number, timeoutMs = 30_000): Promise<number[]> {
	return Promise.all(peers.map((p) => waitFor(async () => sameBytes(await bytesOf(p, path), want), `${path} on ${p.name}`, timeoutMs, t0)));
}

/** Waits until every peer's file at `path` contains `token`; returns each peer's latency from t0. */
export async function textReachesPeers(peers: readonly FullClient[], path: string, token: string, t0: number, timeoutMs = 30_000): Promise<number[]> {
	return Promise.all(peers.map((p) => waitFor(() => (p.vault.textOf(path) ?? "").includes(token), `${token} in ${path} on ${p.name}`, timeoutMs, t0)));
}

export function randomBytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < n; i++) {
		x ^= x << 13; x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5; x >>>= 0;
		out[i] = x & 0xff;
	}
	return out;
}
