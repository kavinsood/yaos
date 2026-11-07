/**
 * Markdown conflict-artifact identity.
 *
 * Sibling notes written by ReconciliationController use a distinctive
 * filename. They are local-only safety copies: they must not enter the
 * CRDT or sync. Matching this pattern is the admission gate.
 *
 * Shape (see ReconciliationController.conflictArtifactPath):
 *   `<base> (YAOS conflict[- crdt|disk|editor] from <device> <stamp>)[ N].md`
 * Stamp is ISO-8601 with `:` replaced by `-`.
 */
const MARKDOWN_CONFLICT_ARTIFACT_RE =
	/ \(YAOS conflict(?: - (?:crdt|disk|editor))? from .+ \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\)(?: \d+)?\.[mM][dD]$/u;

export function isMarkdownConflictArtifactPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	const name = normalized.slice(normalized.lastIndexOf("/") + 1);
	return MARKDOWN_CONFLICT_ARTIFACT_RE.test(name);
}
