/**
 * Reader for the Worker's fatal socket-rejection frame.
 *
 * WHY THIS FILE EXISTS
 * rejectSocket() in server/src/routes/syncSocket.ts sends the same JSON payload
 * twice and then closes the socket with 1008: once as a plain text frame (for
 * generic websocket clients) and once prefixed with "__YPS:" (for
 * y-partyserver clients). The provider does NOT re-emit a "message" event of
 * its own. It consumes the prefixed copy, strips the 6-character prefix, and
 * emits "custom-message" with the bare JSON string — verified in
 * node_modules/y-partyserver/dist/provider/index.js:107-114:
 *
 *     if (event.data.startsWith("__YPS:")) {
 *       const customMessage = event.data.slice(6);
 *       provider.emit("custom-message", [customMessage]);
 *     }
 *
 * Five live suites listened on provider.on("message", ...) instead, an event
 * that never fires, so a rejected connection was invisible to them: they sat
 * out their timeouts and reported "timed out waiting for sync" instead of the
 * server's actual reason. onFatalFrame() is the correct wiring.
 *
 * Raw `ws` sockets are a different story: a real socket does emit "message",
 * and it sees the unprefixed copy. Those listeners are correct as written and
 * feed their frame text straight to parseFatalFrame().
 */

import type YSyncProvider from "y-partyserver/provider";
import type { FatalAuthCode } from "../../server/src/routes/types.ts";

/**
 * The rejection payload built by rejectSocket(): `{ type: "error", code }` plus
 * whichever details the failing admission check attached
 * (server/src/routes/syncSocket.ts:188-256). `clientSchemaVersion` is
 * explicitly `null` — not absent — when the client declared no schema at all.
 */
export interface FatalFrame {
	readonly type: "error";
	readonly code: FatalAuthCode;
	readonly reason?: string;
	readonly clientSchemaVersion?: number | null;
	readonly roomSchemaVersion?: number | null;
	readonly serverSchemaVersion?: number;
}

/**
 * Exhaustive by construction: adding a code to the server's FatalAuthCode union
 * fails to compile here until it is listed, so a new rejection code can never
 * become a frame these suites silently ignore.
 */
const FATAL_AUTH_CODES: Readonly<Record<FatalAuthCode, true>> = {
	unauthorized: true,
	server_misconfigured: true,
	unclaimed: true,
	server_format_unsupported: true,
	update_required: true,
};

function isFatalAuthCode(value: string): value is FatalAuthCode {
	return Object.hasOwn(FATAL_AUTH_CODES, value);
}

/** Integer, explicit null, or absent — anything else is not a schema version. */
function readSchemaVersion(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value === "number" && Number.isInteger(value)) return value;
	return undefined;
}

/**
 * Parse one frame body. Returns null for anything that is not a fatal
 * rejection: non-JSON text, other custom messages (server SV echoes share the
 * "__YPS:" channel), and error-shaped payloads carrying an unknown code.
 * Never throws.
 */
export function parseFatalFrame(text: string): FatalFrame | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	// Property-by-property narrowing: `in` on an `object` intersects the checked
	// key in, so every field below is read as `unknown` and validated once.
	if (typeof parsed !== "object" || parsed === null) return null;
	if (!("type" in parsed) || parsed.type !== "error") return null;
	if (!("code" in parsed)) return null;
	const code = parsed.code;
	if (typeof code !== "string" || !isFatalAuthCode(code)) return null;
	const reason = "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : undefined;
	const serverSchemaVersion =
		"serverSchemaVersion" in parsed
		&& typeof parsed.serverSchemaVersion === "number"
		&& Number.isInteger(parsed.serverSchemaVersion)
			? parsed.serverSchemaVersion
			: undefined;
	return {
		type: "error",
		code,
		reason,
		clientSchemaVersion: readSchemaVersion("clientSchemaVersion" in parsed ? parsed.clientSchemaVersion : undefined),
		roomSchemaVersion: readSchemaVersion("roomSchemaVersion" in parsed ? parsed.roomSchemaVersion : undefined),
		serverSchemaVersion,
	};
}

/** Human-readable one-liner for assertion messages. */
export function describeFatalFrame(frame: FatalFrame): string {
	const parts: string[] = [frame.code];
	if (frame.reason !== undefined) parts.push(frame.reason);
	if (frame.clientSchemaVersion !== undefined) parts.push(`client=${frame.clientSchemaVersion}`);
	if (frame.roomSchemaVersion !== undefined) parts.push(`room=${frame.roomSchemaVersion}`);
	if (frame.serverSchemaVersion !== undefined) parts.push(`server=${frame.serverSchemaVersion}`);
	return parts.join("/");
}

/**
 * Observe fatal rejection frames on a y-partyserver provider.
 *
 * Register this immediately after constructing the provider and before
 * connect(): the server sends the frame and closes in the same turn, so a late
 * listener misses it.
 *
 * No cast is needed. YProvider extends lib0's deprecated `Observable<string>`,
 * whose signature is `on(name: string, f: Function)`, so a precisely typed
 * listener is accepted directly.
 */
export function onFatalFrame(
	provider: YSyncProvider,
	handler: (frame: FatalFrame) => void,
): void {
	provider.on("custom-message", (payload: string) => {
		const frame = parseFatalFrame(payload);
		if (frame) handler(frame);
	});
}
