/**
 * Main-thread disk executor (DESIGN §d.4, §g.3 diskOps/readRequest, §i.1).
 *
 * - Batches are queued per lane; at every op boundary the executor takes the
 *   next op of the highest-priority (lowest lane number) batch, FIFO within a
 *   lane. Order inside one batch is always preserved.
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
import type { Hasher } from "./hashing";
import { utf8 } from "./hashing";

export interface DiskExecutorDeps {
	readonly vault: VaultPort;
	readonly configDir: ConfigDirPort;
	readonly clock: ClockPort;
	readonly hasher: Hasher;
	/** Live check: is this vault path currently bound to an editor view. */
	readonly isBoundPath: (path: string) => boolean;
	readonly budgets: () => Pick<Budgets, "mainSliceMs">;
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
	resolve(results: DiskOpResult[]): void;
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class DiskExecutor {
	private readonly queue: Batch[] = [];
	private seq = 0;
	private running = false;
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
			const batch: Batch = { lane, seq: this.seq++, ops, results: [], failedDocs: new Set(), failedPaths: new Set(), next: 0, resolve };
			if (ops.length === 0) {
				resolve([]);
				return;
			}
			this.queue.push(batch);
			if (!this.running) void this.drain();
		});
	}

	private pick(): Batch | null {
		let best: Batch | null = null;
		for (const b of this.queue) {
			if (!best || b.lane < best.lane || (b.lane === best.lane && b.seq < best.seq)) best = b;
		}
		return best;
	}

	private async drain(): Promise<void> {
		this.running = true;
		this.sliceStart = this.deps.clock.monotonic();
		try {
			for (;;) {
				const batch = this.pick();
				if (!batch) break;
				const op = batch.ops[batch.next] as DiskOp;
				batch.next++;
				batch.results.push(await this.execOne(batch, op));
				if (batch.next >= batch.ops.length) {
					this.queue.splice(this.queue.indexOf(batch), 1);
					batch.resolve(batch.results);
				}
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
				if (op.area === "config") return { opId: op.opId, t: "write", outcome: await this.writeConfig(op.path, op.data.t === "text" ? utf8(op.data.text) : op.data.bytes, op.precondition) };
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

	/** Config area: read-compare-write (ConfigDirPort.writeBytes is tmp+rename atomic). */
	private async writeConfig(path: string, bytes: Uint8Array, pre: WritePrecondition): Promise<WriteOutcome> {
		const { configDir, hasher, clock } = this.deps;
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
					pass = cur !== null && (await hasher.fingerprint(cur)) === pre.fingerprint;
					break;
				case "hash":
					pass = cur !== null && (await hasher.contentHash(path, cur)) === pre.hash;
					break;
			}
			if (!pass) return { ok: false, reason: "precondition", current: curStat, message: `precondition ${pre.t} failed` };
			await configDir.writeBytes(path, bytes);
			const now = clock.now();
			return { ok: true, stat: { path, size: bytes.byteLength, mtimeMs: now, ctimeMs: now }, fingerprint: await hasher.fingerprint(bytes) };
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
