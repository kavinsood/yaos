/**
 * Bound docs and the disk (DESIGN §d.3), worker side: the merge of an external reload, the check that a save of a
 * bound file wrote text the replica already holds (boundSaved), and bound-merge conflict copies.
 *
 * Main never compares or hashes texts: an intercepted reload only names the view (bodyReload), and the engine
 * reads the file through the disk gateway (raw bytes from main, transferred) and merges here. The view holds its
 * saves until `reloaded` (it reports the text Obsidian last loaded), so its old text cannot overwrite the external
 * edit meanwhile.
 */

import { pathKey as defaultPathKey } from "../../core/paths/pathKey";
import { utf8Decode } from "../../core/hash/utf8";
import { DEFAULT_MERGE_LIMITS, merge } from "../../core/merge/merge";
import { applyEditsTo, minimalDiff } from "../../core/merge/minimalDiff";
import { conflictCopyNotice, conflictName } from "../../core/plan/conflictName";
import type { DocId, PathKey, VaultPath } from "../../core/types";
import { LANE, type EngineToMain } from "../../protocol/messages";
import type { ClockPort } from "../../ports/clock";
import type { VaultEvent, VaultStat } from "../../ports/vault";
import { MAX_TEXT_FILE_BYTES } from "../reconcile/localState";
import type { BoundDoc, BoundDocs } from "./boundDocs";
import type { VaultRuntime } from "./vaultRuntime";

/** checkSaved debounce after a vault event on a bound file, and the retry after a read error. */
export const BOUND_SAVED_DEBOUNCE_MS = 50;
export const CHECK_SAVED_RETRY_MS = 1_000;
export const CONFLICT_COPY_RETRY_MS: readonly number[] = [250, 1_000, 2_000, 5_000, 10_000, 30_000];
const CONFLICT_COPY_NAME_TRIES = 12;

export interface BoundDiskDeps {
	readonly bound: BoundDocs;
	post(message: EngineToMain): void;
	runtime(): VaultRuntime | null;
	clock(): ClockPort | null;
	disposed(): boolean;
}

export class BoundDisk {
	private readonly pending = new Set<{ readonly path: string; readonly text: string }>();
	readonly stats = { reloads: 0, reloadMerges: 0, boundSaved: 0, conflictCopies: 0 };

	constructor(private readonly deps: BoundDiskDeps) {}

	/** Conflict copies that hit a disk error and live only in memory until a retry lands (sim: lost at a crash). */
	pendingConflictCopies(): { readonly path: string; readonly text: string }[] {
		return [...this.pending];
	}

	/** Vault events (any source): a modify / create / rename onto a bound file schedules its save check. */
	onVaultEvents(events: readonly VaultEvent[]): void {
		if (this.deps.bound.size === 0) return;
		const keys = new Set<PathKey>();
		for (const e of events) {
			if (e.t === "modify" || e.t === "create") keys.add(defaultPathKey(e.path));
			else if (e.t === "rename") keys.add(defaultPathKey(e.to));
		}
		for (const b of this.deps.bound.byId.values()) if (keys.has(defaultPathKey(b.path))) this.scheduleCheck(b, BOUND_SAVED_DEBOUNCE_MS);
	}

	/** bodyReload: merge the file's text into the replica, then answer `reloaded` (in order after its entry). */
	async reload(docId: DocId, viewId: number, reload: number): Promise<void> {
		const rt = this.deps.runtime();
		const b = this.deps.bound.get(docId);
		if (!rt || !b || !b.attached.has(viewId)) return;
		this.stats.reloads++;
		const rd = await rt.rec.ctx.read(b.path, MAX_TEXT_FILE_BYTES, LANE.openNote).catch(() => null);
		if (this.deps.runtime() !== rt || this.deps.bound.get(docId) !== b || !b.attached.has(viewId)) return;
		let save = false;
		if (rd?.ok && !rt.log.boundFrozen(docId)) {
			const disk = utf8Decode(rd.bytes);
			const crdt = rt.log.boundText(docId);
			// Disk text the replica already holds (its last disk text, or a save of one of its views): not external.
			const base = disk === b.diskText || b.candidates.includes(disk) ? disk : b.diskText;
			const r = merge({ base, disk, crdt, limits: DEFAULT_MERGE_LIMITS });
			const target = r.kind === "identical" ? crdt : r.text;
			if (target !== crdt) {
				this.stats.reloadMerges++;
				void rt.log.editBound(docId, (y) => applyEditsTo(y, crdt, minimalDiff(crdt, target))).catch(() => undefined);
			}
			b.diskText = disk; // absorbed: merged into the replica, or kept by the conflict copy below
			save = target !== disk;
			if (r.kind === "conflict") void this.writeConflictCopy(b.path, docId, r.conflictCopy);
		}
		this.deps.bound.queue(b, { t: "reloaded", viewId, reload, save });
	}

	scheduleCheck(b: BoundDoc, delayMs: number): void {
		const clock = this.deps.clock();
		if (!clock) return;
		if (b.check.timer !== null) clock.clearTimer(b.check.timer);
		b.check.timer = clock.setTimer(delayMs, () => {
			b.check.timer = null;
			if (this.deps.bound.get(b.docId) === b) void this.checkSaved(b);
		});
	}

	/** Serialized per doc; a request while one is queued joins it (the queued run reads the disk later). */
	checkSaved(b: BoundDoc): Promise<void> {
		if (b.check.queued) return b.check.chain;
		b.check.queued = true;
		b.check.chain = b.check.chain.then(async () => {
			b.check.queued = false;
			await this.checkSavedNow(b);
		}).catch(() => undefined);
		return b.check.chain;
	}

	/**
	 * Report a save of a bound file as boundSaved (the engine's new synced base). Disk-verified: read (stat before),
	 * stat after, unchanged in between; and only a text the replica has absorbed (its last disk text, a text a save
	 * of its views read, or its current text) is reported and becomes the reload base. Anything else on disk is an
	 * external write whose reload is still pending: reporting it here would make unmerged text the engine's base.
	 */
	private async checkSavedNow(b: BoundDoc): Promise<void> {
		const rt = this.deps.runtime();
		if (!rt || this.deps.bound.get(b.docId) !== b) return;
		const path = b.path;
		const ctx = rt.rec.ctx;
		const rd = await ctx.read(path, MAX_TEXT_FILE_BYTES, LANE.openNote).catch(() => null);
		if (!rd || (!rd.ok && rd.reason === "io")) return this.scheduleCheck(b, CHECK_SAVED_RETRY_MS);
		if (!rd.ok) return;
		// maxBytes 0: a stat (a non-empty file answers too-large with its stat).
		const after = await ctx.read(path, 0, LANE.openNote).catch(() => null);
		const stat: VaultStat | null = after?.stat ?? null;
		// Changed while reading: the write's own vault event schedules another check.
		if (!stat || stat.size !== rd.bytes.byteLength || stat.mtimeMs !== rd.stat.mtimeMs) return;
		if (this.deps.runtime() !== rt || this.deps.bound.get(b.docId) !== b || b.path !== path) return;
		const text = utf8Decode(rd.bytes);
		const absorbed = text === b.diskText || b.candidates.includes(text) || text === rt.log.boundText(b.docId);
		if (!absorbed) return;
		b.diskText = text;
		if (text === b.lastReported) return;
		b.lastReported = text;
		this.stats.boundSaved++;
		rt.boundSaved(b.docId, path, stat);
	}

	/**
	 * The copy text exists only in memory once the merge has replaced it in the replica, so an I/O failure is
	 * retried (backoff, capped) while the engine runs. Gives up on a non-transient refusal or when every
	 * candidate name is taken.
	 */
	async writeConflictCopy(path: VaultPath, docId: DocId, text: string): Promise<boolean> {
		let attempt = 0;
		const pending = { path, text };
		try {
			for (;;) {
				const rt = this.deps.runtime();
				const r = rt ? await this.tryConflictCopy(rt, path, docId, text) : "io";
				if (r === "ok") return true;
				if (r === "give-up") break;
				if (attempt === 0) {
					this.pending.add(pending);
					this.notice("warn", "conflict-copy-retrying", `Could not write a conflict copy for ${path} (disk error); retrying.`);
				}
				const delay = CONFLICT_COPY_RETRY_MS[Math.min(attempt, CONFLICT_COPY_RETRY_MS.length - 1)] ?? 30_000;
				attempt++;
				const clock = this.deps.clock();
				if (!clock) break;
				await new Promise<void>((resolve) => clock.setTimer(delay, resolve));
				if (this.deps.disposed()) break;
			}
		} finally {
			this.pending.delete(pending);
		}
		this.notice("error", "conflict-copy-failed", `Could not write a conflict copy for ${path}; the other version is kept in the editor history only.`);
		return false;
	}

	/** Names come from core conflictName (DESIGN §f.7); a name another writer took meanwhile is skipped. */
	private async tryConflictCopy(rt: VaultRuntime, path: VaultPath, docId: DocId, text: string): Promise<"ok" | "io" | "give-up"> {
		const ctx = rt.rec.ctx;
		const view = ctx.log.view();
		const nowMs = ctx.now();
		const taken = new Set<PathKey>();
		for (let n = 1; n <= CONFLICT_COPY_NAME_TRIES; n++) {
			const target = conflictName({
				path, docId, deviceLabel: ctx.deps.deviceLabel, nowMs, tzOffsetMinutes: ctx.deps.tzOffsetMinutes?.() ?? 0,
				pathKey: ctx.pk, isTaken: (k) => taken.has(k) || ctx.local.has(k) || view.remoteByPathKey.has(k),
			});
			const res = await ctx.exec({ t: "write", area: "vault", path: target, data: { t: "text", text }, precondition: { t: "absent" }, docId: null, purpose: "conflict-copy" }, LANE.openNote).catch(() => null);
			if (!res || res.t !== "write") return "io";
			const out = res.outcome;
			if (out.ok) {
				this.stats.conflictCopies++;
				this.notice("warn", "conflict-copy", conflictCopyNotice({ from: path, to: target }, 1));
				return "ok";
			}
			if (out.reason === "io") return "io";
			if (out.reason !== "precondition") return "give-up"; // invalid path / parent is a file: not transient
			taken.add(ctx.pk(target));
		}
		return "give-up";
	}

	private notice(level: "info" | "warn" | "error", code: string, message: string): void {
		this.deps.post({ t: "notice", level, code, message });
	}
}
