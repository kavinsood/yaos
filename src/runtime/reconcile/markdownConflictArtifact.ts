import type { App } from "obsidian";
import { canonicalizeMarkdown } from "@shared/markdownCodec";

export type MarkdownConflictSource = "crdt" | "disk" | "editor";

export interface MarkdownConflictArtifactOptions {
	deviceName: string;
	reason: string;
	source?: MarkdownConflictSource;
	trace?: (message: string, details: Record<string, unknown>) => void;
}

function conflictArtifactParts(
	path: string,
	deviceName: string,
	source: MarkdownConflictSource | undefined,
	now: Date,
): { dir: string; base: string; ext: string; prefix: string; suffix: string } {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.toLowerCase().endsWith(".md") ? name.length - 3 : -1;
	const rawBase = dot >= 0 ? name.slice(0, dot) : name;
	const ext = dot >= 0 ? name.slice(dot) : ".md";
	const device = (deviceName.replace(/[\\/:*?"<>|]/g, "-").trim() || "unknown-device").slice(0, 50);
	const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
	const sourcePart = source ? ` - ${source}` : "";
	const suffix = ` (YAOS conflict${sourcePart} from ${device} ${stamp})`;
	const maxBase = Math.max(20, 255 - suffix.length - ext.length - 4);
	const base = rawBase.slice(0, Math.min(100, maxBase));
	return { dir, base, ext, suffix, prefix: `${dir}${base} (YAOS conflict${sourcePart} from ` };
}

export function markdownConflictArtifactPath(
	path: string,
	deviceName: string,
	source?: MarkdownConflictSource,
	now = new Date(),
): string {
	const { dir, base, suffix, ext } = conflictArtifactParts(path, deviceName, source, now);
	return `${dir}${base}${suffix}${ext}`;
}

/**
 * An existing conflict copy of `path` from the same source with exactly this
 * content (canonical bytes), or null. Conflict copies are timestamped, and the
 * in-memory dedupe of the callers does not survive a restart, so without this
 * every daemon restart that re-detects the same unresolved divergence wrote
 * another copy. Only sibling files named `<base> (YAOS conflict[ - source] from …`
 * are read; the scan runs only when a conflict copy is about to be written.
 */
export async function findExistingMarkdownConflictArtifact(
	app: App,
	path: string,
	content: string,
	deviceName: string,
	source?: MarkdownConflictSource,
): Promise<string | null> {
	const { prefix, ext } = conflictArtifactParts(path, deviceName, source, new Date(0));
	const files = typeof app.vault.getMarkdownFiles === "function" ? app.vault.getMarkdownFiles() : [];
	for (const file of files) {
		if (!file.path.startsWith(prefix) || !file.path.endsWith(ext)) continue;
		try {
			if (canonicalizeMarkdown(await app.vault.read(file)) === content) return file.path;
		} catch {
			// Unreadable or vanished: not a usable copy.
		}
	}
	return null;
}

export async function createMarkdownConflictArtifact(
	app: App,
	path: string,
	content: string,
	options: MarkdownConflictArtifactOptions,
): Promise<string> {
	content = canonicalizeMarkdown(content);
	const existing = await findExistingMarkdownConflictArtifact(app, path, content, options.deviceName, options.source);
	if (existing !== null) {
		options.trace?.("conflict-artifact-reused", {
			path,
			conflictPath: existing,
			reason: options.reason,
			source: options.source ?? null,
			contentLength: content.length,
		});
		return existing;
	}
	const basePath = markdownConflictArtifactPath(path, options.deviceName, options.source);
	for (let index = 0; index < 100; index++) {
		const candidate = index === 0 ? basePath : basePath.replace(/(\.md)?$/, ` ${index + 1}$1`);
		if (app.vault.getAbstractFileByPath(candidate)) continue;
		await app.vault.create(candidate, content);
		options.trace?.("conflict-artifact-created", {
			path,
			conflictPath: candidate,
			reason: options.reason,
			source: options.source ?? null,
			contentLength: content.length,
		});
		return candidate;
	}
	throw new Error(`could not create conflict artifact for ${path}`);
}
