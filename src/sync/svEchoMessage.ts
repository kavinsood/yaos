/**
 * Wire format helpers for the yaos/sv-echo custom message.
 *
 * Transport: y-partyserver __YPS: string channel.
 * Payload:   JSON { type: "yaos/sv-echo", schema: 1, sv: <base64> }.
 *
 * Both helpers are pure and Obsidian-free — tested under Node.
 */

import * as Y from "yjs";
import { MAX_SV_ECHO_BASE64_BYTES, SV_ECHO_SCHEMA, SV_ECHO_TYPE } from "./svEchoProtocol";

export { MAX_SV_ECHO_BASE64_BYTES, SV_ECHO_SCHEMA, SV_ECHO_TYPE } from "./svEchoProtocol";

export type SvEchoParseFailureReason =
	| "wrong_schema"
	| "missing_sv"
	| "oversize"
	| "invalid_base64"
	| "invalid_state_vector";

export type SvEchoParseResult =
	| { kind: "not_sv_echo"; bytes: number }
	| { kind: "valid_sv_echo"; sv: Uint8Array; bytes: number }
	| { kind: "invalid_sv_echo"; reason: SvEchoParseFailureReason; bytes: number };

export type SvEchoCounters = {
	customMessageSeenCount: number;
	svEchoSeenCount: number;
	acceptedCount: number;
	rejectedCount: number;
	rejectedOversizeCount: number;
	rejectedInvalidCount: number;
	bytesMax: number;
};

export function createSvEchoCounters(): SvEchoCounters {
	return {
		customMessageSeenCount: 0,
		svEchoSeenCount: 0,
		acceptedCount: 0,
		rejectedCount: 0,
		rejectedOversizeCount: 0,
		rejectedInvalidCount: 0,
		bytesMax: 0,
	};
}

export function recordSvEchoParseResult(counters: SvEchoCounters, result: SvEchoParseResult): void {
	counters.customMessageSeenCount++;
	if (result.kind === "not_sv_echo") return;
	counters.svEchoSeenCount++;
	counters.bytesMax = Math.max(counters.bytesMax, result.bytes);
	if (result.kind === "valid_sv_echo") {
		counters.acceptedCount++;
		return;
	}
	counters.rejectedCount++;
	if (result.reason === "oversize") {
		counters.rejectedOversizeCount++;
	} else {
		counters.rejectedInvalidCount++;
	}
}

export function handleSvEchoCustomMessage(
	payload: string,
	counters: SvEchoCounters,
	onAcceptedSvEcho: (sv: Uint8Array) => void,
): SvEchoParseResult {
	const result = parseSvEchoMessageDetailed(payload);
	recordSvEchoParseResult(counters, result);
	if (result.kind === "valid_sv_echo") onAcceptedSvEcho(result.sv);
	return result;
}

/**
 * Encode a state vector into a custom-message JSON string.
 * Use the result as the argument to sendCustomMessage().
 */
export function makeSvEchoMessage(sv: Uint8Array): string {
	return JSON.stringify({
		type: SV_ECHO_TYPE,
		schema: SV_ECHO_SCHEMA,
		sv: encodeBytesBase64(sv),
	});
}

/**
 * Parse an incoming custom-message string from provider.on("custom-message").
 * Returns the decoded state vector bytes, or null for any invalid/unknown message.
 * Never throws.
 */
export function parseSvEchoMessage(msg: string): Uint8Array | null {
	const result = parseSvEchoMessageDetailed(msg);
	return result.kind === "valid_sv_echo" ? result.sv : null;
}

export function parseSvEchoMessageDetailed(msg: string): SvEchoParseResult {
	const bytes = new TextEncoder().encode(msg).byteLength;
	let parsed: unknown;
	try { parsed = JSON.parse(msg); } catch { return { kind: "not_sv_echo", bytes }; }
	if (typeof parsed !== "object" || parsed === null) return { kind: "not_sv_echo", bytes };
	const p = parsed as Record<string, unknown>;
	if (p.type !== SV_ECHO_TYPE) return { kind: "not_sv_echo", bytes };
	if (p.schema !== SV_ECHO_SCHEMA) return { kind: "invalid_sv_echo", reason: "wrong_schema", bytes };
	if (typeof p.sv !== "string") return { kind: "invalid_sv_echo", reason: "missing_sv", bytes };
	if (p.sv.length > MAX_SV_ECHO_BASE64_BYTES) return { kind: "invalid_sv_echo", reason: "oversize", bytes };
	const decoded = decodeBytesBase64(p.sv);
	if (!decoded) return { kind: "invalid_sv_echo", reason: "invalid_base64", bytes };
	try {
		Y.decodeStateVector(decoded);
	} catch {
		return { kind: "invalid_sv_echo", reason: "invalid_state_vector", bytes };
	}
	return { kind: "valid_sv_echo", sv: decoded, bytes };
}

/**
 * Byte-safe base64 encoder. Uses chunked String.fromCharCode to avoid the
 * argument-list limit that causes `btoa(String.fromCharCode(...largeArray))`
 * to throw on arrays larger than ~65k entries.
 */
export function encodeBytesBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		s += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return btoa(s);
}

/**
 * Byte-safe base64 decoder. Returns null for any invalid base64 input.
 */
export function decodeBytesBase64(s: string): Uint8Array | null {
	try {
		const binary = atob(s);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}
