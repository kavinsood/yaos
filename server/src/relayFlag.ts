// Relay v2 spike: feature flag + configuration. Everything relay-specific is
// gated by `YAOS_RELAY_BODIES === "true"`; with the flag off the server is the
// phase0 server.

export interface RelayFlagEnv {
	YAOS_RELAY_BODIES?: string;
	YAOS_RELAY_MICROBATCH_MS?: string;
	YAOS_RELAY_MAX_BODY_SOCKETS?: string;
	YAOS_RELAY_RATE_BYTES_PER_SEC?: string;
	YAOS_RELAY_BURST_BYTES?: string;
	YAOS_RELAY_MERGED_CACHE_BYTES?: string;
	YAOS_RELAY_CHECKPOINT_ENTRIES?: string;
	YAOS_RELAY_CHECKPOINT_BYTES?: string;
	YAOS_RELAY_EXACT_MERGE_BYTES?: string;
	YAOS_RELAY_CHECKPOINT_MAX_ROWS?: string;
}

export interface RelayConfig {
	microbatchMs: number;
	maxBodySockets: number;
	rateBytesPerSec: number;
	burstBytes: number;
	mergedCacheBytes: number;
	checkpointEntries: number;
	checkpointBytes: number;
	/** Bodies whose merged bytes are at most this use the exact byte merge per append. */
	exactMergeBytes: number;
	/** Max journal rows merged into one checkpoint (K3: merge is superlinear in frames). */
	checkpointMaxRows: number;
}

export const DEFAULT_RELAY_CONFIG: Readonly<RelayConfig> = Object.freeze({
	microbatchMs: 0,
	maxBodySockets: 5000,
	rateBytesPerSec: 256 * 1024,
	burstBytes: 1024 * 1024,
	mergedCacheBytes: 16 * 1024 * 1024,
	checkpointEntries: 50,
	checkpointBytes: 1024 * 1024,
	exactMergeBytes: 256 * 1024,
	checkpointMaxRows: 200,
});

type ProcessLike = { env?: Record<string, string | undefined> };

function testProcessEnv(): Record<string, string | undefined> | undefined {
	// `process` does not exist in the Worker (no nodejs_compat), so this is inert there.
	return (globalThis as { process?: ProcessLike }).process?.env;
}

/**
 * TEST-ONLY default for code paths constructed without an env (unit suites).
 * `YAOS_TEST_FORCE_RELAY_BODIES` (base-tests recommendation) and
 * `YAOS_TEST_RELAY_BODIES` (brief) are both accepted.
 */
export function relayBodiesTestDefault(): boolean {
	const env = testProcessEnv();
	return env?.YAOS_TEST_FORCE_RELAY_BODIES === "true" || env?.YAOS_TEST_RELAY_BODIES === "true";
}

/** Production: exactly `env.YAOS_RELAY_BODIES === "true"`; unset falls back to the test default. */
export function relayBodiesEnabled(env: RelayFlagEnv | null | undefined): boolean {
	if (env?.YAOS_RELAY_BODIES !== undefined) return env.YAOS_RELAY_BODIES === "true";
	return relayBodiesTestDefault();
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function readRelayConfig(env: RelayFlagEnv | null | undefined): RelayConfig {
	const source: RelayFlagEnv = { ...(testProcessEnv() as RelayFlagEnv | undefined ?? {}), ...(env ?? {}) };
	// Ambient process env only fills knobs in tests; the flag itself never comes from it.
	return {
		microbatchMs: positiveInt(source.YAOS_RELAY_MICROBATCH_MS, DEFAULT_RELAY_CONFIG.microbatchMs, 0, 50),
		maxBodySockets: positiveInt(source.YAOS_RELAY_MAX_BODY_SOCKETS, DEFAULT_RELAY_CONFIG.maxBodySockets, 1, 32_000),
		rateBytesPerSec: positiveInt(source.YAOS_RELAY_RATE_BYTES_PER_SEC, DEFAULT_RELAY_CONFIG.rateBytesPerSec, 1, 1 << 30),
		burstBytes: positiveInt(source.YAOS_RELAY_BURST_BYTES, DEFAULT_RELAY_CONFIG.burstBytes, 1, 1 << 30),
		mergedCacheBytes: positiveInt(source.YAOS_RELAY_MERGED_CACHE_BYTES, DEFAULT_RELAY_CONFIG.mergedCacheBytes, 0, 1 << 30),
		checkpointEntries: positiveInt(source.YAOS_RELAY_CHECKPOINT_ENTRIES, DEFAULT_RELAY_CONFIG.checkpointEntries, 1, 1_000_000),
		checkpointBytes: positiveInt(source.YAOS_RELAY_CHECKPOINT_BYTES, DEFAULT_RELAY_CONFIG.checkpointBytes, 1, 1 << 30),
		exactMergeBytes: positiveInt(source.YAOS_RELAY_EXACT_MERGE_BYTES, DEFAULT_RELAY_CONFIG.exactMergeBytes, 0, 1 << 30),
		checkpointMaxRows: positiveInt(source.YAOS_RELAY_CHECKPOINT_MAX_ROWS, DEFAULT_RELAY_CONFIG.checkpointMaxRows, 1, 100_000),
	};
}
