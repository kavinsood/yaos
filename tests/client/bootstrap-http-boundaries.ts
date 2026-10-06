import { strict as assert } from "node:assert";
import {
	BOOTSTRAP_BODY_BATCH_MAX,
	BootstrapHttpPort,
	type BootstrapHttpRequest,
	type BootstrapHttpResponse,
} from "../../legacy-src/sync/bootstrapClient";
import type { StoredDocument } from "../../legacy-src/sync/vaultIndexedDb";
import { VaultSyncHttpPort } from "../../legacy-src/sync/vaultSync";
import {
	createFetchRequester,
	type HttpRequest,
	type HttpResponse,
} from "../../legacy-src/utils/http";
import { suite } from "../harness.ts";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../legacy-src/shared/binaryEnvelope";

const s = suite("bootstrap-http-boundaries");
/** The legacy server's catch-up batch cap (`server/src/contracts.ts`, deleted with the legacy server in P1). */
const MAX_CATCH_UP_BODIES = 100;

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

s.test("bootstrap body and catch-up batches above the server cap are paged (260 notes)", async () => {
	assert.equal(BOOTSTRAP_BODY_BATCH_MAX, MAX_CATCH_UP_BODIES, "client page matches the server contract cap");
	const sizes: Array<[string, number]> = [];
	const request = async (input: BootstrapHttpRequest): Promise<BootstrapHttpResponse> => {
		const parsed = JSON.parse(String(input.body)) as { bodyIds?: string[]; bodies?: Array<{ bodyId: string }> };
		const ids = parsed.bodyIds ?? parsed.bodies?.map((item) => item.bodyId) ?? [];
		const route = input.url.endsWith("/catch-up") ? "catch-up" : "bodies";
		sizes.push([route, ids.length]);
		// The server answers 400 above MAX_CATCH_UP_BODIES (invalid_body_batch / invalid_catch_up_batch).
		if (ids.length > MAX_CATCH_UP_BODIES) return response({ status: 400, json: { error: "invalid_body_batch" } });
		const bodies = ids.map((bodyId) => route === "bodies"
			? { bodyId, bodyEpoch: 1, generation: 1, encodedState: new Uint8Array([1]) }
			: { bodyId, fileId: bodyId, path: `${bodyId}.md`, previousPath: null, lifecycle: "active", bodyEpoch: 1,
				generation: 2, contentHash: "b".repeat(64), size: 1, status: 200, update: new Uint8Array([2]) });
		return response({ arrayBuffer: encodeBinaryEnvelope({ bodies }).slice().buffer });
	};
	const port = new BootstrapHttpPort("https://sync.test", "vault", "token", {} as never, request);
	const ids = Array.from({ length: 260 }, (_, index) => `note-${index}`);
	const states = await port.bodies("boot", ids);
	assert.equal(states.size, 260);
	const caught = await port.catchUpBodies(ids.map((bodyId) => ({ bodyId, bodyEpoch: 1, generation: 1 })));
	assert.equal(caught.size, 260);
	assert.deepEqual(sizes, [["bodies", 100], ["bodies", 100], ["bodies", 60], ["catch-up", 100], ["catch-up", 100], ["catch-up", 60]]);
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

s.test("VaultSync HTTP adapter sends bulk creates as one binary envelope and batches candidates", async () => {
	const requests: HttpRequest[] = [];
	const bulkResponse = {
		batchId: "batch-1", outcomes: [
			{ kind: "file", operationId: "operation-a", path: "a.md", outcome: "created", bodyId: "body-a" },
			{ kind: "file", operationId: "operation-b", path: "b.md", outcome: "exists-different", bodyId: "body-b", existingBodyId: "body-x" },
		], vaultSequence: 2, rootGeneration: 3, rootEpoch: 1, vaultGeneration: "generation", runtimeEpoch: "runtime",
		replayed: false, rootUpdate: Uint8Array.of(9, 9),
	};
	const port = new VaultSyncHttpPort(
		"https://sync.test",
		"vault",
		"token",
		async (request) => {
			requests.push(request);
			const bulk = request.url.endsWith("/lifecycle/create-bulk");
			return {
				status: 200,
				headers: {},
				arrayBuffer: bulk ? encodeBinaryEnvelope(bulkResponse).slice().buffer : new ArrayBuffer(0),
				json: bulk ? null : { receipts: [], highWater: 4 },
				text: "",
			};
		},
	);
	const files = ["a", "b"].map((suffix, index) => ({
		operationId: `operation-${suffix}`,
		bodyId: `body-${suffix}`,
		path: `${suffix}.md`,
		updates: [Uint8Array.of(index + 1, index + 2)],
	}));
	const response = await port.commitCreateBulk({
		batchId: "batch-1", rootEpoch: 1, rootStateVector: Uint8Array.of(0), files, attachments: [],
	});
	await port.submitCandidates(files.map((file, index) => ({
		vaultId: "vault",
		bodyId: file.bodyId,
		bodyEpoch: 1,
		previousBaseline: "",
		pendingMarkdown: file.path,
		candidateId: `candidate-${index}`,
		candidateDigest: String(index).repeat(64),
		encodedUpdate: Uint8Array.of(index + 1, index + 2).buffer,
		capturedAt: index,
	})));

	assert.deepEqual(requests.map((request) => request.url), [
		"https://sync.test/vault/vault/lifecycle/create-bulk",
		"https://sync.test/vault/vault/body/candidates",
	]);
	assert.equal(requests[0]!.contentType, YAOS_BINARY_CONTENT_TYPE);
	const sent = decodeBinaryEnvelope(new Uint8Array(requests[0]!.body as ArrayBuffer)) as {
		batchId: string; files: Array<{ path: string; updates: Uint8Array[] }>; attachments: unknown[];
	};
	assert.equal(sent.batchId, "batch-1");
	assert.deepEqual(sent.files.map((file) => [file.path, file.updates.map((update) => [...update])]),
		[["a.md", [[1, 2]]], ["b.md", [[2, 3]]]]);
	assert.deepEqual(sent.attachments, []);
	assert.deepEqual(response.outcomes.map((outcome) => outcome.outcome), ["created", "exists-different"]);
	assert.deepEqual([...response.rootUpdate!], [9, 9]);
	const envelope = decodeBinaryEnvelope(new Uint8Array(requests[1]!.body as ArrayBuffer)) as {
		candidates: Array<{ bodyId: string; encodedUpdates: Uint8Array[] }>;
	};
	assert.deepEqual(envelope.candidates.map((candidate) => candidate.bodyId), ["body-a", "body-b"]);
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
