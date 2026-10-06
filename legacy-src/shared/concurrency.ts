/**
 * Client-side shared module. It lived under server/src/shared/ while the legacy
 * Worker also used it; P1 moved it here with the legacy server's deletion.
 * legacy-src reaches it through the "@shared/*" alias in tests/run-typescript.mjs.
 */

/** Bounded-concurrency parallel map. Results keep input order. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];

	const normalizedLimit = Math.max(1, Math.min(limit, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T, index);
		}
	}

	await Promise.all(
		Array.from({ length: normalizedLimit }, () => runWorker()),
	);

	return results;
}
