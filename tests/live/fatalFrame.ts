import type YSyncProvider from "y-partyserver/provider";
import type { FatalAuthCode } from "../../server/src/routes/types.ts";

/** Schema-4 edge rejection carried on the y-partyserver control channel. */
export interface FatalFrame {
	readonly type: "error";
	readonly code: FatalAuthCode;
	readonly reason?: string;
	readonly clientSchemaVersion?: number | null;
	readonly serverSchemaVersion?: number;
	readonly clientProtocolVersion?: number | null;
	readonly serverProtocolVersion?: number;
}

const FATAL_AUTH_CODES: Readonly<Record<FatalAuthCode, true>> = {
	unauthorized: true,
	server_misconfigured: true,
	unclaimed: true,
	server_format_unsupported: true,
	update_required: true,
};

function readInteger(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function parseFatalFrame(text: string): FatalFrame | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const value = parsed as Record<string, unknown>;
	if (value.type !== "error" || typeof value.code !== "string" || !Object.hasOwn(FATAL_AUTH_CODES, value.code)) return null;
	return {
		type: "error",
		code: value.code as FatalAuthCode,
		reason: typeof value.reason === "string" ? value.reason : undefined,
		clientSchemaVersion: readInteger(value.clientSchemaVersion),
		serverSchemaVersion: readInteger(value.serverSchemaVersion) ?? undefined,
		clientProtocolVersion: readInteger(value.clientProtocolVersion),
		serverProtocolVersion: readInteger(value.serverProtocolVersion) ?? undefined,
	};
}

export function describeFatalFrame(frame: FatalFrame): string {
	const details: string[] = [frame.code];
	if (frame.reason) details.push(frame.reason);
	if (frame.clientSchemaVersion !== undefined) details.push(`schema-client=${frame.clientSchemaVersion}`);
	if (frame.serverSchemaVersion !== undefined) details.push(`schema-server=${frame.serverSchemaVersion}`);
	if (frame.clientProtocolVersion !== undefined) details.push(`protocol-client=${frame.clientProtocolVersion}`);
	if (frame.serverProtocolVersion !== undefined) details.push(`protocol-server=${frame.serverProtocolVersion}`);
	return details.join("/");
}

/** Register before connect: schema-4 rejections are a single `__YPS:` control payload. */
export function onFatalFrame(provider: YSyncProvider, handler: (frame: FatalFrame) => void): void {
	provider.on("custom-message", (payload: string) => {
		const frame = parseFatalFrame(payload);
		if (frame) handler(frame);
	});
}
