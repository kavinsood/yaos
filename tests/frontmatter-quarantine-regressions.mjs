const quarantineModule = await import("../src/sync/frontmatterQuarantine.ts");
const quarantine = quarantineModule.default ?? quarantineModule;
const {
	buildFrontmatterQuarantineDebugLines,
	clearFrontmatterQuarantinePath,
	readPersistedFrontmatterQuarantine,
	upsertFrontmatterQuarantineEntry,
} = quarantine;

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

console.log("\n--- Test 1: quarantine upsert is per-path and strictly diagnostic ---");
{
	let entries = [];
	entries = upsertFrontmatterQuarantineEntry(entries, {
		path: "Bathroom floor clean.md",
		firstSeenAt: 10,
		lastSeenAt: 10,
		direction: "disk-to-crdt",
		reasons: ["duplicate-key:taskSourceType", "duplicate-key:taskSourceType"],
		prevHash: "prev-a",
		nextHash: "next-a",
		lastNoticeAt: 10,
		lastNotifiedFingerprint: "fp-a",
		count: 1,
	});
	entries = upsertFrontmatterQuarantineEntry(entries, {
		path: "Bathroom floor clean.md",
		firstSeenAt: 20,
		lastSeenAt: 20,
		direction: "crdt-to-disk",
		reasons: ["yaml-parse-error"],
		prevHash: "prev-b",
		nextHash: "next-b",
		count: 1,
	});

	assert(entries.length === 1, "same path collapses into one diagnostic entry");
	assert(entries[0]?.count === 2, "same path increments count");
	assert(entries[0]?.direction === "crdt-to-disk", "same path keeps the latest direction");
	assert(entries[0]?.reasons.length === 1 && entries[0]?.reasons[0] === "yaml-parse-error", "same path keeps normalized latest reasons");
	assert(entries[0]?.lastNoticeAt === 10, "same path preserves prior notice timestamp when no new notice is provided");
	assert(entries[0]?.lastNotifiedFingerprint === "fp-a", "same path preserves prior notice fingerprint when no new notice is provided");
}

console.log("\n--- Test 2: quarantine stays bounded and newest-first ---");
{
	let entries = [];
	for (let i = 0; i < 5; i++) {
		entries = upsertFrontmatterQuarantineEntry(entries, {
			path: `note-${i}.md`,
			firstSeenAt: i,
			lastSeenAt: i,
			direction: "disk-to-crdt",
			reasons: [`reason-${i}`],
			count: 1,
		}, 3);
	}

	assert(entries.length === 3, "quarantine entry list is capped");
	assert(entries[0]?.path === "note-4.md", "newest entry stays first");
	assert(entries[2]?.path === "note-2.md", "oldest retained entry is the cutoff");
}

console.log("\n--- Test 3: quarantine clears by path on clean convergence ---");
{
	const entries = [
		{
			path: "keep.md",
			firstSeenAt: 1,
			lastSeenAt: 2,
			direction: "disk-to-crdt",
			reasons: ["a"],
			count: 1,
		},
		{
			path: "clear.md",
			firstSeenAt: 3,
			lastSeenAt: 4,
			direction: "crdt-to-disk",
			reasons: ["b"],
			count: 2,
		},
	];
	const next = clearFrontmatterQuarantinePath(entries, "clear.md");
	assert(next.length === 1, "clear removes only the target path");
	assert(next[0]?.path === "keep.md", "clear keeps unrelated paths");
}

console.log("\n--- Test 4: persisted quarantine state is sanitized ---");
{
	const entries = readPersistedFrontmatterQuarantine([
		{
			path: "Bathroom floor clean.md",
			firstSeenAt: 10,
			lastSeenAt: 20,
			direction: "disk-to-crdt",
			reasons: ["z", "a", "z"],
			prevHash: "prev",
			nextHash: "next",
			count: 3,
		},
		{ nope: true },
	]);

	assert(entries.length === 1, "invalid persisted entries are dropped");
	assert(entries[0]?.reasons.join(",") === "a,z", "persisted reasons are normalized");
}

console.log("\n--- Test 5: debug lines summarize quarantined paths without content ---");
{
	const lines = buildFrontmatterQuarantineDebugLines([
		{
			path: "Bathroom floor clean.md",
			firstSeenAt: 10,
			lastSeenAt: 20,
			direction: "disk-to-crdt",
			reasons: ["yaml-parse-error"],
			count: 2,
		},
	]);

	assert(lines[0] === "Frontmatter quarantines: 1", "debug header includes entry count");
	assert(lines[1]?.includes("Bathroom floor clean.md"), "debug summary includes path");
	assert(lines[1]?.includes("lastNotice"), "debug summary includes notice timing metadata");
	assert(lines[1]?.includes("noticeFingerprint"), "debug summary includes notice fingerprint metadata");
	assert(!lines[1]?.includes("prevHash"), "debug summary does not expose hashes or content by default");
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
