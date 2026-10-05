/**
 * Crash-point enumeration for reconcile scenarios. A scenario builds a world
 * and leaves it with unsynced changes; `crashPoints` dry-runs one sync to count
 * the disk mutations and storage commits it performs; `runCrashed` replays the
 * scenario with a crash armed at one point (before / after the n-th disk op,
 * before / after the n-th commit), reboots, syncs, and returns the world.
 */

import { sha256Hex } from "../../../core/hash/sha256";
import type { VaultPath } from "../../../core/types";
import { CrashError } from "./fakeGateway";
import type { World } from "./world";

/** testkit is typechecked without node types: a minimal assert. */
function ok(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg: string): void {
	if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

export type CrashKind = "disk-before" | "disk-after" | "commit-before" | "commit-after";
export interface CrashPoint { readonly kind: CrashKind; readonly n: number }

export const label = (p: CrashPoint): string => `${p.kind}#${p.n}`;

export async function crashPoints(make: () => Promise<World>): Promise<{ points: CrashPoint[]; dry: World }> {
	const w = await make();
	const m0 = w.gateway.mutations;
	const c0 = w.storage.commits;
	await w.sync();
	const M = w.gateway.mutations - m0;
	const C = w.storage.commits - c0;
	const points: CrashPoint[] = [];
	for (let n = 1; n <= M; n++) points.push({ kind: "disk-before", n }, { kind: "disk-after", n });
	for (let n = 1; n <= C; n++) points.push({ kind: "commit-before", n }, { kind: "commit-after", n });
	return { points, dry: w };
}

function arm(w: World, p: CrashPoint): void {
	if (p.kind === "disk-before" || p.kind === "disk-after") {
		w.gateway.crashAt(w.gateway.mutations + p.n, p.kind === "disk-after");
		return;
	}
	const at = w.storage.commits + p.n;
	const hook = (n: number): void => {
		if (n === at) throw new CrashError(`${p.kind} ${n}`);
	};
	if (p.kind === "commit-before") w.storage.beforeCommit = hook;
	else w.storage.afterCommit = hook;
}

/** Replay the scenario with a crash at `p`, reboot, and sync to quiet. */
export async function runCrashed(make: () => Promise<World>, p: CrashPoint): Promise<World> {
	const w = await make();
	arm(w, p);
	let crashed = false;
	try {
		await w.sync();
	} catch (e) {
		if (!(e instanceof CrashError)) throw e;
		crashed = true;
	}
	ok(crashed, `crash point ${label(p)} was not reached`);
	await w.crashAndReboot();
	await w.sync();
	await w.sync();
	return w;
}

/**
 * Global convergence: every live doc is on disk with the CRDT's text / the blob's
 * bytes, every visible file is a live doc, S agrees with disk, no open intents,
 * and another sync does nothing.
 */
export async function assertConverged(w: World, where: string): Promise<void> {
	const view = w.log.view();
	for (const r of view.remote.values()) {
		if (r.state !== "live") continue;
		if (r.kind === "markdown") eq(w.vault.text(r.path), w.log.text(r.docId), `${where}: ${r.path} disk != crdt`);
		if (r.kind === "blob") {
			const b = w.vault.bytesOf(r.path);
			ok(b, `${where}: ${r.path} missing on disk`);
			eq(sha256Hex(b), r.blob!.hash, `${where}: ${r.path} bytes != blob`);
		}
		const s = w.synced(r.docId);
		ok(s, `${where}: no synced record for ${r.path}`);
		eq(s.path, r.path, `${where}: synced path`);
	}
	for (const p of Object.keys(w.vault.snapshot())) ok(w.log.liveByPath(p as VaultPath), `${where}: ${p} on disk but not a live doc`);
	eq(w.intents(), 0, `${where}: open intents`);
	const m = w.gateway.mutations;
	const n = w.log.submitted.length;
	await w.sync();
	eq(w.gateway.mutations, m, `${where}: not quiet (disk)`);
	eq(w.log.submitted.length, n, `${where}: not quiet (ns)`);
}
