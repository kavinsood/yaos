/**
 * Diagnostics export (DESIGN §j.7): exportDiagnostics command -> canonical JSON -> file under
 * <configDir>/plugins/yaos/diagnostics/ -> clipboard. Pure orchestration: the Notice and the
 * clipboard are injected, so no obsidian runtime import.
 *
 * The bundle type carries no secrets. The export adds a `settings` section built from an allowlist
 * (never the device token), and formatDiagnostics redacts any secret-looking key at any depth
 * should one ever appear.
 */

import type { EngineSettings } from "../../protocol/messages";
import type { DiagnosticsBundle } from "../../protocol/status";
import type { YaosUiHost } from "./api";
import { errorMessage } from "./format";

export const DIAGNOSTICS_FORMAT = "yaos-diagnostics/1";

/** Keys never written to a diagnostics file, at any depth (case-insensitive substring match). */
const SECRET_KEY_PARTS = ["token", "credential", "secret", "password", "ticket", "pairingcode", "recoverykey", "authorization", "cookie", "apikey"];

export function isSecretKey(key: string): boolean {
	const k = key.toLowerCase().replace(/[^a-z]/g, "");
	return SECRET_KEY_PARTS.some((part) => k.includes(part));
}

function canonicalize(value: unknown, depth: number): unknown {
	if (depth > 32) return "[too deep]";
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map((v) => canonicalize(v, depth + 1));
	if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v === undefined || typeof v === "function") continue;
			out[key] = isSecretKey(key) ? "[redacted]" : canonicalize(v, depth + 1);
		}
		return out;
	}
	return null;
}

/**
 * Non-secret settings written next to the bundle. Identity fields are picked one by one, so the
 * device token (or any field added to the identity later) never gets in; engine settings hold no
 * secrets. Exclude patterns often name folders, so only their count is written unless the user chose
 * to include file names.
 */
export interface DiagnosticsSettings {
	readonly pluginVersion: string;
	readonly transport: "worker" | "inline" | null;
	readonly host: string | null;
	readonly vaultId: string | null;
	readonly deviceId: string | null;
	readonly deviceLabel: string;
	readonly engine: Omit<EngineSettings, "excludePatterns"> & { readonly excludePatternCount: number; readonly excludePatterns?: readonly string[] };
}

export function diagnosticsSettings(host: Pick<YaosUiHost, "data" | "pluginVersion" | "runState">, includePaths: boolean): DiagnosticsSettings {
	const data = host.data();
	const id = data.identity;
	const { excludePatterns, ...engine } = data.engine;
	return {
		pluginVersion: host.pluginVersion,
		transport: host.runState().transport,
		host: id?.host ?? null,
		vaultId: id?.vaultId ?? null,
		deviceId: id?.deviceId ?? null,
		deviceLabel: data.deviceLabel,
		engine: { ...engine, excludePatternCount: excludePatterns.length, ...(includePaths ? { excludePatterns: [...excludePatterns] } : {}) },
	};
}

/** Pretty JSON with recursively sorted keys (stable across runs) and every secret-looking key redacted. */
export function redactedJson(value: unknown): string {
	return `${JSON.stringify(canonicalize(value, 0), null, 2)}\n`;
}

/** Pretty JSON with recursively sorted keys (stable across runs), plus a format tag. */
export function formatDiagnostics(bundle: DiagnosticsBundle, settings?: DiagnosticsSettings): string {
	return redactedJson({ format: DIAGNOSTICS_FORMAT, bundle, settings });
}

/** `2026-10-05T12-34-56-789Z`: an ISO time with no ':' or '.', valid in a file name on every OS. */
export function fileStamp(atMs: number): string {
	return new Date(Number.isFinite(atMs) ? atMs : 0).toISOString().replace(/[:.]/g, "-");
}

/**
 * `yaos-diagnostics-2026-10-05T12-34-56-789Z.json`; `...-with-file-names.json` when the file lists vault paths.
 */
export function diagnosticsFileName(atMs: number, includePaths = false): string {
	return `yaos-diagnostics-${fileStamp(atMs)}${includePaths ? "-with-file-names" : ""}.json`;
}

/** Asked before exportDiagnostics{includePaths: true}. */
export const DIAGNOSTICS_WITH_PATHS_CONFIRM = Object.freeze({
	title: "Export diagnostics with file names?",
	message: "The diagnostics file will also list the folder and file names of the files it mentions (frozen notes, quarantined changes, held changes, recent sync events) and your excluded-path patterns. It still contains no note contents and no device token.\n\nShare it only with someone you are happy to show those names to.",
	confirmText: "Export with file names",
});

export interface ExportDiagnosticsDeps {
	notify(message: string, level: "info" | "error"): void;
	/** Clipboard writer; omitted or rejecting means "not copied". */
	copyText?: (text: string) => Promise<void>;
}

export interface ExportDiagnosticsResult {
	readonly path: string;
	readonly copied: boolean;
}

/**
 * Runs the export end to end (the caller confirms includePaths first). Never throws: failures are
 * reported through notify and return null.
 */
export async function exportDiagnostics(
	host: Pick<YaosUiHost, "command" | "writeDiagnosticsFile" | "data" | "pluginVersion" | "runState">,
	deps: ExportDiagnosticsDeps,
	options: { readonly includePaths: boolean } = { includePaths: false },
): Promise<ExportDiagnosticsResult | null> {
	const { includePaths } = options;
	let text: string;
	let name: string;
	try {
		const result = await host.command({ t: "exportDiagnostics", includePaths });
		if (result.t !== "diagnostics") throw new Error("the sync engine returned no diagnostics");
		text = formatDiagnostics(result.bundle, diagnosticsSettings(host, includePaths));
		name = diagnosticsFileName(result.bundle.generatedAtMs, includePaths);
	} catch (err) {
		deps.notify(`Could not collect diagnostics: ${errorMessage(err)}`, "error");
		return null;
	}
	let path: string;
	try {
		path = await host.writeDiagnosticsFile(name, text);
	} catch (err) {
		deps.notify(`Could not save diagnostics: ${errorMessage(err)}`, "error");
		return null;
	}
	let copied = false;
	if (deps.copyText) {
		try {
			await deps.copyText(text);
			copied = true;
		} catch {
			copied = false;
		}
	}
	const what = includePaths ? "Diagnostics (with file names)" : "Diagnostics";
	deps.notify(copied ? `${what} saved to ${path} and copied to the clipboard.` : `${what} saved to ${path}.`, "info");
	return { path, copied };
}
