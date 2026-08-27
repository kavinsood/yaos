import {
	deviceBearerHeaders,
	fetchSocketTicket,
	requireLiveIdentity,
} from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const HOST = identity.host;
const VAULT_ID = identity.vaultId;

function assert(condition: unknown, msg: string): void {
	if (!condition) {
		throw new Error(msg);
	}
	console.log(`  PASS  ${msg}`);
}


async function getJson(path: string): Promise<{ res: Response; payload: unknown }> {
	const res = await fetch(`${HOST}${path}`, {
		headers: deviceBearerHeaders(identity),
	});
	const text = await res.text();
	let payload: unknown = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = text;
	}
	return { res, payload };
}

async function main() {
	const traceRoomId = VAULT_ID;
	console.log(`Hardening trace room: ${traceRoomId}`);

	console.log("\n--- Test: oversized trace payloads are truncated and do not fail the request ---");
	const hugeSchema = "x".repeat(20_000);
	const { ticket } = await fetchSocketTicket(identity);
	const oversizedUrl = new URL(`${HOST}/vault/sync/${encodeURIComponent(traceRoomId)}`);
	oversizedUrl.searchParams.set("ticket", ticket);
	oversizedUrl.searchParams.set("schemaVersion", hugeSchema);
	const oversizedTraceRes = await fetch(oversizedUrl);
	assert(oversizedTraceRes.status === 426, "invalid giant schema request is rejected normally");

	const oversizedDebug = await getJson(`/vault/${encodeURIComponent(traceRoomId)}/debug/recent`);
	assert(oversizedDebug.res.ok, "debug endpoint returns successfully after oversized trace payload");
	// Note: ws-rejected events are no longer persisted to YAOS_SYNC (issue #40
	// amplification fix — a schema-mismatch loop must not hammer the DO).
	// They are logged via console.warn only.  The trace list may be empty or
	// contain unrelated room events; we only verify the endpoint is healthy.
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
