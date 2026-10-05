/**
 * DiskGateway over FakeVault: what WP-D's diskExecutor does on the main
 * thread, minus the protocol. Executes ops in order; a failed precondition does
 * not stop later ops. Renames are plain vault renames; deletes are trash only.
 *
 * Crash injection: `crashAt(n)` throws CrashError just before the n-th
 * mutating op (1-based, counted across batches) is executed, or — with
 * `after: true` — right after it (the effect happened, the result is lost).
 */

import type { DiskOp, DiskOpResult, DiskReadRequest, DiskReadResult, Lane } from "../../../protocol/messages";
import type { TrashMode } from "../../../ports/vault";
import type { DiskGateway } from "../deps";
import type { FakeVault } from "./fakeVault";

export class CrashError extends Error {
	constructor(where: string) {
		super(`simulated crash ${where}`);
		this.name = "CrashError";
	}
}

export class FakeGateway implements DiskGateway {
	/** Every executed op in order (for assertions). */
	readonly executed: DiskOp[] = [];
	readonly reads: DiskReadRequest[] = [];
	/** Mutating ops started so far. */
	mutations = 0;
	private crash: { at: number; after: boolean } | null = null;
	/** Hook run before each read batch is answered (inject concurrent edits). */
	beforeRead: ((reads: readonly DiskReadRequest[]) => void | Promise<void>) | null = null;
	/** Hook run before each op executes. */
	beforeOp: ((op: DiskOp) => void | Promise<void>) | null = null;

	constructor(readonly vault: FakeVault) {}

	crashAt(n: number, after = false): void {
		this.crash = { at: n, after };
	}

	clearCrash(): void {
		this.crash = null;
	}

	async read(reads: readonly DiskReadRequest[], _lane: Lane): Promise<readonly DiskReadResult[]> {
		if (this.beforeRead) await this.beforeRead(reads);
		const out: DiskReadResult[] = [];
		for (const r of reads) {
			this.reads.push(r);
			if (r.area !== "vault") {
				out.push({ path: r.path, ok: false, reason: "io", stat: null });
				continue;
			}
			const st = await this.vault.stat(r.path);
			if (!st) {
				out.push({ path: r.path, ok: false, reason: "missing", stat: null });
				continue;
			}
			if (st.size > r.maxBytes) {
				out.push({ path: r.path, ok: false, reason: "too-large", stat: st });
				continue;
			}
			out.push({ path: r.path, ok: true, stat: st, bytes: await this.vault.readBytes(r.path) });
		}
		return out;
	}

	async exec(ops: readonly DiskOp[], _lane: Lane): Promise<readonly DiskOpResult[]> {
		const out: DiskOpResult[] = [];
		for (const op of ops) {
			if (this.beforeOp) await this.beforeOp(op);
			this.mutations++;
			const n = this.mutations;
			if (this.crash && !this.crash.after && this.crash.at === n) {
				this.crash = null;
				throw new CrashError(`before disk op ${n} (${op.t})`);
			}
			this.executed.push(op);
			out.push(await this.one(op));
			if (this.crash && this.crash.after && this.crash.at === n) {
				this.crash = null;
				throw new CrashError(`after disk op ${n} (${op.t})`);
			}
		}
		return out;
	}

	private async one(op: DiskOp): Promise<DiskOpResult> {
		switch (op.t) {
			case "write": {
				if (op.area !== "vault") return { opId: op.opId, t: "write", outcome: { ok: false, reason: "io", current: null, message: "config area not supported" } };
				const data = op.data.t === "text" ? op.data.text : op.data.bytes;
				return { opId: op.opId, t: "write", outcome: await this.vault.write(op.path, data, op.precondition) };
			}
			case "rename":
				// Plain vault rename: links are never rewritten (DESIGN §f.2, invariant).
				return { opId: op.opId, t: "rename", outcome: await this.vault.rename(op.from, op.to, op.precondition) };
			case "trash": {
				const mode: TrashMode = op.mode;
				return { opId: op.opId, t: "trash", outcome: await this.vault.trash(op.path, mode, op.precondition) };
			}
			case "removeEmptyFolder":
				await this.vault.removeEmptyFolder(op.path);
				return { opId: op.opId, t: "removeEmptyFolder", ok: true };
		}
	}
}
