/**
 * Flight envelope — the record shape of the exported trace format.
 *
 * Companion to ./flightTaxonomy.ts: the taxonomy names the events, this
 * module describes the line they are serialised into. One NDJSON line of an
 * exported trace is one `FlightEvent`.
 *
 * Lives in observability/ rather than telemetry/debug/ for the same reason as
 * the taxonomy: the exported file is a user-facing artifact, so its shape is
 * a product-owned contract and not an implementation detail of the recorder
 * that writes it.
 *
 * Kept separate from ./traceSink.ts on purpose. traceSink.ts is the in-process
 * port — what product code is allowed to hand to the recorder. This file is
 * the persisted record. They change for different reasons: adding an envelope
 * field is a format change, widening the port is not.
 *
 * `eventSchemaVersion` versions this shape; `taxonomyVersion` versions the
 * vocabulary. They move independently.
 */

import type {
	FlightKind,
	FlightLayer,
	FlightPriority,
	FlightScope,
	FlightSeverity,
	FlightSource,
} from "./flightTaxonomy";

export const FLIGHT_EVENT_SCHEMA_VERSION = 1;

export type FlightEventBase = {
	eventSchemaVersion: number;
	taxonomyVersion: number;

	ts: number;
	mono?: number;
	seq: number;

	kind: FlightKind;
	severity: FlightSeverity;
	scope: FlightScope;
	source: FlightSource;
	layer: FlightLayer;

	traceId: string;
	bootId: string;
	deviceId: string;

	vaultIdHash: string;
	serverHostHash: string;
	pluginVersion: string;
	docSchemaVersion?: number;

	opId?: string;
	causedByOpId?: string;
	pathId?: string;
	path?: string;      // full/local-private mode only; absent in safe/qa-safe
	fileId?: string;
	candidateId?: string;
	svHash?: string;
	updateHash?: string;
	generation?: number;
	connectionGeneration?: number;

	decision?: string;
	reason?: string;

	/**
	 * data must NEVER contain these keys in safe/qa-safe mode:
	 * path, requestedPath, resolvedPath, oldPath, newPath,
	 * host, deviceToken, vaultId, deviceName, qaTraceSecret
	 */
	data?: Record<string, unknown>;
};

export type FlightEvent = FlightEventBase & {
	priority: FlightPriority;
};

/**
 * What callers provide. The recorder fills envelope fields.
 * Omits: eventSchemaVersion, taxonomyVersion, ts, mono, seq,
 *        traceId, bootId, deviceId, vaultIdHash, serverHostHash, pluginVersion.
 */
export type FlightEventInput = Omit<
	FlightEvent,
	| "eventSchemaVersion"
	| "taxonomyVersion"
	| "ts"
	| "mono"
	| "seq"
	| "traceId"
	| "bootId"
	| "deviceId"
	| "vaultIdHash"
	| "serverHostHash"
	| "pluginVersion"
> & {
	mono?: number;
};

/**
 * For path-scoped events: caller supplies raw `path`; the controller
 * resolves it to `pathId` (+ optional raw path in full mode).
 * `path` must never appear inside `data`.
 */
export type FlightPathEventInput = Omit<FlightEventInput, "pathId"> & {
	scope: "file" | "folder";
	path: string;
};
