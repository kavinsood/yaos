/** Shared payload ceiling below the Durable Object SQLite 2 MB row limit. */
export const SQLITE_ROW_SAFE_BYTES = 1_750_000;
export const MAX_DURABLE_UPDATE_BYTES = SQLITE_ROW_SAFE_BYTES;
/** Logical, canonical UTF-8 Markdown ceiling. Durable CRDT frames remain row-bounded. */
export const MAX_CLIENT_MARKDOWN_BYTES = 5 * 1024 * 1024;
export const MAX_CLIENT_MARKDOWN_KB = Math.ceil(MAX_CLIENT_MARKDOWN_BYTES / 1024);
/**
 * Aggregate wire ceiling for one logical Markdown candidate. The extra MiB
 * covers CRDT structure while every durable frame is still independently
 * constrained by MAX_DURABLE_UPDATE_BYTES.
 */
export const MAX_CANDIDATE_UPDATE_BYTES = 6 * 1024 * 1024;
/** Prevents a tiny-frame CPU/SQLite amplification attack. */
export const MAX_CANDIDATE_UPDATE_FRAMES = 16;
