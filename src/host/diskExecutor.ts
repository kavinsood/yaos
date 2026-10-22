/**
 * Main-thread disk executor (DESIGN §d.4, §g.3 diskOps/readRequest, §i.1).
 *
 * - Batches are queued per lane (LANE: openNote, background); at every op
 *   boundary the executor takes the next op of the oldest openNote batch, else
 *   of the oldest background batch. Order inside one batch is always preserved.
 * - Up to budgets.diskOpConcurrency ops run at once, each from a different batch
 *   (Obsidian's mobile file bridge serves concurrent calls 2-3x faster than
 *   serial ones, integration-notes §7.3). An op waits while it shares a docId or
 *   a path (case-folded, or a path's ancestor folder) with a running op or with
 *   the next op of an earlier batch still waiting, so ops on one path keep the
 *   order of their batches.
 * - Work runs in slices of budgets.mainSliceMs, yielding a macrotask between
 *   slices so the editor stays responsive.
 * - Every op carries a WritePrecondition, passed to VaultPort, which checks it
 *   atomically with the write (CAS). A failed precondition never writes.
 * - Dependency rule ("an op whose precondition fails does not stop independent
 *   later ops"): a later op is `skipped` when it shares a docId or any path
 *   (case-folded) with an earlier failed or skipped op of the same batch.
 * - Renames go through VaultPort.rename (Obsidian vault.rename, never
 *   fileManager.renameFile); deletes only through VaultPort.trash.
 * - Bound guard: content writes (materialize/merge/restore/snapshot-restore)
 *   never touch a path that is bound to an editor; Obsidian's own save owns
 *   that file (§d.2). They fail with reason "precondition", message "bound".
 */

import type { Budgets } from "../core/limits";
import type { ClockPort } from "../ports/clock";
import type { ConfigDirPort, RenameOutcome, VaultPort, VaultStat, WriteOutcome, WritePrecondition } from "../ports/vault";
import type { DiskOp, DiskOpResult, DiskReadRequest, DiskReadResult, Lane } from "../protocol/messages";
import type { HashOracle } from "./hashOracle";

export interface DiskExecutorDeps {
	readonly vault: VaultPort;
	readonly configDir: ConfigDirPort;
	readonly clock: ClockPort;
	/** Config-area fingerprint/hash preconditions: the engine hashes (main never does, DESIGN §d.2, §f.2). */
	readonly hashes: HashOracle;
	/** Live check: is this vault path currently bound to an editor view. */
	readonly isBoundPath: (path: string) => boolean;
	/** Post a bound path's unsent editor edits; true when there were any (trash then refuses). */
	readonly flushBoundPath?: (path: string) => boolean;
	readonly budgets: () => Pick<Budgets, "mainSliceMs" | "diskOpConcurrency">;
}

const BOUND_GUARDED = new Set(["materialize", "merge", "restore", "snapshot-restore"]);

interface Batch {
	readonly lane: Lane;
	readonly seq: number;
	readonly ops: readonly DiskOp[];
	readonly results: DiskOpResult[];
	readonly failedDocs: Set<string>;
	readonly failedPaths: Set<string>;
	next: number;
	/** An op of this batch is running. */
	busy: boolean;
	resolve(results: DiskOpResult[]): void;
}

interface Claim {
	readonly docId: string | null;
	readonly paths: readonly string[];
}

function foldKey(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

function opPaths(op: DiskOp): string[] {
	switch (op.t) {
		case "write":
			return [(op.area === "config" ? "\u0000cfg/" : "") + op.path];
		case "rename":
			return [op.from, op.to];
		case "trash":
			return [op.path];
		case "removeEmptyFolder":
			return [op.path];
	}
}

function claimOf(op: DiskOp): Claim {
	return { docId: op.t === "removeEmptyFolder" ? null : op.docId, paths: opPaths(op).map(foldKey) };
}

function nested(a: string, b: string): boolean {
	return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

function overlaps(a: Claim, b: Claim): boolean {
	if (a.docId !== null && a.docId === b.docId) return true;
	return a.paths.some((p) => b.paths.some((q) => nested(p, q)));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class DiskExecutor {
	private readonly queue: Batch[] = [];
	private readonly inflight = new Map<Promise<void>, Claim>();
	private seq = 0;
	private running = false;
	/** Wakes a drain waiting on running ops: a new batch may start in a free slot. */
	private wake: (() => void) | null = null;
	private sliceStart = 0;
	/** Ops executed (not skipped), for tests and status. */
	executed = 0;

	constructor(private readonly deps: DiskExecutorDeps) {}

	pendingOps(): number {
		let n = 0;
		for (const b of this.queue) n += b.ops.length - b.next;
		return n;
	}

	run(lane: Lane, ops: readonly DiskOp[]): Promise<DiskOpResult[]> {
		return new Promise<DiskOpResult[]>((resolve) => {
			const batch: Batch = { lane, seq: this.seq++, ops, results: [], failedDocs: new Set(), failedPaths: new Set(), next: 0, busy: false, resolve };
			if (ops.length === 0) {
				resolve([]);
				return;
			}
			this.queue.push(batch);
			if (!this.running) void this.drain();
			else this.wake?.();
		});
	}

	/** The batches whose next op may start now, in pick order (lane, then seq), at most `room` of them. */
	private startable(room: number): Batch[] {
		const order = [...this.queue].sort((a, b) => a.lane - b.lane || a.seq - b.seq);
		const held: Claim[] = [...this.inflight.values()];
		const out: Batch[] = [];
		for (const b of order) {
			if (out.length >= room) break;
			if (b.next >= b.ops.length) continue;
			const c = claimOf(b.ops[b.next] as DiskOp);
			if (!b.busy && !held.some((h) => overlaps(h, c))) out.push(b);
			held.push(c);
		}
		return out;
	}

	private start(batch: Batch): void {
		const op = batch.ops[batch.next] as DiskOp;
		batch.next++;
		batch.busy = true;
		const task: Promise<void> = this.execOne(batch, op).then((result) => {
			batch.results.push(result);
			batch.busy = false;
			if (batch.next >= batch.ops.length) {
				this.queue.splice(this.queue.indexOf(batch), 1);
				batch.resolve(batch.results);
			}
		}).finally(() => this.inflight.delete(task));
		this.inflight.set(task, claimOf(op));
	}

	private async drain(): Promise<void> {
		this.running = true;
		this.sliceStart = this.deps.clock.monotonic();
		try {
			for (;;) {
				const room = Math.max(1, this.deps.budgets().diskOpConcurrency) - this.inflight.size;
				if (room > 0) for (const b of this.startable(room)) this.start(b);
				if (this.inflight.size === 0) break;
				const woken = new Promise<void>((resolve) => (this.wake = resolve));
				await Promise.race([...this.inflight.keys(), woken]);
				this.wake = null;
				if (this.deps.clock.monotonic() - this.sliceStart >= this.deps.budgets().mainSliceMs) {
					await this.deps.clock.yieldNow();
					this.sliceStart = this.deps.clock.monotonic();
				}
			}
		} finally {
			this.running = false;
		}
	}

	private async execOne(batch: Batch, op: DiskOp): Promise<DiskOpResult> {
		const paths = opPaths(op).map(foldKey);
		const docId = op.t === "removeEmptyFolder" ? null : op.docId;
		if (op.t !== "removeEmptyFolder") {
			const dependent = (docId !== null && batch.failedDocs.has(docId)) || paths.some((p) => batch.failedPaths.has(p));
			if (dependent) {
				this.markFailed(batch, docId, paths);
				return { opId: op.opId, t: "skipped" };
			}
		}
		this.executed++;
		const result = await this.execute(op);
		const failed = (result.t === "write" || result.t === "rename" || result.t === "trash") && !result.outcome.ok;
		if (failed) this.markFailed(batch, docId, paths);
		return result;
	}

	private markFailed(batch: Batch, docId: string | null, paths: readonly string[]): void {
		if (docId !== null) batch.failedDocs.add(docId);
		for (const p of paths) batch.failedPaths.add(p);
	}

	private async execute(op: DiskOp): Promise<DiskOpResult> {
		const { vault } = this.deps;
		switch (op.t) {
			case "write": {
				if (op.area === "config") {
					// The engine sends config data as bytes (engine/compose/hostLink.ts configDir.writeBytes);
					// encoding a text payload here would be O(N) string work on main.
					if (op.data.t === "text") return { opId: op.opId, t: "write", outcome: { ok: false, reason: "io", current: null, message: "config writes take bytes" } };
					return { opId: op.opId, t: "write", outcome: await this.writeConfig(op.path, op.data.bytes, op.precondition) };
				}
				if (BOUND_GUARDED.has(op.purpose) && this.deps.isBoundPath(op.path)) {
					return { opId: op.opId, t: "write", outcome: { ok: false, reason: "precondition", current: await this.safeStat(op.path), message: "bound" } };
				}
				let outcome: WriteOutcome;
				try {
					outcome = await vault.write(op.path, op.data.t === "text" ? op.data.text : op.data.bytes, op.precondition);
				} catch (error) {
					outcome = { ok: false, reason: "io", current: null, message: errorMessage(error) };
				}
				return { opId: op.opId, t: "write", outcome };
			}
			case "rename": {
				let outcome: RenameOutcome;
				try {
					outcome = await vault.rename(op.from, op.to, op.precondition);
				} catch (error) {
					outcome = { ok: false, reason: "io", message: errorMessage(error) };
				}
				return { opId: op.opId, t: "rename", outcome };
			}
			case "trash": {
				// Edits typed before the delete reached this device beat it (§c.7): post them and refuse,
				// so the engine replans with the doc's pending body (restore instead of trash).
				if (this.deps.flushBoundPath?.(op.path)) {
					return { opId: op.opId, t: "trash", outcome: { ok: false, reason: "precondition", message: "bound-unsent-edits" } };
				}
				let outcome: RenameOutcome;
				try {
					outcome = await vault.trash(op.path, op.mode, op.precondition);
				} catch (error) {
					outcome = { ok: false, reason: "io", message: errorMessage(error) };
				}
				return { opId: op.opId, t: "trash", outcome };
			}
			case "removeEmptyFolder": {
				try {
					await vault.removeEmptyFolder(op.path);
					return { opId: op.opId, t: "removeEmptyFolder", ok: true };
				} catch {
					return { opId: op.opId, t: "removeEmptyFolder", ok: false };
				}
			}
		}
	}

	private async safeStat(path: string): Promise<VaultStat | null> {
		try {
			return await this.deps.vault.stat(path);
		} catch {
			return null;
		}
	}

	/**
	 * Config area: read-compare-write (ConfigDirPort.writeBytes is tmp+rename atomic). fingerprint/hash:
	 * the read bytes go (transferred) to the engine, which answers the hash. Window: a change between
	 * the read and writeBytes is not detected (ConfigDirPort exposes no stat to recheck); it was already
	 * check-then-write when main hashed, the engine round trip only widens it. The engine's only config
	 * write today uses "any" (engine/compose/hostLink.ts configDir.writeBytes).
	 */
	private async writeConfig(path: string, bytes: Uint8Array, pre: WritePrecondition): Promise<WriteOutcome> {
		const { configDir, hashes, clock } = this.deps;
		try {
			const cur = await configDir.readBytes(path);
			const curStat: VaultStat | null = cur ? { path, size: cur.byteLength, mtimeMs: clock.now(), ctimeMs: clock.now() } : null;
			let pass: boolean;
			switch (pre.t) {
				case "any":
					pass = true;
					break;
				case "absent":
					pass = cur === null;
					break;
				case "fingerprint":
				case "hash": {
					if (cur === null) {
						pass = false;
						break;
					}
					const [v] = await hashes.hash([{ path, want: pre.t === "fingerprint" ? "fingerprint" : "contentHash", bytes: cur }]);
					pass = v !== undefined && v.hash === (pre.t === "fingerprint" ? pre.fingerprint : pre.hash);
					break;
				}
			}
			if (!pass) return { ok: false, reason: "precondition", current: curStat, message: `precondition ${pre.t} failed` };
			await configDir.writeBytes(path, bytes);
			const now = clock.now();
			return { ok: true, stat: { path, size: bytes.byteLength, mtimeMs: now, ctimeMs: now } };
		} catch (error) {
			return { ok: false, reason: "io", current: null, message: errorMessage(error) };
		}
	}

	/** readRequest: never reads more than maxBytes; results in request order. */
	async read(reqs: readonly DiskReadRequest[]): Promise<DiskReadResult[]> {
		const out: DiskReadResult[] = [];
		let sliceStart = this.deps.clock.monotonic();
		for (const req of reqs) {
			out.push(req.area === "config" ? await this.readConfig(req) : await this.readVault(req));
			if (this.deps.clock.monotonic() - sliceStart >= this.deps.budgets().mainSliceMs) {
				await this.deps.clock.yieldNow();
				sliceStart = this.deps.clock.monotonic();
			}
		}
		return out;
	}

	private async readVault(req: DiskReadRequest): Promise<DiskReadResult> {
		const { vault } = this.deps;
		let stat: VaultStat | null = null;
		try {
			stat = await vault.stat(req.path);
			if (!stat) return { path: req.path, ok: false, reason: "missing", stat: null };
			if (stat.size > req.maxBytes) return { path: req.path, ok: false, reason: "too-large", stat };
			const bytes = await vault.readBytes(req.path);
			if (bytes.byteLength > req.maxBytes) return { path: req.path, ok: false, reason: "too-large", stat: { ...stat, size: bytes.byteLength } };
			const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
			return { path: req.path, ok: true, stat: { ...stat, size: owned.byteLength }, bytes: owned };
		} catch {
			const now = await this.safeStat(req.path);
			if (!now) return { path: req.path, ok: false, reason: "missing", stat: null };
			return { path: req.path, ok: false, reason: "io", stat: stat ?? now };
		}
	}

	private async readConfig(req: DiskReadRequest): Promise<DiskReadResult> {
		try {
			const bytes = await this.deps.configDir.readBytes(req.path);
			if (!bytes) return { path: req.path, ok: false, reason: "missing", stat: null };
			const now = this.deps.clock.now();
			const stat: VaultStat = { path: req.path, size: bytes.byteLength, mtimeMs: now, ctimeMs: now };
			if (bytes.byteLength > req.maxBytes) return { path: req.path, ok: false, reason: "too-large", stat };
			const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
			return { path: req.path, ok: true, stat, bytes: owned };
		} catch {
			return { path: req.path, ok: false, reason: "io", stat: null };
		}
	}
}
