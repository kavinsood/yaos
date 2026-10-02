/**
 * Client view of the `POST /lifecycle/create-bulk` caps. The server's effective
 * caps (`YAOS_BULK_CREATE_MAX_ITEMS` / `YAOS_BULK_CREATE_MAX_BYTES`, which can
 * only lower the protocol defaults) arrive as `bulkCreate` in
 * `/api/capabilities` and in every create-bulk 413 body. Frame bytes are only
 * estimated before encoding, so the client byte budget keeps the same 7/8
 * margin under the server byte cap as the default 3.5 MiB / 4 MiB.
 */

/** Protocol defaults (mirror `server/src/relayFlag.ts`). */
export const BULK_CREATE_MAX_ITEMS = 500;
export const BULK_CREATE_MAX_BYTES = 4 * 1024 * 1024;
/** Client-side split budget: frame bytes are estimated, so stay under the server cap. */
export const BULK_CREATE_CLIENT_BYTE_BUDGET = Math.floor(3.5 * 1024 * 1024);

export interface BulkCreateServerCaps {
	maxItems: number;
	maxBytes: number;
}

export interface BulkCreateClientCaps {
	maxItems: number;
	byteBudget: number;
}

export const DEFAULT_BULK_CREATE_CLIENT_CAPS: Readonly<BulkCreateClientCaps> = Object.freeze({
	maxItems: BULK_CREATE_MAX_ITEMS,
	byteBudget: BULK_CREATE_CLIENT_BYTE_BUDGET,
});

/** Tolerant parse: a malformed or absent value means "server did not say" (null). */
export function parseBulkCreateServerCaps(value: unknown): BulkCreateServerCaps | null {
	if (typeof value !== "object" || value === null) return null;
	const { maxItems, maxBytes } = value as Record<string, unknown>;
	if (typeof maxItems !== "number" || !Number.isSafeInteger(maxItems) || maxItems < 1) return null;
	if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
	return { maxItems, maxBytes };
}

/** The tightest of the defaults and every server-reported cap. */
export function bulkCreateClientCaps(...servers: Readonly<Array<BulkCreateServerCaps | null | undefined>>): BulkCreateClientCaps {
	let maxItems = BULK_CREATE_MAX_ITEMS;
	let byteBudget = BULK_CREATE_CLIENT_BYTE_BUDGET;
	for (const server of servers) {
		if (!server) continue;
		maxItems = Math.min(maxItems, server.maxItems);
		byteBudget = Math.min(byteBudget, Math.max(1, Math.floor(server.maxBytes * 7 / 8)));
	}
	return { maxItems, byteBudget };
}
