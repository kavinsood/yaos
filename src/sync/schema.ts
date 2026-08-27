/**
 * Schema and wire pins shared by every schema-4 client transport.
 *
 * Schema 4 is a clean root/body cutover. Older whole-vault caches are never
 * opened or migrated by this runtime.
 */
export const SCHEMA_VERSION = 4;
export const PROTOCOL_VERSION = 1;
export const STORAGE_FORMAT_VERSION = 1;
export const SNAPSHOT_FORMAT_VERSION = 2;
