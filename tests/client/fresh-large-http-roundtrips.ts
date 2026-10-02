import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import {
	MAX_CANDIDATE_UPDATE_BYTES,
	MAX_CLIENT_MARKDOWN_BYTES,
	MAX_DURABLE_UPDATE_BYTES,
} from "../../server/src/shared/durableLimits";
import { VaultSync, type BulkCreateRequest } from "../../src/sync/vaultSync";
import type { HttpRequest, HttpResponse } from "../../src/utils/http";
import { suite } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { FakeBulkCreateServer, memoryVault, testProvider } from "./helpers/fakeBulkCreateServer.ts";

installDomCrypto();
const s = suite("fresh-large-http-roundtrips");

/** Production HTTP adapter against the bulk-create model: every request is recorded. */
function httpFixture() {
	const server = new FakeBulkCreateServer();
	const requests: HttpRequest[] = [];
	const request = async (input: HttpRequest): Promise<HttpResponse> => {
		requests.push(input);
		if (!input.url.endsWith("/lifecycle/create-bulk")) throw new Error(`unexpected request: ${input.url}`);
		const decoded = decodeBinaryEnvelope(new Uint8Array(input.body as ArrayBuffer)) as BulkCreateRequest;
		const reply = await server.commitCreateBulk(decoded);
		return { status: 200, headers: {}, arrayBuffer: encodeBinaryEnvelope(reply).slice().buffer, json: null, text: "" };
	};
	return { server, requests, request };
}

s.test("exact 5 MiB Unicode creation uses durable frames in exactly one HTTP request", async () => {
	const prefix = "---\ntitle: 大きなノート 👩‍🚀\n---\n";
	const prefixBytes = new TextEncoder().encode(prefix).byteLength;
	const content = prefix + "x".repeat(MAX_CLIENT_MARKDOWN_BYTES - prefixBytes);
	assert.equal(new TextEncoder().encode(content).byteLength, MAX_CLIENT_MARKDOWN_BYTES);
	const vault = memoryVault();
	const { server, requests, request } = httpFixture();
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database, request, providerFactory: testProvider,
	});
	try {
		await runtime.commitFreshBodies([{
			bodyId: "body-large", path: "large.md", content, candidateId: "candidate-large", reason: "import",
		}]);
		assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), ["/vault/vault-1/lifecycle/create-bulk"]);
		const updates = server.calls[0]!.files[0]!.updates;
		assert.ok(updates.length > 1);
		assert.ok(updates.every((update) => update.byteLength > 0 && update.byteLength <= MAX_DURABLE_UPDATE_BYTES));
		assert.ok(updates.reduce((sum, update) => sum + update.byteLength, 0) <= MAX_CANDIDATE_UPDATE_BYTES);
		const reconstructed = new Y.Doc();
		try {
			for (const update of updates) Y.applyUpdate(reconstructed, update);
			assert.equal(reconstructed.getText("body").toString(), content);
		} finally {
			reconstructed.destroy();
		}
		assert.equal(runtime.getFileId("large.md"), "body-large");
		assert.equal(vault.candidates.size, 0);
		assert.equal(vault.lifecycle.size, 0);
	} finally {
		await runtime.destroy();
	}
});

s.test("32 ordinary notes use one production HTTP request with default residency", async () => {
	const inputs = Array.from({ length: 32 }, (_, index) => ({
		bodyId: `body-${index}`,
		path: `batch/note-${index}.md`,
		content: `# Note ${index}\n${"x".repeat(4 * 1024)}`,
		candidateId: `candidate-${index}`,
		reason: "import",
	}));
	const vault = memoryVault();
	const { server, requests, request } = httpFixture();
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database, request, providerFactory: testProvider,
	});
	try {
		const committed = await runtime.commitFreshBodies(inputs);
		assert.equal(committed.results.length, 32);
		assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), ["/vault/vault-1/lifecycle/create-bulk"]);
		assert.equal(server.calls[0]!.files.length, 32);
		assert.ok(server.calls[0]!.files.every((file) => file.updates.every((update) =>
			update.byteLength > 0 && update.byteLength <= MAX_DURABLE_UPDATE_BYTES)));
		assert.ok(inputs.every((input) => runtime.getFileId(input.path) === input.bodyId));
		assert.ok(inputs.every((input) => server.bodyText(input.bodyId) === input.content));
		assert.equal(vault.candidates.size, 0);
		assert.equal(vault.lifecycle.size, 0);
	} finally {
		await runtime.destroy();
	}
});

await s.done();
