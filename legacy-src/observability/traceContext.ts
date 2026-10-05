/**
 * Focused product contract for HTTP trace query parameters and legacy
 * structured trace callbacks routed into the flight recorder.
 */

/**
 * HTTP trace context passed to server requests for distributed tracing.
 */
export interface TraceHttpContext {
	readonly traceId: string;
	readonly bootId: string;
	readonly deviceName: string;
	readonly vaultId: string;
}

/**
 * Arbitrary key-value details attached to trace events.
 */
export interface TraceEventDetails {
	[key: string]: unknown;
}

/**
 * Function signature for recording structured trace events.
 * Product code receives this as a callback; it doesn't import the logger.
 */
export type TraceRecord = (
	source: string,
	msg: string,
	details?: TraceEventDetails,
) => void;

/**
 * Append trace context to a URL as query parameters.
 * Used for distributed tracing across HTTP boundaries.
 */
export function appendTraceParams(url: string, trace?: TraceHttpContext): string {
	if (!trace) return url;
	const target = new URL(url);
	target.searchParams.set("device", trace.deviceName);
	target.searchParams.set("trace", trace.traceId);
	target.searchParams.set("boot", trace.bootId);
	return target.toString();
}
