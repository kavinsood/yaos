import { strict as assert } from "node:assert";
import {
	BootstrapHttpPort,
	type BootstrapHttpRequest,
	type BootstrapHttpResponse,
} from "../../src/sync/bootstrapClient";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import { VaultSyncHttpPort } from "../../src/sync/vaultSync";
import {
	createFetchRequester,
	type HttpRequest,
	type HttpResponse,
} from "../../src/utils/http";
import { suite } from "../harness.ts";

const s = suite("bootstrap-http-boundaries");

function response(overrides: Partial<BootstrapHttpResponse> = {}): BootstrapHttpResponse {
	return {
		status: 200,
		headers: { "x-yaos-generation": "7" },
		arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
		json: {},
		...overrides,
	};
}

s.test("HTTP adapter consumes authenticated root, catalog, and body boundaries directly", async () => {
	const requests: BootstrapHttpRequest[] = [];
	const documents: StoredDocument[] = [];
	const request = async (input: BootstrapHttpRequest): Promise<BootstrapHttpResponse> => {
		requests.push(input);
		if (input.url.endsWith("/bootstrap/start")) {
			return response({ json: { bootstrapId: "boot" } });
		}
		if (input.url.includes("/catalog?")) {
			return response({ json: { entries: [], nextCursor: null } });
		}
		return response();
	};
	const database = {
		putDocument: async (document: StoredDocument) => { documents.push(document); },
	};
	const port = new BootstrapHttpPort(
		"https://sync.test/",
		"vault/id",
		"token",
		database as never,
		request,
		() => 99,
	);

	await port.start("attempt");
	assert.deepEqual(await port.root("boot/id"), new Uint8Array([1, 2, 3]));
	await port.catalog("boot/id", "next/value", 25);
	assert.equal((await port.body("boot/id", "body/id")).generation, 7);
	assert.equal((await port.currentBody("body/id")).generation, 7);
	await port.settleRootThrough(41);
	assert.equal((await port.bodies("boot/id", [])).size, 0);

	assert.deepEqual(
		requests.map(({ url, method }) => ({ url, method })),
		[
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/start", method: "POST" },
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/boot%2Fid/root", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/boot%2Fid/catalog?limit=25&cursor=next%2Fvalue", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/boot%2Fid/body/body%2Fid", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/body/body%2Fid", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/root?through=41", method: "GET" },
		],
	);
	assert.ok(requests.every((entry) => entry.headers.Authorization === "Bearer token"));
	assert.deepEqual(JSON.parse(requests[0]!.body ?? "null"), { attemptId: "attempt" });
	assert.equal(documents[0]?.documentId, "root");
	assert.equal(documents[0]?.generation, 7);
	assert.equal(documents[0]?.updatedAt, 99);
});

s.test("fetch adaptation preserves request bytes and decodes one response body", async () => {
	const requestBody = new Uint8Array([4, 5, 6]).buffer;
	let receivedBody: BodyInit | null | undefined;
	const request = createFetchRequester(async (_input, init) => {
		receivedBody = init?.body;
		return new Response('{"accepted":true}', {
			status: 200,
			headers: {
				"content-type": "application/json",
				"x-yaos-generation": "9",
			},
		});
	});

	const result = await request({
		url: "https://sync.test/vault",
		method: "POST",
		contentType: "application/octet-stream",
		headers: { Authorization: "Bearer token" },
		body: requestBody,
	});

	assert.strictEqual(receivedBody, requestBody);
	assert.deepEqual(result.json, { accepted: true });
	assert.equal(result.headers["x-yaos-generation"], "9");
	assert.deepEqual(
		new Uint8Array(result.arrayBuffer),
		new TextEncoder().encode('{"accepted":true}'),
	);
});

s.test("VaultSync HTTP injection sends candidate bytes without copying", async () => {
	const requests: HttpRequest[] = [];
	const response: HttpResponse = {
		status: 200,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: {
			vaultId: "vault/id",
			vaultGeneration: "generation",
			bodyId: "body/id",
			clientId: "client",
			candidateId: "candidate",
			candidateDigest: "digest",
			durableGeneration: 2,
			runtimeEpoch: "epoch",
		},
		text: "",
	};
	const port = new VaultSyncHttpPort(
		"https://sync.test/",
		"vault/id",
		"token",
		async (request) => {
			requests.push(request);
			return response;
		},
	);
	const encodedUpdate = new Uint8Array([7, 8, 9]).buffer;
	await port.submitCandidate({
		vaultId: "vault/id",
		bodyId: "body/id",
		candidateId: "candidate",
		candidateDigest: "digest",
		encodedUpdate,
		capturedAt: 1,
	});

	assert.strictEqual(requests[0]?.body, encodedUpdate);
	assert.equal(
		requests[0]?.url,
		"https://sync.test/vault/vault%2Fid/body/body%2Fid/candidate",
	);
	assert.equal(requests[0]?.headers?.Authorization, "Bearer token");
});

await s.done();
