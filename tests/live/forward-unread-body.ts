// b3-int: the front Worker forwards Content-Length-framed bodies to the vault
// DO as the unread request stream (687fe08). When the DO answers without
// consuming that body (an early 4xx before any body read), workerd used to log
// "Uncaught TypeError: Can't read from request stream after response has been
// sent" once the response went out. run-live fails if wrangler logs it; this
// suite drives the early-answer paths with real streamed bodies.
import { deviceBearerHeaders, requireLiveIdentity } from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const vaultRoot = `${identity.host}/vault/${encodeURIComponent(identity.vaultId)}`;
const payload = new Uint8Array(256 * 1024).fill(7);

interface Case { readonly name: string; readonly path: string; readonly headers?: Record<string, string>; readonly expect: number }

const cases: readonly Case[] = [
	// Invalid body id: rejected before any read.
	{ name: "candidate with invalid body id", path: "/body/bad.id/candidate", expect: 400 },
	// No body epoch header: the candidate service answers 400 before reading.
	{ name: "candidate without body epoch", path: "/body/unread-body-1/candidate", expect: 400 },
	// Semantic candidate without its epoch header.
	{ name: "semantic candidate without epoch", path: "/semantic/unread-doc-1/candidate", expect: 400 },
];

for (let round = 0; round < 5; round++) {
	for (const entry of cases) {
		const response = await fetch(`${vaultRoot}${entry.path}`, {
			method: "POST",
			headers: deviceBearerHeaders(identity, { "content-type": "application/octet-stream", ...entry.headers }),
			body: payload,
		});
		const text = await response.text();
		if (response.status !== entry.expect) {
			throw new Error(`${entry.name} (round ${String(round)}): expected ${entry.expect}, got ${response.status} ${text.slice(0, 200)}`);
		}
	}
}
// Give workerd a moment to surface any deferred stream error in the log.
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(`Early DO answers to ${cases.length * 5} streamed requests returned normally.`);
