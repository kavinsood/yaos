/**
 * Temp names left by a crash mid-cycle (DESIGN §f.2 "cycles broken through temp
 * names"). diskRename moves S with the file in one tx, so a temp file is
 * untracked only when the crash hit between the rename and its commit. Such a
 * file would otherwise look like a local rename to "x (yaos-tmp id8).md" and be
 * pushed to the namespace. Before planning, move it back to its doc's synced
 * path when that path is free on disk; the next plan redoes the cycle.
 */

import { parseTempPath } from "../../core/plan/order";
import type { Env } from "./diskJobs";
import { moveOk } from "./diskJobs";

export async function recoverTempNames(env: Env): Promise<number> {
	const { ctx } = env;
	const tracked = new Set<string>();
	for (const s of ctx.store.synced.values()) tracked.add(s.pathKey);
	let moved = 0;
	for (const l of [...ctx.local.values()]) {
		const id8 = parseTempPath(l.path);
		if (id8 === null || l.excluded || l.hash === null || tracked.has(l.pathKey)) continue;
		// The doc whose file went missing with exactly these contents (id8 alone could collide).
		const owners = [...ctx.store.synced.values()].filter((s) => s.docId.startsWith(id8) && !ctx.local.has(s.pathKey) && s.contentHash === l.hash);
		const s = owners[0];
		if (owners.length !== 1 || !s) continue;
		const res = await ctx.exec({ t: "rename", from: l.diskPath, to: s.path, precondition: { t: "hash", hash: l.hash }, docId: s.docId, purpose: "remote-move" });
		const stat = moveOk(res);
		if (!stat) {
			env.scan.markDirty(l.diskPath, null);
			continue;
		}
		ctx.echo.expectRename(l.pathKey, s.pathKey);
		await ctx.commit({}, [{ ...l, diskPath: stat.path, path: s.path, pathKey: s.pathKey, size: stat.size, mtimeMs: stat.mtimeMs, hashedAtMs: ctx.now() }], [l.pathKey]);
		moved++;
	}
	return moved;
}
