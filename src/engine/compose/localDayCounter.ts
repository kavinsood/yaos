/**
 * A count that restarts at local midnight (status `conflictCopiesToday`). The day comes from the
 * injected clock and the host's zone offset (minutes east of UTC, as for conflict names), so a
 * virtual clock drives it in tests.
 */

const DAY_MS = 86_400_000;

/** Local calendar day number of wall time `nowMs` at `tzOffsetMinutes` east of UTC. */
export function localDay(nowMs: number, tzOffsetMinutes: number): number {
	return Math.floor((nowMs + tzOffsetMinutes * 60_000) / DAY_MS);
}

export class LocalDayCounter {
	private day = Number.NaN;
	private n = 0;

	constructor(private readonly today: () => number) {}

	add(): void {
		this.roll();
		this.n++;
	}

	get value(): number {
		this.roll();
		return this.n;
	}

	private roll(): void {
		const d = this.today();
		if (d === this.day) return;
		this.day = d;
		this.n = 0;
	}
}
