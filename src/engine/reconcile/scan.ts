/**
 * Startup scan, vault-event hints and hash confirmation (DESIGN §f.4, §f.6).
 *
 * - observations: diffed against the local tree; an unchanged, non-racy stat
 *   keeps its hash, anything else becomes `hash = null`. After the last chunk
 *   entries not listed are dropped and every pending entry is read + hashed;
 *   then localComplete = true (it stays true for the session).
 * - events: hints only. An own echo is dropped; anything else marks the path
 *   dirty (hash = null) and scopes the next pass. Deletes are verified by a
 *   re-read: only a "missing" read removes the entry.
 */

import type { LocalEntry, PathKey } from "../../core/types";
import { RACY_WINDOW_MS } from "../../core/limits";
import type { VaultEvent, VaultStat } from "../../ports/vault";
import type { LocalObservation } from "../../protocol/messages";
import type { Ctx } from "./context";
import { fromRecord, hashBytes } from "./localState";

const DEFAULT_IO_BYTES = 8 * 1024 * 1024;

export class Scanner {
	/** pathKeys touched by hints since the last pass (scope of the next scoped pass). */
	readonly dirty = new Set<PathKey>();
	private seen: Set<PathKey> | null = null;

	constructor(private readonly ctx: Ctx) {}

	/** Rebuild the in-memory tree from the store (classification is recomputed). */
	load(): void {
		for (const r of this.ctx.store.localTree.values()) {
			const c = this.ctx.classify(r.diskPath, r.size);
			this.ctx.local.set(r.pathKey, fromRecord(r, c.excluded));
		}
	}

	private pendingEntry(stat: VaultStat, prev: LocalEntry | undefined): LocalEntry {
		const c = this.ctx.classify(stat.path, stat.size);
		return {
			diskPath: stat.path, path: c.path, pathKey: c.pathKey, kind: c.kind, size: stat.size, mtimeMs: stat.mtimeMs,
			hash: null, fingerprint: null, hashedAtMs: 0, excluded: c.excluded, bound: prev?.bound ?? false,
		};
	}

	async observe(chunk: readonly LocalObservation[], complete: boolean): Promise<void> {
		const seen = (this.seen ??= new Set());
		for (const { stat } of chunk) {
			const c = this.ctx.classify(stat.path, stat.size);
			seen.add(c.pathKey);
			const e = this.ctx.local.get(c.pathKey);
			const racy = e !== undefined && e.mtimeMs >= e.hashedAtMs - RACY_WINDOW_MS;
			if (e && !c.excluded && !e.excluded && e.hash !== null && !racy && e.size === stat.size && e.mtimeMs === stat.mtimeMs && e.kind === c.kind) {
				if (e.diskPath !== stat.path) this.ctx.local.set(c.pathKey, { ...e, diskPath: stat.path, path: c.path });
				continue;
			}
			this.ctx.local.set(c.pathKey, this.pendingEntry(stat, e));
		}
		if (!complete) return;
		this.seen = null;
		const gone = [...this.ctx.local.keys()].filter((k) => !seen.has(k));
		for (const k of gone) this.ctx.local.delete(k);
		await this.ctx.commit({}, [], gone);
		await this.hashPending();
		this.ctx.localComplete = true;
	}

	onEvents(events: readonly VaultEvent[]): void {
		for (const ev of events) {
			if (this.ctx.echo.match(ev)) continue;
			switch (ev.t) {
				case "create":
				case "modify":
					this.markDirty(ev.path, ev.stat);
					break;
				case "delete":
					this.markDirty(ev.path, null);
					break;
				case "rename":
					this.ctx.renames.push({ from: ev.from.normalize("NFC"), to: ev.to.normalize("NFC"), atMs: this.ctx.now() });
					this.markDirty(ev.from, null);
					this.markDirty(ev.to, ev.stat);
					break;
			}
		}
	}

	/** Mark a path as changed: stat known → pending entry; else the next read decides (missing removes it). */
	markDirty(diskPath: string, stat: VaultStat | null): void {
		const c = this.ctx.classify(diskPath, stat?.size ?? 0);
		this.dirty.add(c.pathKey);
		const e = this.ctx.local.get(c.pathKey);
		if (stat) this.ctx.local.set(c.pathKey, this.pendingEntry(stat, e));
		else if (e) this.ctx.local.set(c.pathKey, { ...e, hash: null, fingerprint: null, hashedAtMs: 0, diskPath, path: c.path, excluded: c.excluded });
		else this.ctx.local.set(c.pathKey, { diskPath, path: c.path, pathKey: c.pathKey, kind: c.kind, size: 0, mtimeMs: 0, hash: null, fingerprint: null, hashedAtMs: 0, excluded: c.excluded, bound: false });
	}

	/** Entries the last hashPending could not read (I/O error): still hash = null. */
	lastUnread = 0;

	/** Read and hash every non-excluded entry with hash = null (batched by I/O budget), then persist. */
	async hashPending(): Promise<number> {
		let unread = 0;
		const budget = this.ctx.deps.maxDiskIoBytesInFlight ?? DEFAULT_IO_BYTES;
		const pending = [...this.ctx.local.values()].filter((e) => e.hash === null).sort((a, b) => (a.pathKey < b.pathKey ? -1 : 1));
		let done = 0;
		let i = 0;
		while (i < pending.length) {
			const batch: LocalEntry[] = [];
			let bytes = 0;
			while (i < pending.length && (batch.length === 0 || bytes + pending[i]!.size <= budget)) {
				bytes += pending[i]!.size;
				batch.push(pending[i++]!);
			}
			const put: LocalEntry[] = [];
			const drop: PathKey[] = [];
			const toRead = batch.filter((e) => !e.excluded);
			for (const e of batch) if (e.excluded) put.push(e);
			const reqs = toRead.map((e) => ({ area: "vault" as const, path: e.diskPath, maxBytes: this.ctx.classify(e.diskPath, 0).maxBytes }));
			const results = reqs.length > 0 ? await this.ctx.deps.disk.read(reqs, 3) : [];
			for (let j = 0; j < toRead.length; j++) {
				const e = toRead[j]!;
				const r = results[j];
				if (!r) continue;
				if (!r.ok) {
					if (r.reason === "missing") drop.push(e.pathKey);
					else if (r.reason === "too-large") put.push({ ...e, excluded: true, size: r.stat?.size ?? e.size });
					else {
						unread++;
						this.ctx.notice("warn", "read-failed", `could not read ${e.path}`);
					}
					continue;
				}
				const c = this.ctx.classify(r.stat.path, r.stat.size);
				if (c.excluded) {
					put.push({ ...e, excluded: true, size: r.stat.size, mtimeMs: r.stat.mtimeMs });
					continue;
				}
				const h = hashBytes(c.kind, r.bytes);
				put.push({ ...e, diskPath: r.stat.path, path: c.path, kind: c.kind, size: r.stat.size, mtimeMs: r.stat.mtimeMs, hash: h.hash, fingerprint: h.fingerprint, hashedAtMs: this.ctx.now(), excluded: false });
				done++;
			}
			await this.ctx.commit({}, put.filter((e) => !drop.includes(e.pathKey)), drop);
		}
		this.lastUnread = unread;
		return done;
	}
}
