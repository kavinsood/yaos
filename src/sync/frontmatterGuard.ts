import yaml from "js-yaml";

export type FrontmatterRisk = "ok" | "warn" | "block" | "unknown";
export type FieldPolicy = "register" | "ordered-list" | "set-like" | "opaque";

export interface FrontmatterValidationResult {
	risk: FrontmatterRisk;
	reasons: string[];
	frontmatterLength: number | null;
	previousFrontmatterLength?: number | null;
}

type FrontmatterBlock =
	| { kind: "none" }
	| { kind: "malformed"; reason: string }
	| {
		kind: "present";
		frontmatterText: string;
		bodyText: string;
		start: number;
		end: number;
	};

type ParsedFrontmatter = {
	root: Record<string, unknown> | null;
	blockReasons: string[];
	warnReasons: string[];
};

type ValueKind = "null" | "scalar" | "array" | "object";

const FRONTMATTER_OPEN = "---";
const FRONTMATTER_CLOSE = new Set(["---", "..."]);

const FIELD_POLICIES: Record<string, FieldPolicy> = {
	aliases: "ordered-list",
	cssclasses: "set-like",
	tags: "set-like",
	timeestimate: "register",
	tasksourcetype: "register",
	title: "register",
};

export function validateFrontmatterTransition(
	previousContent: string | null | undefined,
	nextContent: string,
): FrontmatterValidationResult {
	const previousBlock = previousContent != null ? extractFrontmatter(previousContent) : { kind: "none" as const };
	const next = extractFrontmatter(nextContent);
	const previousLength = previousBlock.kind === "present" ? previousBlock.frontmatterText.length : null;

	if (next.kind === "none") {
		return {
			risk: "ok",
			reasons: [],
			frontmatterLength: null,
			previousFrontmatterLength: previousLength,
		};
	}

	if (next.kind === "malformed") {
		return {
			risk: "block",
			reasons: [`malformed-frontmatter:${next.reason}`],
			frontmatterLength: null,
			previousFrontmatterLength: previousLength,
		};
	}

	const blockReasons = new Set<string>();
	const warnReasons = new Set<string>();

	const nextLength = next.frontmatterText.length;
	if (
		previousLength != null
		&& previousLength > 0
		&& nextLength > previousLength * 2
		&& nextLength - previousLength > 128
	) {
		blockReasons.add("frontmatter-growth-burst");
	}

	const parsedNext = parseFrontmatter(next.frontmatterText);
	addReasons(blockReasons, parsedNext.blockReasons);
	addReasons(warnReasons, parsedNext.warnReasons);

	if (parsedNext.root) {
		const parsedPrevious =
			previousBlock.kind === "present" && previousBlock.frontmatterText !== next.frontmatterText
				? parseFrontmatter(previousBlock.frontmatterText)
				: { root: {} as Record<string, unknown>, blockReasons: [], warnReasons: [] };
		const policyAnalysis = analyzeFieldPolicies(parsedPrevious.root ?? {}, parsedNext.root);
		addReasons(blockReasons, policyAnalysis.blockReasons);
		addReasons(warnReasons, policyAnalysis.warnReasons);
	}

	return {
		risk:
			blockReasons.size > 0
				? "block"
				: (warnReasons.size > 0 ? "warn" : "ok"),
		reasons:
			blockReasons.size > 0
				? Array.from(blockReasons).sort()
				: Array.from(warnReasons).sort(),
		frontmatterLength: nextLength,
		previousFrontmatterLength: previousLength,
	};
}

export function isFrontmatterBlocked(result: FrontmatterValidationResult): boolean {
	return result.risk === "block";
}

export function extractFrontmatter(content: string): FrontmatterBlock {
	const firstLineEnd = findLineEnd(content, 0);
	const firstLine = content.slice(0, firstLineEnd).trim();
	if (firstLine !== FRONTMATTER_OPEN) {
		return { kind: "none" };
	}

	let cursor = advancePastLineBreak(content, firstLineEnd);
	const frontmatterStart = cursor;
	while (cursor < content.length) {
		const lineEnd = findLineEnd(content, cursor);
		const line = content.slice(cursor, lineEnd).trim();
		if (FRONTMATTER_CLOSE.has(line)) {
			const bodyStart = advancePastLineBreak(content, lineEnd);
			return {
				kind: "present",
				frontmatterText: content.slice(frontmatterStart, cursor),
				bodyText: content.slice(bodyStart),
				start: frontmatterStart,
				end: cursor,
			};
		}
		cursor = advancePastLineBreak(content, lineEnd);
	}

	return { kind: "malformed", reason: "missing-closing-fence" };
}

export function getFieldPolicy(fieldName: string): FieldPolicy {
	return FIELD_POLICIES[normalizeFieldName(fieldName)] ?? "opaque";
}

/**
 * Extract a specific block reason from a js-yaml duplicate-key exception.
 *
 * js-yaml throws "duplicated mapping key (line:col)" when it encounters a
 * duplicate key.  The key name is absent from the message string, but
 * `err.mark.line` (0-indexed) points to the offending line in the parsed text,
 * so we can extract the key name directly from the source without a second
 * parse.  Falls back to the generic "yaml-parse-duplicate-key" if position
 * information is unavailable or extraction fails.
 */
function duplicateKeyReason(err: unknown, frontmatterText: string): string {
	if (!(err instanceof Error)) return "yaml-parse-error";
	if (!err.message.includes("duplicated mapping key")) return "yaml-parse-error";
	try {
		const mark = (err as { mark?: { line: number } }).mark;
		if (mark != null) {
			const line = (frontmatterText.split("\n")[mark.line] ?? "").trim();
			// Quoted key: "foo": ... or 'foo': ...
			const quotedMatch = /^(["'])(.+?)\1\s*:/.exec(line);
			if (quotedMatch) return `duplicate-key:${quotedMatch[2]}`;
			// Unquoted key: foo: ...  (first colon is the key-value separator)
			const colonIdx = line.indexOf(":");
			if (colonIdx > 0) return `duplicate-key:${line.slice(0, colonIdx).trim()}`;
		}
	} catch {
		// Position extraction failed; return the generic duplicate reason.
	}
	return "yaml-parse-duplicate-key";
}

function parseFrontmatter(frontmatterText: string): ParsedFrontmatter {
	try {
		const parsed = yaml.load(frontmatterText);
		if (parsed == null) {
			return {
				root: {},
				blockReasons: [],
				warnReasons: [],
			};
		}

		// A frontmatter block must be a YAML mapping (key-value pairs).
		// Bare scalars, sequences, and any other non-map root type are invalid
		// Obsidian frontmatter and must be blocked, not merely warned about.
		if (!isPlainObject(parsed)) {
			return {
				root: null,
				blockReasons: ["frontmatter-non-map-root"],
				warnReasons: [],
			};
		}

		return {
			root: parsed,
			blockReasons: [],
			warnReasons: [],
		};
	} catch (error) {
		return {
			root: null,
			blockReasons: [duplicateKeyReason(error, frontmatterText)],
			warnReasons: [],
		};
	}
}

function analyzeFieldPolicies(
	previousRoot: Record<string, unknown>,
	nextRoot: Record<string, unknown>,
): { blockReasons: string[]; warnReasons: string[] } {
	const blockReasons = new Set<string>();
	const warnReasons = new Set<string>();
	const allKeys = new Set([
		...Object.keys(previousRoot),
		...Object.keys(nextRoot),
	]);

	for (const key of allKeys) {
		const policy = getFieldPolicy(key);
		if (policy === "opaque") continue;

		const hasPrevious = Object.prototype.hasOwnProperty.call(previousRoot, key);
		const hasNext = Object.prototype.hasOwnProperty.call(nextRoot, key);
		if (!hasNext) continue;

		const nextValue = nextRoot[key];
		if (policy === "set-like" && Array.isArray(nextValue) && hasDuplicateNormalizedValues(nextValue)) {
			warnReasons.add(`set-like-duplicates:${key}`);
		}

		if (!hasPrevious) continue;
		const previousValue = previousRoot[key];
		const previousKind = getValueKind(previousValue);
		const nextKind = getValueKind(nextValue);
		if (previousKind === nextKind) continue;

		if (policy === "register") {
			blockReasons.add(`field-type-flip:${key}:${previousKind}->${nextKind}`);
			continue;
		}

		if ((policy === "ordered-list" || policy === "set-like")
			&& (previousKind === "array" || nextKind === "array")) {
			blockReasons.add(`field-type-flip:${key}:${previousKind}->${nextKind}`);
		}
	}

	return {
		blockReasons: Array.from(blockReasons),
		warnReasons: Array.from(warnReasons),
	};
}

function normalizeFieldName(fieldName: string): string {
	return fieldName.trim().toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object"
		&& value !== null
		&& !Array.isArray(value)
		&& !(value instanceof Date);
}

function getValueKind(value: unknown): ValueKind {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (value instanceof Date) return "scalar";
	if (typeof value === "object") return "object";
	return "scalar";
}

function hasDuplicateNormalizedValues(values: unknown[]): boolean {
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = normalizeValue(value);
		if (seen.has(normalized)) return true;
		seen.add(normalized);
	}
	return false;
}

function normalizeValue(value: unknown): string {
	if (value instanceof Date) {
		return `date:${value.toISOString()}`;
	}
	if (Array.isArray(value) || isPlainObject(value)) {
		return JSON.stringify(value);
	}
	return `${typeof value}:${String(value)}`;
}

function addReasons(target: Set<string>, reasons: string[]): void {
	for (const reason of reasons) {
		target.add(reason);
	}
}

function findLineEnd(content: string, start: number): number {
	const newline = content.indexOf("\n", start);
	if (newline === -1) return content.length;
	return content.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
}

function advancePastLineBreak(content: string, lineEnd: number): number {
	if (lineEnd >= content.length) return content.length;
	if (content.charCodeAt(lineEnd) === 13 && content.charCodeAt(lineEnd + 1) === 10) {
		return lineEnd + 2;
	}
	if (content.charCodeAt(lineEnd) === 10) {
		return lineEnd + 1;
	}
	if (content.charCodeAt(lineEnd) === 13) {
		return lineEnd + 1;
	}
	return lineEnd;
}
