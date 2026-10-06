import { createHash, randomBytes } from "node:crypto";

const utf8 = new TextEncoder();
const T0 = performance.now();

/** Milliseconds since the suite started (monotonic). */
export const now = () => Math.round((performance.now() - T0) * 10) / 10;
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const id = (bytes = 12) => randomBytes(bytes).toString("base64url");
export const b64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
export const sha256hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
	if (!a || !b || a.byteLength !== b.byteLength) return false;
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/** Deterministic, label-tagged payload of at least `size` bytes. */
export function payloadOf(label: string, size = 0): Uint8Array {
	const head = utf8.encode(`${label}|`);
	const out = new Uint8Array(Math.max(head.byteLength, size));
	out.set(head);
	for (let i = head.byteLength; i < out.byteLength; i++) out[i] = (i * 31 + label.length) & 0xff;
	return out;
}

export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((x, y) => x - y);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const round = (value: number) => Math.round(value * 10) / 10;

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Recursively collects arrays of objects that carry a string `deviceId`. */
export function findDeviceEntries(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).deviceId === "string") {
				out.push(item as Record<string, unknown>);
			} else findDeviceEntries(item, out);
		}
	} else if (value && typeof value === "object") {
		for (const child of Object.values(value)) findDeviceEntries(child, out);
	}
	return out;
}

/** Keys anywhere in `value` that look like credential material. */
export function tokenLikeKeys(value: unknown, path = "", out: string[] = []): string[] {
	if (Array.isArray(value)) value.forEach((item, index) => tokenLikeKeys(item, `${path}[${index}]`, out));
	else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (/token|secret|hash|key/i.test(key)) out.push(`${path}.${key}`.replace(/\[\d+\]/g, "[]"));
			tokenLikeKeys(child, `${path}.${key}`, out);
		}
	}
	return [...new Set(out)];
}
