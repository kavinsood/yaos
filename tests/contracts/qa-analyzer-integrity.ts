import { join, resolve } from "path";
import { analyzeTrace } from "../../qa/analyzers/analyzer";
import { isAnalyzerReport } from "../../qa/analyzers/report";
import { resolveTraceExportPath } from "../../qa/controllers/trace-path";
import { FlightTraceController, type FlightTraceDeps } from "../../src/telemetry/debug/flightTraceController";
import { suite } from "../harness.ts";

const s = suite("qa-analyzer-integrity");

const validEvent = JSON.stringify({
	eventSchemaVersion: 1,
	taxonomyVersion: 13,
	ts: 1,
	seq: 1,
	kind: "provider.connected",
	severity: "info",
	scope: "connection",
	source: "connectionController",
	layer: "provider",
	priority: "important",
	traceId: "trace-123",
	bootId: "boot-123",
	deviceId: "device-123",
	vaultIdHash: "vault-hash",
	serverHostHash: "server-hash",
	pluginVersion: "2.1.0",
});

const validHeader = JSON.stringify({
	recordType: "trace-header",
	traceHeaderFormatVersion: 1,
	redacted: true,
	readme: "First line of a YAOS debug trace. Every following line is one JSON event.",
	generatedAt: "2026-08-27T12:00:00.000Z",
	generationDurationMs: 12,
	exportedAt: "2026-08-27T12:00:01.000Z",
	versions: {
		pluginVersion: "1.2.3",
		serverVersion: null,
		documentSchemaVersionSupportedByClient: 3,
		documentSchemaVersionStoredInDocument: 3,
		flightEventSchemaVersion: 1,
		flightEventTaxonomyVersion: 13,
	},
	platform: {
		obsidianApiVersion: "1.8.10",
		operatingSystem: "darwin",
		isMobile: false,
		isDesktopApp: true,
	},
	traceIdentity: {
		traceId: "trace-123",
		bootId: "boot-123",
		deviceId: "device-123",
		vaultIdHash: "vault-hash",
		serverHostHash: "server-hash",
		pathPseudonymSaltFingerprint: "salt-fingerprint",
	},
	traceContents: {
		eventCount: 1,
		segmentCount: 1,
		segmentsRotated: false,
		pathIdentityDegraded: false,
		droppedEventCount: 0,
		droppedEventCountByKind: {},
	},
	pathPseudonymization: {
		scheme: "sha256(vaultScopedSalt || NUL || normalizedVaultPath), first 128 bits, prefixed p:",
		saltScope: "vault",
		stableAcrossDevicesOfSameVault: true,
		stableAcrossTraceSessions: true,
	},
	pathDirectory: null,
	syncStateAvailable: false,
	settingsSnapshot: null,
	syncFacts: null,
	syncState: null,
	vaultVersusCrdtComparison: null,
	httpTraceContext: null,
	recentLogLines: { plugin: [], sync: [] },
	openFiles: [],
	diskMirror: null,
	blobSync: null,
	serverTraceEvents: [],
	frontmatterQuarantineNotes: [],
});

s.section("Test 1: valid events and blank lines are accepted");
{
	const report = analyzeTrace(`\n${validEvent}\n\n`, { traceFile: "valid.ndjson" });
	s.check(report.passed, "valid trace passes");
	s.check(report.summary.checkedEvents === 1, "one valid event is analyzed");
	s.check(
		!report.failures.some((finding) => finding.rule === "malformed-flight-event"),
		"blank lines do not create malformed-event failures",
	);
	s.check(report.summary.warnings === 0, "inapplicable rules do not increment warnings");
	s.check(report.coverage.notApplicableRules.length > 0, "inapplicable rules are reported as coverage");
}

s.section("Test 2: an exported trace header is accepted only on line one");
{
	const report = analyzeTrace(`${validHeader}\n${validEvent}`, { traceFile: "exported.ndjson" });
	s.check(report.passed, "realistic header and valid event pass");
	s.check(report.summary.checkedEvents === 1, "the header is not counted as an event");
	s.check(
		!report.failures.some((finding) => finding.rule === "malformed-flight-event"),
		"the official first-line header is recognized",
	);

	const misplaced = analyzeTrace(`${validEvent}\n${validHeader}`, { traceFile: "misplaced-header.ndjson" });
	const malformed = misplaced.failures.find((finding) => finding.rule === "malformed-flight-event");
	s.check(!misplaced.passed, "a header after the first line fails closed");
	s.check(malformed?.description.includes("2 (invalid-event-shape)") === true, "misplaced header line is named");
}

s.section("Test 3: malformed trace headers fail closed");
{
	const malformedHeader = JSON.stringify({
		...JSON.parse(validHeader),
		...JSON.parse(validEvent),
		traceHeaderFormatVersion: "1",
	});
	const report = analyzeTrace(`${malformedHeader}\n${validEvent}`, { traceFile: "malformed-header.ndjson" });
	const malformed = report.failures.find((finding) => finding.rule === "malformed-flight-event");
	s.check(!report.passed, "a malformed first-line header fails");
	s.check(malformed?.description.includes("1 (invalid-event-shape)") === true, "malformed header line is named");
	s.check(report.summary.checkedEvents === 1, "valid events remain analyzed after a malformed header");
}

s.section("Test 4: invalid JSON fails closed");
{
	const report = analyzeTrace(`${validEvent}\n{not-json}`, { traceFile: "invalid-json.ndjson" });
	const malformed = report.failures.find((finding) => finding.rule === "malformed-flight-event");
	s.check(!report.passed, "trace with invalid JSON fails");
	s.check(!!malformed, "malformed-flight-event hard failure is reported");
	s.check(malformed?.description.includes("2 (invalid-json)") === true, "failure names the invalid line");
	s.check(report.summary.checkedEvents === 1, "valid events are still counted alongside the failure");
}

s.section("Test 5: valid JSON with an invalid event shape fails closed");
{
	const report = analyzeTrace(`${validEvent}\n${JSON.stringify({ kind: "provider.connected" })}`, {
		traceFile: "invalid-shape.ndjson",
	});
	const malformed = report.failures.find((finding) => finding.rule === "malformed-flight-event");
	s.check(!report.passed, "trace with an invalid event shape fails");
	s.check(malformed?.description.includes("2 (invalid-event-shape)") === true, "failure names the shape error");
}

s.section("Test 6: analyzer report validation rejects missing and malformed reports");
{
	const report = analyzeTrace(validEvent, { traceFile: "shape.ndjson" });
	s.check(isAnalyzerReport(report), "real analyzer report is accepted");
	s.check(!isAnalyzerReport(null), "null report is rejected");
	s.check(!isAnalyzerReport({ passed: true }), "partial report is rejected");
	s.check(!isAnalyzerReport({ ...report, passed: "yes" }), "non-boolean passed field is rejected");
}

s.section("Test 7: relative trace exports resolve once against the vault root");
{
	const vaultRoot = resolve("tmp", "qa-vault");
	const relativeTrace = join(".obsidian", "plugins", "yaos", "diagnostics", "trace.ndjson");
	const expected = join(vaultRoot, ".obsidian", "plugins", "yaos", "diagnostics", "trace.ndjson");
	s.check(
		resolveTraceExportPath(relativeTrace, vaultRoot) === expected,
		"relative export resolves to <vault>/.obsidian/... without an extra .obsidian",
	);

	let missingVaultRejected = false;
	try {
		resolveTraceExportPath(relativeTrace, null);
	} catch {
		missingVaultRejected = true;
	}
	s.check(missingVaultRejected, "relative export without a vault root is rejected");
}

s.section("Test 8: exported controller trace passes the analyzer");
{
	const files = new Map<string, string>();
	const fakeWindow = {
		setInterval: () => 1,
		clearInterval: () => {},
		setTimeout: () => 2,
		clearTimeout: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	Object.defineProperty(globalThis, "window", {
		value: fakeWindow,
		configurable: true,
		writable: true,
	});
	const adapter = {
		append: async (path: string, content: string) => {
			files.set(path, `${files.get(path) ?? ""}${content}`);
		},
		write: async (path: string, content: string) => {
			files.set(path, content);
		},
		read: async (path: string) => {
			const content = files.get(path);
			if (content === undefined) throw new Error(`missing ${path}`);
			return content;
		},
		list: async (path: string) => ({
			files: [...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)),
			folders: [],
		}),
		exists: async () => true,
		mkdir: async () => {},
		stat: async () => null,
		remove: async () => {},
		rmdir: async () => {},
	};
	const settings = {
		vaultId: "analyzer-vault",
		host: "https://sync.example.com",
		token: "secret",
		deviceName: "analyzer-device",
		debug: true,
		enableAttachmentSync: false,
		externalEditPolicy: "newest-wins",
	};
	const deps: FlightTraceDeps = {
		app: { vault: { configDir: ".obsidian", adapter } } as never,
		getSettings: () => settings as never,
		getPluginVersion: () => "2.1.0",
		getDocSchemaVersion: () => 3,
		buildCheckpoint: async () => ({}),
		collectTraceHeaderInput: async () => null,
		isIndexedDbRelatedError: () => false,
		isObsidianFileMetadataRaceError: () => false,
		handleIndexedDbDegraded: () => {},
		getLocalDeviceId: async () => "device-export-test",
		log: () => {},
	};
	const controller = new FlightTraceController(deps);
	await controller.start();
	controller.recordTrace("qa", "export-analyzer-contract");
	const exported = await controller.exportTrace({ diagDir: ".obsidian/plugins/yaos/diagnostics" });
	s.check(exported.ok, "controller exports a trace artifact");
	if (exported.ok) {
		const raw = files.get(exported.path) ?? "";
		const lines = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const report = analyzeTrace(raw, { traceFile: exported.path });
		s.check(report.passed, "actual controller export passes analyzer");
		s.check(report.summary.checkedEvents === lines.length - 1, "header is excluded from the event count");
		const event = lines[1];
		s.check(
			event?.eventSchemaVersion === 1
				&& event.taxonomyVersion === 13
				&& typeof event.traceId === "string"
				&& typeof event.bootId === "string",
			"actual exported event carries the current envelope",
		);
	}
	await controller.stop();
}

await s.done();
