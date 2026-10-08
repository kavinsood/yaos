/**
 * The device check on main (commands "YAOS: Run device check" and "YAOS: Run large attachment check (max size)"). The
 * engine runs every step in the worker, on its live ports (engine/compose/deviceCheck.ts); main only asks for it,
 * shows one line per step (deviceCheckModal.ts), and copies or saves the report as redacted JSON next to the
 * diagnostics files (diagnostics.ts redactedJson, YaosUiHost.writeDiagnosticsFile). Pure: no obsidian runtime import.
 */

import { relayHttpDeadlineMs } from "../../core/deadline";
import { MAX_BLOB_UPLOAD_BYTES } from "../../core/limits";
import { DEVICE_CHECK_QUICK_BYTES } from "../../protocol/messages";
import type { DeviceCheckMode, DeviceCheckReport, DeviceCheckStep } from "../../protocol/status";
import type { YaosUiHost } from "./api";
import { diagnosticsSettings, fileStamp, redactedJson } from "./diagnostics";

export const DEVICE_CHECK_FORMAT = "yaos-device-check/1";

/** The check's local work on a slow phone (random bytes, hashing, sealing), on top of its transfers. */
export const DEVICE_CHECK_LOCAL_MS = 60_000;

/**
 * The deviceCheck request's deadline: every test blob goes up and comes back, so its bytes twice over at the relay
 * HTTP floor rate (core/deadline.ts relayHttpDeadlineMs), plus the local work. The large check uses the engine's
 * max blob size as its status reports it (MAX_BLOB_UPLOAD_BYTES until it does). The engine's own idle windows end a
 * stalled transfer long before this; it only bounds an engine that never answers.
 */
export function deviceCheckDeadlineMs(mode: DeviceCheckMode, maxBlobBytes: number | null): number {
	const blobBytes = mode === "quick" ? DEVICE_CHECK_QUICK_BYTES.reduce((a, b) => a + b, 0) : maxBlobBytes ?? MAX_BLOB_UPLOAD_BYTES;
	return relayHttpDeadlineMs(2 * blobBytes) + DEVICE_CHECK_LOCAL_MS;
}

const mb = (bytes: number): string => `${Math.round(bytes / 1e5) / 10} MB`;

/** Asked before the large check. `maxBlobBytes`: the engine's current max blob size (status), null when unknown. */
export function largeCheckConfirm(maxBlobBytes: number | null): { readonly title: string; readonly message: string; readonly confirmText: string } {
	const size = maxBlobBytes !== null && maxBlobBytes > 0 ? `a ${mb(maxBlobBytes)} test file (the largest attachment this server takes)` : "a test file of the largest size this server takes";
	return {
		title: "Run the large attachment check?",
		message: `YAOS uploads ${size} over your current connection, downloads it again and checks it. It uses about 300 MB of memory, and twice the file's size in data.\n\n`
			+ "If the phone stops the sync engine for using too much memory, sync stops (\"YAOS stopped\") until you run \"Restart sync engine\". Your notes are not touched.",
		confirmText: "Run the check",
	};
}

/** Pretty JSON, keys sorted, every secret-looking key redacted (as diagnostics), with the non-secret settings. */
export function formatDeviceCheck(report: DeviceCheckReport, settings: ReturnType<typeof diagnosticsSettings>): string {
	return redactedJson({ format: DEVICE_CHECK_FORMAT, report, settings });
}

/** `yaos-device-check-<stamp>.json` / `yaos-large-attachment-check-<stamp>.json`. */
export function deviceCheckFileName(atMs: number, mode: DeviceCheckMode): string {
	return `yaos-${mode === "quick" ? "device-check" : "large-attachment-check"}-${fileStamp(atMs)}.json`;
}

const MARK: Readonly<Record<DeviceCheckStep["status"], string>> = { pass: "✓", fail: "✗", skip: "–" };

function duration(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms)} ms`;
}

/** One line per step: mark, name, time, detail. */
export function stepLine(s: DeviceCheckStep): string {
	return `${MARK[s.status]} ${s.name} · ${duration(s.ms)} · ${s.detail}`;
}

export function summaryLine(r: DeviceCheckReport): string {
	const failed = r.steps.filter((s) => s.status === "fail").length;
	const skipped = r.steps.filter((s) => s.status === "skip").length;
	const ran = r.steps.length - skipped;
	const skip = skipped > 0 ? `, ${skipped} skipped` : "";
	return failed === 0 ? `All ${ran} checks passed${skip} (${duration(r.totalMs)}).` : `${failed} of ${ran} checks failed${skip} (${duration(r.totalMs)}).`;
}

export interface DeviceCheckRun {
	readonly report: DeviceCheckReport;
	/** The redacted JSON the Copy and Save buttons hand on. */
	readonly text: string;
	readonly fileName: string;
}

/** Asks the engine for the check and formats its report. Rejects with a message safe to show. */
export async function runDeviceCheck(host: Pick<YaosUiHost, "deviceCheck" | "data" | "pluginVersion" | "runState">, mode: DeviceCheckMode): Promise<DeviceCheckRun> {
	const report = await host.deviceCheck(mode);
	return { report, text: formatDeviceCheck(report, diagnosticsSettings(host, false)), fileName: deviceCheckFileName(report.startedAtMs, mode) };
}
