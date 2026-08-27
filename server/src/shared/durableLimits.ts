export const MAX_DURABLE_UPDATE_BYTES = 1_750_000;
/** Leaves deterministic headroom for Yjs update structure and wire metadata. */
export const MAX_CLIENT_MARKDOWN_BYTES = 1_500_000;
export const MAX_CLIENT_MARKDOWN_KB = Math.floor(MAX_CLIENT_MARKDOWN_BYTES / 1024);
