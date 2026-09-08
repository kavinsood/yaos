import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFrozenTrace, readFrozenSemanticEdits, validateFrozenTrace } from "./trace";
import { additionalHighWaterBytes } from "./metrics";
import type { MemorySnapshot, PathologyProfile } from "./types";

const profile: PathologyProfile = {
	name: "self-test",
	baseChars: 4_096,
	edits: 250,
	clients: 3,
	clientBurst: 7,
	candidateEvery: 13,
	rootOperations: 250,
	activeRootEntries: 20,
};
const root = mkdtempSync(join(tmpdir(), "yaos-pathology-self-test-"));
try {
	const baseline: MemorySnapshot = {
		label: "baseline",
		elapsedMs: 0,
		rssBytes: 80,
		heapUsedBytes: 0,
		externalBytes: 0,
		arrayBufferBytes: 0,
		maxRssBytes: 100,
	};
	if (additionalHighWaterBytes(baseline, 150) !== 50) {
		throw new Error("RSS high-water delta used current RSS instead of baseline maxRSS");
	}
	const firstDirectory = join(root, "first");
	const secondDirectory = join(root, "second");
	const first = generateFrozenTrace({ outputDirectory: firstDirectory, profile, seed: 0x5eed });
	const second = generateFrozenTrace({ outputDirectory: secondDirectory, profile, seed: 0x5eed });
	for (const key of ["base", "updates", "candidates", "semantic", "final"] as const) {
		if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) {
			throw new Error(`${key} evidence is not deterministic`);
		}
	}
	validateFrozenTrace(firstDirectory);
	const semantic = readFrozenSemanticEdits(firstDirectory);
	if (semantic.length !== profile.edits || semantic.at(-1)?.sequence !== profile.edits - 1) {
		throw new Error("frozen semantic operations were not replayable");
	}
	const updatePath = join(firstDirectory, "updates.bin");
	const corrupted = readFileSync(updatePath);
	const last = corrupted.length - 1;
	corrupted[last] = corrupted[last]! ^ 0xff;
	writeFileSync(updatePath, corrupted);
	let rejected = false;
	try {
		validateFrozenTrace(firstDirectory);
	} catch {
		rejected = true;
	}
	if (!rejected) throw new Error("corrupted frozen evidence was accepted");
	console.log("pathology lab self-test passed: deterministic traces, semantic replay, and corruption rejection");
} finally {
	rmSync(root, { recursive: true, force: true });
}
