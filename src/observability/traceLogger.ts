/**
 * TraceLoggerPort — product-safe interface for a persistent trace logger.
 *
 * TraceRuntimeController depends only on this interface.
 * The concrete implementation (PersistentTraceLogger) lives in src/telemetry/debug/trace.ts
 * and is injected by the lab runtime when settings.debug is true.
 */

import type { TraceEventDetails, TraceHttpContext } from "./traceContext";

export interface TraceLoggerPort {
	readonly httpContext: TraceHttpContext;
	readonly isEnabled: boolean;
	record(source: string, msg: string, details?: TraceEventDetails): void;
	captureCrash(kind: string, error: unknown, context?: TraceEventDetails): void;
	updateCurrentState(state: unknown): void;
	shutdown(): Promise<void>;
}

export interface TraceLoggerConfig {
	enabled: boolean;
	deviceName: string;
	vaultId: string;
}
