// Regression test for INV-SEC-02 / Phase 1.3.
//
// The default diagnostics export (safe-summary mode) must not contain
// vault filenames or path-shaped strings anywhere in the output. This test
// drives the path redactor against a fixture shaped like the real
// diagnostics bundle, then walks the output recursively to assert no
// raw path remains. The fixture exercises:
//
//   - structural path fields (path, oldPath, newPath, etc.)
//   - path-list fields (missingOnDisk, missingInCrdt)
//   - free-form strings containing embedded paths (recentEvents.msg)
//   - heterogeneous server-trace shapes
//   - paths that are NOT seeded into knownPaths (must still be caught
//     by the regex during deep walk)
//
// A separate assertion verifies that the passthrough redactor (used by
// the explicit with-filenames action) leaves the bundle unchanged.

import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
	globalThis.crypto = webcrypto;
}

const redactorModule = await import("../src/diagnostics/pathRedactor.ts");
const redactorExports = redactorModule.default ?? redactorModule;
const { createPathRedactor, createPassthroughRedactor, generateBundleSalt } = redactorExports;

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

async function sha256Hex(text) {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const KNOWN_PATHS = [
	"Inbox/note.md",
	"Projects/Alpha/plan.md",
	"Attachments/screenshot.png",
	"Daily/2026-05-09.md",
	"Canvases/board.canvas",
	"Drawings/sketch.excalidraw",
];

const UNSEEDED_PATHS = [
	// Path-shaped strings that can show up in free-form messages but are
	// not seeded via knownPaths. The deep walker must catch them via the
	// PATH_REGEX path.
	"Recently Deleted/old.md",
	"Templates/meeting (2024).md",
];

function makeFixture() {
	return {
		generatedAt: "2026-05-09T10:00:00.000Z",
		redaction: { mode: "safe-summary", schema: 1 },
		settings: {
			host: "(redacted)",
			tokenPrefix: "abcdef01...",
			vaultId: "vault-xyz",
			deviceName: "laptop",
		},
		hashDiff: {
			missingOnDisk: ["Inbox/note.md", "Projects/Alpha/plan.md"],
			missingInCrdt: ["Attachments/screenshot.png"],
			hashMismatches: [
				{
					path: "Daily/2026-05-09.md",
					diskHash: "deadbeef",
					crdtHash: "cafebabe",
					diskLength: 1024,
					crdtLength: 1052,
				},
			],
		},
		recentEvents: {
			// Paths in event messages are always wrapped in double quotes
			// by the codebase's logging convention; the redactor depends
			// on that. Tests must mirror the convention.
			plugin: [
				{ ts: "2026-05-09T09:59:01.000Z", msg: 'scheduled write for "Inbox/note.md"' },
				{ ts: "2026-05-09T09:59:05.000Z", msg: 'tombstone created "Recently Deleted/old.md"' },
				{ ts: "2026-05-09T09:59:07.000Z", msg: 'rebind for "Templates/meeting (2024).md"' },
			],
			sync: [
				{ ts: "2026-05-09T09:59:10.000Z", msg: 'remote update "Canvases/board.canvas" applied' },
			],
		},
		openFiles: [
			{ path: "Daily/2026-05-09.md", leafId: "leaf-1", binding: "bound" },
			{ filePath: "Drawings/sketch.excalidraw", leafId: "leaf-2", binding: "bound" },
		],
		diskMirror: {
			openPaths: ["Inbox/note.md", "Daily/2026-05-09.md"],
			suppressedCount: 2,
			pendingWrites: 0,
		},
		blobSync: {
			pendingUploads: 1,
			pendingDownloads: 0,
			currentUploads: [
				{ path: "Attachments/screenshot.png", bytes: 102400 },
			],
		},
		serverTrace: [
			{
				ts: "2026-05-09T09:58:00.000Z",
				event: "doc-load-completed",
				roomId: "room-xyz",
				diagnostic: 'loaded checkpoint for "Inbox/note.md"',
			},
		],
	};
}

function flattenStrings(value, out = []) {
	if (typeof value === "string") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) flattenStrings(item, out);
	} else if (value && typeof value === "object") {
		for (const v of Object.values(value)) flattenStrings(v, out);
	}
	return out;
}

console.log("\n--- Test 1: safe-summary redaction removes every seeded path ---");
{
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });
	const redacted = redactor.redactDeep(makeFixture());
	const allStrings = flattenStrings(redacted);

	for (const path of KNOWN_PATHS) {
		assert(
			!allStrings.some((s) => s.includes(path)),
			`output does not contain seeded path "${path}"`,
		);
	}
}

console.log("\n--- Test 2: redaction also catches non-seeded path-shaped strings ---");
{
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });
	const redacted = redactor.redactDeep(makeFixture());
	const allStrings = flattenStrings(redacted);

	for (const path of UNSEEDED_PATHS) {
		assert(
			!allStrings.some((s) => s.includes(path)),
			`output does not contain unseeded path "${path}"`,
		);
	}
}

console.log("\n--- Test 3: redaction is stable within one bundle (in-bundle correlation works) ---");
{
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });
	const tag1 = redactor.redactPath("Inbox/note.md");
	const tag2 = redactor.redactPath("Inbox/note.md");
	const tag3 = redactor.redactInText('scheduled write for "Inbox/note.md"').match(/path:[a-f0-9]+/)?.[0];
	assert(tag1 === tag2, "redactPath is stable for the same path");
	assert(tag1 === tag3, "redactPath and redactInText agree on the same path");
	assert(tag1.startsWith("path:"), "redacted tag has the documented prefix");
}

console.log("\n--- Test 4: redaction differs across bundles (no cross-bundle linkage) ---");
{
	const r1 = await createPathRedactor(generateBundleSalt(), sha256Hex, { knownPaths: KNOWN_PATHS });
	const r2 = await createPathRedactor(generateBundleSalt(), sha256Hex, { knownPaths: KNOWN_PATHS });
	const tag1 = r1.redactPath("Inbox/note.md");
	const tag2 = r2.redactPath("Inbox/note.md");
	assert(tag1 !== tag2, "different bundle salts produce different hashes for the same path");
}

console.log("\n--- Test 5: passthrough redactor (with-filenames mode) preserves the bundle ---");
{
	const fixture = makeFixture();
	const redactor = createPassthroughRedactor();
	const out = redactor.redactDeep(fixture);
	assert(redactor.active === false, "passthrough redactor reports active=false");
	assert(JSON.stringify(out) === JSON.stringify(fixture), "passthrough leaves bundle byte-identical");
}

console.log("\n--- Test 6: structural fields are redacted even without an extension match ---");
{
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, {
		// Seed the structural value so cache resolves it deterministically.
		knownPaths: ["No Extension Folder/file"],
	});
	const out = redactor.redactDeep({ path: "No Extension Folder/file" });
	assert(out.path.startsWith("path:"), "structural path field is redacted via known-key path");
	assert(out.path !== "No Extension Folder/file", "raw value does not survive");
}

console.log("\n--- Test 7: server-trace and free-form strings get scanned ---");
{
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });
	const out = redactor.redactDeep({
		serverTrace: [
			{ event: "x", diagnostic: '"Inbox/note.md" was loaded' },
		],
	});
	assert(
		!out.serverTrace[0].diagnostic.includes("Inbox/note.md"),
		"path embedded in server-trace free-form string is redacted",
	);
	assert(
		/path:[a-f0-9]+/.test(out.serverTrace[0].diagnostic),
		"server-trace diagnostic now contains a redacted tag",
	);
}

console.log("\n--- Test 8: salted hash is not the raw path even after JSON serialization ---");
{
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });
	const out = JSON.stringify(redactor.redactDeep(makeFixture()));

	for (const path of [...KNOWN_PATHS, ...UNSEEDED_PATHS]) {
		assert(
			!out.includes(path),
			`serialized output does not contain raw path "${path}"`,
		);
	}
	assert(!out.includes(salt), "serialized output does not contain the salt");
}

console.log("\n--- Test 9: file extensions covered include all routed YAOS file types ---");
{
	const required = ["md", "canvas", "excalidraw", "base", "png", "jpg", "pdf"];
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex);
	for (const ext of required) {
		const sample = `Folder/sample.${ext}`;
		const out = redactor.redactInText(`a path "${sample}" appears here`);
		assert(
			!out.includes(sample),
			`extension ".${ext}" is recognised as a quoted path suffix`,
		);
	}
}

console.log("\n--- Test 10: prose without quoted paths is not falsely redacted ---");
{
	// Free-form prose that mentions extensions but is not wrapped in
	// quotes must NOT be redacted. The codebase's logging convention is
	// to quote paths; relaxing the boundary causes false positives that
	// hurt log readability without improving privacy.
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex);
	const samples = [
		"scheduled write for the daily note.md item",  // unquoted
		"deferred 3 writes by 1500ms",                  // pure prose
		"loaded checkpoint after journal compaction",   // pure prose
	];
	for (const sample of samples) {
		const out = redactor.redactInText(sample);
		assert(
			!/path:[a-f0-9]+/.test(out),
			`prose without quoted path is left alone: "${sample}"`,
		);
	}
}

console.log("\n--- Test 11: known paths are replaced even when unquoted (exact-replacement pass) ---");
{
	// Pass 1 of redactInText replaces known (cached) paths wherever they
	// appear in a string, even without surrounding quotes. This closes the
	// gap where a future log line might emit a path without the convention.
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });

	// Unquoted occurrence of a seeded path must be caught by Pass 1.
	const sample = "writing Inbox/note.md to disk";
	const out = redactor.redactInText(sample);
	assert(
		!out.includes("Inbox/note.md"),
		"seeded path in unquoted position is replaced by exact-replacement pass",
	);
	assert(
		/path:[a-f0-9]+/.test(out),
		"exact-replacement inserts a redacted tag",
	);
}

console.log("\n--- Test 12: safe-mode bundle shape — no tokenPrefix, vaultId, deviceName ---");
{
	// Simulate the field shape that DiagnosticsService produces in both modes:
	//   token: { present: boolean }  — no prefix, no length, in either mode
	//   safe mode: vaultId: "(redacted)", deviceName: "(redacted)"
	// The redactor must leave these synthetic redactions intact.
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });

	const safeBundle = {
		settings: {
			host: "(redacted)",
			token: { present: true },
			vaultId: "(redacted)",
			deviceName: "(redacted)",
		},
	};
	const out = redactor.redactDeep(safeBundle);
	assert(out.settings.host === "(redacted)", "host stays redacted through redactDeep");
	assert(out.settings.vaultId === "(redacted)", "vaultId stays redacted through redactDeep");
	assert(out.settings.deviceName === "(redacted)", "deviceName stays redacted through redactDeep");
	assert(out.settings.token.present === true, "token.present is preserved");
	assert(!("length" in (out.settings.token ?? {})), "no token.length field (not needed)");
	assert(!("prefix" in (out.settings.token ?? {})), "no tokenPrefix field in bundle");

	// Document the known design boundary: the path redactor handles path-shaped
	// strings only. Identifier fields like token prefix and deviceName are NOT
	// caught by the regex and must be scrubbed by the service before calling
	// redactDeep. This is by design — the redactor is not responsible for
	// identifier-field scrubbing, and the service's safe-mode branch explicitly
	// sets these fields to "(redacted)" before building rawDiagnostics.
	const withLeaks = {
		settings: {
			token: "tok_abcdef01...",
			deviceName: "Kavin's MacBook Air",
		},
	};
	const outLeaks = redactor.redactDeep(withLeaks);
	assert(
		outLeaks.settings.token === "tok_abcdef01...",
		"non-path token string is NOT altered by path redactor (service must scrub it explicitly)",
	);
	assert(
		outLeaks.settings.deviceName === "Kavin's MacBook Air",
		"non-path deviceName is NOT altered by path redactor (service must set it to '(redacted)')",
	);
}

console.log("\n--- Test 13: post-redaction leak check catches a missed path ---");
{
	// Simulate the service-side paranoid check: after redactDeep, serialize
	// and assert no known path appears. If one slips through, export is aborted.
	const salt = generateBundleSalt();
	const redactor = await createPathRedactor(salt, sha256Hex, { knownPaths: KNOWN_PATHS });

	// A correct bundle should pass the check.
	const cleanBundle = redactor.redactDeep(makeFixture());
	const cleanJson = JSON.stringify(cleanBundle);
	const leaksAfterRedaction = KNOWN_PATHS.filter((p) => cleanJson.includes(p));
	assert(leaksAfterRedaction.length === 0, "post-redaction leak check passes for a properly redacted bundle");

	// If redaction were broken (passthrough), the check would catch it.
	const { createPassthroughRedactor: mkPassthrough } = redactorExports;
	const broken = mkPassthrough().redactDeep(makeFixture());
	const brokenJson = JSON.stringify(broken);
	const leaksInBroken = KNOWN_PATHS.filter((p) => brokenJson.includes(p));
	assert(leaksInBroken.length > 0, "post-redaction leak check catches paths that survived a broken redactor");
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
