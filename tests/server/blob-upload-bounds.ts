import { MAX_BLOB_UPLOAD_BYTES } from "../../server/src/contracts";
import { handleBlobRoute } from "../../server/src/routes/blobs";
import { createHash } from "node:crypto";
import type { ObjectStorePort, ObjectWriteOptions, VerifiedObjectStreamOptions } from "../../server/src/platformPorts";
import { verifyObjectStream } from "../../server/src/verifiedObjectStream";
import { blobKey } from "../../server/src/vaultObjectStore";
import { FakeObjectStore, makeConfigNamespace, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";
import { COLLABORATION_POLICY_VERSION, capabilityDigestForRole } from "../../server/src/collaboration";

const s = suite("blob-upload-bounds");
const encoder = new TextEncoder();
const VAULT_ID = "vault-blob-upload-aa";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function blobEnv(bucket: ObjectStorePort) {
	const capabilityDigest = await capabilityDigestForRole("member");
	return makeEnv({
		YAOS_BUCKET: bucket,
		YAOS_SYNC: { call: async (_actorName: string, request: Request) => {
			if (new URL(request.url).pathname === "/blobs/suspects") return json({ suspect: [] });
			if (new URL(request.url).pathname === "/blobs/clear-suspect") return json({ cleared: true });
			throw new Error(`unexpected blob authority route: ${new URL(request.url).pathname}`);
		} },
		YAOS_CONFIG: makeConfigNamespace(async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/__yaos/collaboration/authorize") {
				return json({
					device: { deviceId: "device-blob-upload-aa", vaultId: VAULT_ID, name: "Uploader" },
					principal: { principalId: "principal-blob-upload-aa", vaultId: VAULT_ID },
					membership: { principalId: "principal-blob-upload-aa", vaultId: VAULT_ID, role: "member", state: "active", revision: 1 },
					actor: { vaultId: VAULT_ID, vaultGeneration: "generation-blob-upload-aa", principalId: "principal-blob-upload-aa",
						membershipRevision: 1, deviceId: "device-blob-upload-aa", deviceCredentialRevision: 1,
						role: "member", policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest },
				});
			}
			if (url.pathname !== "/__yaos/vault" || url.searchParams.get("vaultId") !== VAULT_ID) {
				return json({ error: "unknown_vault" }, 404);
			}
			return json({
				vault: {
					vaultId: VAULT_ID,
					vaultGeneration: "generation-blob-upload-aa",
					name: "Uploads",
					state: "active",
					createdAt: 1,
					provisionedAt: 1,
				},
				provisioningError: null,
			});
		}),
	});
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

function uploadRequest(
	hash: string,
	body: ReadableStream<Uint8Array>,
	headers?: HeadersInit,
): Request {
	const requestHeaders = new Headers(headers);
	requestHeaders.set("Authorization", "Bearer blob-upload-token");
	return new Request(`https://example.test/vault/${VAULT_ID}/blobs/${hash}`, {
		method: "PUT",
		headers: requestHeaders,
		body,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
}

async function errorMessage(response: Response): Promise<string | undefined> {
	return (await response.json() as { error?: string }).error;
}


class MetadataRecordingBucket extends FakeObjectStore {
	contentType: string | null = null;
	readonly streamCalls: string[] = [];
	async head(key: string) {
		const metadata = await super.head(key);
		return metadata ? { ...metadata, sha256: createHash("sha256").update(this.objects.get(key)!).digest("hex") } : null;
	}

	async createOnlyVerifiedStream(key: string, body: ReadableStream<Uint8Array>, options: VerifiedObjectStreamOptions): Promise<"created" | "exists"> {
		this.streamCalls.push(key);
		const digest = createHash("sha256");
		const chunks: Uint8Array[] = [];
		await verifyObjectStream(body, options,
			async (chunk) => { digest.update(chunk); },
			async () => digest.digest("hex"),
			async (chunk) => { chunks.push(chunk.slice()); },
		);
		if (this.objects.has(key)) return "exists";
		const bytes = new Uint8Array(options.length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return await this.createOnly(key, bytes, options);
	}

	override async put(key: string, value: Uint8Array, options?: ObjectWriteOptions): Promise<void> {
		this.contentType = options?.contentType ?? null;
		await super.put(key, value, options);
	}
}

s.section("Known-length streamed publication");
{
	const body = encoder.encode("streamed content-addressed bytes");
	const hash = await sha256Hex(body);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body.subarray(0, 8));
			controller.enqueue(body.subarray(8));
			controller.close();
		},
	});
	const bucket = new MetadataRecordingBucket();
	const response = await handleBlobRoute(
		await blobEnv(bucket),
		VAULT_ID,
		uploadRequest(hash, stream, { "Content-Type": "image/png", "Content-Length": String(body.byteLength) }),
		[hash],
		json,
	);

	s.check(response.status === 204, "a bounded stream with exact Content-Length is accepted");
	s.check(bucket.streamCalls.length === 1, "an accepted stream uses the verified streaming port exactly once");
	s.check(bucket.puts.length === 1, "an accepted stream is published exactly once");
	const written = bucket.puts[0]?.bytes;
	s.check(
		written?.byteLength === body.byteLength
			&& written.every((byte, index) => byte === body[index]),
		"all accepted chunks are published in order",
	);
	s.check(bucket.contentType === "image/png", "the upload Content-Type is preserved in R2 metadata");
}

s.section("Crossing the declared length at the size limit");
{
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(MAX_BLOB_UPLOAD_BYTES));
			controller.enqueue(new Uint8Array([1]));
		},
		cancel() {
			cancelled = true;
		},
	});
	const bucket = new MetadataRecordingBucket();
	const hash = "a".repeat(64);
	const response = await handleBlobRoute(
		await blobEnv(bucket),
		VAULT_ID,
		uploadRequest(hash, stream, { "Content-Length": String(MAX_BLOB_UPLOAD_BYTES) }),
		[hash],
		json,
	);

	s.check(response.status === 400, "a stream crossing its declared length is rejected");
	s.check(
		await errorMessage(response) === "Content-Length mismatch",
		"a crossing stream reports the exact-length error",
	);
	s.check(cancelled, "the request stream is cancelled when its crossing chunk arrives");
	s.check(bucket.puts.length === 0, "no partial R2 object is published after a crossing chunk");
}

s.section("Declared length validation happens before body access");
{
	for (const [declared, expectedStatus, label] of [
		[null, 400, "missing"],
		["not-a-number", 400, "invalid"],
		[String(MAX_BLOB_UPLOAD_BYTES + 1), 413, "oversized"],
	] as const) {
		let bodyAccesses = 0;
		const hash = "b".repeat(64);
		const headers = new Headers({ Authorization: "Bearer blob-upload-token" });
		if (declared !== null) headers.set("Content-Length", declared);
		// @ts-expect-error Intentionally incomplete Request proves invalid lengths are rejected before any body access.
		const request: Request = {
			method: "PUT",
			headers,
			get body(): ReadableStream<Uint8Array> {
				bodyAccesses++;
				throw new Error("body must not be accessed");
			},
		};
		const bucket = new MetadataRecordingBucket();
		const response = await handleBlobRoute(
			await blobEnv(bucket),
			VAULT_ID,
			request,
			[hash],
			json,
		);

		s.check(response.status === expectedStatus, `${label} Content-Length is rejected`);
		s.check(bodyAccesses === 0, `${label} Content-Length is rejected before body access`);
		s.check(bucket.puts.length === 0, `${label} Content-Length never publishes to R2`);
		s.check(bucket.streamCalls.length === 0, `${label} Content-Length never invokes the streaming port`);
	}
}

s.section("Empty and failed streams");
{
	const hash = "c".repeat(64);
	const emptyBucket = new MetadataRecordingBucket();
	const emptyResponse = await handleBlobRoute(
		await blobEnv(emptyBucket),
		VAULT_ID,
		uploadRequest(hash, new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		}), { "Content-Length": "1" }),
		[hash],
		json,
	);
	s.check(emptyResponse.status === 400, "an empty stream is rejected");
	s.check(await errorMessage(emptyResponse) === "missing request body", "empty streams preserve the missing-body error");
	s.check(emptyBucket.puts.length === 0, "an empty stream never publishes to R2");

	let pullCount = 0;
	const failedStream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pullCount++;
			if (pullCount === 1) {
				controller.enqueue(encoder.encode("partial"));
				return;
			}
			controller.error(new Error("client disconnected"));
		},
	});
	const failedBucket = new MetadataRecordingBucket();
	const failedResponse = await handleBlobRoute(
		await blobEnv(failedBucket),
		VAULT_ID,
		uploadRequest(hash, failedStream, { "Content-Length": "8" }),
		[hash],
		json,
	);
	s.check(failedResponse.status === 400, "a stream failure is rejected");
	s.check(await errorMessage(failedResponse) === "failed to read request body", "stream failure has a stable client error");
	s.check(failedBucket.puts.length === 0, "bytes read before a stream failure are never published to R2");
}

s.section("Hash verification precedes publication");
{
	const body = encoder.encode("not the addressed content");
	const wrongHash = "0".repeat(64);
	const bucket = new MetadataRecordingBucket();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});
	const response = await handleBlobRoute(
		await blobEnv(bucket),
		VAULT_ID,
		uploadRequest(wrongHash, stream, { "Content-Length": String(body.byteLength) }),
		[wrongHash],
		json,
	);

	s.check(response.status === 400, "a streamed body with the wrong hash is rejected");
	s.check(await errorMessage(response) === "hash mismatch", "hash mismatch preserves its response message");
	s.check(bucket.puts.length === 0, "a hash mismatch never publishes to R2");
}

s.section("Incorrect declared lengths leave no object");
{
	const body = encoder.encode("exact length required");
	const hash = await sha256Hex(body);
	for (const length of [body.byteLength - 1, body.byteLength + 1]) {
		const bucket = new MetadataRecordingBucket();
		const stream = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(body);
			controller.close();
		} });
		const response = await handleBlobRoute(await blobEnv(bucket), VAULT_ID,
			uploadRequest(hash, stream, { "Content-Length": String(length) }), [hash], json);
		s.check(response.status === 400, `declared length ${length} is rejected for ${body.byteLength} bytes`);
		s.check(await errorMessage(response) === "Content-Length mismatch", "incorrect lengths preserve the stable client error");
		s.check(bucket.puts.length === 0 && bucket.objects.size === 0, "incorrect lengths never publish a final object");
	}
}

s.section("Existing blobs still require correct submitted bytes");
{
	const body = encoder.encode("immutable existing content");
	const hash = await sha256Hex(body);
	const bucket = new MetadataRecordingBucket();
	const env = await blobEnv(bucket);
	const upload = (bytes: Uint8Array, contentType: string) => handleBlobRoute(env, VAULT_ID,
		uploadRequest(hash, new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(bytes);
			controller.close();
		} }), { "Content-Length": String(bytes.byteLength), "Content-Type": contentType }), [hash], json);
	const initial = await upload(body, "text/plain");
	s.check(initial.status === 204 && bucket.puts.length === 1, "a correct upload creates the existing-key fixture once");
	s.check((await upload(body, "image/png")).status === 204, "correct bytes at an existing key remain idempotent");
	s.check(bucket.puts.length === 1 && bucket.contentType === "text/plain", "correct duplicates do not rewrite bytes or metadata");
	const corrupt = body.slice();
	corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
	let consumed = 0;
	const stream = new ReadableStream<Uint8Array>({ pull(controller) {
		if (consumed === corrupt.length) return controller.close();
		controller.enqueue(corrupt.slice(consumed, consumed + 2));
		consumed = Math.min(consumed + 2, corrupt.length);
	} });
	const response = await handleBlobRoute(env, VAULT_ID,
		uploadRequest(hash, stream, { "Content-Length": String(corrupt.length) }), [hash], json);
	s.check(response.status === 400, "corrupt submitted bytes return 400 even when the addressed blob exists");
	s.check(await errorMessage(response) === "hash mismatch", "existing-key corrupt bytes preserve the hash mismatch error");
	s.check(consumed === corrupt.length, "an existing-key corrupt upload is consumed completely for verification");
	const stored = bucket.objects.get(blobKey(VAULT_ID, "generation-blob-upload-aa", hash));
	s.check(bucket.puts.length === 1 && stored?.byteLength === body.length
		&& stored.every((byte, index) => byte === body[index]), "corrupt uploads cannot replace the existing object");
}

await s.done();
