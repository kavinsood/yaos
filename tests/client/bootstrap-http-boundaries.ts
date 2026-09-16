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
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";

const s = suite("bootstrap-http-boundaries");

function response(overrides: Partial<BootstrapHttpResponse> = {}): BootstrapHttpResponse {
	return {
		status: 200,
		headers: { "x-yaos-generation": "7", "x-yaos-body-epoch": "1", "x-yaos-root-epoch": "1" },
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
			return response({ json: { bootstrapId: "boot/id", capture: { rootEpoch: 1 } } });
		}
		if (input.url.includes("/catalog?")) {
			return response({ json: { entries: [], nextCursor: null } });
		}
		if (input.url.endsWith("/catch-up")) {
			return response({ arrayBuffer: encodeBinaryEnvelope({ bodies: [{
				bodyId: "body-current",
				fileId: "body-current",
				path: "Current.md",
				previousPath: null,
				lifecycle: "active",
				bodyEpoch: 1,
				generation: 8,
				contentHash: "a".repeat(64),
				size: 3,
				status: 200,
				update: new Uint8Array([1, 2, 3]),
			}] }).slice().buffer });
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
	const caught = await port.catchUpBodies([{ bodyId: "body-current", bodyEpoch: 1, generation: 7 }]);
	assert.deepEqual(caught.get("body-current")?.state?.encodedState, new Uint8Array([1, 2, 3]));

	assert.deepEqual(
		requests.map(({ url, method }) => ({ url, method })),
		[
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/start", method: "POST" },
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/boot%2Fid/root", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/boot%2Fid/catalog?limit=25&cursor=next%2Fvalue", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/bootstrap/boot%2Fid/body/body%2Fid", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/body/body%2Fid", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/root?through=41", method: "GET" },
			{ url: "https://sync.test/vault/vault%2Fid/catch-up", method: "POST" },
		],
	);
	assert.ok(requests.every((entry) => entry.headers.Authorization === "Bearer token"));
	assert.deepEqual(JSON.parse(typeof requests[0]!.body === "string" ? requests[0]!.body : "null"), { attemptId: "attempt" });
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

s.test("oversized bootstrap batches split and a single oversized body falls back to raw bytes", async () => {
	const requests: BootstrapHttpRequest[] = [];
	const request = async (input: BootstrapHttpRequest): Promise<BootstrapHttpResponse> => {
		requests.push(input);
		if (input.method === "POST") return response({ status: 413, json: { error: "bootstrap_response_too_large" } });
		return response({ headers: { "x-yaos-generation": "11", "x-yaos-body-epoch": "1" }, arrayBuffer: new Uint8Array([4, 5, 6]).buffer });
	};
	const port = new BootstrapHttpPort("https://sync.test", "vault", "token", {} as never, request);
	const states = await port.bodies("boot", ["large-a", "large-b"]);
	assert.equal(states.size, 2);
	assert.equal(states.get("large-a")?.generation, 11);
	assert.deepEqual(states.get("large-b")?.encodedState, new Uint8Array([4, 5, 6]));
	assert.equal(requests.filter((entry) => entry.method === "POST").length, 3);
	assert.equal(requests.filter((entry) => entry.method === "GET").length, 2);
});

s.test("a single oversized catch-up body falls back to generation-matched raw state", async () => {
	const requests: BootstrapHttpRequest[] = [];
	const request = async (input: BootstrapHttpRequest): Promise<BootstrapHttpResponse> => {
		requests.push(input);
		if (input.url.endsWith("/catch-up")) {
			return response({ status: 413, json: { error: "catch_up_response_too_large" } });
		}
		if (input.url.endsWith("/head/large")) {
			return response({ json: {
				bodyId: "large", fileId: "large", path: "large.md", generation: 17,
				bodyEpoch: 1,
				contentHash: "a".repeat(64), size: 1_700_000,
			} });
		}
		return response({ headers: { "x-yaos-generation": "17", "x-yaos-body-epoch": "1" }, arrayBuffer: new Uint8Array([7, 8, 9]).buffer });
	};
	const port = new BootstrapHttpPort("https://sync.test", "vault", "token", {} as never, request);
	const caught = await port.catchUpBodies([{ bodyId: "large", bodyEpoch: 1, generation: 16 }]);
	assert.equal(caught.get("large")?.head.path, "large.md");
	assert.deepEqual(caught.get("large")?.state?.encodedState, new Uint8Array([7, 8, 9]));
	assert.deepEqual(requests.map((entry) => entry.method), ["POST", "GET", "GET"]);
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
		bodyEpoch: 1,
		previousBaseline: "",
		pendingMarkdown: "test",
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

s.test("VaultSync HTTP adapter batches create admissions and candidate updates into one request each", async () => {
	const requests: HttpRequest[] = [];
	const port = new VaultSyncHttpPort(
		"https://sync.test",
		"vault",
		"token",
		async (request) => {
			requests.push(request);
			return {
				status: 200,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: request.url.endsWith("/lifecycle/admissions")
					? { receipts: [], vaultSequence: 2, runtimeEpoch: "runtime" }
					: { receipts: [], highWater: 4 },
				text: "",
			};
		},
	);
	const operations = ["a", "b"].map((suffix) => ({
		operationId: `operation-${suffix}`,
		kind: "create" as const,
		fileId: `body-${suffix}`,
		bodyId: `body-${suffix}`,
		bodyEpoch: 1 as const,
		path: `${suffix}.md`,
		candidateId: `candidate-${suffix}`,
		candidateDigest: suffix.repeat(64),
	}));
	await port.commitCreateAdmissionsBatch(operations);
	await port.submitCandidates(operations.map((operation, index) => ({
		vaultId: "vault",
		bodyId: operation.bodyId,
		bodyEpoch: 1,
		previousBaseline: "",
		pendingMarkdown: operation.path,
		candidateId: operation.candidateId,
		candidateDigest: operation.candidateDigest,
		encodedUpdate: Uint8Array.of(index + 1, index + 2).buffer,
		capturedAt: index,
	})));

	assert.deepEqual(requests.map((request) => request.url), [
		"https://sync.test/vault/vault/lifecycle/admissions",
		"https://sync.test/vault/vault/body/candidates",
	]);
	assert.deepEqual(JSON.parse(requests[0]!.body as string), { operations });
	const envelope = decodeBinaryEnvelope(new Uint8Array(requests[1]!.body as ArrayBuffer)) as {
		candidates: Array<{ bodyId: string; encodedUpdates: Uint8Array[] }>;
	};
	assert.deepEqual(envelope.candidates.map((candidate) => candidate.bodyId), ["body-a", "body-b"]);
	assert.deepEqual(envelope.candidates.map((candidate) => candidate.encodedUpdates.map((update) => [...update])),
		[[[1, 2]], [[2, 3]]]);
	assert.ok(requests.every((request) => request.headers?.Authorization === "Bearer token"));
});

s.test("VaultSync HTTP adapter routes a persisted multi-frame candidate through the batch envelope", async () => {
	const requests: HttpRequest[] = [];
	const port = new VaultSyncHttpPort("https://sync.test", "vault", "token", async (request) => {
		requests.push(request);
		return {
			status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "",
			json: { receipts: [{ candidateId: "candidate" }], highWater: 1 },
		};
	});
	await port.submitCandidate({
		vaultId: "vault", bodyId: "body", bodyEpoch: 1, previousBaseline: "",
		pendingMarkdown: "framed", candidateId: "candidate", candidateDigest: "a".repeat(64),
		encodedUpdate: Uint8Array.of(1).buffer,
		encodedUpdates: [Uint8Array.of(2, 3).buffer, Uint8Array.of(4, 5).buffer],
		capturedAt: 1,
	});
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.url, "https://sync.test/vault/vault/body/candidates");
	const envelope = decodeBinaryEnvelope(new Uint8Array(requests[0]!.body as ArrayBuffer)) as {
		candidates: Array<{ encodedUpdates: Uint8Array[] }>;
	};
	assert.deepEqual(envelope.candidates[0]!.encodedUpdates.map((update) => [...update]), [[2, 3], [4, 5]]);
});

await s.done();
