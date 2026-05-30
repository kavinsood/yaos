/**
 * Minimal typed representation of a flight event for the analyzer.
 * Mirrors the shape of FlightEvent from src/debug/flightEvents.ts
 * but kept separate so the analyzer has no build dependency on the plugin.
 */

export interface FlightEvent {
	ts: number;
	seq: number;
	kind: string;
	severity: string;
	scope: string;
	source: string;
	layer: string;
	priority: "critical" | "important" | "verbose";

	traceId?: string;
	bootId?: string;
	deviceId?: string;
	vaultIdHash?: string;

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

export function parseNdjson(raw: string): FlightEvent[] {
	const events: FlightEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as FlightEvent);
		} catch { /* skip malformed lines */ }
	}
	return events;
}
