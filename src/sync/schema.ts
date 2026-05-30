/**
 * YAOS CRDT schema version constant.
 *
 * This module is intentionally Obsidian-free so it can be imported
 * in Node regression tests and server code without the Obsidian dependency.
 *
 * Schema versioning semantics:
 *   v1 — legacy path model (pathToId authoritative)
 *   v2 — id-first model (meta.path authoritative), flat JSON metadata values
 *   v3 — nested Y.Map metadata (field-level CRDT), lazy on-write migration
 *
 * Bump this constant AND SERVER_MIN/MAX_SCHEMA_VERSION in server/src/version.ts
 * together whenever a breaking schema change ships.
 */
export const SCHEMA_VERSION = 3;
