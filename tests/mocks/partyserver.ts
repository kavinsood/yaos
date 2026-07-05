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

/** Resolve a named DO stub, or throw if the namespace is not a real binding. */
export async function getServerByName(ns: unknown, name: string) {
	if (
		ns &&
		typeof ns === "object" &&
		"idFromName" in ns &&
		typeof (ns as { idFromName: unknown }).idFromName === "function" &&
		"get" in ns &&
		typeof (ns as { get: unknown }).get === "function"
	) {
		const binding = ns as DurableObjectNamespace;
		const id = binding.idFromName(name);
		const stub = binding.get(id);
		const req = new Request("http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/");
		req.headers.set("x-partykit-room", name);
		await stub.fetch(req);
		return stub;
	}
	throw new Error(
		`Durable Object namespace accessed before authentication. ` +
		`getServerByName("${name}") was called — INV-SEC-01 violation.`,
	);
}

/** Stub base class. Not instantiated in any tested path. */
export class Server {
	constructor() {}
}
