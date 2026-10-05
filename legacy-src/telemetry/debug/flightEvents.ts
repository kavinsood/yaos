/**
 * Flight recorder internals.
 *
 * The published trace format — the event vocabulary and the record shape — is
 * NOT here. It is product-owned and lives in:
 *
 *   src/observability/flightTaxonomy.ts   FLIGHT_KIND, FLIGHT_TAXONOMY_VERSION,
 *                                         severity/scope/layer/source/priority
 *   src/observability/flightEnvelope.ts   FlightEvent(+Base/Input/PathInput),
 *                                         FLIGHT_EVENT_SCHEMA_VERSION
 *   src/observability/recoveryEventTypes.ts  recovery.skipped payload types
 *
 * What remains below is machinery of *this* recorder: how it is configured,
 * what it can refuse to record, and what an export attempt can return. None of
 * it appears in an exported trace line.
 */

import type { FlightEventInput, FlightPathEventInput } from "../../observability/flightEnvelope";

// -----------------------------------------------------------------------
// FlightSink — typed module boundary
// -----------------------------------------------------------------------

export type FlightSink = {
	record(event: FlightEventInput): void;
	recordPath(event: FlightPathEventInput): Promise<void>;
};

// -----------------------------------------------------------------------
// Misc supporting types
// -----------------------------------------------------------------------

export type SkipReason =
	| "excluded-path"
	| "oversized-text-file"
	| "frontmatter-unsafe"
	| "external-policy-never"
	| "external-policy-open-file"
	| "suppressed-remote-writeback"
	| "pending-rename-target"
	| "tombstoned-path"
	| "safety-brake"
	| "r2-unavailable"
	| "server-update-required"
	| "auth-failed";

export type FlightMode = "safe" | "qa-safe" | "full" | "local-private";

export type PathIdentity = {
	pathId: string;
	path?: string;
};

export type TraceContext = {
	traceId: string;
	bootId: string;
	deviceId: string;
	vaultIdHash: string;
	serverHostHash: string;
	pluginVersion: string;
	docSchemaVersion?: number;
};

// -----------------------------------------------------------------------
// Export result type
// -----------------------------------------------------------------------

export type FlightExportResult =
	| { ok: true; path: string; includesFilenames: boolean }
	| {
		ok: false;
		reason:
			| "trace-not-active"
			| "trace-unsafe-for-safe-export"
			| "trace-not-exportable"
			| "trace-degraded-path-identity"
			| "write-failed"
			| "flush-failed";
	};
