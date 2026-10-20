/**
 * Registers the units of a `*.sim.test.ts` file (the slow sweeps and measured runs `npm run test:sim` runs and
 * `npm run test:client` skips). scripts/sim-test.mjs runs each unit in its own process, costliest first:
 * - YAOS_SIM_LIST=1: prints every unit (index, name, cost in rough seconds) and registers nothing;
 * - YAOS_SIM_UNIT=<i>: registers unit i only.
 * Without either (`node --test <file>`), every unit is registered.
 */
import { test } from "node:test";

export const SIM_UNIT_PREFIX = "sim-unit ";

let units = 0;

export function simTest(name: string, cost: number, fn: () => Promise<void>): void {
	const i = units++;
	if (process.env.YAOS_SIM_LIST === "1") {
		process.stdout.write(`${SIM_UNIT_PREFIX}${JSON.stringify({ i, name, cost })}\n`);
		return;
	}
	const only = process.env.YAOS_SIM_UNIT;
	if (only !== undefined && Number(only) !== i) return;
	test(name, fn);
}
