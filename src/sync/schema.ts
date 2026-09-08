/**
 * Schema and wire pins shared by every schema-8 client transport.
 *
 * Schema 8 is the semantic Canvas cutover. Older caches are never
 * opened or migrated by this runtime.
 */
export const SCHEMA_VERSION = 8;
export const PROTOCOL_VERSION = 4;
export const STORAGE_FORMAT_VERSION = 3;
export const SNAPSHOT_FORMAT_VERSION = 3;
