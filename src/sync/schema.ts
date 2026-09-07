/**
 * Schema and wire pins shared by every schema-6 client transport.
 *
 * Schema 6 is a clean semantic-frontmatter cutover. Older caches are never
 * opened or migrated by this runtime.
 */
export const SCHEMA_VERSION = 6;
export const PROTOCOL_VERSION = 2;
export const STORAGE_FORMAT_VERSION = 2;
export const SNAPSHOT_FORMAT_VERSION = 2;
