/**
 * Product-owned recovery event types.
 *
 * These types describe the payload shapes for recovery.skipped events emitted
 * by ReconciliationController. They live here (not in telemetry/debug) because product
 * runtime code constructs and references them directly.
 *
 * The lab layer imports these when building flight event schemas.
 */

/**
 * Closed string-literal union covering every site at which
 * ReconciliationController calls shouldBlockFrontmatterIngest. Used as the
 * `branch` discriminator on `recovery.skipped` events with
 * `data.reason === "frontmatter-ingest-blocked"`. New emission sites
 * require extending this union AND updating the spec.
 *
 * See spec: .kiro/specs/frontmatter-guard-orchestration/requirements.md R2.
 */
export type FrontmatterIngestBlockBranch =
	| "disk-to-crdt-existing"
	| "disk-to-crdt-seed"
	| "bound-file-local-only-divergence"
	| "bound-file-local-only-seed"
	| "bound-file-open-idle-disk-recovery"
	| "bound-file-open-idle-seed";

/**
 * Typed payload shape for the `frontmatter-ingest-blocked` variant of
 * `recovery.skipped.data`. The helper
 * `ReconciliationController.recordFrontmatterIngestBlocked` is the only
 * production constructor of this payload.
 */
export type RecoverySkippedFrontmatterData = {
	reason: "frontmatter-ingest-blocked";
	wasBound: boolean;
	branch: FrontmatterIngestBlockBranch;
};
