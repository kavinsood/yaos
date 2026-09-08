import type { LabMeasurement, MemorySnapshot, YjsCensus } from "./types";

export function operatingSystemMaxRssBytes(): number {
	// Node normalizes resourceUsage().maxRSS to KiB on every supported host.
	return process.resourceUsage().maxRSS * 1024;
}

export function additionalHighWaterBytes(baseline: MemorySnapshot, maximumRssBytes: number): number {
	// maxRSS is a lifetime high-water mark. Compare it with the high-water mark
	// already reached after imports and forced GC, not with baseline current RSS.
	return Math.max(0, maximumRssBytes - baseline.maxRssBytes);
}

export function settleMemory(minimumPasses = 5, maximumPasses = 24): void {
	if (typeof global.gc !== "function") throw new Error("pathology lab children require --expose-gc");
	let previous = Number.POSITIVE_INFINITY;
	for (let pass = 0; pass < maximumPasses; pass++) {
		global.gc();
		const current = process.memoryUsage().rss;
		if (pass + 1 >= minimumPasses && current >= previous) return;
		previous = current;
	}
}

export class MemoryTracker {
	private readonly clockStarted = performance.now();
	private readonly cpuStarted = process.cpuUsage();
	private readonly snapshots: MemorySnapshot[] = [];
	readonly baseline: MemorySnapshot;

	constructor(readonly arm: string, readonly trace: string) {
		settleMemory();
		this.baseline = this.capture("process-baseline");
	}

	mark(label: string, settle = false): MemorySnapshot {
		if (settle) settleMemory();
		return this.capture(label);
	}

	finish(input: {
		textSha256?: string | null;
		textCodeUnits?: number | null;
		encodedStateBytes?: number | null;
		census?: YjsCensus | null;
		counters?: Record<string, number | string | boolean | null>;
	}): LabMeasurement {
		const settled = this.mark("settled-final", true);
		const cpu = process.cpuUsage(this.cpuStarted);
		const maximum = Math.max(this.baseline.maxRssBytes, ...this.snapshots.map((sample) => sample.maxRssBytes));
		const representative = [...this.snapshots]
			.sort((left, right) => right.rssBytes - left.rssBytes)[0] ?? this.baseline;
		const peak: MemorySnapshot = { ...representative, label: "observed-peak", maxRssBytes: maximum };
		return {
			format: "yaos-pathology-measurement-v1",
			arm: this.arm,
			trace: this.trace,
			startedAt: new Date(Date.now() - (performance.now() - this.clockStarted)).toISOString(),
			elapsedMs: performance.now() - this.clockStarted,
			cpuUserMicros: cpu.user,
			cpuSystemMicros: cpu.system,
			baseline: this.baseline,
			peak,
			settled,
			peakAdditionalRssBytes: additionalHighWaterBytes(this.baseline, maximum),
			textSha256: input.textSha256 ?? null,
			textCodeUnits: input.textCodeUnits ?? null,
			encodedStateBytes: input.encodedStateBytes ?? null,
			census: input.census ?? null,
			counters: input.counters ?? {},
			samples: [...this.snapshots],
		};
	}

	private capture(label: string): MemorySnapshot {
		const usage = process.memoryUsage();
		const snapshot: MemorySnapshot = {
			label,
			elapsedMs: performance.now() - this.clockStarted,
			rssBytes: usage.rss,
			heapUsedBytes: usage.heapUsed,
			externalBytes: usage.external,
			arrayBufferBytes: usage.arrayBuffers,
			maxRssBytes: operatingSystemMaxRssBytes(),
		};
		this.snapshots.push(snapshot);
		return snapshot;
	}
}
