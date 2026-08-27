/**
 * Pure trace-header builder (INV-SEC-02).
 *
 * The flight trace says what happened; this header says what world it happened
 * in. It is emitted as line 1 of the exported NDJSON file, ahead of the causally
 * ordered events, because the recipient — the maintainer, or an LLM the user
 * pastes the file into — has no other context about the vault, the versions or
 * the sync state the events were produced under.
 *
 * That consumer constraint is why every key here is spelled out rather than
 * abbreviated, and why the object carries its own format version and an explicit
 * `redacted` flag: a reader must be able to tell, from the file alone, whether
 * `pathId` values are pseudonyms or whether real filenames are present.
 *
 * This module is intentionally Obsidian-free so it can be imported and tested
 * under Node without any Obsidian mock. All callers must pre-gather data and
 * pass it in. No I/O, no Notice, no vault adapter. The function is
 * side-effect-free and deterministic given a fixed salt.
 */

import { type SyncFacts } from "../../runtime/connectionFacts";
import type { ReconciliationStats } from "../../runtime/reconciliationController";

import {
	buildFrontmatterQuarantineDebugLines,
	type FrontmatterQuarantineEntry,
} from "../../sync/frontmatterQuarantine";
import {
	createPassthroughRedactor,
	createPathRedactor,
	generateBundleSalt,
	type Sha256Hex,
} from "./pathRedactor";

export const TRACE_HEADER_FORMAT_VERSION = 1;

const HEADER_README =
	"First line of a YAOS debug trace. Every following line is one JSON event, " +
	"ordered causally by its `seq` field. When `redacted` is true, vault file " +
	"paths appear only as stable `pathId` pseudonyms and the server URL, vault id " +
	"and device name are withheld; when it is false, `pathDirectory` maps every " +
	"pathId to its real vault path.";

type LogLine = { ts: string; msg: string };

type ContentHash = { hash: string; length: number };


function describeServerReceiptStartupValidation(state: string | null): string {
	switch (state) {
		case "validated":
			return "validated";
		case "skipped_local_yjs_timeout":
			return "skipped: local Yjs cache did not finish loading; persisted receipt candidate was not trusted this session";
		case "unavailable":
			return "unavailable";
		case "not_started":
			return "not started";
		default:
			return state ?? "unknown";
	}
}

export interface TraceHeaderPlatform {
	obsidianApiVersion: string | null;
	operatingSystem: string;
	isMobile: boolean;
	isDesktopApp: boolean;
}

/**
 * Point-in-time state gathered by DiagnosticsService. Everything here is a
 * plain value; nothing in this module touches Obsidian or the vault.
 */
export interface TraceHeaderStateInput {
	generatedAt: string;
	generationDurationMs: number;
	platform: TraceHeaderPlatform;
	serverVersion: string | null;
	settings: {
		host: string;
		deviceToken: string | null | undefined;
		vaultId: string;
		deviceName: string;
		debug: boolean;
		enableAttachmentSync: boolean;
		externalEditPolicy: string;
	};
	syncState: {
		reconcileCompleted: boolean;
		reconcileInFlight: boolean;
		reconcilePending: boolean;
		lastReconcileStats: ReconciliationStats | null;
		awaitingFirstProviderSyncAfterStartup: boolean;
		lastReconciledGeneration: number;
		connectedToServer: boolean;
		providerSynced: boolean;
		localCacheReady: boolean;
		connectionGeneration: number;
		fatalAuthError: boolean;
		fatalAuthCode: string | null;
		fatalAuthDetails: unknown;
		indexedDbError: boolean;
		indexedDbErrorDetails: unknown;
		serverReceiptStartupValidation: string | null;
		serverReceiptEchoCounters: unknown;
		activeCrdtPathCount: number;
		blobPathCount: number;
		syncableMarkdownFileCountOnDisk: number;
		openFileCount: number;
		documentSchemaVersionSupportedByClient: number | null;
		documentSchemaVersionStoredInDocument: number | null | undefined;
	};
	syncFacts: SyncFacts;
	/** Raw HTTP trace context — passed through opaquely. */
	httpTraceContext: unknown;
	diskHashes: Map<string, ContentHash>;
	crdtHashes: Map<string, ContentHash>;
	pluginLogLines: LogLine[];
	syncLogLines: LogLine[];
	serverTraceEvents: unknown[];
	openFiles: Array<Record<string, unknown>>;
	diskMirrorSnapshot: unknown;
	blobSyncSnapshot: unknown;
	frontmatterQuarantine: FrontmatterQuarantineEntry[];
	sha256Hex: Sha256Hex;
}

/** Facts contributed by the flight recorder at export time. */
export interface TraceHeaderTraceFacts {
	traceId: string;
	bootId: string;
	deviceId: string;
	vaultIdHash: string;
	serverHostHash: string;
	pluginVersion: string;
	flightEventSchemaVersion: number;
	flightEventTaxonomyVersion: number;
	exportedAt: string;
	eventCount: number;
	segmentCount: number;
	segmentsRotated: boolean;
	pathIdentityDegraded: boolean;
	droppedEventCount: number;
	droppedEventCountByKind: Record<string, number>;
	pathPseudonymSaltFingerprint: string | null;
	/** pathId ↔ real path for every path the recorder resolved this session. */
	pathDirectory: Array<{ pathId: string; path: string }>;
}

export interface TraceHeaderInput {
	trace: TraceHeaderTraceFacts;
	/**
	 * Point-in-time world state. null when sync is not initialised: the trace
	 * still exports, the header just says so instead of inventing state.
	 */
	state: TraceHeaderStateInput | null;
}

export interface TraceHeaderResult {
	header: Record<string, unknown>;
	/** True if a known vault path survived redaction. Caller must abort the export. */
	leakDetected: boolean;
	missingOnDiskCount: number;
	missingInCrdtCount: number;
	hashMismatchCount: number;
}

export async function buildTraceHeader(
	input: TraceHeaderInput,
	options: { redacted?: boolean; salt?: string } = {},
): Promise<TraceHeaderResult> {
	// Redaction is opt-out, never opt-in: an export that forgets to say what it
	// wants gets the shareable one.
	const redacted = options.redacted ?? true;
	const { trace, state } = input;

	const pathIdByPath = new Map(trace.pathDirectory.map((entry) => [entry.path, entry.pathId]));
	const identify = (path: string) => ({
		pathId: pathIdByPath.get(path) ?? "p:unresolved",
		...(redacted ? {} : { path }),
	});

	const knownPaths = state ? [...state.diskHashes.keys(), ...state.crdtHashes.keys()] : [];
	const allPaths = new Set(knownPaths);
	const filesMissingOnDisk: Array<Record<string, unknown>> = [];
	const filesMissingInCrdt: Array<Record<string, unknown>> = [];
	const contentHashMismatches: Array<Record<string, unknown>> = [];
	if (state) {
		for (const path of allPaths) {
			const disk = state.diskHashes.get(path);
			const crdt = state.crdtHashes.get(path);
			if (!disk && crdt) {
				filesMissingOnDisk.push(identify(path));
				continue;
			}
			if (disk && !crdt) {
				filesMissingInCrdt.push(identify(path));
				continue;
			}
			if (disk && crdt && disk.hash !== crdt.hash) {
				contentHashMismatches.push({
					...identify(path),
					diskContentHash: redacted ? `${disk.hash.slice(0, 12)}…` : disk.hash,
					crdtContentHash: redacted ? `${crdt.hash.slice(0, 12)}…` : crdt.hash,
					diskContentLength: disk.length,
					crdtContentLength: crdt.length,
				});
			}
		}
	}

	// The redactor is the backstop for free-form text (log lines, server trace
	// payloads) where a path can appear inside a message string. The structured
	// path lists above are already pseudonymised through the recorder's own
	// pathId namespace so that they join against the event lines below.
	const redactor = redacted && state
		? await createPathRedactor(options.salt ?? generateBundleSalt(), state.sha256Hex, { knownPaths })
		: createPassthroughRedactor();

	const rawHeader: Record<string, unknown> = {
		recordType: "trace-header",
		traceHeaderFormatVersion: TRACE_HEADER_FORMAT_VERSION,
		redacted,
		readme: HEADER_README,
		generatedAt: state?.generatedAt ?? trace.exportedAt,
		generationDurationMs: state?.generationDurationMs ?? 0,
		exportedAt: trace.exportedAt,
		versions: {
			pluginVersion: trace.pluginVersion,
			serverVersion: state?.serverVersion ?? null,
			documentSchemaVersionSupportedByClient:
				state?.syncState.documentSchemaVersionSupportedByClient ?? null,
			documentSchemaVersionStoredInDocument:
				state?.syncState.documentSchemaVersionStoredInDocument ?? null,
			flightEventSchemaVersion: trace.flightEventSchemaVersion,
			flightEventTaxonomyVersion: trace.flightEventTaxonomyVersion,
		},
		platform: state?.platform ?? null,
		traceIdentity: {
			traceId: trace.traceId,
			bootId: trace.bootId,
			deviceId: trace.deviceId,
			vaultIdHash: trace.vaultIdHash,
			serverHostHash: trace.serverHostHash,
			pathPseudonymSaltFingerprint: trace.pathPseudonymSaltFingerprint,
		},
		traceContents: {
			eventCount: trace.eventCount,
			segmentCount: trace.segmentCount,
			segmentsRotated: trace.segmentsRotated,
			pathIdentityDegraded: trace.pathIdentityDegraded,
			droppedEventCount: trace.droppedEventCount,
			droppedEventCountByKind: trace.droppedEventCountByKind,
		},
		pathPseudonymization: {
			scheme: "sha256(vaultScopedSalt || NUL || normalizedVaultPath), first 128 bits, prefixed p:",
			saltScope: "vault",
			stableAcrossDevicesOfSameVault: true,
			stableAcrossTraceSessions: true,
			note: "Traces sharing a pathPseudonymSaltFingerprint use the same pathId namespace and can be merged across devices.",
		},
		pathDirectory: redacted ? null : trace.pathDirectory,
		syncStateAvailable: state !== null,
		settingsSnapshot: state
			? {
				serverHost: redacted ? "(redacted)" : state.settings.host,
				deviceTokenConfigured: !!state.settings.deviceToken,
				vaultId: redacted ? "(redacted)" : state.settings.vaultId,
				deviceName: redacted ? "(redacted)" : state.settings.deviceName,
				debugModeEnabled: state.settings.debug,
				attachmentSyncEnabled: state.settings.enableAttachmentSync,
				externalEditPolicy: state.settings.externalEditPolicy,
			}
			: null,
		syncFacts: state?.syncFacts ?? null,
		syncState: state
			? {
				...state.syncState,
				serverReceiptStartupValidationExplanation: describeServerReceiptStartupValidation(
					state.syncState.serverReceiptStartupValidation,
				),
			}
			: null,
		vaultVersusCrdtComparison: state
			? {
				filesMissingOnDisk,
				filesMissingInCrdt,
				contentHashMismatches,
				matchingFileCount:
					allPaths.size -
					filesMissingOnDisk.length -
					filesMissingInCrdt.length -
					contentHashMismatches.length,
				comparedFileCount: allPaths.size,
			}
			: null,
		httpTraceContext: state?.httpTraceContext ?? null,
		recentLogLines: {
			plugin: state?.pluginLogLines.slice(-240) ?? [],
			sync: state?.syncLogLines.slice(-240) ?? [],
		},
		openFiles: state?.openFiles ?? [],
		diskMirror: state?.diskMirrorSnapshot ?? null,
		blobSync: state?.blobSyncSnapshot ?? null,
		serverTraceEvents: state?.serverTraceEvents ?? [],
		frontmatterQuarantineNotes: state
			? buildFrontmatterQuarantineDebugLines(state.frontmatterQuarantine)
			: [],
	};

	const header = redactContentFingerprints(
		redactor.redactDeep(rawHeader),
		redacted,
	) as Record<string, unknown>;

	// Post-redaction leak check (INV-SEC-02): abort if any known vault path
	// survived into the serialised redacted header.
	let leakDetected = false;
	if (redacted && redactor.active) {
		const serialized = JSON.stringify(header);
		for (const path of knownPaths) {
			if (serialized.includes(path)) {
				leakDetected = true;
				break;
			}
		}
	}

	return {
		header,
		leakDetected,
		missingOnDiskCount: filesMissingOnDisk.length,
		missingInCrdtCount: filesMissingInCrdt.length,
		hashMismatchCount: contentHashMismatches.length,
	};
}

const CONTENT_FINGERPRINT_KEYS = new Set([
	"hash",
	"diskHash",
	"crdtHash",
	"diskContentHash",
	"crdtContentHash",
	"diskHashBefore",
	"diskHashAfter",
	"expectedHash",
	"localHash",
	"remoteHash",
]);

function redactContentFingerprints(value: unknown, redacted: boolean): unknown {
	if (!redacted || value === null) return value;
	if (Array.isArray(value)) {
		return value.map((item) => redactContentFingerprints(item, redacted));
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			if (
				CONTENT_FINGERPRINT_KEYS.has(key) &&
				typeof nested === "string" &&
				/^[0-9a-f]{64}$/i.test(nested)
			) {
				out[key] = `${nested.slice(0, 12)}…`;
			} else {
				out[key] = redactContentFingerprints(nested, redacted);
			}
		}
		return out;
	}
	return value;
}
