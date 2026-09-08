export interface PathologyProfile {
	readonly name: string;
	readonly baseChars: number;
	readonly edits: number;
	readonly clients: number;
	readonly clientBurst: number;
	readonly candidateEvery: number;
	readonly rootOperations: number;
	readonly activeRootEntries: number;
}

export interface SemanticEdit {
	readonly sequence: number;
	readonly client: number;
	readonly kind: "insert" | "delete" | "replace";
	readonly position: number;
	readonly deleteCount: number;
	readonly insertText: string;
}

export interface YjsCensus {
	readonly structs: number;
	readonly deletedStructs: number;
	readonly gcStructs: number;
	readonly clientBuckets: number;
	readonly pendingStructBytes: number;
	readonly pendingDeleteSetBytes: number;
}

export interface FrozenTraceManifest {
	readonly format: "yaos-pathology-trace-v1";
	readonly generatedAt: string;
	readonly profile: PathologyProfile;
	readonly seed: number;
	readonly bodyId: string;
	readonly source: {
		readonly kind: "synthetic" | "corpus";
		readonly path: string | null;
		readonly originalUtf8Bytes: number;
	};
	readonly base: {
		readonly textCodeUnits: number;
		readonly utf8Bytes: number;
		readonly updateBytes: number;
		readonly sha256: string;
	};
	readonly updates: {
		readonly frames: number;
		readonly bytes: number;
		readonly maximumFrameBytes: number;
		readonly fileBytes: number;
		readonly sha256: string;
	};
	readonly candidates: {
		readonly frames: number;
		readonly bytes: number;
		readonly maximumFrameBytes: number;
		readonly fileBytes: number;
		readonly sha256: string;
	};
	readonly semantic: {
		readonly operations: number;
		readonly fileBytes: number;
		readonly sha256: string;
	};
	readonly final: {
		readonly textCodeUnits: number;
		readonly utf8Bytes: number;
		readonly textSha256: string;
		readonly encodedStateBytes: number;
		readonly census: YjsCensus;
	};
}

export interface MemorySnapshot {
	readonly label: string;
	readonly elapsedMs: number;
	readonly rssBytes: number;
	readonly heapUsedBytes: number;
	readonly externalBytes: number;
	readonly arrayBufferBytes: number;
	readonly maxRssBytes: number;
}

export interface LabMeasurement {
	readonly format: "yaos-pathology-measurement-v1";
	readonly arm: string;
	readonly trace: string;
	readonly startedAt: string;
	readonly elapsedMs: number;
	readonly cpuUserMicros: number;
	readonly cpuSystemMicros: number;
	readonly baseline: MemorySnapshot;
	readonly peak: MemorySnapshot;
	readonly settled: MemorySnapshot;
	readonly peakAdditionalRssBytes: number;
	readonly textSha256: string | null;
	readonly textCodeUnits: number | null;
	readonly encodedStateBytes: number | null;
	readonly census: YjsCensus | null;
	readonly counters: Record<string, number | string | boolean | null>;
	readonly samples: readonly MemorySnapshot[];
}
