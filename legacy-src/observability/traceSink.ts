/**
 * TraceSink — domain-level observability interface.
 *
 * Sync/runtime code emits domain events through this interface.
 * The flight recorder becomes an adapter (FlightTraceSink) that maps
 * domain events to the existing flight event schema.
 *
 * Design rules:
 *   - record() and recordPath() are non-blocking. They never return promises.
 *   - flush() is the only async/durability boundary.
 *   - Callers never need to await trace completion.
 *   - Implementation may queue async work (HMAC, redaction) internally.
 */

import type {
	FlightLayer,
	FlightPriority,
	FlightScope,
	FlightSeverity,
	FlightSource,
} from "./flightTaxonomy";
import type { ProductEventKind } from "./productEventKinds";

export interface DomainTraceEvent {
	readonly kind: string;
	readonly scope: "vault" | "file" | "connection" | "diagnostics";
	readonly severity: "debug" | "info" | "warn" | "error";
	readonly opId?: string;
	readonly data?: Record<string, unknown>;
}

export interface DomainPathTraceEvent extends DomainTraceEvent {
	readonly scope: "file";
	readonly path: string;
	/**
	 * Optional priority override. When absent, FlightTraceSink derives
	 * priority from severity (error→critical, warn/info→important, debug→verbose).
	 * Use this only when the default mapping is wrong (e.g., diskDeleteObserved
	 * is severity:info but priority:critical).
	 */
	readonly priority?: "critical" | "important" | "verbose";
}

export interface TraceSink {
	/** Record a non-path-scoped domain event. Non-blocking. */
	record(event: DomainTraceEvent): void;
	/** Record a path-scoped domain event. Non-blocking. */
	recordPath(event: DomainPathTraceEvent): void;
	/** Flush pending async work (HMAC, redaction). Only async boundary. */
	flush?(): Promise<void>;
}

// -----------------------------------------------------------------------
// Product event input types
//
// These are capability-narrowed *views* of the canonical envelope in
// ./flightEnvelope.ts, not parallel declarations of it. Every member is
// derived with Extract<> from the published taxonomy, so the two cannot
// drift and each view fails closed: if a taxonomy member is renamed the
// narrowed union loses it and the offending product callsite stops
// compiling, rather than silently inheriting a capability.
//
// Because every field is a subset of the canonical field,
// ProductFlightEventInput is assignable to FlightEventInput and
// ProductFlightPathEventInput to FlightPathEventInput. That is what lets
// the recorder entry points take a single parameter type instead of a
// union of the two spellings.
// -----------------------------------------------------------------------

export type ProductFlightScope = Extract<
	FlightScope,
	"file" | "folder" | "vault" | "blob" | "connection"
>;
export type ProductFlightSeverity = FlightSeverity;
export type ProductFlightPriority = FlightPriority;
export type ProductFlightLayer = Extract<
	FlightLayer,
	| "lifecycle"
	| "disk"
	| "crdt"
	| "provider"
	| "server"
	| "reconcile"
	| "recovery"
	| "policy"
	| "editor"
	| "blob"
>;
export type ProductFlightSource = Extract<
	FlightSource,
	| "vaultSync"
	| "vaultEvents"
	| "diskMirror"
	| "editorBinding"
	| "reconciliationController"
	| "connectionController"
	| "blobSync"
>;

/**
 * Product event input — used by sync/runtime code.
 *
 * `kind` is a `ProductEventKind`, so product code cannot emit a harness- or
 * recorder-only kind (`qa.phase`, `debug.trace.started`, `export.manifest`, …).
 */
export interface ProductFlightEventInput {
	readonly kind: ProductEventKind;
	readonly severity: ProductFlightSeverity;
	readonly scope: ProductFlightScope;
	readonly source: ProductFlightSource;
	readonly layer: ProductFlightLayer;
	readonly priority: ProductFlightPriority;
	readonly opId?: string;
	readonly data?: Record<string, unknown>;
}

/**
 * Product path event input — used by sync/runtime code for file-scoped events.
 */
export interface ProductFlightPathEventInput extends ProductFlightEventInput {
	readonly scope: "file" | "folder";
	readonly path: string;
}
