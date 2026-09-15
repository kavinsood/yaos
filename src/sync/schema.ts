/**
 * Schema and wire pins shared by every schema-10 client transport.
 *
 * Schema 10 is the browser-publication cutover. Older caches are never
 * opened or migrated by this runtime.
 */
export const SCHEMA_VERSION = 10;
export const PROTOCOL_VERSION = 8;
export const STORAGE_FORMAT_VERSION = 6;
export const SNAPSHOT_FORMAT_VERSION = 4;
