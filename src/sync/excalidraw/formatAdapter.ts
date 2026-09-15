import LZString from "lz-string";
import { MAX_EXCALIDRAW_INITIALIZE_BYTES, MAX_EXCALIDRAW_SCENE_ELEMENTS,
	canonicalExcalidrawJson } from "@shared/excalidrawProtocol";
import { sha256TextHex } from "../../utils/sha256";
import { validateExcalidrawElement } from "./canonical";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "./types";

const MAX_AUXILIARY_BYTES = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_SCENE_BYTES = 16 * 1024 * 1024;
const DRAWING_OPEN = /(^|\n)(##? Drawing)\r?\n```(json|compressed-json)\r?\n/g;

export type ExcalidrawDiskFormat = "excalidraw-json" | "obsidian-excalidraw-markdown";

export interface ExcalidrawContainerAuxiliary {
	format: ExcalidrawDiskFormat;
	compressed: boolean;
	prefix: string;
	suffix: string;
	newline: "\n" | "\r\n";
	trailingNewline: boolean;
	sceneFields: Record<string, unknown>;
}

export interface ParsedExcalidrawContainer {
	format: ExcalidrawDiskFormat;
	elements: ExcalidrawElementRecord[];
	files: ExcalidrawNativeFile[];
	auxiliary: ExcalidrawContainerAuxiliary;
	canonicalSceneHash: string;
	roundTripProven: true;
}

export type ExcalidrawContainerParseResult =
	| { kind: "valid"; value: ParsedExcalidrawContainer }
	| { kind: "unsupported"; reason: string }
	| { kind: "invalid"; reason: string }
	| { kind: "oversized"; reason: string; measured: number; maximum: number };

interface ExtractedScene {
	format: ExcalidrawDiskFormat;
	compressed: boolean;
	sceneJson: string;
	prefix: string;
	suffix: string;
	newline: "\n" | "\r\n";
	trailingNewline: boolean;
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function extractMarkdown(text: string): ExtractedScene | ExcalidrawContainerParseResult {
	DRAWING_OPEN.lastIndex = 0;
	const match = DRAWING_OPEN.exec(text);
	if (!match) return { kind: "unsupported", reason: "Markdown file has no fenced Excalidraw Drawing section" };
	if (DRAWING_OPEN.exec(text)) return { kind: "invalid", reason: "Markdown file contains multiple Drawing sections" };
	const bodyStart = match.index + match[0].length;
	const newline = match[0].includes("\r\n") ? "\r\n" : "\n";
	const fence = `${newline}\`\`\``;
	const bodyEnd = text.indexOf(fence, bodyStart);
	if (bodyEnd < 0) return { kind: "invalid", reason: "Drawing code fence is unterminated" };
	const prefix = text.slice(0, bodyStart);
	const suffix = text.slice(bodyEnd);
	const userHeader = text.slice(0, match.index + (match[1]?.length ?? 0));
	if (/^excalidraw-onload-script\s*:/im.test(userHeader) || /```/.test(userHeader)) {
		return { kind: "unsupported", reason: "executable or unproven Markdown auxiliary content blocks semantic promotion" };
	}
	if (utf8Bytes(prefix) + utf8Bytes(suffix) > MAX_AUXILIARY_BYTES) {
		return { kind: "oversized", reason: "Markdown auxiliary container exceeds its bound",
			measured: utf8Bytes(prefix) + utf8Bytes(suffix), maximum: MAX_AUXILIARY_BYTES };
	}
	const compressed = match[3] === "compressed-json";
	const encoded = text.slice(bodyStart, bodyEnd);
	const sceneJson = compressed ? LZString.decompressFromBase64(encoded.replace(/[\r\n]/g, "")) : encoded;
	if (sceneJson === null) return { kind: "invalid", reason: "compressed Drawing payload cannot be decompressed" };
	return { format: "obsidian-excalidraw-markdown", compressed, sceneJson, prefix, suffix, newline,
		trailingNewline: text.endsWith(newline) };
}

function nativeFiles(value: unknown): ExcalidrawNativeFile[] | null {
	if (value === undefined) return [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const files: ExcalidrawNativeFile[] = [];
	for (const [fileId, unknownFile] of Object.entries(value as Record<string, unknown>)) {
		if (!unknownFile || typeof unknownFile !== "object" || Array.isArray(unknownFile)) return null;
		const file = unknownFile as Partial<ExcalidrawNativeFile>;
		if (file.id !== fileId || typeof file.dataURL !== "string" || typeof file.mimeType !== "string"
			|| !Number.isSafeInteger(file.created) || (file.created as number) < 0) return null;
		files.push({ ...(unknownFile as ExcalidrawNativeFile) });
	}
	return files;
}

function compressScene(value: string, newline: string): string {
	const compressed = LZString.compressToBase64(value);
	const chunks: string[] = [];
	for (let offset = 0; offset < compressed.length; offset += 256) chunks.push(compressed.slice(offset, offset + 256));
	return chunks.join(`${newline}${newline}`);
}

/** Bounded closed-file adapter for official JSON and current plugin Markdown containers. */
export class ExcalidrawFormatAdapter {
	async parse(bytes: Uint8Array): Promise<ExcalidrawContainerParseResult> {
		if (bytes.byteLength > MAX_EXCALIDRAW_INITIALIZE_BYTES) return { kind: "oversized",
			reason: "Excalidraw container exceeds initialization bound", measured: bytes.byteLength,
			maximum: MAX_EXCALIDRAW_INITIALIZE_BYTES };
		let text: string;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch { return { kind: "invalid", reason: "Excalidraw container is not valid UTF-8" }; }
		const trimmed = text.trim();
		let extracted: ExtractedScene | ExcalidrawContainerParseResult;
		if (trimmed.startsWith("{")) {
			extracted = { format: "excalidraw-json", compressed: false, sceneJson: trimmed, prefix: "", suffix: "",
				newline: text.includes("\r\n") ? "\r\n" : "\n", trailingNewline: /\r?\n$/.test(text) };
		} else extracted = extractMarkdown(text);
		if ("kind" in extracted) return extracted;
		const sceneBytes = utf8Bytes(extracted.sceneJson);
		if (sceneBytes > MAX_DECOMPRESSED_SCENE_BYTES) return { kind: "oversized",
			reason: "decoded Excalidraw scene exceeds its bound", measured: sceneBytes, maximum: MAX_DECOMPRESSED_SCENE_BYTES };
		let unknownScene: unknown;
		try { unknownScene = JSON.parse(extracted.sceneJson) as unknown; }
		catch { return { kind: "invalid", reason: "Drawing payload is not valid JSON" }; }
		if (!unknownScene || typeof unknownScene !== "object" || Array.isArray(unknownScene)) {
			return { kind: "invalid", reason: "Drawing payload must be an object" };
		}
		const scene = unknownScene as Record<string, unknown>;
		if (scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
			return { kind: "unsupported", reason: "Drawing payload is not a supported Excalidraw scene" };
		}
		if (scene.elements.length > MAX_EXCALIDRAW_SCENE_ELEMENTS) return { kind: "oversized",
			reason: "Excalidraw scene element count exceeds its bound", measured: scene.elements.length,
			maximum: MAX_EXCALIDRAW_SCENE_ELEMENTS };
		let elements: ExcalidrawElementRecord[];
		try {
			elements = scene.elements.map(validateExcalidrawElement);
			if (new Set(elements.map((element) => element.id)).size !== elements.length) throw new Error("duplicate IDs");
		} catch { return { kind: "invalid", reason: "Drawing contains invalid or duplicate native elements" }; }
		const files = nativeFiles(scene.files);
		if (!files) return { kind: "invalid", reason: "Drawing contains invalid binary-file metadata" };
		const sceneFields = Object.fromEntries(Object.entries(scene).filter(([key]) => key !== "elements" && key !== "files"));
		let canonicalScene: string;
		try { canonicalScene = canonicalExcalidrawJson({ sceneFields, elements }); }
		catch { return { kind: "invalid", reason: "Drawing contains noncanonical JSON values" }; }
		const auxiliary: ExcalidrawContainerAuxiliary = { format: extracted.format, compressed: extracted.compressed,
			prefix: extracted.prefix, suffix: extracted.suffix, newline: extracted.newline,
			trailingNewline: extracted.trailingNewline, sceneFields };
		const value: ParsedExcalidrawContainer = { format: extracted.format, elements, files, auxiliary,
			canonicalSceneHash: await sha256TextHex(canonicalScene), roundTripProven: true };
		const materialized = this.materialize(value, elements, files);
		const verification = await this.parseWithoutRoundTrip(materialized);
		if (!verification || verification.canonicalSceneHash !== value.canonicalSceneHash
			|| canonicalExcalidrawJson(verification.auxiliary.sceneFields) !== canonicalExcalidrawJson(sceneFields)) {
			return { kind: "unsupported", reason: "Drawing container cannot be proven round-trippable" };
		}
		return { kind: "valid", value };
	}

	materialize(container: ParsedExcalidrawContainer, elements: readonly ExcalidrawElementRecord[],
		files: readonly ExcalidrawNativeFile[]): Uint8Array {
		const validated = elements.map(validateExcalidrawElement);
		const fileMap = Object.fromEntries(files.map((file) => [file.id, file]));
		const scene = { ...container.auxiliary.sceneFields, elements: validated, files: fileMap };
		const json = JSON.stringify(scene, null, "\t");
		let text: string;
		if (container.format === "excalidraw-json") text = json + (container.auxiliary.trailingNewline ? container.auxiliary.newline : "");
		else {
			const payload = container.auxiliary.compressed ? compressScene(json, container.auxiliary.newline) : json;
			text = container.auxiliary.prefix + payload + container.auxiliary.suffix;
		}
		const bytes = new TextEncoder().encode(text);
		if (bytes.byteLength > MAX_EXCALIDRAW_INITIALIZE_BYTES) throw new Error("materialized Excalidraw container exceeds its bound");
		return bytes;
	}

	private async parseWithoutRoundTrip(bytes: Uint8Array): Promise<ParsedExcalidrawContainer | null> {
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			const extracted = text.trim().startsWith("{")
				? { format: "excalidraw-json" as const, compressed: false, sceneJson: text.trim(), prefix: "", suffix: "",
					newline: text.includes("\r\n") ? "\r\n" as const : "\n" as const, trailingNewline: /\r?\n$/.test(text) }
				: extractMarkdown(text);
			if ("kind" in extracted) return null;
			const scene = JSON.parse(extracted.sceneJson) as Record<string, unknown>;
			const elements = (scene.elements as unknown[]).map(validateExcalidrawElement);
			const files = nativeFiles(scene.files); if (!files) return null;
			const sceneFields = Object.fromEntries(Object.entries(scene).filter(([key]) => key !== "elements" && key !== "files"));
			return { format: extracted.format, elements, files, auxiliary: { format: extracted.format,
				compressed: extracted.compressed, prefix: extracted.prefix, suffix: extracted.suffix,
				newline: extracted.newline, trailingNewline: extracted.trailingNewline, sceneFields },
				canonicalSceneHash: await sha256TextHex(canonicalExcalidrawJson({ sceneFields, elements })), roundTripProven: true };
		} catch { return null; }
	}
}
