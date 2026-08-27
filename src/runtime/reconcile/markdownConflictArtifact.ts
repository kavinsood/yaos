import type { App } from "obsidian";

export type MarkdownConflictSource = "crdt" | "disk" | "editor";

export interface MarkdownConflictArtifactOptions {
	deviceName: string;
	reason: string;
	source?: MarkdownConflictSource;
	trace?: (message: string, details: Record<string, unknown>) => void;
}

export function markdownConflictArtifactPath(
	path: string,
	deviceName: string,
	source?: MarkdownConflictSource,
	now = new Date(),
): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.toLowerCase().endsWith(".md") ? name.length - 3 : -1;
	const base = dot >= 0 ? name.slice(0, dot) : name;
	const ext = dot >= 0 ? name.slice(dot) : ".md";
	const device = (deviceName.replace(/[\\/:*?"<>|]/g, "-").trim() || "unknown-device").slice(0, 50);
	const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
	const sourcePart = source ? ` - ${source}` : "";
	const suffix = ` (YAOS conflict${sourcePart} from ${device} ${stamp})`;
	const maxBase = Math.max(20, 255 - suffix.length - ext.length - 4);
	return `${dir}${base.slice(0, Math.min(100, maxBase))}${suffix}${ext}`;
}

export async function createMarkdownConflictArtifact(
	app: App,
	path: string,
	content: string,
	options: MarkdownConflictArtifactOptions,
): Promise<string> {
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
