import { strict as assert } from "node:assert";
import { invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import { handleOperatorVaultRuntimeRoute } from "../../server/src/routes/vault";
import { BULK_CREATE_MAX_REQUEST_BYTES } from "../../server/src/vaultBulkCreateService";
import { makeConfigNamespace, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

// b3-cpu: a bounded vault route whose body declares Content-Length within the cap is forwarded as the
// untouched stream (no JS chunk loop, no copy); oversize declarations are still rejected unread.
const s = suite("forward-body-passthrough");
const VAULT_ID = "vault-forward-passthrough-01";
const VAULT_GENERATION = "generation-forward-passthrough-01";

function harness() {
	invalidateStoredServerConfigCache();
	const forwarded: Request[] = [];
	const env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async () => Response.json({ vault: { vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
			name: "Passthrough", state: "active", createdAt: 1, provisionedAt: 2 } })),
		YAOS_SYNC: makeVaultSyncNamespace(async (request) => {
			forwarded.push(request);
			const bytes = new Uint8Array(await request.arrayBuffer());
			return Response.json({ bytes: bytes.byteLength, last: bytes.at(-1) ?? null });
		}),
	});
	return { env, forwarded };
}

function streamed(bytes: Uint8Array, declared: string | null, pulls: { n: number }) {
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			const at = pulls.n++ * 4096;
			if (at >= bytes.byteLength) controller.close();
			else controller.enqueue(bytes.subarray(at, at + 4096));
		},
	}, { highWaterMark: 0 });
	return new Request(`https://example.test/vault/${VAULT_ID}/lifecycle/create-bulk`, {
		method: "POST", body: source, duplex: "half",
		headers: declared === null ? {} : { "Content-Length": declared },
	} as RequestInit & { duplex: "half" });
}

s.test("declared length within the cap is forwarded as the unread stream", async () => {
	const { env, forwarded } = harness();
	const bytes = new Uint8Array(3 * 1024 * 1024).map((_v, i) => i & 0xff);
	const pulls = { n: 0 };
	const request = streamed(bytes, String(bytes.byteLength), pulls);
	const response = await handleOperatorVaultRuntimeRoute(request, env, VAULT_ID, "/lifecycle/create-bulk");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { bytes: bytes.byteLength, last: bytes.at(-1) });
	assert.equal(forwarded.length, 1);
	assert.equal(forwarded[0]!.headers.get("content-length"), String(bytes.byteLength), "length is forwarded");
	assert.equal(request.bodyUsed, true, "the actor, not the front Worker, consumed the stream");
});

s.test("oversize or malformed declarations are rejected before the body is touched", async () => {
	for (const [declared, status] of [[String(BULK_CREATE_MAX_REQUEST_BYTES + 1), 413], ["12x", 400]] as const) {
		const { env, forwarded } = harness();
		const pulls = { n: 0 };
		const response = await handleOperatorVaultRuntimeRoute(streamed(new Uint8Array(16), declared, pulls), env, VAULT_ID,
			"/lifecycle/create-bulk");
		assert.equal(response.status, status);
		assert.equal(forwarded.length, 0);
		assert.equal(pulls.n, 0, "no chunk was pulled");
	}
});

s.test("no declared length keeps the bounded buffered read", async () => {
	const { env, forwarded } = harness();
	const pulls = { n: 0 };
	const response = await handleOperatorVaultRuntimeRoute(streamed(new Uint8Array(10_000).fill(7), null, pulls), env, VAULT_ID,
		"/lifecycle/create-bulk");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { bytes: 10_000, last: 7 });
	assert.equal(forwarded.length, 1);
	assert.ok(pulls.n >= 3, "front Worker read the chunks itself");
});

await s.done();
