import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobAddress } from "../../ports/crypto";
import { BLOB_EXISTS_BATCH, createHttpBlob, DEFAULT_MAX_BLOB_BYTES, probeHttpBlob } from "./httpBlob";
import { RelayHttpError } from "./relayHttp";
import { fakeFetch, jsonResponse, type FakeRequest } from "./relayTestFakes";

const TOKEN = "device-token-SECRET";
const addr = (i: number) => i.toString(16).padStart(64, "0") as BlobAddress;

function blob(route: (req: FakeRequest) => Response | "network") {
	const f = fakeFetch(route);
	return { port: createHttpBlob({ baseUrl: "https://r.example/", vaultId: "v1", credential: TOKEN, fetch: f.fetch }), requests: f.requests };
}

async function rejection(p: Promise<unknown>): Promise<RelayHttpError> {
	try {
		await p;
	} catch (error) {
		assert.ok(error instanceof RelayHttpError);
		assert.ok(!error.message.includes(TOKEN));
		return error;
	}
	assert.fail("expected a rejection");
}

describe("httpBlob", () => {
	it("put/get round-trip over the blob routes", async () => {
		const store = new Map<string, Uint8Array>();
		const { port, requests } = blob((req) => {
			const key = req.url.pathname.split("/").pop() ?? "";
			if (req.method === "PUT" && req.body instanceof Uint8Array) {
				store.set(key, req.body);
				return new Response(null, { status: 204 });
			}
			const hit = store.get(key);
			return hit ? new Response(hit.slice()) : jsonResponse({ error: "not found" }, 404);
		});
		assert.equal(port.maxBlobBytes, DEFAULT_MAX_BLOB_BYTES);
		await port.put(addr(1), new Uint8Array([1, 2]));
		assert.deepEqual(await port.get(addr(1)), new Uint8Array([1, 2]));
		assert.equal(await port.get(addr(2)), null);
		assert.equal(requests[0]!.url.pathname, `/vault/v1/blobs/${addr(1)}`);
		assert.equal(requests[0]!.headers.get("content-type"), "application/octet-stream");
		for (const r of requests) assert.equal(r.headers.get("authorization"), `Bearer ${TOKEN}`);
	});

	it("has() batches by 50 and only reports requested addresses", async () => {
		const { port, requests } = blob((req) => {
			const hashes: string[] = JSON.parse(String(req.body)).hashes;
			return jsonResponse({ present: [...hashes.filter((_h, i) => i % 2 === 0), addr(9999)] });
		});
		const wanted = Array.from({ length: 120 }, (_v, i) => addr(i));
		const present = await port.has(wanted);
		assert.equal(requests.length, 3);
		assert.equal(JSON.parse(String(requests[0]!.body)).hashes.length, BLOB_EXISTS_BATCH);
		assert.equal(requests[0]!.url.pathname, "/vault/v1/blobs/exists");
		assert.equal(present.size, 60);
		assert.ok(present.has(addr(0)) && !present.has(addr(1)) && !present.has(addr(9999)));
		assert.equal((await port.has([])).size, 0);
	});

	it("503 attachments_unavailable and other failures throw RelayHttpError", async () => {
		const unavailable = blob(() => jsonResponse({ error: "attachments_unavailable" }, 503)).port;
		for (const p of [unavailable.get(addr(1)), unavailable.put(addr(1), new Uint8Array(1)), unavailable.has([addr(1)])]) {
			const e = await rejection(p);
			assert.deepEqual([e.status, e.code], [503, "attachments_unavailable"]);
		}
		const mismatch = await rejection(blob(() => jsonResponse({ error: "hash mismatch" }, 400)).port.put(addr(1), new Uint8Array(1)));
		assert.equal(mismatch.code, "hash mismatch");
		const unknownVault = await rejection(blob(() => jsonResponse({ error: "unknown_vault" }, 404)).port.get(addr(1)));
		assert.equal(unknownVault.code, "unknown_vault");
		assert.equal((await rejection(blob(() => "network").port.get(addr(1)))).code, "network_error");
	});

	it("probeHttpBlob follows capabilities.attachments", async () => {
		const off = fakeFetch(() => jsonResponse({ claimed: true, attachments: false, maxBlobUploadBytes: 10 }));
		assert.equal(await probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: off.fetch }), null);
		assert.equal(off.requests[0]!.url.pathname, "/api/capabilities");
		const on = fakeFetch(() => jsonResponse({ claimed: true, attachments: true, maxBlobUploadBytes: 1234 }));
		const port = await probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: on.fetch });
		assert.equal(port?.maxBlobBytes, 1234);
		await rejection(probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: fakeFetch(() => "network").fetch }));
	});
});
