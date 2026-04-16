let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

class MarkdownIngestHarness {
	constructor() {
		this.dirtyMarkdownPaths = new Map();
		this.markdownDrainPromise = null;
		this.disk = new Map();
		this.synced = new Map();
		this.tombstonedPaths = new Set();
		this.processCount = 0;
		this.processedReasons = [];
		this.onProcessStart = null;
	}

	setDisk(path, content) {
		this.disk.set(path, content);
	}

	getSynced(path) {
		return this.synced.get(path);
	}

	tombstonePath(path) {
		this.tombstonedPaths.add(path);
	}

	async markMarkdownDirty(path, reason) {
		const previous = this.dirtyMarkdownPaths.get(path);
		if (previous !== "create") {
			this.dirtyMarkdownPaths.set(path, reason);
		}

		if (this.markdownDrainPromise) return;

		this.markdownDrainPromise = this.drainDirtyMarkdownPaths()
			.finally(() => {
				this.markdownDrainPromise = null;
				if (this.dirtyMarkdownPaths.size > 0) {
					void this.markMarkdownDrainPending();
				}
			});

		await this.markdownDrainPromise;
	}

	async markMarkdownDrainPending() {
		if (this.markdownDrainPromise) return;

		this.markdownDrainPromise = this.drainDirtyMarkdownPaths()
			.finally(() => {
				this.markdownDrainPromise = null;
				if (this.dirtyMarkdownPaths.size > 0) {
					void this.markMarkdownDrainPending();
				}
			});

		await this.markdownDrainPromise;
	}

	async drainDirtyMarkdownPaths() {
		while (this.dirtyMarkdownPaths.size > 0) {
			const batch = Array.from(this.dirtyMarkdownPaths.entries());
			this.dirtyMarkdownPaths.clear();

			for (const [path, reason] of batch) {
				await this.processDirtyMarkdownPath(path, reason);
			}
		}
	}

	async processDirtyMarkdownPath(path, reason) {
		this.processCount++;
		this.processedReasons.push(reason);
		if (this.onProcessStart) {
			await this.onProcessStart(path, reason, this.processCount);
		}
		if (this.tombstonedPaths.has(path)) {
			if (reason === "create") {
				this.tombstonedPaths.delete(path);
			} else {
				return;
			}
		}
		const content = this.disk.get(path);
		if (typeof content === "string") {
			this.synced.set(path, content);
		}
	}
}

console.log("\n--- Test: markdown dirty-set coalesces modify bursts under backpressure ---");
{
	const harness = new MarkdownIngestHarness();
	const path = "burst.md";
	harness.setDisk(path, "seed");

	let firstProcessStarted;
	const firstProcessSeen = new Promise((resolve) => {
		firstProcessStarted = resolve;
	});
	let releaseFirstProcess;
	const firstProcessGate = new Promise((resolve) => {
		releaseFirstProcess = resolve;
	});

	harness.onProcessStart = async (_path, _reason, count) => {
		if (count === 1) {
			firstProcessStarted();
			await firstProcessGate;
		}
	};

	const initialDrain = harness.markMarkdownDirty(path, "modify");
	await firstProcessSeen;

	const burstStart = Date.now();
	for (let i = 1; i <= 100; i++) {
		harness.setDisk(path, `version-${i}`);
		void harness.markMarkdownDirty(path, "modify");
	}
	const burstDurationMs = Date.now() - burstStart;

	releaseFirstProcess();
	await initialDrain;
	if (harness.markdownDrainPromise) {
		await harness.markdownDrainPromise;
	}

	console.log(`  INFO  queued 100 modify events in ${burstDurationMs}ms`);
	assert(harness.processCount === 2, `coalesced burst into 2 drain passes (got ${harness.processCount})`);
	assert(
		harness.getSynced(path) === "version-100",
		"final synced content matches the latest disk content",
	);
	assert(harness.dirtyMarkdownPaths.size === 0, "dirty map empty after drain settles");
}

console.log("\n--- Test: tombstoned paths revive on create intent (not modify) ---");
{
	const harness = new MarkdownIngestHarness();
	const path = "restore.md";

	harness.setDisk(path, "v1");
	await harness.markMarkdownDirty(path, "create");
	assert(harness.getSynced(path) === "v1", "initial create synced");

	harness.tombstonePath(path);
	harness.setDisk(path, "v2");

	await harness.markMarkdownDirty(path, "modify");
	assert(harness.getSynced(path) === "v1", "modify event keeps tombstoned path blocked");

	await harness.markMarkdownDirty(path, "create");
	assert(harness.getSynced(path) === "v2", "create event revives tombstoned path");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
