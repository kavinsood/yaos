/**
 * Schema and wire pins shared by every schema-7 client transport.
 *
 * Schema 7 is the principal-aware collaboration cutover. Older caches are never
 * opened or migrated by this runtime.
 */
export const SCHEMA_VERSION = 7;
export const PROTOCOL_VERSION = 3;
export const STORAGE_FORMAT_VERSION = 2;
export const SNAPSHOT_FORMAT_VERSION = 2;
