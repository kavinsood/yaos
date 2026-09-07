import { canonicalizeMarkdown } from "@shared/markdownCodec";

export const FRONTMATTER_BOUNDARY_VERSION = "frontmatter-boundary-v1" as const;
export type FrontmatterBoundaryVersion = typeof FRONTMATTER_BOUNDARY_VERSION;

export type MarkdownComponents =
	| {
		kind: "none";
		propertiesRegion: "";
		yamlText: "";
		body: string;
		bodyOffset: 0;
	}
	| {
		kind: "present";
		propertiesRegion: string;
		yamlText: string;
		body: string;
		bodyOffset: number;
		closingFence: "---" | "...";
	}
	| {
		kind: "ambiguous";
		reason: "missing-closing-fence";
		content: string;
	};

/** Split canonical Markdown without parsing or rewriting the YAML payload. */
export function splitMarkdownComponents(content: string): MarkdownComponents {
	const canonical = canonicalizeMarkdown(content);
	const firstLineEnd = lineEnd(canonical, 0);
	if (canonical.slice(0, firstLineEnd) !== "---") {
		return {
			kind: "none",
			propertiesRegion: "",
			yamlText: "",
			body: canonical,
			bodyOffset: 0,
		};
	}

	const yamlStart = advanceLine(canonical, firstLineEnd);
	let cursor = yamlStart;
	while (cursor < canonical.length) {
		const end = lineEnd(canonical, cursor);
		const line = canonical.slice(cursor, end);
		if (line === "---" || line === "...") {
			const bodyOffset = advanceLine(canonical, end);
			return {
				kind: "present",
				propertiesRegion: canonical.slice(0, bodyOffset),
				yamlText: canonical.slice(yamlStart, cursor),
				body: canonical.slice(bodyOffset),
				bodyOffset,
				closingFence: line,
			};
		}
		cursor = advanceLine(canonical, end);
	}

	return { kind: "ambiguous", reason: "missing-closing-fence", content: canonical };
}

export function composeMarkdownComponents(propertiesRegion: string, body: string): string {
	return canonicalizeMarkdown(propertiesRegion) + canonicalizeMarkdown(body);
}

export type BodyOnlyComposition =
	| {
		kind: "composed";
		content: string;
		heldPropertiesRegion: string;
		incomingPropertiesRegion: string;
		body: string;
	}
	| { kind: "ambiguous"; side: "current" | "incoming"; reason: string };

/** Hold the current properties bytes while admitting the incoming body bytes. */
export function composeBodyOnlyProgress(
	currentContent: string,
	incomingContent: string,
): BodyOnlyComposition {
	const current = splitMarkdownComponents(currentContent);
	if (current.kind === "ambiguous") {
		return { kind: "ambiguous", side: "current", reason: current.reason };
	}
	const incoming = splitMarkdownComponents(incomingContent);
	if (incoming.kind === "ambiguous") {
		return { kind: "ambiguous", side: "incoming", reason: incoming.reason };
	}
	return {
		kind: "composed",
		content: composeMarkdownComponents(current.propertiesRegion, incoming.body),
		heldPropertiesRegion: current.propertiesRegion,
		incomingPropertiesRegion: incoming.propertiesRegion,
		body: incoming.body,
	};
}

function lineEnd(content: string, start: number): number {
	const newline = content.indexOf("\n", start);
	return newline === -1 ? content.length : newline;
}

function advanceLine(content: string, end: number): number {
	return end < content.length && content.charCodeAt(end) === 10 ? end + 1 : end;
}
