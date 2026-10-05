/**
 * Small formatting helpers for UI copy. Pure: no obsidian runtime, no DOM.
 * Ported in part from legacy-src/utils/format.ts (formatUnknown).
 */

const MAX_ERROR_CHARS = 300;

/** Human text for an unknown thrown value, bounded in length. */
export function errorMessage(value: unknown): string {
	let text: string;
	if (value instanceof Error) text = value.message || value.name;
	else if (typeof value === "string") text = value;
	else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") text = String(value);
	else if (value && typeof value === "object" && "message" in value && typeof (value as { message: unknown }).message === "string") {
		text = (value as { message: string }).message;
	} else text = "Unknown error";
	text = text.trim() || "Unknown error";
	return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** "850 ms", "12 s", "3 min", "2 h". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0 s";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s} s`;
	const min = Math.round(s / 60);
	if (min < 90) return `${min} min`;
	return `${Math.round(min / 60)} h`;
}

/** "just now", "5 min ago", "2 h ago". */
export function formatAgo(atMs: number, nowMs: number): string {
	const d = nowMs - atMs;
	if (d < 30_000) return "just now";
	return `${formatDuration(d)} ago`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i] ?? "TiB"}`;
}

/** Abbreviate long opaque ids for display: "abcd…wxyz". */
export function shortenMiddle(value: string, keep = 6): string {
	return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** Fixed-width mask for a secret: never reveals any character or the length. */
export function maskSecret(secret: string | null | undefined): string {
	return secret ? "••••••••••••" : "(none)";
}
