/**
 * Pure diagnostics bundle builder (INV-SEC-02).
 *
 * This module is intentionally Obsidian-free so it can be imported and tested
 * under Node without any Obsidian mock. All callers must pre-gather data and
 * pass it as DiagnosticsBundleInput. No I/O, no Notice, no vault adapter.
 *
 * The function is side-effect-free (deterministic given a fixed salt). The
 * salt is generated externally — pass a fixed salt in tests for reproducibility.
 */

import { type SyncFacts } from "../runtime/connectionFacts";
import {
	buildFrontmatterQuarantineDebugLines,
	type FrontmatterQuarantineEntry,
} from "../sync/frontmatterQuarantine";
import {
	createPassthroughRedactor,
	createPathRedactor,
	generateBundleSalt,
	type Sha256Hex,
} from "./pathRedactor";

type EventEntry = { ts: string; msg: string };

type LastReconcileStats = {
	at: string;
	mode: string;
	plannedCreates: number;
	plannedUpdates: number;
	flushedCreates: number;
	flushedUpdates: number;
	safetyBrakeTriggered: boolean;
	safetyBrakeReason: string | null;
};

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

/** All pre-gathered data passed into buildDiagnosticsBundle. No Obsidian I/O. */
export interface DiagnosticsBundleInput {
	generatedAt: string;
	generationMs: number;
	settings: {
		host: string;
		token: string | null | undefined;
		vaultId: string;
		deviceName: string;
		debug: boolean;
		enableAttachmentSync: boolean;
		externalEditPolicy: string;
	};
	stateSnapshot: {
		reconciled: boolean;
		reconcileInFlight: boolean;
		reconcilePending: boolean;
		lastReconcileStats: LastReconcileStats | null;
		awaitingFirstProviderSyncAfterStartup: boolean;
		lastReconciledGeneration: number;
		connected: boolean;
		providerSynced: boolean;
		localReady: boolean;
		connectionGeneration: number;
		fatalAuthError: boolean;
		fatalAuthCode: string | null;
		fatalAuthDetails: unknown;
		idbError: boolean;
		idbErrorDetails: unknown;
		serverReceiptStartupValidation: string | null;
		svEcho: unknown;
		pathToIdCount: number;
		activePathCount: number;
		blobPathCount: number;
		diskFileCount: number;
		openFileCount: number;
		schema: { supportedByClient: number | null; storedInDoc: number | null | undefined };
	};
	syncFacts: SyncFacts;
	/** Raw trace context — passed through opaquely into the bundle. */
	trace: unknown;
	diskHashes: Map<string, { hash: string; length: number }>;
	crdtHashes: Map<string, { hash: string; length: number }>;
	eventRing: EventEntry[];
	syncEvents: EventEntry[];
	serverTrace: unknown[];
	openFiles: Array<Record<string, unknown>>;
	diskMirrorSnapshot: unknown;
	blobSyncSnapshot: unknown;
	frontmatterQuarantine: FrontmatterQuarantineEntry[];
	sha256Hex: Sha256Hex;
}

export interface DiagnosticsBundleResult {
	bundle: Record<string, unknown>;
	/** True if a known vault path survived redaction. Caller should abort and warn. */
	leakDetected: boolean;
	missingOnDiskCount: number;
	missingInCrdtCount: number;
	hashMismatchCount: number;
}

export async function buildDiagnosticsBundle(
	input: DiagnosticsBundleInput,
	options: { includeFilenames: boolean; salt?: string },
): Promise<DiagnosticsBundleResult> {
	const { settings, stateSnapshot: s } = input;
	const knownPaths = [
		...Array.from(input.diskHashes.keys()),
		...Array.from(input.crdtHashes.keys()),
	];

	const allPaths = new Set<string>([...input.diskHashes.keys(), ...input.crdtHashes.keys()]);
	const missingOnDisk: string[] = [];
	const missingInCrdt: string[] = [];
	const hashMismatches: Array<{ path: string; diskHash: string; crdtHash: string; diskLength: number; crdtLength: number }> = [];
	for (const path of allPaths) {
		const disk = input.diskHashes.get(path);
		const crdt = input.crdtHashes.get(path);
		if (!disk && crdt) { missingOnDisk.push(path); continue; }
		if (disk && !crdt) { missingInCrdt.push(path); continue; }
		if (disk && crdt && disk.hash !== crdt.hash) {
			hashMismatches.push({ path, diskHash: disk.hash, crdtHash: crdt.hash, diskLength: disk.length, crdtLength: crdt.length });
		}
	}

	const salt = options.salt ?? generateBundleSalt();
	const redactor = options.includeFilenames
		? createPassthroughRedactor()
		: await createPathRedactor(salt, input.sha256Hex, { knownPaths });

	const safeHash = (hash: string) =>
		options.includeFilenames ? hash : `${hash.slice(0, 12)}…`;

	const rawDiagnostics: Record<string, unknown> = {
		generatedAt: input.generatedAt,
		generationMs: input.generationMs,
		redaction: {
			mode: options.includeFilenames ? "with-filenames" : "safe-summary",
			schema: 1,
		},
		syncFacts: input.syncFacts,
		trace: input.trace ?? null,
		settings: {
			host: options.includeFilenames ? settings.host : "(redacted)",
			token: { present: !!settings.token },
			vaultId: options.includeFilenames ? settings.vaultId : "(redacted)",
			deviceName: options.includeFilenames ? settings.deviceName : "(redacted)",
			debug: settings.debug,
			enableAttachmentSync: settings.enableAttachmentSync,
			externalEditPolicy: settings.externalEditPolicy,
		},
		state: {
			reconciled: s.reconciled,
			reconcileInFlight: s.reconcileInFlight,
			reconcilePending: s.reconcilePending,
			lastReconcile: s.lastReconcileStats,
			awaitingFirstProviderSyncAfterStartup: s.awaitingFirstProviderSyncAfterStartup,
			lastReconciledGeneration: s.lastReconciledGeneration,
			connected: s.connected,
			providerSynced: s.providerSynced,
			localReady: s.localReady,
			connectionGeneration: s.connectionGeneration,
			fatalAuthError: s.fatalAuthError,
			fatalAuthCode: s.fatalAuthCode,
			fatalAuthDetails: s.fatalAuthDetails,
			idbError: s.idbError,
			idbErrorDetails: s.idbErrorDetails,
			serverReceiptStartupValidation: s.serverReceiptStartupValidation,
			serverReceiptStartupValidationDetail: describeServerReceiptStartupValidation(s.serverReceiptStartupValidation),
			svEcho: s.svEcho,
			pathToIdCount: s.pathToIdCount,
			activePathCount: s.activePathCount,
			blobPathCount: s.blobPathCount,
			diskFileCount: s.diskFileCount,
			openFileCount: s.openFileCount,
			schema: s.schema,
		},
		hashDiff: {
			missingOnDisk,
			missingInCrdt,
			hashMismatches: hashMismatches.map((entry) => ({
				...entry,
				diskHash: safeHash(entry.diskHash),
				crdtHash: safeHash(entry.crdtHash),
			})),
			matchingCount: allPaths.size - missingOnDisk.length - missingInCrdt.length - hashMismatches.length,
			totalCompared: allPaths.size,
		},
		recentEvents: {
			plugin: input.eventRing.slice(-240),
			sync: input.syncEvents.slice(-240),
		},
		openFiles: input.openFiles,
		diskMirror: input.diskMirrorSnapshot ?? null,
		blobSync: input.blobSyncSnapshot ?? null,
		serverTrace: input.serverTrace,
		frontmatterQuarantine: buildFrontmatterQuarantineDebugLines(input.frontmatterQuarantine),
	};

	const bundle = redactContentFingerprints(
		redactor.redactDeep(rawDiagnostics),
		options.includeFilenames,
	) as Record<string, unknown>;

	// Post-redaction leak check (INV-SEC-02): abort if any known vault path
	// survived into the serialised safe bundle.
	let leakDetected = false;
	if (!options.includeFilenames && redactor.active) {
		const serialized = JSON.stringify(bundle);
		for (const path of knownPaths) {
			if (serialized.includes(path)) {
				leakDetected = true;
				break;
			}
		}
	}

	return {
		bundle,
		leakDetected,
		missingOnDiskCount: missingOnDisk.length,
		missingInCrdtCount: missingInCrdt.length,
		hashMismatchCount: hashMismatches.length,
	};
}

const CONTENT_FINGERPRINT_KEYS = new Set([
	"hash",
	"diskHash",
	"crdtHash",
	"diskHashBefore",
	"diskHashAfter",
	"expectedHash",
	"localHash",
	"remoteHash",
]);

function redactContentFingerprints(value: unknown, includeFull: boolean): unknown {
	if (includeFull || value === null) return value;
	if (Array.isArray(value)) {
		return value.map((item) => redactContentFingerprints(item, includeFull));
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
				out[key] = redactContentFingerprints(nested, includeFull);
			}
		}
		return out;
	}
	return value;
}
