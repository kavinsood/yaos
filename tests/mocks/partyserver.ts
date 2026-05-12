/**
 * Minimal runtime mock for the "partyserver" package.
 *
 * The real partyserver imports from "cloudflare:workers" which is only
 * available inside the Cloudflare Workers runtime. Tests that import
 * server code (syncSocket.ts, trace.ts, index.ts) need this mock to
 * avoid the cloudflare:workers resolution error at test time.
 *
 * getServerByName is designed to throw if called — any pre-auth code
 * path that reaches it means a Durable Object namespace was touched
 * before authentication, which is the invariant under test (FU-4).
 *
 * Use via JITI_ALIAS: { "partyserver": "<path-to-this-file>" }
 */

/** Throws if called — DO namespace should never be accessed pre-auth. */
export function getServerByName(_ns: unknown, _name: string): never {
	throw new Error(
		`Durable Object namespace accessed before authentication. ` +
		`getServerByName("${_name}") was called — INV-SEC-01 violation.`,
	);
}

/** Stub base class. Not instantiated in any tested path. */
export class Server {
	constructor() {}
}
