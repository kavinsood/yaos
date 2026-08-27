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

/** Tracks room-namespace calls so rejection tests can prove the route never even probes a Durable Object. */
let getServerByNameCallCount = 0;

export function resetGetServerByNameCallCount(): void {
	getServerByNameCallCount = 0;
}

export function getGetServerByNameCallCount(): number {
	return getServerByNameCallCount;
}

/** Throws if called — DO namespace should never be accessed pre-auth. */
export function getServerByName(_ns: unknown, _name: string): never {
	getServerByNameCallCount++;
	throw new Error(
		`Durable Object namespace accessed before authentication. ` +
		`getServerByName("${_name}") was called — INV-SEC-01 violation.`,
	);
}

/** Runtime-sized base class for server tests; routing tests still trap namespace access above. */
export class Server {
	readonly ctx: unknown;
	readonly env: unknown;

	constructor(ctx?: unknown, env?: unknown) {
		this.ctx = ctx;
		this.env = env;
	}

	getConnections(): Iterable<never> {
		return [];
	}
}
