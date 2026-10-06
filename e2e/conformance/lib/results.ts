/** Test definitions, per-test recorder (PASS / FAIL / SKIP + INFO lines), secret-free result file, summary table. */
import type { Ctx } from "./context.ts";

export type Status = "PASS" | "FAIL" | "SKIP";
export type Group = "baseline" | "decision";

export interface TestDef {
	id: string;
	group: Group;
	area: string;
	/** What the black-box run against today's server is expected to show (from reading the code). */
	expectedBefore: Status;
	slow?: boolean;
	timeoutMs?: number;
	run: (ctx: Ctx, t: Recorder) => Promise<void>;
}

export interface Check { name: string; ok: boolean; detail?: unknown }
export interface Info { reason: string; observed?: unknown }

export interface TestResult {
	id: string;
	group: Group;
	area: string;
	slow: boolean;
	expectedBefore: Status;
	status: Status;
	reason: string;
	observed?: unknown;
	expected?: unknown;
	checks?: Check[];
	info?: Info[];
	durationMs: number;
}

export class Recorder {
	checks: Check[] = [];
	infos: Info[] = [];
	verdict: { status: Status; reason: string; observed?: unknown; expected?: unknown } | null = null;
	observed: Record<string, unknown> = {};
	expected: unknown = undefined;

	/** Records a sub-check; the verdict defaults to PASS iff every check is ok. */
	check(name: string, ok: boolean, detail?: unknown): boolean {
		this.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
		return ok;
	}
	observe(key: string, value: unknown) { this.observed[key] = value; }
	expect(value: unknown) { this.expected = value; }
	info(reason: string, observed?: unknown) { this.infos.push({ reason, ...(observed === undefined ? {} : { observed }) }); }
	private set(status: Status, reason: string, observed?: unknown, expected?: unknown) {
		if (this.verdict) { this.info(`(late verdict ignored) ${status}: ${reason}`); return; }
		this.verdict = { status, reason, ...(observed === undefined ? {} : { observed }), ...(expected === undefined ? {} : { expected }) };
	}
	pass(reason: string, observed?: unknown, expected?: unknown) { this.set("PASS", reason, observed, expected); }
	fail(reason: string, observed?: unknown, expected?: unknown) { this.set("FAIL", reason, observed, expected); }
	skip(reason: string, observed?: unknown) { this.set("SKIP", reason, observed); }
	routeMissing(route: string, observed?: unknown) { this.fail(`route-missing: ${route} -> Worker 404`, observed); }

	finish(id: string, def: TestDef, durationMs: number): TestResult {
		let status: Status;
		let reason: string;
		if (this.verdict) ({ status, reason } = this.verdict);
		else if (this.checks.length > 0) {
			const failed = this.checks.filter((c) => !c.ok);
			status = failed.length === 0 ? "PASS" : "FAIL";
			reason = failed.length === 0 ? `${this.checks.length} checks ok` : `failed: ${failed.map((c) => c.name).join("; ")}`;
		} else { status = "FAIL"; reason = "test produced no verdict"; }
		// An explicit PASS never hides a failed sub-check.
		if (status === "PASS" && this.checks.some((c) => !c.ok)) {
			status = "FAIL";
			reason = `failed: ${this.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`;
		}
		const observed = this.verdict?.observed ?? (Object.keys(this.observed).length ? this.observed : undefined);
		const expected = this.verdict?.expected ?? this.expected;
		return { id, group: def.group, area: def.area, slow: !!def.slow, expectedBefore: def.expectedBefore, status, reason,
			...(observed !== undefined ? { observed } : {}), ...(expected !== undefined ? { expected } : {}),
			...(this.checks.length ? { checks: this.checks } : {}), ...(this.infos.length ? { info: this.infos } : {}),
			durationMs: Math.round(durationMs) };
	}
}

export function table(results: TestResult[]): string {
	const rows = [["ID", "group", "status", "exp", "ms", "reason"]];
	for (const r of results) {
		rows.push([r.id, r.group, r.status, r.expectedBefore === r.status ? "=" : `!${r.expectedBefore}`, String(r.durationMs),
			r.reason.slice(0, 110)]);
		for (const info of r.info ?? []) rows.push(["", "", "INFO", "", "", info.reason.slice(0, 110)]);
	}
	const widths = rows[0]!.map((_, i) => Math.min(i === 5 ? 110 : 40, Math.max(...rows.map((row) => row[i]!.length))));
	return rows.map((row) => row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i]!)).join("  ")).join("\n");
}
