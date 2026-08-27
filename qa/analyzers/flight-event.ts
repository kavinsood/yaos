/**
 * Minimal typed representation of a flight event for the analyzer.
 * Mirrors the shape of FlightEvent from src/observability/flightEnvelope.ts
 * but kept separate so the analyzer has no build dependency on the plugin.
 */

export interface FlightEvent {
	eventSchemaVersion: number;
	taxonomyVersion: number;
	ts: number;
	seq: number;
	kind: string;
	severity: string;
	scope: string;
	source: string;
	layer: string;
	priority: "critical" | "important" | "verbose";
	traceId: string;
	bootId: string;
	deviceId: string;
	vaultIdHash: string;
	serverHostHash: string;
	pluginVersion: string;
	pathId?: string;
	path?: string;
	opId?: string;
	causedByOpId?: string;
	fileId?: string;
	connectionGeneration?: number;
	generation?: number;
	decision?: string;
	reason?: string;
	data?: Record<string, unknown>;
}

export interface NdjsonParseIssue {
	line: number;
	reason: "invalid-json" | "invalid-event-shape";
}

export interface NdjsonParseResult {
	events: FlightEvent[];
	issues: NdjsonParseIssue[];
}
const TRACE_HEADER_FORMAT_VERSION = 1;
const CURRENT_EVENT_SCHEMA_VERSION = 1;
const CURRENT_TAXONOMY_VERSION = 13;

function isTraceHeader(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const header = value as Record<string, unknown>;
	const versions = header.versions as Record<string, unknown> | null;
	const traceIdentity = header.traceIdentity as Record<string, unknown> | null;
	const traceContents = header.traceContents as Record<string, unknown> | null;
	return (
		header.recordType === "trace-header"
		&& header.traceHeaderFormatVersion === TRACE_HEADER_FORMAT_VERSION
		&& typeof header.redacted === "boolean"
		&& typeof header.readme === "string"
		&& typeof header.generatedAt === "string"
		&& typeof header.generationDurationMs === "number"
		&& typeof header.exportedAt === "string"
		&& versions !== null
		&& typeof versions === "object"
		&& !Array.isArray(versions)
		&& typeof versions.pluginVersion === "string"
		&& versions.flightEventSchemaVersion === CURRENT_EVENT_SCHEMA_VERSION
		&& versions.flightEventTaxonomyVersion === CURRENT_TAXONOMY_VERSION
		&& traceIdentity !== null
		&& typeof traceIdentity === "object"
		&& !Array.isArray(traceIdentity)
		&& typeof traceIdentity.traceId === "string"
		&& typeof traceIdentity.bootId === "string"
		&& typeof traceIdentity.deviceId === "string"
		&& typeof traceIdentity.vaultIdHash === "string"
		&& typeof traceIdentity.serverHostHash === "string"
		&& traceContents !== null
		&& typeof traceContents === "object"
		&& !Array.isArray(traceContents)
		&& typeof traceContents.eventCount === "number"
		&& typeof traceContents.segmentCount === "number"
		&& typeof traceContents.segmentsRotated === "boolean"
		&& typeof traceContents.droppedEventCount === "number"
		&& typeof header.syncStateAvailable === "boolean"
	);
}

function isFlightEvent(value: unknown): value is FlightEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	return (
		event.eventSchemaVersion === CURRENT_EVENT_SCHEMA_VERSION
		&& event.taxonomyVersion === CURRENT_TAXONOMY_VERSION
		&& typeof event.ts === "number"
		&& typeof event.seq === "number"
		&& typeof event.kind === "string"
		&& typeof event.severity === "string"
		&& typeof event.scope === "string"
		&& typeof event.source === "string"
		&& typeof event.layer === "string"
		&& typeof event.traceId === "string"
		&& typeof event.bootId === "string"
		&& typeof event.deviceId === "string"
		&& typeof event.vaultIdHash === "string"
		&& typeof event.serverHostHash === "string"
		&& typeof event.pluginVersion === "string"
		&& (
			event.priority === "critical"
			|| event.priority === "important"
			|| event.priority === "verbose"
		)
	);
}

export function parseNdjson(raw: string): NdjsonParseResult {
	const events: FlightEvent[] = [];
	const issues: NdjsonParseIssue[] = [];
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index]!.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			issues.push({ line: index + 1, reason: "invalid-json" });
			continue;
		}
		const headerRecord = parsed !== null
			&& typeof parsed === "object"
			&& !Array.isArray(parsed)
			&& (parsed as Record<string, unknown>).recordType === "trace-header";
		if (headerRecord) {
			if (index === 0 && isTraceHeader(parsed)) continue;
			issues.push({ line: index + 1, reason: "invalid-event-shape" });
			continue;
		}
		if (!isFlightEvent(parsed)) {
			issues.push({ line: index + 1, reason: "invalid-event-shape" });
			continue;
		}
		events.push(parsed);
	}
	return { events, issues };
}
