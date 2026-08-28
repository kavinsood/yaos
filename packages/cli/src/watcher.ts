/**
 * The daemon's filesystem watcher.
 *
 * EVENTS ARE HINTS, NOT TRUTH. Nothing here infers a rename, pairs a delete
 * with a create, or decides what a change means. It says "something happened at
 * this path" and the reconciliation controller — which already owns rename
 * ordering, suppression and remote-delete arbitration — works out the rest from
 * an authoritative read. That is what buys the freedom to emit delete+create
 * for a `mv` and be right anyway.
 *
 * Three mechanisms earn their place:
 *   - `awaitWriteFinish`, so a file still being written is never read;
 *   - a short coalescing window, so an editor's save-dance (write temp, rename,
 *     touch) becomes one hint instead of four;
 *   - an ignore predicate that keeps the atomic-write temp file the daemon
 *     itself creates from waking the daemon up.
 */

import nodePath from "node:path";
import type { Stats } from "node:fs";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import type { NodeApp } from "./nodeApp";
import { toVaultRelativePath } from "./paths";

/**
 * Something changed at `path`. `path` is vault-relative, POSIX, NFC.
 *
 * There is no `rename` member, and this is the whole story rather than a
 * temporary state: a local `mv` reaches chokidar as an unlink plus an add, so
 * that is what the daemon forwards — a delete and a create. Reconciliation
 * does not need a paired rename to converge; the price is that a moved note
 * arrives on other devices as a new note, with its content but not its
 * history.
 */
export type FsHint = { kind: "create" | "modify" | "delete"; path: string };

export interface FsWatcher {
	close(): Promise<void>;
}

/**
 * How long a burst is held before it is reported.
 *
 * Long enough to fold an editor's multi-step save into one hint, short enough
 * that a human typing in vim does not notice. Not a correctness parameter: a
 * hint that arrives late is still just a hint.
 */
const COALESCE_MS = 60;

/** chokidar's own settle window for a file that is still being written. */
const AWAIT_WRITE_FINISH = { stabilityThreshold: 200, pollInterval: 50 };

/**
 * TEST-ONLY, AND INERT UNLESS `YAOS_TEST_ONLY_DROP_HINT` IS SET.
 *
 * A vault-relative path substring whose hints are thrown away. It exists for
 * the one failure this file cannot otherwise be exercised against: an event
 * the OS never delivers at all. An inotify queue that overflows drops events
 * silently, and the daemon's answer to that is not the watcher — it is the
 * periodic authoritative reconcile. That safety net is unfalsifiable from
 * outside the process unless a hint can be made to genuinely disappear, and
 * no write this platform supports is invisible to chokidar.
 *
 * Read once, at module load, so the production cost is one `!== null` on a
 * module constant per watcher event and nothing else. Nothing in the daemon,
 * its config parser or its documentation sets this; only tests/headless does.
 */
const DROPPED_HINT_MARKER: string | null = process.env["YAOS_TEST_ONLY_DROP_HINT"]?.trim() || null;

/**
 * Should the watcher pretend this path does not exist?
 *
 * The subtlety, inherited from PR #16: when chokidar has no `stats` yet it
 * re-evaluates later with them, so a stats-less call must NOT prune on the
 * "not a .md file" rule — a directory called `notes.v2` would be pruned along
 * with everything under it. Dot-segments are safe to prune either way, and they
 * are what removes `.obsidian`, `.git` and the `.yaos-write-*.tmp` files the
 * daemon's own atomic writes create.
 */
function shouldIgnorePath(
	vaultRoot: string,
	rawPath: string,
	stats: Stats | undefined,
): boolean {
	const absolute = nodePath.isAbsolute(rawPath)
		? rawPath
		: nodePath.resolve(vaultRoot, rawPath);
	const relative = nodePath.relative(vaultRoot, absolute);
	if (relative === "") return false;
	if (relative.startsWith("..")) return true;
	for (const segment of relative.split(nodePath.sep)) {
		if (segment.startsWith(".")) return true;
	}
	if (stats === undefined) return false;
	if (stats.isDirectory()) return false;
	return !absolute.toLowerCase().endsWith(".md");
}

/**
 * Watch `host`'s vault root and report Markdown changes as hints.
 *
 * Returns immediately; chokidar's initial directory walk finishes in the
 * background. That is deliberate — the daemon's first reconcile is
 * authoritative and does not need the watcher to be ready, and blocking startup
 * on a full walk of a large vault would delay the readiness line for nothing.
 */
export function startWatcher(
	host: NodeApp,
	onHint: (hint: FsHint) => void,
): FsWatcher {
	const pending = new Map<string, "create" | "modify" | "delete">();
	let flushTimer: NodeJS.Timeout | null = null;
	let closed = false;

	const flush = (): void => {
		flushTimer = null;
		if (closed) return;
		const batch = [...pending];
		pending.clear();
		for (const [path, kind] of batch) {
			onHint({ kind, path });
		}
	};

	const record = (kind: "create" | "modify" | "delete", rawPath: string): void => {
		if (closed) return;
		const absolute = nodePath.isAbsolute(rawPath)
			? rawPath
			: nodePath.resolve(host.vaultRoot, rawPath);
		if (!absolute.toLowerCase().endsWith(".md")) return;
		const path = toVaultRelativePath(host.vaultRoot, absolute);
		if (path === null) return;

		// Simulated OS-level event loss; see DROPPED_HINT_MARKER. Placed here,
		// ahead of the index refresh below, because an event that was never
		// delivered leaves no trace at all — a hint that still updates the
		// stat cache and is only suppressed downstream would be a weaker
		// fixture than the failure it stands in for.
		if (DROPPED_HINT_MARKER !== null && path.includes(DROPPED_HINT_MARKER)) return;

		// Refresh the index BEFORE the hint goes out, so that whatever the
		// daemon does in response reads a `cachedStat` that agrees with the
		// disk rather than the state from before this event.
		if (kind === "delete") {
			host.index.forget(path);
		} else {
			host.statSyncEntry(path);
		}

		// Coalesce by path. A create that has not been reported yet stays a
		// create when the file is then modified — the daemon has not seen the
		// path at all, so "created" is the truthful summary. Everything else is
		// last-one-wins, which for a delete is the only safe collapse.
		const previous = pending.get(path);
		if (previous === "create" && kind === "modify") {
			// keep "create"
		} else {
			pending.set(path, kind);
		}
		if (flushTimer === null) {
			flushTimer = setTimeout(flush, COALESCE_MS);
			flushTimer.unref?.();
		}
	};

	const watcher: ChokidarWatcher = chokidarWatch(host.vaultRoot, {
		persistent: true,
		ignoreInitial: true,
		alwaysStat: true,
		awaitWriteFinish: AWAIT_WRITE_FINISH,
		ignored: (path, stats) => shouldIgnorePath(host.vaultRoot, path, stats),
	});

	watcher.on("add", (path) => record("create", path));
	watcher.on("change", (path) => record("modify", path));
	watcher.on("unlink", (path) => record("delete", path));
	watcher.on("addDir", () => {
		// The tree changed shape, so the containment memo may be describing a
		// directory that is now a symlink. Cheaper to re-prove than to reason
		// about which entry went stale.
		host.forgetContainedDirectories();
	});
	watcher.on("unlinkDir", (path) => {
		const vaultPath = toVaultRelativePath(host.vaultRoot, nodePath.resolve(host.vaultRoot, path));
		if (vaultPath !== null) host.index.forgetSubtree(vaultPath);
		host.forgetContainedDirectories();
	});
	watcher.on("error", (error) => {
		// A watcher error is not fatal: the periodic authoritative reconcile is
		// the daemon's real safety net, and killing the process because inotify
		// hiccuped would be worse than running blind until the next sweep.
		console.error("[yaos] watcher error:", error);
	});

	return {
		async close(): Promise<void> {
			if (closed) return;
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			// Deliver what is already known before shutting down. Losing the
			// last edit to a SIGTERM is precisely the failure this drain exists
			// to prevent.
			flush();
			closed = true;
			await watcher.close();
		},
	};
}
