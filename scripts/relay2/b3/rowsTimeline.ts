/**
 * b3-m-typing: background poller of the exact vault-DO row counter (`debug/sql-rows`, operator session). Each reading
 * is (wall ms, billedRowsWritten, rowsRead, setAlarms). A poll is one Worker + one DO request; its own row reads are
 * reported (`pollReadCost`, the median rowsRead delta of quiet polls) so scenario reads can be netted.
 */
import { sleep } from "../lib/common";
import type { Context } from "../lib/context";
import { RowsCounter, type RowsReading } from "../wb/adapters";

type Result = Record<string, unknown>;
export interface TimelinePoint { wall: number; w: number | null; r: number | null; alarms: number | null; reset?: boolean }

export class RowsTimeline {
	readonly points: TimelinePoint[] = [];
	readonly marks: Record<string, number> = {};
	private running = false;
	private loop: Promise<void> | null = null;
	private readonly counter: RowsCounter;
	constructor(context: Context, private readonly pollMs: number) { this.counter = new RowsCounter(context, undefined, "debug-route"); }
	private push(x: RowsReading) {
		const alarms = (x.extra as Result | undefined)?.setAlarms;
		const prev = this.points.at(-1);
		const p: TimelinePoint = { wall: x.wall, w: x.rowsWritten, r: x.rowsRead, alarms: typeof alarms === "number" ? alarms : null };
		if (prev && p.w !== null && prev.w !== null && p.w < prev.w) p.reset = true;
		this.points.push(p);
		return p;
	}
	async readNow(): Promise<TimelinePoint> { return this.push(await this.counter.read()); }
	mark(name: string) { this.marks[name] = Date.now(); }
	async start(): Promise<TimelinePoint> {
		const first = await this.readNow();
		this.running = true;
		this.loop = (async () => { while (this.running) { await sleep(this.pollMs); if (this.running) await this.readNow(); } })();
		return first;
	}
	async stop(): Promise<Result> {
		this.running = false;
		await this.loop;
		await this.readNow();
		return this.summary();
	}
	/** Reading at or just before `wall` (else the first one). */
	at(wall: number): TimelinePoint { let hit = this.points[0]!; for (const p of this.points) { if (p.wall <= wall) hit = p; else break; } return hit; }
	delta(a: TimelinePoint, b: TimelinePoint) {
		const resets = this.points.some((p) => p.reset && p.wall > a.wall && p.wall <= b.wall);
		const d = (x: number | null, y: number | null) => (x === null || y === null || resets ? null : y - x);
		return { rowsWritten: d(a.w, b.w), rowsRead: d(a.r, b.r), setAlarms: d(a.alarms, b.alarms), polls: this.points.filter((p) => p.wall > a.wall && p.wall <= b.wall).length, counterReset: resets };
	}
	/** Write steps (> 0 rows between consecutive polls) relative to `origin`. */
	steps(origin: number) {
		const out: Array<{ tMs: number; rows: number; reads: number; alarms: number }> = [];
		for (let i = 1; i < this.points.length; i++) {
			const a = this.points[i - 1]!, b = this.points[i]!;
			if (a.w === null || b.w === null || b.reset) continue;
			if (b.w - a.w > 0) out.push({ tMs: b.wall - origin, rows: b.w - a.w, reads: (b.r ?? 0) - (a.r ?? 0), alarms: (b.alarms ?? 0) - (a.alarms ?? 0) });
		}
		return out;
	}
	pollReadCost(): number | null {
		const quiet: number[] = [];
		for (let i = 1; i < this.points.length; i++) {
			const a = this.points[i - 1]!, b = this.points[i]!;
			if (a.w !== null && b.w !== null && a.r !== null && b.r !== null && !b.reset && b.w === a.w) quiet.push(b.r - a.r);
		}
		if (!quiet.length) return null;
		quiet.sort((x, y) => x - y);
		return quiet[Math.floor(quiet.length / 2)]!;
	}
	summary(): Result {
		const first = this.points[0]!, last = this.points.at(-1)!;
		const marks = Object.fromEntries(Object.entries(this.marks).map(([k, v]) => [k, new Date(v).toISOString()]));
		const seg: Result = {};
		const names = Object.keys(this.marks).sort((a, b) => this.marks[a]! - this.marks[b]!);
		const bounds = [["start", first.wall], ...names.map((n) => [n, this.marks[n]!] as const), ["end", last.wall]] as Array<readonly [string, number]>;
		for (let i = 1; i < bounds.length; i++) seg[`${bounds[i - 1]![0]}→${bounds[i]![0]}`] = this.delta(this.at(bounds[i - 1]![1]), this.at(bounds[i]![1]));
		const origin = this.marks.typingStart ?? first.wall;
		return { source: "debug/sql-rows (billedRowsWritten = SQL rows + setAlarm)", pollMs: this.pollMs, readings: this.points.length,
			total: this.delta(first, last), segments: seg, marks, pollReadCost: this.pollReadCost(), writeSteps: this.steps(origin),
			startWall: new Date(first.wall).toISOString(), endWall: new Date(last.wall).toISOString() };
	}
}
