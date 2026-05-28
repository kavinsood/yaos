/**
 * Bounded-concurrency parallel map.
 *
 * This is the single canonical implementation. If a copy exists elsewhere
 * (e.g. server/src/concurrency.ts), it must be kept byte-identical to this
 * function body or replaced with a re-export when build boundaries allow.
 */
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
