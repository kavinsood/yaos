import { MAX_BLOB_UPLOAD_BYTES } from "../../server/src/contracts";
import { handleBlobRoute } from "../../server/src/routes/blobs";
import type { ObjectStorePort, ObjectWriteOptions } from "../../server/src/platformPorts";
import { FakeObjectStore, makeConfigNamespace, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("blob-upload-bounds");
const encoder = new TextEncoder();
const VAULT_ID = "vault-blob-upload-aa";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function blobEnv(bucket: ObjectStorePort) {
	return makeEnv({
		YAOS_BUCKET: bucket,
		YAOS_CONFIG: makeConfigNamespace(async (request) => {
			const url = new URL(request.url);
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
	return new Request(`https://example.test/vault/${VAULT_ID}/blobs/${hash}`, {
		method: "PUT",
		headers,
		body,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
}

async function errorMessage(response: Response): Promise<string | undefined> {
	return (await response.json() as { error?: string }).error;
}


class MetadataRecordingBucket extends FakeObjectStore {
	contentType: string | null = null;

	override async put(key: string, value: Uint8Array, options?: ObjectWriteOptions): Promise<void> {
		this.contentType = options?.contentType ?? null;
		await super.put(key, value, options);
	}
}

s.section("Missing Content-Length");
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
		blobEnv(bucket),
		VAULT_ID,
		uploadRequest(hash, stream, { "Content-Type": "image/png" }),
		[hash],
		json,
	);

	s.check(response.status === 204, "a bounded stream without Content-Length is accepted");
	s.check(bucket.puts.length === 1, "an accepted stream is published exactly once");
	const written = bucket.puts[0]?.bytes;
	s.check(
		written?.byteLength === body.byteLength
			&& written.every((byte, index) => byte === body[index]),
		"all accepted chunks are published in order",
	);
	s.check(bucket.contentType === "image/png", "the upload Content-Type is preserved in R2 metadata");
}

s.section("Crossing the undeclared size limit");
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
	const bucket = new FakeObjectStore();
	const hash = "a".repeat(64);
	const response = await handleBlobRoute(
		blobEnv(bucket),
		VAULT_ID,
		uploadRequest(hash, stream),
		[hash],
		json,
	);

	s.check(response.status === 413, "a missing-length stream crossing the limit is rejected");
	s.check(
		await errorMessage(response) === `contentLength exceeds max upload size (${MAX_BLOB_UPLOAD_BYTES} bytes)`,
		"an undeclared oversized stream preserves the upload-limit error",
	);
	s.check(cancelled, "the request stream is cancelled when its crossing chunk arrives");
	s.check(bucket.puts.length === 0, "no partial R2 object is published after a crossing chunk");
}

s.section("Declared length validation happens before body access");
{
	for (const [declared, expectedStatus, label] of [
		["not-a-number", 400, "invalid"],
		[String(MAX_BLOB_UPLOAD_BYTES + 1), 413, "oversized"],
	] as const) {
		let bodyAccesses = 0;
		const hash = "b".repeat(64);
		// @ts-expect-error Intentionally incomplete Request proves invalid lengths are rejected before any body access.
		const request: Request = {
			method: "PUT",
			headers: new Headers({ "Content-Length": declared }),
			get body(): ReadableStream<Uint8Array> {
				bodyAccesses++;
				throw new Error("body must not be accessed");
			},
		};
		const bucket = new FakeObjectStore();
		const response = await handleBlobRoute(
			blobEnv(bucket),
			VAULT_ID,
			request,
			[hash],
			json,
		);

		s.check(response.status === expectedStatus, `${label} Content-Length is rejected`);
		s.check(bodyAccesses === 0, `${label} Content-Length is rejected before body access`);
		s.check(bucket.puts.length === 0, `${label} Content-Length never publishes to R2`);
	}
}

s.section("Empty and failed streams");
{
	const hash = "c".repeat(64);
	const emptyBucket = new FakeObjectStore();
	const emptyResponse = await handleBlobRoute(
		blobEnv(emptyBucket),
		VAULT_ID,
		uploadRequest(hash, new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		})),
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
	const failedBucket = new FakeObjectStore();
	const failedResponse = await handleBlobRoute(
		blobEnv(failedBucket),
		VAULT_ID,
		uploadRequest(hash, failedStream),
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
	const bucket = new FakeObjectStore();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});
	const response = await handleBlobRoute(
		blobEnv(bucket),
		VAULT_ID,
		uploadRequest(wrongHash, stream, { "Content-Length": String(body.byteLength) }),
		[wrongHash],
		json,
	);

	s.check(response.status === 400, "a streamed body with the wrong hash is rejected");
	s.check(await errorMessage(response) === "hash mismatch", "hash mismatch preserves its response message");
	s.check(bucket.puts.length === 0, "a hash mismatch never publishes to R2");
}

await s.done();
