import { resolve } from "node:path";
import { closeStore, openStore, populateStoreFromCandidates } from "./fixture";
import { readTraceManifest } from "./trace";

interface PrepareSpec {
	traceDirectory: string;
	databasePath: string;
	checkpoint: boolean;
}

const raw = process.argv[2];
if (!raw) throw new Error("pathology fixture preparation requires a JSON spec");
const parsed = JSON.parse(raw) as PrepareSpec;
const spec: PrepareSpec = {
	traceDirectory: resolve(parsed.traceDirectory),
	databasePath: resolve(parsed.databasePath),
	checkpoint: parsed.checkpoint,
};
const fixture = openStore(spec.databasePath);
try {
	const commits = populateStoreFromCandidates(spec.traceDirectory, fixture);
	let checkpointChunks = 0;
	if (spec.checkpoint) {
		const manifest = readTraceManifest(spec.traceDirectory);
		checkpointChunks = fixture.store.writeCheckpoint(manifest.bodyId).chunks;
	}
	process.stdout.write(`${JSON.stringify({ prepared: true, commits, checkpointChunks })}\n`);
} finally {
	closeStore(fixture);
}
