export type FatalAuthCode =
	| "unauthorized"
	| "server_misconfigured"
	| "server_format_unsupported"
	| "unclaimed"
	| "update_required";

export interface FatalAuthMessage {
	code: FatalAuthCode;
	clientSchemaVersion: number | null;
	roomSchemaVersion: number | null;
	reason: string | null;
}

const FATAL_AUTH_CODES: Readonly<Record<FatalAuthCode, true>> = {
	unauthorized: true,
	server_misconfigured: true,
	server_format_unsupported: true,
	unclaimed: true,
	update_required: true,
};

export function parseFatalAuthMessage(payload: string): FatalAuthMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (
		record.type !== "error" ||
		typeof record.code !== "string" ||
		!Object.prototype.hasOwnProperty.call(FATAL_AUTH_CODES, record.code)
	) {
		return null;
	}
	return {
		code: record.code as FatalAuthCode,
		clientSchemaVersion:
			typeof record.clientSchemaVersion === "number" && Number.isInteger(record.clientSchemaVersion)
				? record.clientSchemaVersion
				: null,
		roomSchemaVersion:
			typeof record.roomSchemaVersion === "number" && Number.isInteger(record.roomSchemaVersion)
				? record.roomSchemaVersion
				: null,
		reason: typeof record.reason === "string" ? record.reason : null,
	};
}
