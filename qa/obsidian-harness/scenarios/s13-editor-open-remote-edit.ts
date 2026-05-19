/**
 * s13-editor-open-remote-edit
 *
 * Device B has a Markdown file open in the editor (CRDT binding active).
 * Device A edits the same file through the normal YAOS path.
 * Device B must converge without duplication, stale echo, editor/CRDT mismatch,
 * disk/CRDT mismatch, or recovery old-state resurrection.
 *
 * Uses marker content so semantic duplication is detectable, not just hash equality.
 *
 * Acceptance:
 *   - B editorHash == crdtHash == diskHash == expectedHash
 *   - B editorSampleKind == healthy_sampled
 *   - final content has exactly one BASELINE and exactly one REMOTE_EDIT_FROM_A
 *   - no stale_hash_after_newer_witness
 *   - no recovery_emitted_old_hash
 *   - no editor_crdt_mismatch
 *   - no disk_crdt_mismatch
 */

export const SCENARIO_ID = "s13-editor-open-remote-edit";

export const INITIAL_CONTENT = "# S13 Editor Open Remote Edit\n\nBASELINE\n";
export const FINAL_CONTENT = "# S13 Editor Open Remote Edit\n\nBASELINE\nREMOTE_EDIT_FROM_A\n";

export const FORBIDDEN_DIVERGENCE_REASONS = [
	"stale_hash_after_newer_witness",
	"recovery_emitted_old_hash",
	"editor_crdt_mismatch",
	"disk_crdt_mismatch",
];
