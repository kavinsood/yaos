/**
 * Diagnostics export (DESIGN §j.7): exportDiagnostics command -> canonical JSON -> file under
 * <configDir>/plugins/yaos/diagnostics/ -> clipboard. Pure orchestration: the Notice and the
 * clipboard are injected, so no obsidian runtime import.
 *
 * The bundle type carries no secrets; formatDiagnostics adds nothing (no identity, no host) and
 * additionally redacts any secret-looking key should one ever appear.
 */

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

/** Pretty JSON with recursively sorted keys (stable across runs), plus a format tag. */
export function formatDiagnostics(bundle: DiagnosticsBundle): string {
	return `${JSON.stringify(canonicalize({ format: DIAGNOSTICS_FORMAT, bundle }, 0), null, 2)}\n`;
}

/** `yaos-diagnostics-2026-10-05T12-34-56-789Z.json` (no ':' so the name is valid on every OS). */
export function diagnosticsFileName(atMs: number): string {
	const iso = new Date(Number.isFinite(atMs) ? atMs : 0).toISOString().replace(/[:.]/g, "-");
	return `yaos-diagnostics-${iso}.json`;
}

export interface ExportDiagnosticsDeps {
	notify(message: string, level: "info" | "error"): void;
	/** Clipboard writer; omitted or rejecting means "not copied". */
	copyText?: (text: string) => Promise<void>;
}

export interface ExportDiagnosticsResult {
	readonly path: string;
	readonly copied: boolean;
}

/** Runs the export end to end. Never throws: failures are reported through notify and return null. */
export async function exportDiagnostics(
	host: Pick<YaosUiHost, "command" | "writeDiagnosticsFile">,
	deps: ExportDiagnosticsDeps,
): Promise<ExportDiagnosticsResult | null> {
	let text: string;
	let name: string;
	try {
		const result = await host.command({ t: "exportDiagnostics" });
		if (result.t !== "diagnostics") throw new Error("the sync engine returned no diagnostics");
		text = formatDiagnostics(result.bundle);
		name = diagnosticsFileName(result.bundle.generatedAtMs);
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
	deps.notify(copied ? `Diagnostics saved to ${path} and copied to the clipboard.` : `Diagnostics saved to ${path}.`, "info");
	return { path, copied };
}
