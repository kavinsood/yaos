const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";
const TOKEN = process.env.SYNC_TOKEN || "";
const BASE_VAULT_ID = process.env.YAOS_TEST_VAULT_ID || `yaos-hardening-${Date.now().toString(36)}`;

if (!TOKEN) {
	throw new Error("SYNC_TOKEN is required for hardening worker tests");
}

function assert(condition, msg) {
	if (!condition) {
		throw new Error(msg);
	}
	console.log(`  PASS  ${msg}`);
}

function authHeaders(extra = {}) {
	return {
		Authorization: `Bearer ${TOKEN}`,
		...extra,
	};
}

async function getJson(path) {
	const res = await fetch(`${HOST}${path}`, {
		headers: authHeaders(),
	});
	const text = await res.text();
	let payload = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = text;
	}
	return { res, payload };
}

async function main() {
	const traceRoomId = `${BASE_VAULT_ID}-hardening-trace`;
	console.log(`Hardening trace room: ${traceRoomId}`);

	console.log("\n--- Test: oversized trace payloads are truncated and do not fail the request ---");
	const hugeSchema = "x".repeat(20_000);
	const oversizedTraceRes = await fetch(
		`${HOST}/vault/sync/${encodeURIComponent(traceRoomId)}?schemaVersion=${hugeSchema}`,
		{
			headers: authHeaders(),
		},
	);
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
