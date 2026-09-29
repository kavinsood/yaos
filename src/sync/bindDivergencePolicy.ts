import { canonicalizeMarkdown } from "@shared/markdownCodec";
import { splitMarkdownComponents } from "./frontmatterBoundary";
import { mergeThreeWayText } from "./threeWayMerge";
import type { BindDivergenceDecision } from "./editorBinding";

/**
 * What the disk index knows about the last disk/body agreement of a path,
 * as seen by bind-time divergence resolution.
 *
 * - "whole": the full canonical content hash (and its content, if known).
 * - "body-only": only the Markdown body settled (properties were held by the
 *   frontmatter guard), so only body components can be compared.
 * - "unknown": no baseline, a baseline from another local incarnation, or a
 *   hash computed under an older canonical-Markdown version.
 */
export type BindDivergenceBaseline =
	| { kind: "whole"; hash: string; content: string | null }
	| { kind: "body-only"; bodyHash: string; propertiesHash: string }
	| { kind: "unknown"; reason: "missing" | "untrusted" | "canonical-version" };

export interface BindDivergenceInput {
	path: string;
	editorContent: string;
	bodyContent: string;
}

export interface BindDivergencePolicyDeps {
	getBaseline(path: string): Promise<BindDivergenceBaseline>;
	hash(content: string): Promise<string>;
	/** Write the conflict note; must throw if it could not be written. */
	createArtifact(path: string, content: string, reason: string): Promise<string>;
	notify(message: string): void;
	log?(message: string): void;
	now?(): number;
}

/** Repeated identical resolutions of one (path, editor, body) triple. */
export class BindDivergenceQuarantinedError extends Error {
	/** Retrying an identical resolution cannot help (editorBinding). */
	readonly nonRetryable = true as const;
	constructor(readonly path: string, readonly attempts: number) {
		super(`bind divergence for "${path}" repeated ${attempts} times; quarantined`);
	}
}

const QUARANTINE_WINDOW_MS = 60_000;
const QUARANTINE_MAX_ATTEMPTS = 4;
const PRESERVED_MAX = 512;

/**
 * Decide which side of a bind-time editor/body divergence holds local input.
 *
 * Obsidian loads the editor from disk, so an editor equal to the baseline
 * carries no edit and the body wins; a body equal to the baseline carries
 * nothing the editor lacks and the editor wins. When both moved, or nothing
 * is known, the editor text is preserved as a conflict note before the body
 * (the durable, converged state) is shown - preservation before convergence.
 *
 * Artifacts are deduplicated per (path, editor content) for the session, so
 * re-resolving the same editor text never writes another copy, and identical
 * repeated resolutions are quarantined (docs/sync-contract.md, open/editor-
 * bound divergence).
 */
export class BindDivergencePolicy {
	private readonly preserved = new Map<string, string>();
	private readonly attempts = new Map<string, { count: number; firstAt: number }>();

	constructor(private readonly deps: BindDivergencePolicyDeps) {}

	async resolve(input: BindDivergenceInput): Promise<BindDivergenceDecision> {
		const editor = canonicalizeMarkdown(input.editorContent);
		const body = canonicalizeMarkdown(input.bodyContent);
		if (editor === body) return "adopt-body";

		const [editorHash, bodyHash] = await Promise.all([this.deps.hash(editor), this.deps.hash(body)]);
		this.countAttempt(input.path, editorHash, bodyHash);
		const baseline = await this.deps.getBaseline(input.path);

		if (baseline.kind === "whole") {
			if (editorHash === baseline.hash) return "adopt-body";
			if (bodyHash === baseline.hash) return "adopt-editor";
			if (baseline.content !== null) {
				const merge = mergeThreeWayText(canonicalizeMarkdown(baseline.content), editor, body);
				if (merge.kind === "clean") {
					// Everything the editor changed is already in the body.
					if (merge.content === body) return "adopt-body";
					// Everything the body changed is already in the editor.
					if (merge.content === editor) return "adopt-editor";
					// Disjoint edits on both sides: both are kept in the merge.
					return { kind: "adopt-merged", content: merge.content };
				}
			}
			return this.preserveEditor(input.path, editor, editorHash, "bind-divergence-both-changed");
		}

		if (baseline.kind === "body-only") {
			const editorParts = splitMarkdownComponents(editor);
			const bodyParts = splitMarkdownComponents(body);
			if (editorParts.kind !== "ambiguous" && bodyParts.kind !== "ambiguous") {
				const [editorBodyHash, bodyBodyHash, editorPropertiesHash] = await Promise.all([
					this.deps.hash(editorParts.body),
					this.deps.hash(bodyParts.body),
					this.deps.hash(editorParts.propertiesRegion),
				]);
				const editorPropertiesKnown = editorParts.propertiesRegion === bodyParts.propertiesRegion
					|| editorPropertiesHash === baseline.propertiesHash;
				if (editorBodyHash === baseline.bodyHash && editorPropertiesKnown) return "adopt-body";
				if (bodyBodyHash === baseline.bodyHash && editorParts.propertiesRegion === bodyParts.propertiesRegion) {
					return "adopt-editor";
				}
			}
			return this.preserveEditor(input.path, editor, editorHash, "bind-divergence-body-only-both-changed");
		}

		// Unknown baseline: ambiguity follows conservative preservation.
		return this.preserveEditor(
			input.path,
			editor,
			editorHash,
			baseline.reason === "missing" ? "bind-divergence-no-baseline" : `bind-divergence-${baseline.reason}-baseline`,
		);
	}

	private async preserveEditor(
		path: string,
		editor: string,
		editorHash: string,
		reason: string,
	): Promise<BindDivergenceDecision> {
		const key = `${path}\u0000${editorHash}`;
		const existing = this.preserved.get(key);
		if (existing !== undefined) {
			this.deps.log?.(`bind divergence "${path}": editor text already preserved as "${existing}"`);
			return "adopt-body";
		}
		// Throws when the note cannot be written: the caller must then keep
		// both sides untouched (no convergence without preservation).
		const conflictPath = await this.deps.createArtifact(path, editor, reason);
		this.preserved.set(key, conflictPath);
		for (const oldest of this.preserved.keys()) {
			if (this.preserved.size <= PRESERVED_MAX) break;
			this.preserved.delete(oldest);
		}
		this.deps.notify(`YAOS preserved diverged editor text of “${path}” as “${conflictPath}”.`);
		return "adopt-body";
	}

	private countAttempt(path: string, editorHash: string, bodyHash: string): void {
		const now = this.deps.now?.() ?? Date.now();
		const key = `${path}\u0000${editorHash}\u0000${bodyHash}`;
		const previous = this.attempts.get(key);
		const entry = previous && now - previous.firstAt <= QUARANTINE_WINDOW_MS
			? { count: previous.count + 1, firstAt: previous.firstAt }
			: { count: 1, firstAt: now };
		this.attempts.set(key, entry);
		for (const oldest of this.attempts.keys()) {
			if (this.attempts.size <= PRESERVED_MAX) break;
			this.attempts.delete(oldest);
		}
		if (entry.count > QUARANTINE_MAX_ATTEMPTS) throw new BindDivergenceQuarantinedError(path, entry.count);
	}
}
