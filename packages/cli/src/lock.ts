/**
 * One daemon per vault, enforced on the state directory.
 *
 * The invariant being protected is not "two processes must not write the same
 * file" — the CRDT would survive that — it is that two daemons sharing one
 * local cache would each persist a doc the other has not seen, and whichever
 * shut down last would silently win. The lock lives beside the cache it
 * protects, not in the vault, because the cache is the shared resource.
 */

import { promises as fs } from "node:fs";
import nodePath from "node:path";
import os from "node:os";

interface LockRecord {
	readonly pid: number;
	readonly hostname: string;
	/**
	 * Epoch ms at which the holding process started, used to tell a live
	 * holder apart from an unrelated process that inherited a recycled pid.
	 */
	readonly startedAt: number;
	readonly acquiredAt: string;
}

export interface LockHandle {
	readonly path: string;
	/** Remove the lock, but only while it is still ours. */
	release(): Promise<void>;
}

/** The state directory is held by a process we believe is still alive. */
export class LockHeldError extends Error {
	constructor(
		readonly lockPath: string,
		readonly holder: { pid: number; hostname: string } | null,
	) {
		const who = holder
			? `pid ${holder.pid} on ${holder.hostname}`
			: "an unreadable lock record";
		super(
			`State directory is locked by ${who}: ${lockPath}. ` +
			`Only one YAOS daemon may use a state directory at a time.`,
		);
		this.name = "LockHeldError";
	}
}

/**
 * Linux `USER_HZ`. `sysconf(_SC_CLK_TCK)` is 100 on every mainstream Linux
 * build and is not exposed to Node; a wrong value here only widens the window
 * in which a recycled pid is mistaken for the original, and the tolerance
 * below already dominates that error.
 */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Slack between the kernel's process-start tick and the `performance.timeOrigin`
 * a Node process records for itself. The kernel clocks the exec; Node clocks
 * its own bootstrap some tens of milliseconds later.
 */
const START_TIME_TOLERANCE_MS = 2_000;

/**
 * Epoch ms at which `pid` started, or null when this platform cannot say.
 *
 * Linux only, via procfs. Everywhere else the answer is "unknown", and the
 * caller must then treat any live pid as a live holder — refusing to start is
 * recoverable, stomping a running daemon's cache is not.
 */
async function processStartTime(pid: number): Promise<number | null> {
	if (process.platform !== "linux") return null;
	try {
		const [statRaw, bootRaw] = await Promise.all([
			fs.readFile(`/proc/${pid}/stat`, "utf8"),
			fs.readFile("/proc/stat", "utf8"),
		]);
		// The comm field is parenthesised and may itself contain spaces and
		// parentheses, so fields are counted from the LAST ")".
		const commEnd = statRaw.lastIndexOf(")");
		if (commEnd < 0) return null;
		// After comm, field 3 (state) is index 0. starttime is field 22.
		const fields = statRaw.slice(commEnd + 2).trim().split(/\s+/);
		const startTicks = Number(fields[19]);
		const btime = Number(/^btime\s+(\d+)$/m.exec(bootRaw)?.[1]);
		if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
		return Math.round((btime + startTicks / CLOCK_TICKS_PER_SECOND) * 1000);
	} catch {
		return null;
	}
}

/** Does a process with this pid exist right now? */
function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists and belongs to somebody else — that is alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseRecord(raw: string): LockRecord | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) return null;
		const record = value as Partial<LockRecord>;
		if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return null;
		if (typeof record.hostname !== "string") return null;
		if (typeof record.startedAt !== "number") return null;
		if (typeof record.acquiredAt !== "string") return null;
		return record as LockRecord;
	} catch {
		return null;
	}
}

/**
 * Is an existing lock record dead enough to reclaim?
 *
 * Four cases, in order of confidence:
 *   - unparseable       → reclaim; a truncated record cannot name a holder.
 *   - foreign hostname  → refuse; we cannot inspect processes on that machine.
 *   - pid absent        → reclaim; the holder is gone.
 *   - pid present       → reclaim only if the OS proves the process started at
 *                         a different time than the record claims. Unknown
 *                         start time means refuse.
 */
async function isStale(record: LockRecord | null): Promise<boolean> {
	if (!record) return true;
	if (record.hostname !== os.hostname()) return false;
	if (!pidExists(record.pid)) return true;
	const actualStart = await processStartTime(record.pid);
	if (actualStart === null) return false;
	return Math.abs(actualStart - record.startedAt) > START_TIME_TOLERANCE_MS;
}

async function writeLockExclusive(lockPath: string, record: LockRecord): Promise<void> {
	const handle = await fs.open(lockPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
		await handle.datasync();
	} finally {
		await handle.close();
	}
	// Durability of the lock's EXISTENCE, not its bytes: a crash that loses the
	// directory entry would silently un-lock a running daemon.
	const dir = await fs.open(nodePath.dirname(lockPath), "r");
	try {
		await dir.sync();
	} catch {
		// Directory fsync is unsupported on some filesystems; the lock still
		// works for every non-power-loss case, which is the one that matters.
	} finally {
		await dir.close();
	}
}

/**
 * Take the state-directory lock, reclaiming it from a dead holder.
 *
 * Throws `LockHeldError` when a live daemon owns it. Two daemons racing to
 * reclaim the same stale lock can both unlink and both create; the read-back
 * after creation is the tiebreak, and the loser sees `LockHeldError` rather
 * than a lock it does not own.
 */
export async function acquireProcessLock(lockPath: string): Promise<LockHandle> {
	const record: LockRecord = {
		pid: process.pid,
		hostname: os.hostname(),
		startedAt: Math.round(performance.timeOrigin),
		acquiredAt: new Date().toISOString(),
	};
	const serialized = JSON.stringify(record);

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await writeLockExclusive(lockPath, record);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const existing = parseRecord(await fs.readFile(lockPath, "utf8").catch(() => ""));
			if (!await isStale(existing)) {
				throw new LockHeldError(lockPath, existing);
			}
			await fs.rm(lockPath, { force: true });
			continue;
		}

		// Confirm the bytes on disk are the ones we wrote. If another daemon
		// reclaimed the same stale lock a moment later, they are not.
		const readBack = parseRecord(await fs.readFile(lockPath, "utf8").catch(() => ""));
		if (!readBack || readBack.pid !== record.pid || readBack.startedAt !== record.startedAt) {
			throw new LockHeldError(lockPath, readBack);
		}

		let released = false;
		return {
			path: lockPath,
			release: async () => {
				if (released) return;
				released = true;
				const current = await fs.readFile(lockPath, "utf8").catch(() => "");
				const parsed = parseRecord(current);
				if (parsed && parsed.pid === record.pid && parsed.startedAt === record.startedAt) {
					await fs.rm(lockPath, { force: true });
				}
			},
		};
	}

	throw new LockHeldError(
		lockPath,
		parseRecord(await fs.readFile(lockPath, "utf8").catch(() => serialized)),
	);
}
