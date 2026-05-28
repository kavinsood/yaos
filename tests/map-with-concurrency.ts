/**
 * Unit tests for mapWithConcurrency.
 *
 * Covers: empty input, concurrency limit, order preservation, rejection behavior.
 */

import { mapWithConcurrency } from "../src/shared/concurrency";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function assertDeepEqual(actual: unknown, expected: unknown, msg: string) {
	assert(JSON.stringify(actual) === JSON.stringify(expected), msg);
}

console.log("\n--- Test 1: empty input returns empty array ---");
{
	const result = await mapWithConcurrency([], 5, async (x) => x);
	assertDeepEqual(result, [], "empty input => empty output");
}

console.log("\n--- Test 2: maps all items ---");
{
	const result = await mapWithConcurrency([1, 2, 3], 2, async (x) => x * 10);
	assertDeepEqual(result, [10, 20, 30], "maps items correctly");
}

console.log("\n--- Test 3: order is preserved regardless of worker timing ---");
{
	// Items with descending delays — slower items first.
	const delays = [30, 20, 10, 5, 1];
	const result = await mapWithConcurrency(delays, 2, async (ms, idx) => {
		await new Promise((r) => setTimeout(r, ms));
		return idx;
	});
	assertDeepEqual(result, [0, 1, 2, 3, 4], "order preserved with varying delays");
}

console.log("\n--- Test 4: concurrency limit is respected ---");
{
	let concurrent = 0;
	let maxConcurrent = 0;
	const limit = 3;
	const items = Array.from({ length: 10 }, (_, i) => i);

	await mapWithConcurrency(items, limit, async (x) => {
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await new Promise((r) => setTimeout(r, 5));
		concurrent--;
		return x;
	});

	assert(maxConcurrent <= limit, `max concurrent ${maxConcurrent} <= limit ${limit}`);
	assert(maxConcurrent >= 1, `max concurrent ${maxConcurrent} >= 1 (actually ran)`);
}

console.log("\n--- Test 5: limit clamped to items.length ---");
{
	let maxConcurrent = 0;
	let concurrent = 0;
	const items = [1, 2];

	await mapWithConcurrency(items, 100, async (x) => {
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await new Promise((r) => setTimeout(r, 5));
		concurrent--;
		return x;
	});

	assert(maxConcurrent <= 2, `limit clamped: max concurrent ${maxConcurrent} <= items.length 2`);
}

console.log("\n--- Test 6: limit 0 or negative treated as 1 ---");
{
	const result = await mapWithConcurrency([1, 2, 3], 0, async (x) => x * 2);
	assertDeepEqual(result, [2, 4, 6], "limit=0 still processes all items");

	const result2 = await mapWithConcurrency([1, 2, 3], -5, async (x) => x + 1);
	assertDeepEqual(result2, [2, 3, 4], "limit=-5 still processes all items");
}

console.log("\n--- Test 7: worker rejection propagates ---");
{
	let caught = false;
	try {
		await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => {
			if (x === 3) throw new Error("boom");
			return x;
		});
	} catch (e: unknown) {
		caught = true;
		assert(e instanceof Error && e.message === "boom", "error message preserved");
	}
	assert(caught, "worker rejection propagates to caller");
}

console.log("\n--- Test 8: worker rejection stops processing remaining items ---");
{
	const processed: number[] = [];
	try {
		await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1, async (x) => {
			if (x === 3) throw new Error("stop");
			processed.push(x);
			return x;
		});
	} catch {
		// expected
	}
	// With concurrency=1, items after 3 should not be processed.
	assert(!processed.includes(4), "items after rejection not processed (sequential)");
}

console.log("\n--- Test 9: index argument is correct ---");
{
	const indices: number[] = [];
	await mapWithConcurrency(["a", "b", "c"], 2, async (_, idx) => {
		indices.push(idx);
		return idx;
	});
	assertDeepEqual(indices.sort(), [0, 1, 2], "indices are 0, 1, 2");
}

console.log("\n--- Test 10: undefined values are processed, not skipped ---");
{
	const result = await mapWithConcurrency(
		[undefined, 1, undefined, 2] as (number | undefined)[],
		2,
		async (value) => value === undefined ? "undef" : `val:${value}`,
	);
	assertDeepEqual(result, ["undef", "val:1", "undef", "val:2"], "undefined items processed correctly");
}

console.log("\n--- Test 11: null and falsy values are processed ---");
{
	const result = await mapWithConcurrency([null, 0, "", false] as (null | number | string | boolean)[], 2, async (value) => {
		return String(value);
	});
	assertDeepEqual(result, ["null", "0", "", "false"], "falsy values processed correctly");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
