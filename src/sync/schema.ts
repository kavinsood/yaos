/**
 * Schema and wire pins shared by every schema-5 client transport.
 *
 * Schema 5 is a clean revisioned-attachment cutover. Older caches are never
 * opened or migrated by this runtime.
 */
export const SCHEMA_VERSION = 5;
export const PROTOCOL_VERSION = 1;
export const STORAGE_FORMAT_VERSION = 2;
export const SNAPSHOT_FORMAT_VERSION = 2;
