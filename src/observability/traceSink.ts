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
// These types mirror FlightEventInput/FlightPathEventInput but use
// string literals for kind instead of the FlightKind enum. Product code
// imports these; the adapter (FlightTraceSink) maps to flight schema.
// -----------------------------------------------------------------------

export type ProductFlightScope = "file" | "folder" | "vault" | "blob" | "connection";
export type ProductFlightSeverity = "debug" | "info" | "warn" | "error";
export type ProductFlightPriority = "critical" | "important" | "verbose";
export type ProductFlightLayer =
	| "lifecycle"
	| "disk"
	| "crdt"
	| "provider"
	| "server"
	| "reconcile"
	| "recovery"
	| "policy"
	| "editor"
	| "blob";
export type ProductFlightSource =
	| "vaultSync"
	| "vaultEvents"
	| "diskMirror"
	| "editorBinding"
	| "reconciliationController"
	| "connectionController"
	| "blobSync"
	| "serverAckTracker";

/**
 * Product event input — used by sync/runtime code.
 * kind is a string literal (e.g., "crdt.file.created") not an enum import.
 */
export interface ProductFlightEventInput {
	readonly kind: string;
	readonly severity: ProductFlightSeverity;
	readonly scope: ProductFlightScope;
	readonly source: ProductFlightSource;
	readonly layer: ProductFlightLayer;
	readonly priority?: ProductFlightPriority;
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
