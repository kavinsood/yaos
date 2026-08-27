/**
 * Trace header test.
 *
 * Tests buildTraceHeader() — the pure function that produces the first line of
 * an exported debug trace. It takes pre-gathered plain data and returns the
 * header with no Obsidian I/O (no vault writes, no Notice).
 *
 * The exported file is meant to be read by a maintainer or an LLM with no
 * access to this repository, so the header must be self-describing as well as
 * safe.
 *
 * Invariants tested:
 *   Redacted (the default — an export that says nothing gets the safe one):
 *     - serverHost / vaultId / deviceName are "(redacted)"
 *     - tokenConfigured is a bare boolean: no prefix, no length
 *     - known vault paths do not appear anywhere in the serialised header
 *     - pathDirectory is withheld
 *     - full content hashes are truncated, prefix kept for correlation
 *     - leakDetected is false when redaction works, true when a path survives
 *
 *   With filenames (redacted: false):
 *     - serverHost / vaultId / deviceName ARE present
 *     - pathDirectory maps every pathId back to its real path
 *     - leakDetected is false (passthrough redactor, no check performed)
 *
 *   Always:
 *     - the header identifies itself (recordType, format version, readme)
 *     - the pathId scheme is described well enough to merge two traces
 *     - a null state still produces a valid header
 *
 * This test is intentionally Obsidian-free. It uses a real SHA-256
 * implementation via Node's webcrypto.
 */

import { webcrypto } from "node:crypto";

/**
 * lib.dom's `Crypto` and @types/node's `webcrypto.Crypto` contradict each other
 * on `SubtleCrypto` (the same clash tsconfig.tests.json documents), so Node's
 * implementation is not assignable to the DOM-typed global. Check the whole of
 * `Crypto` — its three members — at runtime instead of asserting it.
 */
function isDomCrypto(value: unknown): value is Crypto {
	if (typeof value !== "object" || value === null) return false;
	if (!("subtle" in value) || typeof value.subtle !== "object" || value.subtle === null) return false;
	if (!("digest" in value.subtle) || typeof value.subtle.digest !== "function") return false;
	if (!("getRandomValues" in value) || typeof value.getRandomValues !== "function") return false;
	return "randomUUID" in value && typeof value.randomUUID === "function";
}

if (typeof globalThis.crypto === "undefined") {
	const nodeCrypto: unknown = webcrypto;
	if (!isDomCrypto(nodeCrypto)) throw new Error("node:crypto webcrypto lacks the Crypto surface these tests need");
	globalThis.crypto = nodeCrypto;
}

// Import from the pure module directly — no Obsidian imports, no ConfirmModal.
import {
	buildTraceHeader,
	TRACE_HEADER_FORMAT_VERSION,
	type TraceHeaderInput,
	type TraceHeaderStateInput,
	type TraceHeaderTraceFacts,
} from "../../src/telemetry/diagnostics/diagnosticsBundle";
import { suite } from "../harness.ts";

const s = suite("diagnostics-bundle");

// ── SHA-256 via Node webcrypto ─────────────────────────────────────────────────

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Fake input with known sensitive values ────────────────────────────────────

const SENSITIVE_HOST      = "https://my-secret-worker.workers.dev";
const SENSITIVE_VAULT     = "vault-id-abc123";
const SENSITIVE_DEVICE    = "kavin-macbook-pro";
const KNOWN_PATH_1        = "Projects/secret-plan.md";
const KNOWN_PATH_2        = "Inbox/private-note.md";
// Path that only appears in the server trace — NOT in diskHashes or crdtHashes.
// This exercises the regex-based redactor path for unseeded paths in free-form
// log messages (not known-path key redaction).
const SERVER_TRACE_ONLY_PATH = "Attachments/private-image.png";
const HISTORICAL_EVENT_ONLY_PATH = "Deleted Medical Notes/old-result.md";
const STRUCTURED_TRACE_ONLY_PATH = "Archive/structured-secret.md";
const CONFLICT_PATH = "Notes/important (YAOS conflict from Laptop 2026-05-11T12-00-00Z).md";
const NORMALIZED_PATH = "Notes/some-file.md";
const FULL_CONTENT_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const PATH_ID_1 = "p:1111111111111111111111111111111a";
const PATH_ID_2 = "p:2222222222222222222222222222222b";

function makeTrace(overrides: Partial<TraceHeaderTraceFacts> = {}): TraceHeaderTraceFacts {
	return {
		traceId: "trace-test-001",
		bootId: "boot-test-001",
		deviceId: "device-test-001",
		vaultIdHash: "a".repeat(64),
		serverHostHash: "b".repeat(64),
		pluginVersion: "1.6.1",
		flightEventSchemaVersion: 2,
		flightEventTaxonomyVersion: 3,
		exportedAt: "2026-05-10T00:00:05.000Z",
		eventCount: 12,
		segmentCount: 1,
		segmentsRotated: false,
		pathIdentityDegraded: false,
		droppedEventCount: 0,
		droppedEventCountByKind: {},
		pathPseudonymSaltFingerprint: "f".repeat(32),
		pathDirectory: [
			{ pathId: PATH_ID_1, path: KNOWN_PATH_1 },
			{ pathId: PATH_ID_2, path: KNOWN_PATH_2 },
		],
		...overrides,
	};
}

function makeState(overrides: Partial<TraceHeaderStateInput> = {}): TraceHeaderStateInput {
	const diskHashes = new Map<string, { hash: string; length: number }>([
		[KNOWN_PATH_1, { hash: "abc123", length: 42 }],
		[KNOWN_PATH_2, { hash: "def456", length: 100 }],
	]);
	const crdtHashes = new Map<string, { hash: string; length: number }>([
		[KNOWN_PATH_1, { hash: "abc123", length: 42 }],
	]);

	return {
		generatedAt: "2026-05-10T00:00:00.000Z",
		generationDurationMs: 123,
		platform: {
			obsidianApiVersion: "1.8.7",
			operatingSystem: "darwin",
			isMobile: false,
			isDesktopApp: true,
		},
		serverVersion: "2026.05.01",
		settings: {
			host: SENSITIVE_HOST,
			token: "secret-token",
			vaultId: SENSITIVE_VAULT,
			deviceName: SENSITIVE_DEVICE,
			debug: true,
			enableAttachmentSync: false,
			externalEditPolicy: "always",
		},
		syncState: {
			reconcileCompleted: true,
			reconcileInFlight: false,
			reconcilePending: false,
			lastReconcileStats: null,
			awaitingFirstProviderSyncAfterStartup: false,
			lastReconciledGeneration: 1,
			connectedToServer: true,
			providerSynced: true,
			localCacheReady: true,
			connectionGeneration: 1,
			fatalAuthError: false,
			fatalAuthCode: null,
			fatalAuthDetails: null,
			indexedDbError: false,
			indexedDbErrorDetails: null,
			serverReceiptStartupValidation: "validated",
			serverReceiptEchoCounters: {
				customMessageSeenCount: 0,
				svEchoSeenCount: 0,
				acceptedCount: 0,
				rejectedCount: 0,
			},
			activeCrdtPathCount: 2,
			blobPathCount: 0,
			syncableMarkdownFileCountOnDisk: 2,
			openFileCount: 1,
			documentSchemaVersionSupportedByClient: 2,
			documentSchemaVersionStoredInDocument: 2,
		},
		syncFacts: {
			headlineState: "online",
			serverReachable: true,
			authAccepted: true,
			websocketOpen: true,
			lastAuthRejectCode: null,
			lastLocalUpdateAt: null,
			lastLocalUpdateWhileConnectedAt: null,
			lastRemoteUpdateAt: null,
			pendingLocalCount: null,
			pendingBlobUploads: 0,
			// FU-8 receipt facts: connected fixture with nothing in flight.
			serverReceipt: {
				serverAppliedLocalState: true,
				lastServerReceiptEchoAt: null,
				lastKnownServerReceiptEchoAt: null,
				candidatePersistenceHealthy: true,
				candidatePersistenceFailureCount: 0,
				hasUnconfirmedCandidate: false,
				candidateCapturedAt: null,
			},
		},
		httpTraceContext: null,
		diskHashes,
		crdtHashes,
		pluginLogLines: [
			{ ts: "2026-05-10T00:00:00.000Z", msg: `synced "${KNOWN_PATH_1}"` },
			{ ts: "2026-05-10T00:00:01.000Z", msg: `failed to read "${HISTORICAL_EVENT_ONLY_PATH}"` },
		],
		syncLogLines: [],
		serverTraceEvents: [
			// Path only in the server trace — not in diskHashes/crdtHashes.
			{ event: "blob-synced", msg: `blob uploaded: "${SERVER_TRACE_ONLY_PATH}"` },
			{
				source: "reconcile",
				msg: "reconcile-safety-brake-blocked",
				details: {
					affectedPathSample: [STRUCTURED_TRACE_ONLY_PATH],
					blockedUpdatePathSample: [STRUCTURED_TRACE_ONLY_PATH],
					hash: FULL_CONTENT_HASH,
					diskHashBefore: FULL_CONTENT_HASH,
				},
			},
			{
				source: "conflict",
				msg: "conflict-artifact-needed",
				details: {
					path: KNOWN_PATH_1,
					conflictPath: CONFLICT_PATH,
					normalizedPath: NORMALIZED_PATH,
					reason: "bound-file-ambiguous-divergence",
				},
			},
		],
		openFiles: [
			{ path: KNOWN_PATH_1, status: "open" },
		],
		diskMirrorSnapshot: { observedPaths: [KNOWN_PATH_1] },
		blobSyncSnapshot: null,
		frontmatterQuarantine: [],
		sha256Hex,
		...overrides,
	};
}

function makeInput(overrides: Partial<TraceHeaderInput> = {}): TraceHeaderInput {
	return { trace: makeTrace(), state: makeState(), ...overrides };
}

// ── Test 0: server receipt startup validation is explained in prose ──────────

s.section("Test 0: server receipt startup validation detail");
{
	const { header } = await buildTraceHeader(makeInput({
		state: makeState({
			syncState: {
				...makeState().syncState,
				serverReceiptStartupValidation: "skipped_local_yjs_timeout",
			},
		}),
	}));
	const syncState = header.syncState as Record<string, unknown>;
	s.check(
		syncState.serverReceiptStartupValidationExplanation ===
			"skipped: local Yjs cache did not finish loading; persisted receipt candidate was not trusted this session",
		"header explains that skipped startup validation means the persisted candidate was not trusted",
	);
}

// ── Test 1: redaction is the default ─────────────────────────────────────────

s.section("Test 1: redaction is opt-out, not opt-in");
{
	const { header } = await buildTraceHeader(makeInput());
	const settings = header.settingsSnapshot as Record<string, unknown>;

	s.check(header.redacted === true, "an export that passes no options is redacted");
	s.check(settings.serverHost === "(redacted)", "default: serverHost is (redacted)");
	s.check(
		!JSON.stringify(header).includes(KNOWN_PATH_1),
		"default: known vault paths are absent",
	);
}

// ── Test 2: redacted — sensitive settings are withheld ───────────────────────

s.section("Test 2: redacted — settings snapshot");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });
	const settings = header.settingsSnapshot as Record<string, unknown>;

	s.check(settings.serverHost === "(redacted)", "redacted: serverHost is (redacted)");
	s.check(settings.vaultId === "(redacted)", "redacted: vaultId is (redacted)");
	s.check(settings.deviceName === "(redacted)", "redacted: deviceName is (redacted)");
	s.check(settings.tokenConfigured === true, "redacted: tokenConfigured is a bare boolean");
	s.check(
		!JSON.stringify(settings).includes("secret-token"),
		"redacted: the token value itself never appears",
	);
	s.check(settings.debugModeEnabled === true, "settings snapshot records that debug was on");
	s.check(
		settings.externalEditPolicy === "always",
		"settings snapshot keeps non-sensitive policy values verbatim",
	);
}

// ── Test 3: redacted — known vault paths do not appear ───────────────────────

s.section("Test 3: redacted — vault paths absent");
{
	const { header, leakDetected } = await buildTraceHeader(makeInput(), { redacted: true });
	const serialized = JSON.stringify(header);

	s.check(!serialized.includes(KNOWN_PATH_1), `redacted: "${KNOWN_PATH_1}" not in header`);
	s.check(!serialized.includes(KNOWN_PATH_2), `redacted: "${KNOWN_PATH_2}" not in header`);
	s.check(!leakDetected, "redacted: leakDetected is false when paths are redacted");
	s.check(header.pathDirectory === null, "redacted: pathDirectory is withheld");
}

// ── Test 4: redacted — host/vault/device not in serialized header ────────────

s.section("Test 4: redacted — server URL, vault ID, device name absent");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });
	const serialized = JSON.stringify(header);

	s.check(!serialized.includes(SENSITIVE_HOST), "redacted: server URL not in header");
	s.check(!serialized.includes(SENSITIVE_VAULT), "redacted: vault ID not in header");
	s.check(!serialized.includes(SENSITIVE_DEVICE), "redacted: device name not in header");
}

// ── Test 5: the header is self-describing ────────────────────────────────────

s.section("Test 5: header identifies itself to a reader with no repo access");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });

	s.check(header.recordType === "trace-header", "header declares recordType");
	s.check(
		header.traceHeaderFormatVersion === TRACE_HEADER_FORMAT_VERSION,
		"header declares its own format version",
	);
	s.check(
		typeof header.readme === "string" && (header.readme as string).includes("seq"),
		"readme explains the NDJSON layout and the causal seq ordering",
	);

	const versions = header.versions as Record<string, unknown>;
	s.check(versions.pluginVersion === "1.6.1", "versions carry the plugin version");
	s.check(versions.serverVersion === "2026.05.01", "versions carry the server version");
	s.check(
		versions.documentSchemaVersionSupportedByClient === 2 &&
			versions.documentSchemaVersionStoredInDocument === 2,
		"versions carry both document schema versions",
	);
	s.check(
		versions.flightEventSchemaVersion === 2 && versions.flightEventTaxonomyVersion === 3,
		"versions carry the event schema and taxonomy versions",
	);

	const platform = header.platform as Record<string, unknown>;
	s.check(platform.operatingSystem === "darwin" && platform.isMobile === false, "platform is reported");

	const contents = header.traceContents as Record<string, unknown>;
	s.check(contents.eventCount === 12, "traceContents reports how many events follow");
	s.check(contents.droppedEventCount === 0, "traceContents reports dropped events");
}

// ── Test 6: the pathId namespace is described well enough to merge traces ────

s.section("Test 6: pathId namespace is self-describing");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });

	const identity = header.traceIdentity as Record<string, unknown>;
	s.check(identity.traceId === "trace-test-001", "traceIdentity carries the traceId");
	s.check(
		identity.pathPseudonymSaltFingerprint === "f".repeat(32),
		"traceIdentity publishes the salt fingerprint so two traces can be matched",
	);

	const scheme = header.pathPseudonymization as Record<string, unknown>;
	s.check(
		typeof scheme.scheme === "string" && (scheme.scheme as string).includes("sha256"),
		"the pseudonymization scheme is spelled out",
	);
	s.check(scheme.saltScope === "vault", "the salt scope is stated as vault");
	s.check(
		scheme.stableAcrossDevicesOfSameVault === true,
		"the header states that pathIds correlate across devices of one vault",
	);
}

// ── Test 7: leak detection fires when a path survives redaction ──────────────

s.section("Test 7: leakDetected fires on a real redaction escape");
{
	// The deep walker redacts string *values*. A vault path used as an object
	// *key* slips through — which is exactly the structural escape the
	// post-redaction check exists to catch.
	const leaky = makeInput({
		state: makeState({
			blobSyncSnapshot: { [KNOWN_PATH_1]: { pendingBytes: 12 } },
		}),
	});

	const { header, leakDetected } = await buildTraceHeader(leaky, { redacted: true });
	s.check(
		JSON.stringify(header).includes(KNOWN_PATH_1),
		"precondition: a path used as an object key survives the deep walker",
	);
	s.check(leakDetected, "leakDetected is true when a known path survives into the header");

	const { leakDetected: cleanRun } = await buildTraceHeader(makeInput(), { redacted: true });
	s.check(!cleanRun, "leakDetected is false on a correctly redacted header");

	const { leakDetected: unredactedRun } = await buildTraceHeader(makeInput(), { redacted: false });
	s.check(!unredactedRun, "with filenames: no leak check is performed, so leakDetected is false");
}

// ── Test 8: with filenames — sensitive fields ARE present ────────────────────

s.section("Test 8: with filenames — settings and directory included");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: false });
	const settings = header.settingsSnapshot as Record<string, unknown>;
	const serialized = JSON.stringify(header);

	s.check(header.redacted === false, "header records that it is not redacted");
	s.check(settings.serverHost === SENSITIVE_HOST, "with filenames: serverHost is present");
	s.check(settings.vaultId === SENSITIVE_VAULT, "with filenames: vaultId is present");
	s.check(settings.deviceName === SENSITIVE_DEVICE, "with filenames: deviceName is present");
	s.check(serialized.includes(KNOWN_PATH_1), `with filenames: "${KNOWN_PATH_1}" is present`);

	const directory = header.pathDirectory as Array<{ pathId: string; path: string }>;
	s.check(Array.isArray(directory) && directory.length === 2, "with filenames: pathDirectory is included");
	s.check(
		directory.some((e) => e.pathId === PATH_ID_1 && e.path === KNOWN_PATH_1),
		"pathDirectory maps each pathId back to its real vault path",
	);
}

// ── Test 9: vault vs CRDT comparison counts ──────────────────────────────────

s.section("Test 9: vault vs CRDT comparison");
{
	// KNOWN_PATH_2 is in diskHashes but not crdtHashes → missing in CRDT.
	const { header, missingOnDiskCount, missingInCrdtCount, hashMismatchCount } =
		await buildTraceHeader(makeInput(), { redacted: true });
	const comparison = header.vaultVersusCrdtComparison as Record<string, unknown>;

	s.check(missingInCrdtCount === 1, "one path missing in CRDT (KNOWN_PATH_2)");
	s.check(missingOnDiskCount === 0, "no paths missing on disk");
	s.check(hashMismatchCount === 0, "no hash mismatches (KNOWN_PATH_1 matches)");
	s.check(comparison.comparedFileCount === 2, "comparedFileCount is 2");
	s.check(comparison.matchingFileCount === 1, "matchingFileCount is 1");

	const missing = comparison.filesMissingInCrdt as Array<Record<string, unknown>>;
	s.check(missing.length === 1, "filesMissingInCrdt has one entry");
	s.check(
		missing[0]?.pathId === PATH_ID_2 && missing[0]?.path === undefined,
		"redacted comparison entries carry the pathId only, joinable against the event lines",
	);

	const { header: fullHeader } = await buildTraceHeader(makeInput(), { redacted: false });
	const fullMissing = (fullHeader.vaultVersusCrdtComparison as Record<string, unknown>)
		.filesMissingInCrdt as Array<Record<string, unknown>>;
	s.check(
		fullMissing[0]?.path === KNOWN_PATH_2,
		"with filenames: comparison entries also carry the real path",
	);
}

// ── Test 10: unseeded paths in free-form text are redacted by regex ──────────

s.section("Test 10: redacted — unseeded paths in log text");
{
	// SERVER_TRACE_ONLY_PATH appears in the server trace as a quoted path string
	// but is NOT in diskHashes or crdtHashes. Known-path seeding will not cover
	// it; the regex redactor must catch it.
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });
	const serialized = JSON.stringify(header);

	s.check(
		!serialized.includes(SERVER_TRACE_ONLY_PATH),
		`redacted: unseeded server trace path "${SERVER_TRACE_ONLY_PATH}" not in header`,
	);
	s.check(
		!serialized.includes(HISTORICAL_EVENT_ONLY_PATH),
		`redacted: stale historical log path "${HISTORICAL_EVENT_ONLY_PATH}" not in header`,
	);
	s.check(
		!serialized.includes(STRUCTURED_TRACE_ONLY_PATH),
		`redacted: structured trace path sample "${STRUCTURED_TRACE_ONLY_PATH}" not in header`,
	);
	s.check(
		!serialized.includes(CONFLICT_PATH),
		`redacted: conflictPath "${CONFLICT_PATH}" not in header`,
	);
	s.check(
		!serialized.includes(NORMALIZED_PATH),
		`redacted: normalizedPath "${NORMALIZED_PATH}" not in header`,
	);
	s.check(
		!serialized.includes(FULL_CONTENT_HASH),
		"redacted: full content hashes are truncated",
	);
	s.check(
		serialized.includes(`${FULL_CONTENT_HASH.slice(0, 12)}…`),
		"redacted: content hash prefix remains for correlation",
	);

	const { header: fullHeader } = await buildTraceHeader(makeInput(), { redacted: false });
	const fullSerialized = JSON.stringify(fullHeader);
	s.check(
		fullSerialized.includes(SERVER_TRACE_ONLY_PATH),
		`with filenames: unseeded server trace path "${SERVER_TRACE_ONLY_PATH}" is present`,
	);
	s.check(
		fullSerialized.includes(HISTORICAL_EVENT_ONLY_PATH),
		`with filenames: stale historical log path "${HISTORICAL_EVENT_ONLY_PATH}" is present`,
	);
	s.check(
		fullSerialized.includes(STRUCTURED_TRACE_ONLY_PATH),
		`with filenames: structured trace path sample "${STRUCTURED_TRACE_ONLY_PATH}" is present`,
	);
	s.check(
		fullSerialized.includes(CONFLICT_PATH),
		`with filenames: conflictPath "${CONFLICT_PATH}" is present`,
	);
	s.check(
		fullSerialized.includes(NORMALIZED_PATH),
		`with filenames: normalizedPath "${NORMALIZED_PATH}" is present`,
	);
	s.check(
		fullSerialized.includes(FULL_CONTENT_HASH),
		"with filenames: full content hashes are present",
	);
}

// ── Test 11: a trace exported before sync initialised still has a header ─────

s.section("Test 11: null state still produces a usable header");
{
	const { header, leakDetected } = await buildTraceHeader({ trace: makeTrace(), state: null });

	s.check(header.syncStateAvailable === false, "header says outright that sync state is unavailable");
	s.check(header.settingsSnapshot === null, "settingsSnapshot is null rather than invented");
	s.check(header.syncState === null, "syncState is null rather than invented");
	s.check(header.vaultVersusCrdtComparison === null, "comparison is null rather than invented");
	s.check(header.recordType === "trace-header", "header is still self-identifying");
	s.check(header.generatedAt === "2026-05-10T00:00:05.000Z", "generatedAt falls back to exportedAt");
	s.check(!leakDetected, "no state means no known paths and no leak");
}
await s.done();
