export type Cleanup = () => void | Promise<void>;

/** One reverse-order, idempotent teardown authority for command lifetime. */
export class CleanupStack {
	private readonly entries: Cleanup[] = [];
	private disposing: Promise<void> | null = null;
	private disposed = false;

	defer(cleanup: Cleanup): void {
		if (this.disposed || this.disposing) throw new Error("Cannot register cleanup after disposal started");
		let called = false;
		this.entries.push(async () => {
			if (called) return;
			called = true;
			await cleanup();
		});
	}

	dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		if (this.disposed) return Promise.resolve();
		this.disposing = this.run();
		return this.disposing;
	}

	private async run(): Promise<void> {
		const failures: unknown[] = [];
		while (this.entries.length > 0) {
			const cleanup = this.entries.pop()!;
			try {
				await cleanup();
			} catch (error) {
				failures.push(error);
			}
		}
		this.disposed = true;
		if (failures.length > 0) throw new AggregateError(failures, "Cleanup failed");
	}
}
