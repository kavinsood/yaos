/** Shared payload ceiling below the Durable Object SQLite 2 MB row limit. */
export const SQLITE_ROW_SAFE_BYTES = 1_750_000;
export const MAX_DURABLE_UPDATE_BYTES = SQLITE_ROW_SAFE_BYTES;
/** Leaves deterministic headroom for Yjs update structure and wire metadata. */
export const MAX_CLIENT_MARKDOWN_BYTES = 1_500_000;
export const MAX_CLIENT_MARKDOWN_KB = Math.ceil(MAX_CLIENT_MARKDOWN_BYTES / 1024);
