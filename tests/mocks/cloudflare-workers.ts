/**
 * Minimal runtime mock for the "cloudflare:workers" module.
 *
 * VaultBlobStore extends DurableObject from this package. Tests that import
 * server/src/index.ts (which re-exports VaultBlobStore) need this alias to
 * avoid MODULE_NOT_FOUND in Node.js.
 */

export class DurableObject {
	constructor(_ctx: unknown, _env: unknown) {}
}
