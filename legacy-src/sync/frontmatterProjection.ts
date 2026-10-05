import { composeMarkdownComponents, splitMarkdownComponents } from "./frontmatterBoundary";
import {
	parseSemanticFrontmatter,
	type FrontmatterSemanticSnapshot,
	type SemanticFieldSnapshot,
	type SemanticScalar,
} from "./frontmatterSemanticModel";

export type FrontmatterProjectionResult =
	| { kind: "unchanged"; content: string }
	| { kind: "projected"; content: string; changedFields: string[] }
	| { kind: "opaque"; content: string; reason: string };

interface SourceEntry {
	field: string;
	start: number;
	end: number;
	source: string;
}

interface Patch {
	start: number;
	end: number;
	text: string;
	field: string;
}

/** Project only known simple keys; every unrelated source byte is retained. */
export function projectFrontmatterSemantics(
	content: string,
	snapshot: FrontmatterSemanticSnapshot,
): FrontmatterProjectionResult {
	const split = splitMarkdownComponents(content);
	if (split.kind === "ambiguous") return { kind: "opaque", content, reason: split.reason };
	const parsed = parseSemanticFrontmatter(content);
	if (parsed.kind === "opaque") return { kind: "opaque", content, reason: parsed.reason };
	const currentFields = parsed.fields;
	const currentYaml = split.kind === "present" ? split.yamlText : "";
	const scanned = scanEntries(currentYaml);
	if (scanned.kind === "opaque") return { kind: "opaque", content, reason: scanned.reason };

	const patches: Patch[] = [];
	const changed = new Set<string>();
	const allFields = new Set([...currentFields.keys(), ...Object.keys(snapshot.fields)]);
	for (const field of allFields) {
		const current = currentFields.get(field);
		const desired = snapshot.fields[field];
		if (fieldEqual(current, desired)) continue;
		const entry = scanned.entries.get(field);
		if (current && !entry) {
			return { kind: "opaque", content, reason: `unlocated-source:${field}` };
		}
		if (!desired) {
			if (!entry) continue;
			if (!entryIsSurgicallyReplaceable(entry.source)) {
				return { kind: "opaque", content, reason: `unsupported-source:${field}` };
			}
			patches.push({ start: entry.start, end: entry.end, text: "", field });
			changed.add(field);
			continue;
		}
		const rendered = renderField(desired);
		if (rendered === null) return { kind: "opaque", content, reason: `unsupported-value:${field}` };
		if (entry) {
			if (!entryIsSurgicallyReplaceable(entry.source)) {
				return { kind: "opaque", content, reason: `unsupported-source:${field}` };
			}
			patches.push({ start: entry.start, end: entry.end, text: rendered, field });
		} else {
			const separator = currentYaml.length === 0 || currentYaml.endsWith("\n") ? "" : "\n";
			patches.push({ start: currentYaml.length, end: currentYaml.length, text: separator + rendered, field });
		}
		changed.add(field);
	}
	if (patches.length === 0) return { kind: "unchanged", content };

	let yamlText = currentYaml;
	for (const patch of patches.sort((left, right) => right.start - left.start || right.end - left.end)) {
		yamlText = yamlText.slice(0, patch.start) + patch.text + yamlText.slice(patch.end);
	}
	const propertiesRegion = yamlText.length === 0 && Object.keys(snapshot.fields).length === 0
		? ""
		: split.kind === "present"
			? `---\n${yamlText}${split.propertiesRegion.slice(4 + split.yamlText.length)}`
			: `---\n${yamlText}---\n`;
	return {
		kind: "projected",
		content: composeMarkdownComponents(propertiesRegion, split.body),
		changedFields: Array.from(changed).sort(),
	};
}

function scanEntries(yamlText: string):
	| { kind: "scanned"; entries: Map<string, SourceEntry> }
	| { kind: "opaque"; reason: string } {
	const entries = new Map<string, SourceEntry>();
	const lines = linesWithOffsets(yamlText);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.text.trim() === "" || line.text.trimStart().startsWith("#")) continue;
		if (/^\s/.test(line.text)) continue;
		const match = /^([A-Za-z0-9_-]+):(?:\s|$)/.exec(line.text);
		if (!match) continue;
		const field = match[1]!.toLowerCase();
		if (entries.has(field)) return { kind: "opaque", reason: `duplicate-key:${field}` };
		let end = line.end;
		for (let next = index + 1; next < lines.length; next++) {
			const candidate = lines[next]!;
			if (candidate.text !== "" && !/^\s/.test(candidate.text) && !candidate.text.startsWith("#")) break;
			end = candidate.end;
			index = next;
		}
		const source = yamlText.slice(line.start, end);
		entries.set(field, { field, start: line.start, end, source });
	}
	return { kind: "scanned", entries };
}

function entryIsSurgicallyReplaceable(source: string): boolean {
	if (/[&*!]/.test(source) || /(^|\s)<<\s*:/.test(source)) return false;
	const lines = source.replace(/\n$/, "").split("\n");
	if (lines.some((line) => line.trimStart().startsWith("#") || /\s#/.test(line))) return false;
	if (lines.length === 1) return !/[[\]{}]/.test(lines[0]!);
	return lines.slice(1).every((line) => line.trim() === "" || /^\s{2}-\s+[^#]+$/.test(line));
}

function renderField(field: SemanticFieldSnapshot): string | null {
	if (field.policy === "register") {
		if (Array.isArray(field.value)) return null;
		return `${field.key}: ${renderScalar(field.value)}\n`;
	}
	const values = Array.isArray(field.value) ? field.value : [field.value];
	if (values.length === 0) return `${field.key}: []\n`;
	return `${field.key}:\n${values.map((value) => `  - ${renderScalar(value)}\n`).join("")}`;
}

function renderScalar(value: SemanticScalar): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function fieldEqual(
	left: SemanticFieldSnapshot | undefined,
	right: SemanticFieldSnapshot | undefined,
): boolean {
	if (!left || !right) return left === right;
	if (left.policy !== right.policy) return false;
	if (left.policy === "set-like") {
		const leftValues = (Array.isArray(left.value) ? left.value : [left.value]).map(normalizeScalar).sort();
		const rightValues = (Array.isArray(right.value) ? right.value : [right.value]).map(normalizeScalar).sort();
		return JSON.stringify(leftValues) === JSON.stringify(rightValues);
	}
	return JSON.stringify(left.value) === JSON.stringify(right.value);
}

function normalizeScalar(value: SemanticScalar): string {
	return `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
}

function linesWithOffsets(content: string): Array<{ text: string; start: number; end: number }> {
	const result: Array<{ text: string; start: number; end: number }> = [];
	let start = 0;
	while (start < content.length) {
		const newline = content.indexOf("\n", start);
		const end = newline === -1 ? content.length : newline + 1;
		result.push({ text: content.slice(start, newline === -1 ? end : newline), start, end });
		start = end;
	}
	return result;
}
