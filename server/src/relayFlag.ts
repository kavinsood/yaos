// Relay v2 spike: feature flag + configuration. Everything relay-specific is
// gated by `YAOS_RELAY_BODIES === "true"`; with the flag off the server is the
// phase0 server.
import { MAX_DURABLE_UPDATE_BYTES } from "./contracts";

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
	/** Server-side per-body semantic-reset cooldown (ms). Test workers set this small via [vars]. */
	YAOS_RELAY_RESET_COOLDOWN_MS?: string;
	YAOS_RELAY_MAX_MERGE_INPUT_BYTES?: string;
	YAOS_RELAY_LAZY_HASH_MAX_BYTES?: string;
	/** Round 4 lean append (docs/relay2-protocol.md §6.4): exactly "true" enables it. */
	YAOS_RELAY_LEAN_ROWS?: string;
	YAOS_RELAY_LEAN_CATALOG_DELAY_MS?: string;
	/**
	 * Relay v3 write reduction (docs/relay3-group-commit.md): "1" or "true" enables
	 * group commit + one tail row per body + one receipt row per device. Requires
	 * YAOS_RELAY_BODIES and YAOS_RELAY_LEAN_ROWS; ignored otherwise.
	 */
	YAOS_RELAY_GROUP_COMMIT?: string;
	YAOS_RELAY_GC_IDLE_MS?: string;
	YAOS_RELAY_GC_MAX_MS?: string;
	/** v3: minimum time between two idle-triggered group commits of one body (0 = off). */
	YAOS_RELAY_GC_MIN_INTERVAL_MS?: string;
	YAOS_RELAY_GC_MAX_BYTES?: string;
	YAOS_RELAY_GC_TAIL_MAX_BYTES?: string;
	YAOS_RELAY_GC_TAIL_RATIO?: string;
	/** v3: tail row cap; a group commit that leaves the tail at or over it checkpoints the body. */
	YAOS_RELAY_GC_TAIL_BYTES?: string;
	/** v3: delay of the (one per window) alarm that publishes coalesced catalog events; 0 = tail checkpoints only. */
	YAOS_RELAY_GC_CATALOG_DELAY_MS?: string;
	/** Write-budget spike (int-bulk): create-bulk caps; see `readBulkCreateLimits`. Not relay-gated. */
	YAOS_BULK_CREATE_MAX_ITEMS?: string;
	YAOS_BULK_CREATE_MAX_BYTES?: string;
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
	/** Minimum time between two semantic resets of one body (mirrors BODY_COMPACTION_THRESHOLDS.softCooldownMs). */
	resetCooldownMs: number;
	/**
	 * Max summed input bytes of one server byte merge (checkpoint + tail). ywasm
	 * byte ops cost up to ~10x input for struct-dense updates, the linear memory
	 * caps at 96 MiB and an OOM trap poisons the instance, so bigger merges are
	 * refused (docs/relay2-protocol.md §6.2).
	 */
	maxMergeInputBytes: number;
	/** Bodies whose merged bytes exceed this never get the lazy hash materialisation (hash stays unknown). */
	lazyHashMaxBytes: number;
	/**
	 * Lean append (§6.4): no vault_clock write, attribution and the accepted hash
	 * inline on the journal row, no per-append catalog event (coalesced by the
	 * alarm `leanCatalogDelayMs` after the first pending append; current catalog
	 * reads overlay the journal head meanwhile).
	 */
	leanRows: boolean;
	leanCatalogDelayMs: number;
	/**
	 * Relay v3 (requires leanRows): validated frames are broadcast at once and
	 * buffered per (body, epoch); the buffer commits in one transaction after
	 * `gcIdleMs` without a frame (and at least `gcMinIntervalMs` after the
	 * body's previous commit), `gcMaxMs` after its first frame, or at
	 * `gcMaxBytes`, whichever is first. Receipts are sent after that commit.
	 */
	groupCommit: boolean;
	gcIdleMs: number;
	gcMaxMs: number;
	/**
	 * v3 commit-rate cap: an idle flush waits until this long after the body's
	 * previous commit, so idle-triggered commits are at most one per interval
	 * whatever the typing rhythm. The max window, the bytes cap and forced
	 * flushes (HTTP read/save, authority fence, semantic reset) are exempt.
	 */
	gcMinIntervalMs: number;
	gcMaxBytes: number;
	gcTailBytes: number;
	/**
	 * b3-ckpt tail hysteresis: a tail at or over `gcTailBytes` checkpoints only
	 * once it also reaches `gcTailRatio` x the body's checkpoint size, capped at
	 * `gcTailMaxBytes` (well inside RELAY_TAIL_HARD_MAX_BYTES and the SQLite row
	 * limit). Small-edit bodies (tiny tails, frame cap first) are unaffected; a
	 * whole-file rewrite (one note-sized update per save) gets ~ratio saves per
	 * checkpoint instead of ~2. Replay on load reads at most checkpoint x (1 +
	 * ratio) bytes. `gcTailMaxBytes <= gcTailBytes` restores the fixed soft cap.
	 */
	gcTailMaxBytes: number;
	gcTailRatio: number;
	/**
	 * v3: a group commit arms the relay alarm at most once per window, this far
	 * out (one setAlarm row per window, not per commit). The alarm publishes the
	 * coalesced catalog events of every body committed since (the catalog head
	 * is already right via the overlay; only the delta feed lags). 0 disables
	 * it: events are then published only by tail checkpoints and other alarms.
	 */
	gcCatalogDelayMs: number;
}

/**
 * The token bucket must hold at least one maximum-size frame, otherwise frames
 * between the burst and MAX_DURABLE_UPDATE_BYTES are rejected forever. R12: the
 * bucket is charged with raw messages, so it also covers the frame header (the
 * admission cap is MAX_CANDIDATE_BYTES + 64) and one maximum text envelope.
 */
export const RELAY_MIN_BURST_BYTES = MAX_DURABLE_UPDATE_BYTES + 64 + 64 * 1024;
export const RELAY_DEFAULT_RESET_COOLDOWN_MS = 24 * 60 * 60_000;

export const DEFAULT_RELAY_CONFIG: Readonly<RelayConfig> = Object.freeze({
	microbatchMs: 0,
	maxBodySockets: 5000,
	rateBytesPerSec: 256 * 1024,
	burstBytes: Math.max(1024 * 1024, RELAY_MIN_BURST_BYTES),
	mergedCacheBytes: 16 * 1024 * 1024,
	checkpointEntries: 50,
	checkpointBytes: 1024 * 1024,
	exactMergeBytes: 256 * 1024,
	checkpointMaxRows: 200,
	resetCooldownMs: RELAY_DEFAULT_RESET_COOLDOWN_MS,
	maxMergeInputBytes: 9 * 1024 * 1024,
	lazyHashMaxBytes: 3 * 1024 * 1024,
	leanRows: false,
	leanCatalogDelayMs: 2_000,
	groupCommit: false,
	gcIdleMs: 300,
	gcMaxMs: 1_500,
	gcMinIntervalMs: 1_000,
	gcMaxBytes: 65_536,
	gcTailBytes: 65_536,
	gcTailMaxBytes: 768 * 1024,
	gcTailRatio: 16,
	gcCatalogDelayMs: 30_000,
});

/** v3 flag value: "1" (brief) or "true" (the other relay flags' spelling). */
export function groupCommitFlag(value: string | undefined): boolean {
	return value === "1" || value === "true";
}

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
		microbatchMs: positiveInt(source.YAOS_RELAY_MICROBATCH_MS, DEFAULT_RELAY_CONFIG.microbatchMs, 0, 250),
		maxBodySockets: positiveInt(source.YAOS_RELAY_MAX_BODY_SOCKETS, DEFAULT_RELAY_CONFIG.maxBodySockets, 1, 32_000),
		rateBytesPerSec: positiveInt(source.YAOS_RELAY_RATE_BYTES_PER_SEC, DEFAULT_RELAY_CONFIG.rateBytesPerSec, 1, 1 << 30),
		burstBytes: Math.max(RELAY_MIN_BURST_BYTES,
			positiveInt(source.YAOS_RELAY_BURST_BYTES, DEFAULT_RELAY_CONFIG.burstBytes, 1, 1 << 30)),
		mergedCacheBytes: positiveInt(source.YAOS_RELAY_MERGED_CACHE_BYTES, DEFAULT_RELAY_CONFIG.mergedCacheBytes, 0, 1 << 30),
		checkpointEntries: positiveInt(source.YAOS_RELAY_CHECKPOINT_ENTRIES, DEFAULT_RELAY_CONFIG.checkpointEntries, 1, 1_000_000),
		checkpointBytes: positiveInt(source.YAOS_RELAY_CHECKPOINT_BYTES, DEFAULT_RELAY_CONFIG.checkpointBytes, 1, 1 << 30),
		exactMergeBytes: positiveInt(source.YAOS_RELAY_EXACT_MERGE_BYTES, DEFAULT_RELAY_CONFIG.exactMergeBytes, 0, 1 << 30),
		checkpointMaxRows: positiveInt(source.YAOS_RELAY_CHECKPOINT_MAX_ROWS, DEFAULT_RELAY_CONFIG.checkpointMaxRows, 1, 100_000),
		resetCooldownMs: positiveInt(source.YAOS_RELAY_RESET_COOLDOWN_MS, DEFAULT_RELAY_CONFIG.resetCooldownMs, 0, 30 * 24 * 60 * 60_000),
		maxMergeInputBytes: positiveInt(source.YAOS_RELAY_MAX_MERGE_INPUT_BYTES, DEFAULT_RELAY_CONFIG.maxMergeInputBytes, 1, 64 * 1024 * 1024),
		lazyHashMaxBytes: positiveInt(source.YAOS_RELAY_LAZY_HASH_MAX_BYTES, DEFAULT_RELAY_CONFIG.lazyHashMaxBytes, 0, 64 * 1024 * 1024),
		leanRows: source.YAOS_RELAY_LEAN_ROWS === "true",
		leanCatalogDelayMs: positiveInt(source.YAOS_RELAY_LEAN_CATALOG_DELAY_MS, DEFAULT_RELAY_CONFIG.leanCatalogDelayMs, 0, 600_000),
		// v3 requires lean rows (sequence allocation and catalog overlay build on them).
		groupCommit: groupCommitFlag(source.YAOS_RELAY_GROUP_COMMIT) && source.YAOS_RELAY_LEAN_ROWS === "true",
		gcIdleMs: positiveInt(source.YAOS_RELAY_GC_IDLE_MS, DEFAULT_RELAY_CONFIG.gcIdleMs, 1, 60_000),
		gcMaxMs: positiveInt(source.YAOS_RELAY_GC_MAX_MS, DEFAULT_RELAY_CONFIG.gcMaxMs, 1, 60_000),
		gcMinIntervalMs: positiveInt(source.YAOS_RELAY_GC_MIN_INTERVAL_MS, DEFAULT_RELAY_CONFIG.gcMinIntervalMs, 0, 60_000),
		gcMaxBytes: positiveInt(source.YAOS_RELAY_GC_MAX_BYTES, DEFAULT_RELAY_CONFIG.gcMaxBytes, 1, MAX_DURABLE_UPDATE_BYTES),
		gcTailBytes: positiveInt(source.YAOS_RELAY_GC_TAIL_BYTES, DEFAULT_RELAY_CONFIG.gcTailBytes, 1, 1024 * 1024),
		gcTailMaxBytes: positiveInt(source.YAOS_RELAY_GC_TAIL_MAX_BYTES, DEFAULT_RELAY_CONFIG.gcTailMaxBytes, 1, 1024 * 1024),
		gcTailRatio: positiveInt(source.YAOS_RELAY_GC_TAIL_RATIO, DEFAULT_RELAY_CONFIG.gcTailRatio, 0, 1024),
		gcCatalogDelayMs: positiveInt(source.YAOS_RELAY_GC_CATALOG_DELAY_MS, DEFAULT_RELAY_CONFIG.gcCatalogDelayMs, 0, 3_600_000),
	};
}

/**
 * Effective `POST /lifecycle/create-bulk` caps. The defaults are the protocol
 * maxima (500 items, 4 MiB of decoded frame bytes); the env vars can only lower
 * them (a smaller batch keeps one request under a CPU budget, e.g. the Workers
 * Free plan). Out-of-range or non-numeric values clamp / fall back like the
 * relay knobs. Advertised as `bulkCreate` in `/api/capabilities` and in every
 * 413 body, so clients split by the server's numbers. A single-file batch keeps
 * its own (larger) per-file limit.
 */
export interface BulkCreateLimits {
	maxItems: number;
	maxBytes: number;
}

export const BULK_CREATE_DEFAULT_MAX_ITEMS = 500;
export const BULK_CREATE_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const BULK_CREATE_MIN_MAX_BYTES = 64 * 1024;

export function readBulkCreateLimits(env: RelayFlagEnv | null | undefined): BulkCreateLimits {
	const source: RelayFlagEnv = { ...(testProcessEnv() as RelayFlagEnv | undefined ?? {}), ...(env ?? {}) };
	return {
		maxItems: positiveInt(source.YAOS_BULK_CREATE_MAX_ITEMS, BULK_CREATE_DEFAULT_MAX_ITEMS, 1, BULK_CREATE_DEFAULT_MAX_ITEMS),
		maxBytes: positiveInt(source.YAOS_BULK_CREATE_MAX_BYTES, BULK_CREATE_DEFAULT_MAX_BYTES,
			BULK_CREATE_MIN_MAX_BYTES, BULK_CREATE_DEFAULT_MAX_BYTES),
	};
}
