/**
 * Product-owned recovery event types.
 *
 * These types describe the payload shapes for recovery.skipped events emitted
 * by ReconciliationController. They live here (not in telemetry/debug) because product
 * runtime code constructs and references them directly.
 *
 * This is the canonical and only home for these declarations. The flight
 * recorder imports them from here.
 */

/**
 * Closed-enum reason discriminator for `recovery.skipped` events. The
 * controller picks exactly one of these per emission. New reasons require
 * extending this union.
 *
 * - "crdt-current-no-op"          CRDT and disk already agree.
 * - "recovery-lock-active"        bound recovery lock is still active.
 * - "recent-editor-activity"      crdtOnly branch idle-grace bail.
 * - "disk-unchanged-since-settlement" disk still equals its settled
 *                                 baseline, so it carries no local edit;
 *                                 a differing body is ahead and wins.
 * - "frontmatter-ingest-blocked"  shouldBlockFrontmatterIngest returned
 *                                 true at one of the six block sites.
 *                                 See FrontmatterIngestBlockBranch.
 */
export type RecoverySkippedReason =
	| "crdt-current-no-op"
	| "recovery-lock-active"
	| "recent-editor-activity"
	| "recent-editor-activity-local-only"
	| "disk-unchanged-since-settlement"
	| "frontmatter-ingest-blocked";

/**
 * Closed string-literal union covering every site at which
 * ReconciliationController calls shouldBlockFrontmatterIngest. Used as the
 * `branch` discriminator on `recovery.skipped` events with
 * `data.reason === "frontmatter-ingest-blocked"`. New emission sites
 * require extending this union.
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
