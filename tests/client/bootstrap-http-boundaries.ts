import { strict as assert } from "node:assert";
import {
	BootstrapHttpPort,
	type BootstrapHttpRequest,
	type BootstrapHttpResponse,
} from "../../src/sync/bootstrapClient";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
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

await s.done();
